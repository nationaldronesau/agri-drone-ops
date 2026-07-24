import type { Prisma } from '@prisma/client';
import sharp from 'sharp';
import prisma from '@/lib/db';
import type {
  Sam3BatchV2JobData,
  Sam3BatchV2JobResult,
  Sam3BatchV2Mode,
} from '@/lib/queue/batch-queue-v2';
import { acquireGpuLock, refreshGpuLock, releaseGpuLock } from '@/lib/services/gpu-lock';
import {
  awsSam3Service,
  type SAM3ConceptApplyOptions,
  type SAM3ConceptDetection,
  type SAM3RefineInstancePrompt,
} from '@/lib/services/aws-sam3';
import { S3Service } from '@/lib/services/s3';
import { normalizeDetectionType } from '@/lib/utils/detection-types';
import { buildExemplarCrops, normalizeExemplarCrops } from '@/lib/utils/exemplar-crops';
import {
  SAM3_BATCH_JOB_KINDS,
  summarizeChildBatchJobs,
  type Sam3BatchJobKind,
} from '@/lib/utils/sam3-batch-jobs';
import { scaleExemplarBoxes, type BoxCoordinate } from '@/lib/utils/exemplar-scaling';
import { fetchImageSafely } from '@/lib/utils/security';
import {
  greenFraction,
  greenFractionInPolygon,
  greenestBlobCentre,
  pointInPolygon,
} from '@/lib/utils/vegetation';

const BASE_URL = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';

export const SAM3_BATCH_V2_MAX_IMAGES = 500;
export const SAM3_BATCH_V2_MAX_EXEMPLARS = 10;
export const SAM3_BATCH_V2_GPU_LOCK_TTL_MS = 300000;
export const SAM3_BATCH_V2_GPU_LOCK_HEARTBEAT_MS = 45000;
export const SAM3_BATCH_V2_GPU_LOCK_RETRY_INTERVAL_MS = 5000;
export const SAM3_BATCH_V2_GPU_LOCK_RETRY_TIMEOUT_MS = 60000;
export const SAM3_BATCH_V2_GPU_MEMORY_THRESHOLD_MB = 12 * 1024;
export const SAM3_BATCH_V2_MODEL_OVERHEAD_MB = 4096;
export const SAM3_VEGETATION_DISABLE_BELOW = 0.05;
export const SAM3_VEGETATION_CLAMP = [0.05, 0.4] as const;
export const SAM3_BATCH_V2_VEGETATION_ALARM_MEDIAN = 0.3;
export const SAM3_BATCH_V2_INSTANCE_REFINEMENT_CHUNK_SIZE = 200;
export const SAM3_BATCH_V2_DEFAULT_CANDIDATE_BUDGET = 400;
export const SAM3_BATCH_V2_DEFAULT_RETRIEVAL_BACKEND = 'dinov3_vitl16_sat';

export type Sam3BatchV2RefineMode = 'instances' | 'concept';
export type Sam3BatchV2VegetationMode = 'active' | 'disabled_low_exemplar_green';

export function resolveBatchV2VegetationGate(exemplarGreenMedian: number): {
  mode: Sam3BatchV2VegetationMode;
  threshold: number | null;
} {
  if (exemplarGreenMedian < SAM3_VEGETATION_DISABLE_BELOW) {
    return {
      mode: 'disabled_low_exemplar_green',
      threshold: null,
    };
  }

  return {
    mode: 'active',
    threshold: Math.min(
      SAM3_VEGETATION_CLAMP[1],
      Math.max(SAM3_VEGETATION_CLAMP[0], 0.5 * exemplarGreenMedian)
    ),
  };
}

export function resolveBatchV2RefineMode(
  value: string | undefined = process.env.SAM3_REFINE_MODE
): Sam3BatchV2RefineMode {
  return value?.trim().toLowerCase() === 'concept' ? 'concept' : 'instances';
}

export function resolveBatchV2CandidateBudget(
  value: string | undefined = process.env.SAM3_CANDIDATE_BUDGET
): number {
  const parsed = value ? Number.parseInt(value, 10) : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0
    ? parsed
    : SAM3_BATCH_V2_DEFAULT_CANDIDATE_BUDGET;
}

export function resolveBatchV2RetrievalBackend(
  refineMode: Sam3BatchV2RefineMode = resolveBatchV2RefineMode(),
  value: string | undefined = process.env.SAM3_RETRIEVAL_BACKEND
): string | undefined {
  if (refineMode !== 'instances') {
    return undefined;
  }

  const configured = value?.trim();
  return configured || SAM3_BATCH_V2_DEFAULT_RETRIEVAL_BACKEND;
}

const parseOptionalNumber = (value: string | undefined): number | undefined => {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
};

const parseOptionalInt = (value: string | undefined): number | undefined => {
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
};

export function resolveBatchV2VegetationPrior(
  configured?: boolean,
  envValue: string | undefined = process.env.SAM3_VEGETATION_PRIOR
): boolean {
  if (envValue?.trim().toLowerCase() === 'false') return false;
  return configured ?? true;
}

export const SAM3_BATCH_V2_DEFAULT_SIMILARITY_THRESHOLD =
  parseOptionalNumber(process.env.SAM3_CONCEPT_SIMILARITY_THRESHOLD) ?? 0.65;
export const SAM3_BATCH_V2_DEFAULT_TOP_K =
  parseOptionalInt(process.env.SAM3_CONCEPT_TOP_K) ?? 120;
export const SAM3_BATCH_V2_DEFAULT_MIN_BOX_SIZE =
  parseOptionalInt(process.env.SAM3_CONCEPT_MIN_BOX_SIZE) ?? 16;
export const SAM3_BATCH_V2_DEFAULT_MAX_BOX_SIZE =
  parseOptionalInt(process.env.SAM3_CONCEPT_MAX_BOX_SIZE) ?? 600;
export const SAM3_BATCH_V2_DEFAULT_NMS_THRESHOLD =
  parseOptionalNumber(process.env.SAM3_CONCEPT_NMS_THRESHOLD) ?? 0.5;
export const SAM3_BATCH_V2_FALLBACK_SIMILARITY_THRESHOLD =
  parseOptionalNumber(process.env.SAM3_CONCEPT_FALLBACK_SIMILARITY_THRESHOLD) ?? 0.5;
export const SAM3_BATCH_V2_FALLBACK_TOP_K =
  parseOptionalInt(process.env.SAM3_CONCEPT_FALLBACK_TOP_K) ?? 40;
export type Sam3BatchV2ReviewProfile = 'balanced' | 'high_recall';
export const SAM3_BATCH_V2_HIGH_RECALL_SIMILARITY_THRESHOLD =
  parseOptionalNumber(process.env.SAM3_CONCEPT_HIGH_RECALL_SIMILARITY_THRESHOLD) ?? 0.75;
export const SAM3_BATCH_V2_HIGH_RECALL_TOP_K =
  parseOptionalInt(process.env.SAM3_CONCEPT_HIGH_RECALL_TOP_K) ?? 180;
export const SAM3_BATCH_V2_HIGH_RECALL_FALLBACK_SIMILARITY_THRESHOLD =
  parseOptionalNumber(process.env.SAM3_CONCEPT_HIGH_RECALL_FALLBACK_SIMILARITY_THRESHOLD) ?? 0.65;
export const SAM3_BATCH_V2_HIGH_RECALL_FALLBACK_TOP_K =
  parseOptionalInt(process.env.SAM3_CONCEPT_HIGH_RECALL_FALLBACK_TOP_K) ?? 120;
export const SAM3_BATCH_V2_MIN_TARGET_CANDIDATES = Math.max(
  0,
  parseOptionalInt(process.env.SAM3_CONCEPT_MIN_TARGET_CANDIDATES) ?? 25
);
export const SAM3_BATCH_V2_MAX_TARGET_CANDIDATES = Math.max(
  SAM3_BATCH_V2_MIN_TARGET_CANDIDATES,
  parseOptionalInt(process.env.SAM3_CONCEPT_MAX_TARGET_CANDIDATES) ??
    SAM3_BATCH_V2_DEFAULT_TOP_K
);
export const SAM3_BATCH_V2_HIGH_RECALL_MIN_TARGET_CANDIDATES = Math.max(
  0,
  parseOptionalInt(process.env.SAM3_CONCEPT_HIGH_RECALL_MIN_TARGET_CANDIDATES) ?? 50
);
export const SAM3_BATCH_V2_HIGH_RECALL_MAX_TARGET_CANDIDATES = Math.max(
  SAM3_BATCH_V2_HIGH_RECALL_MIN_TARGET_CANDIDATES,
  parseOptionalInt(process.env.SAM3_CONCEPT_HIGH_RECALL_MAX_TARGET_CANDIDATES) ??
    SAM3_BATCH_V2_HIGH_RECALL_TOP_K
);
export const SAM3_BATCH_V2_MIN_REFINEMENT_IOU = Math.max(
  0,
  parseOptionalNumber(process.env.SAM3_TARGET_REFINEMENT_MIN_IOU) ?? 0.1
);
export const SAM3_BATCH_V2_SOURCE_DETECTION_EXEMPLAR_LIMIT = Math.max(
  1,
  parseOptionalInt(process.env.SAM3_SOURCE_DETECTION_EXEMPLAR_LIMIT) ?? 30
);
export const SAM3_BATCH_V2_SOURCE_DETECTION_MIN_ANCHOR_OVERLAP = Math.max(
  0,
  Math.min(
    1,
    parseOptionalNumber(process.env.SAM3_SOURCE_DETECTION_MIN_ANCHOR_OVERLAP) ?? 0.2
  )
);
export function resolveBatchV2ReviewProfileForMode(
  mode: Sam3BatchV2Mode
): Sam3BatchV2ReviewProfile {
  return mode === 'concept_propagation' ? 'high_recall' : 'balanced';
}

export function getBatchV2MinTargetCandidates(
  profile: Sam3BatchV2ReviewProfile = 'balanced',
  refineMode: Sam3BatchV2RefineMode = resolveBatchV2RefineMode()
): number {
  if (refineMode === 'instances') {
    return resolveBatchV2CandidateBudget();
  }
  return profile === 'high_recall'
    ? SAM3_BATCH_V2_HIGH_RECALL_MIN_TARGET_CANDIDATES
    : SAM3_BATCH_V2_MIN_TARGET_CANDIDATES;
}

export function getBatchV2MaxTargetCandidates(
  profile: Sam3BatchV2ReviewProfile = 'balanced',
  refineMode: Sam3BatchV2RefineMode = resolveBatchV2RefineMode()
): number {
  if (refineMode === 'instances') {
    return resolveBatchV2CandidateBudget();
  }
  return profile === 'high_recall'
    ? SAM3_BATCH_V2_HIGH_RECALL_MAX_TARGET_CANDIDATES
    : SAM3_BATCH_V2_MAX_TARGET_CANDIDATES;
}

export function buildBatchV2ConceptApplyOptions(
  profile: Sam3BatchV2ReviewProfile = 'balanced'
): SAM3ConceptApplyOptions {
  const highRecall = profile === 'high_recall';
  const refineMode = resolveBatchV2RefineMode();
  const instancesMode = refineMode === 'instances';
  return {
    returnPolygons: true,
    similarityThreshold: highRecall
      ? SAM3_BATCH_V2_HIGH_RECALL_SIMILARITY_THRESHOLD
      : SAM3_BATCH_V2_DEFAULT_SIMILARITY_THRESHOLD,
    topK: instancesMode
      ? resolveBatchV2CandidateBudget()
      : highRecall
        ? SAM3_BATCH_V2_HIGH_RECALL_TOP_K
        : SAM3_BATCH_V2_DEFAULT_TOP_K,
    minBoxSize: SAM3_BATCH_V2_DEFAULT_MIN_BOX_SIZE,
    maxBoxSize: SAM3_BATCH_V2_DEFAULT_MAX_BOX_SIZE,
    nmsThreshold: SAM3_BATCH_V2_DEFAULT_NMS_THRESHOLD,
    ...(instancesMode
      ? {
          sizeFilterMinRatio: 0.2,
          sizeFilterMaxRatio: 2.5,
          embeddingBackend: resolveBatchV2RetrievalBackend(refineMode),
          candidatesOnly: true,
        }
      : {}),
  };
}

export function buildBatchV2ConceptFallbackApplyOptions(
  profile: Sam3BatchV2ReviewProfile = 'balanced'
): SAM3ConceptApplyOptions {
  const highRecall = profile === 'high_recall';
  const refineMode = resolveBatchV2RefineMode();
  const instancesMode = refineMode === 'instances';
  return {
    returnPolygons: true,
    similarityThreshold: highRecall
      ? SAM3_BATCH_V2_HIGH_RECALL_FALLBACK_SIMILARITY_THRESHOLD
      : SAM3_BATCH_V2_FALLBACK_SIMILARITY_THRESHOLD,
    topK: instancesMode
      ? resolveBatchV2CandidateBudget()
      : highRecall
        ? SAM3_BATCH_V2_HIGH_RECALL_FALLBACK_TOP_K
        : SAM3_BATCH_V2_FALLBACK_TOP_K,
    minBoxSize: SAM3_BATCH_V2_DEFAULT_MIN_BOX_SIZE,
    maxBoxSize: SAM3_BATCH_V2_DEFAULT_MAX_BOX_SIZE,
    nmsThreshold: SAM3_BATCH_V2_DEFAULT_NMS_THRESHOLD,
    ...(instancesMode
      ? {
          sizeFilterMinRatio: 0.2,
          sizeFilterMaxRatio: 2.5,
          embeddingBackend: resolveBatchV2RetrievalBackend(refineMode),
          candidatesOnly: true,
        }
      : {}),
  };
}

function conceptDetectionScore(
  detection: Pick<SAM3ConceptDetection, 'similarity' | 'confidence'>
): number {
  if (typeof detection.similarity === 'number' && Number.isFinite(detection.similarity)) {
    return detection.similarity;
  }
  if (typeof detection.confidence === 'number' && Number.isFinite(detection.confidence)) {
    return detection.confidence;
  }
  return 0;
}

export function filterBatchV2ConceptDetections(
  detections: SAM3ConceptDetection[],
  options: SAM3ConceptApplyOptions = buildBatchV2ConceptApplyOptions()
): SAM3ConceptDetection[] {
  const threshold =
    typeof options.similarityThreshold === 'number'
      ? options.similarityThreshold
      : SAM3_BATCH_V2_DEFAULT_SIMILARITY_THRESHOLD;

  return detections
    .filter((detection) => conceptDetectionScore(detection) >= threshold)
    .sort((left, right) => conceptDetectionScore(right) - conceptDetectionScore(left));
}

const EMPIRICAL_GPU_MEMORY_LOOKUP_MB: Record<number, number> = {
  1: 4608,
  2: 5632,
  4: 7168,
  6: 8704,
  8: 10240,
  10: 12800,
};

export function getGpuAdmissionCropCount(mode: Sam3BatchV2Mode, cropCount: number): number {
  return mode === 'visual_crop_match' ? cropCount : 1;
}

export type Sam3BatchV2Stage =
  | 'prepare'
  | 'estimate'
  | 'admit'
  | 'run_sam3'
  | 'persist'
  | 'terminal';

export type Sam3BatchV2StageStatus = 'queued' | 'started' | 'completed' | 'failed';

export type Sam3BatchV2AssetOutcome =
  | 'success'
  | 'zero_detections'
  | 'oom'
  | 'inference_error'
  | 'prepare_error';

export type Sam3BatchV2TerminalState =
  | 'completed'
  | 'completed_partial'
  | 'rejected_preflight'
  | 'failed_prepare'
  | 'failed_inference'
  | 'failed_persist';

export interface Sam3BatchV2StageLogEntry {
  stage: Sam3BatchV2Stage;
  status: Sam3BatchV2StageStatus;
  timestamp: string;
  attempt?: number;
  mode?: Sam3BatchV2Mode;
  assetId?: string;
  assetOutcome?: Sam3BatchV2AssetOutcome;
  terminalState?: Sam3BatchV2TerminalState;
  errorCode?: string;
  errorMessage?: string;
  cropCount?: number;
  admissionCropCount?: number;
  operatorCropCount?: number;
  sourceDetectionCropCount?: number;
  modeUsed?: 'box_prompt_match' | 'source_box_match' | 'visual_crops' | 'concept_propagation';
  reviewProfile?: Sam3BatchV2ReviewProfile;
  visualCropSource?: 'operator' | 'operator_crops' | 'server_built_crops' | 'source_detections' | 'concept_exemplar';
  backendMode?: string;
  backendWarning?: string;
  candidateExpansionUsed?: boolean;
  detectionCount?: number;
  candidateCount?: number;
  conceptExemplarCount?: number;
  refinementBoxCount?: number;
  refinementDetectionCount?: number;
  refinementMode?: Sam3BatchV2RefineMode;
  candidateBudget?: number;
  refineSentInstances?: number;
  refineRefinedInstances?: number;
  refineRejectedInstances?: number;
  refineIncompleteChunks?: number;
  vegetationPrior?: boolean;
  exemplarGreenMedian?: number;
  vegetationMode?: Sam3BatchV2VegetationMode;
  vegetationThreshold?: number | null;
  vegetationGatedCandidates?: number;
  vegetationRecenteredCandidates?: number;
  vegetationGatedMasks?: number;
  vegetationDeduplicatedMasks?: number;
  maskGreenFractionP10?: number;
  maskGreenFractionMedian?: number;
  maskGreenFractionP90?: number;
  durationMs?: number;
  gpuMemoryMb?: number;
  estimatedMemoryMb?: number;
  thresholdMemoryMb?: number;
  totalAssets?: number;
  processedImages?: number;
  failedAssets?: number;
}

export interface Sam3BatchV2StageSummary {
  latestStage: Sam3BatchV2Stage | null;
  terminalState: Sam3BatchV2TerminalState | null;
  lastMessage: string | null;
  assetOutcomes: Record<Sam3BatchV2AssetOutcome, number>;
}

export interface Sam3BatchV2JobLike {
  data: Sam3BatchV2JobData;
  attemptsMade?: number;
  updateProgress(progress: number): Promise<unknown>;
}

interface BatchJobRecord {
  kind?: string | null;
  parentBatchJobId?: string | null;
  sourceAssetId?: string | null;
  stageLog?: unknown;
}

interface BatchJobRollupRecord {
  id: string;
  status: string;
  processedImages: number;
  totalImages: number;
  detectionsFound: number;
  errorMessage: string | null;
  shardIndex: number | null;
  shardCount: number | null;
  startedAt: Date | null;
  completedAt: Date | null;
  stageLog?: unknown;
}

interface AssetRecord {
  id: string;
  storageUrl: string | null;
  s3Key: string | null;
  s3Bucket: string | null;
  storageType: string | null;
  imageWidth: number | null;
  imageHeight: number | null;
}

interface PrismaBatchTransaction {
  pendingAnnotation: {
    deleteMany(args: unknown): Promise<unknown>;
    createMany(args: unknown): Promise<unknown>;
  };
  batchJob: {
    update(args: unknown): Promise<unknown>;
  };
}

interface PrismaLike {
  batchJob: {
    findUnique(args: unknown): Promise<BatchJobRecord | null>;
    findMany(args: unknown): Promise<BatchJobRollupRecord[]>;
    update(args: unknown): Promise<unknown>;
  };
  asset: {
    findMany(args: unknown): Promise<AssetRecord[]>;
    findUnique(args: unknown): Promise<AssetRecord | null>;
  };
  $transaction<T>(fn: (tx: PrismaBatchTransaction) => Promise<T>): Promise<T>;
}

interface AwsSam3Like {
  isConfigured(): boolean;
  isReady(): boolean;
  refreshStatus(): Promise<{ modelLoaded: boolean; instanceState: string; ipAddress: string | null }>;
  startInstance(): Promise<boolean>;
  resizeImage(imageBuffer: Buffer): Promise<{
    buffer: Buffer;
    scaling: { scaleFactor: number };
  }>;
  segmentWithExemplars(request: {
    image: string;
    exemplarCrops: string[];
    className?: string;
  }): Promise<{
    success: boolean;
    response: {
      detections: Array<{
        bbox: [number, number, number, number];
        confidence: number;
        polygon?: [number, number][];
      }>;
      count: number;
      mode?: string;
      warning?: string;
    } | null;
    error?: string;
    errorCode?: string;
  }>;
  segment(request: {
    image: string;
    boxes: Array<{ x1: number; y1: number; x2: number; y2: number }>;
    className: string;
    minSize?: number;
    maxSize?: number | null;
    returnPolygons?: boolean;
  }): Promise<{
    success: boolean;
    response: {
      detections: Array<{
        bbox: [number, number, number, number];
        confidence: number;
        polygon?: [number, number][];
      }>;
      count: number;
    } | null;
    error?: string;
    errorCode?: string;
  }>;
  refineInstances?(request: {
    image: string;
    instances: SAM3RefineInstancePrompt[];
    return_polygons: true;
    decode_batch?: number;
    polygon_resolution?: number;
    score_threshold?: number;
  }): Promise<{
    success: boolean;
    response: {
      instances: Array<{
        id: string;
        polygon: [number, number][] | null;
        bbox_from_mask: [number, number, number, number] | null;
        predicted_iou: number;
        score: number;
      }>;
      image_size: [number, number];
    } | null;
    error?: string;
    errorCode?: string;
  }>;
  warmupConceptService(): Promise<{ success: boolean; data: { sam3Loaded: boolean; dinoLoaded: boolean } | null; error?: string }>;
  createConceptExemplar(request: {
    imageBuffer: Buffer;
    boxes: BoxCoordinate[];
    className: string;
    imageId?: string;
    embeddingBackend?: string;
  }): Promise<{
    success: boolean;
    data: { exemplarId: string; backendWarning?: string } | null;
    error?: string;
    errorCode?: string;
  }>;
  applyConceptExemplar(request: {
    exemplarId: string;
    imageBuffer: Buffer;
    imageId?: string;
    options?: SAM3ConceptApplyOptions;
  }): Promise<{
    success: boolean;
    data: {
      detections: SAM3ConceptDetection[];
      processingTimeMs: number;
      backendWarning?: string;
    } | null;
    error?: string;
    errorCode?: string;
  }>;
}

interface Sam3BatchV2Dependencies {
  prisma: PrismaLike;
  awsSam3Service: AwsSam3Like;
  acquireGpuLock: typeof acquireGpuLock;
  refreshGpuLock: typeof refreshGpuLock;
  releaseGpuLock: typeof releaseGpuLock;
  sleep(ms: number): Promise<void>;
  now(): Date;
}

interface PreparedBatchContext {
  batchJobId: string;
  parentBatchJobId: string | null;
  projectId: string;
  weedType: string;
  mode: Sam3BatchV2Mode;
  textPrompt: string;
  sourceAssetId: string;
  sourceImageBuffer: Buffer;
  exemplars: BoxCoordinate[];
  exemplarSourceWidth?: number;
  exemplarSourceHeight?: number;
  exemplarCrops: string[];
  visualCropSource?: Sam3BatchV2StageLogEntry['visualCropSource'];
  assets: AssetRecord[];
  missingAssetIds: string[];
  cropCount: number;
  operatorCropCount: number;
  vegetationPrior: boolean;
  exemplarGreenMedian: number;
  vegetationMode?: Sam3BatchV2VegetationMode;
  vegetationThreshold: number | null;
  exemplarDiameter: number;
}

interface AssetInferenceResult {
  assetId: string;
  detections: Array<{
    bbox: [number, number, number, number];
    polygon: [number, number][];
    confidence: number;
    similarity?: number;
  }>;
  outcome: Sam3BatchV2AssetOutcome;
  errorCode?: string;
  errorMessage?: string;
  backendMode?: string;
  backendWarning?: string;
  candidateExpansionUsed?: boolean;
  candidateCount?: number;
  refinementBoxCount?: number;
  refinementDetectionCount?: number;
  refinementMode?: Sam3BatchV2RefineMode;
  candidateBudget?: number;
  refineSentInstances?: number;
  refineRefinedInstances?: number;
  refineRejectedInstances?: number;
  refineIncompleteChunks?: number;
  vegetationMode?: Sam3BatchV2VegetationMode;
  vegetationThreshold?: number | null;
  vegetationGatedCandidates?: number;
  vegetationRecenteredCandidates?: number;
  vegetationGatedMasks?: number;
  vegetationDeduplicatedMasks?: number;
  maskGreenFractionP10?: number;
  maskGreenFractionMedian?: number;
  maskGreenFractionP90?: number;
}

interface ConceptRefinementResult {
  detections: AssetInferenceResult['detections'];
  candidateCount: number;
  refinementBoxCount: number;
  refinementDetectionCount: number;
  refinementMode?: Sam3BatchV2RefineMode;
  candidateBudget?: number;
  refineSentInstances?: number;
  refineRefinedInstances?: number;
  refineRejectedInstances?: number;
  refineIncompleteChunks?: number;
  vegetationMode?: Sam3BatchV2VegetationMode;
  vegetationThreshold?: number | null;
  vegetationGatedCandidates?: number;
  vegetationRecenteredCandidates?: number;
  vegetationGatedMasks?: number;
  vegetationDeduplicatedMasks?: number;
  maskGreenFractionP10?: number;
  maskGreenFractionMedian?: number;
  maskGreenFractionP90?: number;
  usedCandidateFallback?: boolean;
  backendWarning?: string;
}

interface VegetationPriorContext {
  enabled: boolean;
  exemplarGreenMedian: number;
  exemplarDiameter?: number;
  mode?: Sam3BatchV2VegetationMode;
  threshold?: number | null;
}

function normalizeVegetationPriorContext(
  vegetation?: VegetationPriorContext
): VegetationPriorContext | undefined {
  if (!vegetation) return undefined;
  if (!vegetation.enabled && !vegetation.mode) {
    return { ...vegetation, threshold: null };
  }

  const gate = vegetation.mode
    ? {
        mode: vegetation.mode,
        threshold:
          vegetation.mode === 'disabled_low_exemplar_green'
            ? null
            : vegetation.threshold ??
              resolveBatchV2VegetationGate(vegetation.exemplarGreenMedian).threshold,
      }
    : resolveBatchV2VegetationGate(vegetation.exemplarGreenMedian);

  return {
    ...vegetation,
    enabled: vegetation.enabled && gate.mode === 'active',
    mode: gate.mode,
    threshold: gate.threshold,
  };
}

interface VegetationCandidateResult {
  candidates: SAM3ConceptDetection[];
  imageWidth: number;
  imageHeight: number;
  threshold: number;
  gatedCount: number;
  recenteredCount: number;
  promptPoints: Map<SAM3ConceptDetection, [number, number]>;
}

interface VegetationMaskResult {
  detections: AssetInferenceResult['detections'];
  gatedCount: number;
  deduplicatedCount: number;
  p10?: number;
  median?: number;
  p90?: number;
}

interface ConceptExemplarRef {
  exemplarId: string;
  sourceBoxIndex?: number;
  backendWarning?: string;
}

interface ConceptCandidateResult {
  detections: SAM3ConceptDetection[];
  candidateExpansionUsed: boolean;
  backendWarning?: string;
}

interface GpuAdmissionResult {
  acquired: boolean;
  token: string | null;
  errorCode?: string;
  errorMessage?: string;
}

function defaultSleep(ms: number) {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

interface NamedError extends Error {
  errorCode?: string;
}

function createNamedError(name: string, message: string, errorCode?: string) {
  const error = new Error(message);
  error.name = name;
  if (errorCode) {
    (error as NamedError).errorCode = errorCode;
  }
  return error;
}

function getErrorCode(error: unknown, fallback: string): string {
  return error instanceof Error && typeof (error as NamedError).errorCode === 'string'
    ? (error as NamedError).errorCode!
    : fallback;
}

export function parseStageLog(stageLog: unknown): Sam3BatchV2StageLogEntry[] {
  if (!Array.isArray(stageLog)) {
    return [];
  }

  return stageLog.filter((entry): entry is Sam3BatchV2StageLogEntry => {
    return Boolean(
      entry &&
        typeof entry === 'object' &&
        'stage' in entry &&
        'status' in entry &&
        'timestamp' in entry
    );
  });
}

export function createStageLogEntry(
  entry: Omit<Sam3BatchV2StageLogEntry, 'timestamp'>,
  now: Date = new Date()
): Sam3BatchV2StageLogEntry {
  return {
    ...entry,
    timestamp: now.toISOString(),
  };
}

export function estimatePeakGpuMemoryMb(cropCount: number): {
  estimatedMemoryMb: number;
  thresholdMemoryMb: number;
  source: 'lookup' | 'formula';
  overBudget: boolean;
} {
  const lookupKeys = Object.keys(EMPIRICAL_GPU_MEMORY_LOOKUP_MB)
    .map((value) => Number.parseInt(value, 10))
    .sort((left, right) => left - right);
  const lookupKey = lookupKeys.find((value) => cropCount <= value);

  const estimatedMemoryMb =
    lookupKey != null
      ? EMPIRICAL_GPU_MEMORY_LOOKUP_MB[lookupKey]
      : Math.ceil(
          SAM3_BATCH_V2_MODEL_OVERHEAD_MB +
            (cropCount * 512 * 512 * 4) / (1024 * 1024)
        );

  return {
    estimatedMemoryMb,
    thresholdMemoryMb: SAM3_BATCH_V2_GPU_MEMORY_THRESHOLD_MB,
    source: lookupKey != null ? 'lookup' : 'formula',
    overBudget: estimatedMemoryMb > SAM3_BATCH_V2_GPU_MEMORY_THRESHOLD_MB,
  };
}

export function summarizeStageLog(stageLog: Sam3BatchV2StageLogEntry[]): Sam3BatchV2StageSummary {
  const outcomes: Record<Sam3BatchV2AssetOutcome, number> = {
    success: 0,
    zero_detections: 0,
    oom: 0,
    inference_error: 0,
    prepare_error: 0,
  };
  const latestAssetOutcomes = new Map<string, Sam3BatchV2AssetOutcome>();

  for (const entry of stageLog) {
    if (entry.assetId && entry.assetOutcome) {
      latestAssetOutcomes.set(entry.assetId, entry.assetOutcome);
    }
  }

  for (const outcome of latestAssetOutcomes.values()) {
    outcomes[outcome] += 1;
  }

  const reversed = [...stageLog].reverse();
  const terminalEntry = reversed.find((entry) => entry.stage === 'terminal');
  const latestStageEntry = reversed.find((entry) => entry.stage !== 'terminal');
  const lastMessageEntry = reversed.find((entry) => entry.errorMessage);

  return {
    latestStage: latestStageEntry?.stage ?? null,
    terminalState: terminalEntry?.terminalState ?? null,
    lastMessage: lastMessageEntry?.errorMessage ?? null,
    assetOutcomes: outcomes,
  };
}

export function determineTerminalState(assetResults: AssetInferenceResult[]): {
  terminalState: Sam3BatchV2TerminalState;
  topLevelStatus: 'COMPLETED' | 'FAILED';
  errorMessage: string | null;
} {
  const successes = assetResults.filter(
    (result) => result.outcome === 'success' || result.outcome === 'zero_detections'
  );
  const failures = assetResults.filter(
    (result) => result.outcome === 'oom' || result.outcome === 'inference_error' || result.outcome === 'prepare_error'
  );

  if (failures.length === 0) {
    return {
      terminalState: 'completed',
      topLevelStatus: 'COMPLETED',
      errorMessage: null,
    };
  }

  if (successes.length > 0) {
    return {
      terminalState: 'completed_partial',
      topLevelStatus: 'COMPLETED',
      errorMessage: summarizeFailureCounts(failures),
    };
  }

  const terminalState = failures.some(
    (result) => result.outcome === 'oom' || result.outcome === 'inference_error'
  )
    ? 'failed_inference'
    : 'failed_prepare';

  return {
    terminalState,
    topLevelStatus: 'FAILED',
    errorMessage: summarizeFailureCounts(failures),
  };
}

function summarizeFailureCounts(assetResults: AssetInferenceResult[]): string {
  const counts = assetResults.reduce<Record<string, number>>((summary, result) => {
    summary[result.outcome] = (summary[result.outcome] || 0) + 1;
    return summary;
  }, {});

  return Object.entries(counts)
    .map(([outcome, count]) => `${count} ${outcome.replace(/_/g, ' ')}`)
    .join('; ');
}

function classifyInferenceFailure(errorCode?: string, errorMessage?: string): Sam3BatchV2AssetOutcome {
  const normalized = `${errorCode || ''} ${errorMessage || ''}`.toLowerCase();
  if (
    normalized.includes('oom') ||
    normalized.includes('out of memory') ||
    normalized.includes('cuda') ||
    normalized.includes('memory')
  ) {
    return 'oom';
  }
  return 'inference_error';
}

function toBatchStageLogJson(stageLog: Sam3BatchV2StageLogEntry[]): Prisma.InputJsonValue {
  return stageLog as unknown as Prisma.InputJsonValue;
}

async function fetchAssetImage(asset: AssetRecord): Promise<Buffer> {
  let imageUrl: string;

  if (asset.storageType?.toLowerCase() === 's3' && asset.s3Key) {
    imageUrl = asset.s3Bucket
      ? await S3Service.getSignedUrl(asset.s3Key, 3600, asset.s3Bucket)
      : await S3Service.getSignedUrl(asset.s3Key);
  } else if (asset.storageUrl) {
    imageUrl = asset.storageUrl.startsWith('/') ? `${BASE_URL}${asset.storageUrl}` : asset.storageUrl;
  } else {
    throw new Error(`Asset ${asset.id} has no image URL`);
  }

  return fetchImageSafely(imageUrl, `Asset ${asset.id}`);
}

function normalizePolygon(
  polygon: [number, number][] | undefined,
  bbox: [number, number, number, number]
): [number, number][] {
  if (Array.isArray(polygon) && polygon.length >= 3) {
    return polygon.map((point) => [Math.round(point[0]), Math.round(point[1])] as [number, number]);
  }

  return [
    [bbox[0], bbox[1]],
    [bbox[2], bbox[1]],
    [bbox[2], bbox[3]],
    [bbox[0], bbox[3]],
  ];
}

function bboxToBoxCoordinate(
  bbox: [number, number, number, number],
  scaleFactor = 1
): BoxCoordinate {
  return {
    x1: Math.round(bbox[0] * scaleFactor),
    y1: Math.round(bbox[1] * scaleFactor),
    x2: Math.round(bbox[2] * scaleFactor),
    y2: Math.round(bbox[3] * scaleFactor),
  };
}

function isValidBox(box: BoxCoordinate): boolean {
  return box.x2 > box.x1 && box.y2 > box.y1;
}

function bboxArea(bbox: [number, number, number, number]): number {
  return Math.max(0, bbox[2] - bbox[0]) * Math.max(0, bbox[3] - bbox[1]);
}

function bboxIou(
  first: [number, number, number, number],
  second: [number, number, number, number]
): number {
  const x1 = Math.max(first[0], second[0]);
  const y1 = Math.max(first[1], second[1]);
  const x2 = Math.min(first[2], second[2]);
  const y2 = Math.min(first[3], second[3]);
  const intersection = bboxArea([x1, y1, x2, y2]);
  const union = bboxArea(first) + bboxArea(second) - intersection;

  return union > 0 ? intersection / union : 0;
}

function dedupeAndLimitConceptDetections(
  detections: SAM3ConceptDetection[],
  options: SAM3ConceptApplyOptions,
  limit = getBatchV2MaxTargetCandidates()
): SAM3ConceptDetection[] {
  const nmsThreshold =
    typeof options.nmsThreshold === 'number'
      ? options.nmsThreshold
      : SAM3_BATCH_V2_DEFAULT_NMS_THRESHOLD;
  const selected: SAM3ConceptDetection[] = [];
  const instancesMode = resolveBatchV2RefineMode() === 'instances';

  for (const detection of [...detections].sort(
    (left, right) =>
      conceptDetectionScore(right) - conceptDetectionScore(left) ||
      (instancesMode
        ? conceptCandidateKey(left).localeCompare(conceptCandidateKey(right))
        : 0)
  )) {
    if (selected.some((candidate) => bboxIou(candidate.bbox, detection.bbox) > nmsThreshold)) {
      continue;
    }

    selected.push(detection);
    if (selected.length >= limit) {
      break;
    }
  }

  return selected;
}

function bestConceptCandidateMatchForBbox(
  bbox: [number, number, number, number],
  candidates: SAM3ConceptDetection[]
): { candidate: SAM3ConceptDetection; iou: number } | null {
  let bestCandidate: SAM3ConceptDetection | null = null;
  let bestScore = -1;

  for (const candidate of candidates) {
    const score = bboxIou(bbox, candidate.bbox);
    if (score > bestScore) {
      bestCandidate = candidate;
      bestScore = score;
    }
  }

  return bestCandidate ? { candidate: bestCandidate, iou: bestScore } : null;
}

function conceptCandidateKey(candidate: SAM3ConceptDetection): string {
  return `${candidate.bbox.join(',')}:${conceptDetectionScore(candidate).toFixed(6)}`;
}

function combineBackendWarnings(...warnings: Array<string | undefined>): string | undefined {
  const unique = [...new Set(warnings.flatMap((warning) => warning ? [warning] : []))];
  return unique.length > 0 ? unique.join(' ') : undefined;
}

function bboxCentre(bbox: [number, number, number, number]): [number, number] {
  return [(bbox[0] + bbox[2]) / 2, (bbox[1] + bbox[3]) / 2];
}

function medianBoxDiameter(boxes: BoxCoordinate[]): number {
  return median(
    boxes.map((box) => Math.max(box.x2 - box.x1, box.y2 - box.y1))
  );
}

function medianCandidateDiameter(candidates: SAM3ConceptDetection[]): number {
  return median(
    candidates.map((candidate) =>
      Math.max(candidate.bbox[2] - candidate.bbox[0], candidate.bbox[3] - candidate.bbox[1])
    )
  );
}

function buildInstanceRefinementPrompts(
  assetId: string,
  candidates: SAM3ConceptDetection[],
  promptPoints?: Map<SAM3ConceptDetection, [number, number]>,
  exemplarDiameter?: number
): {
  prompts: SAM3RefineInstancePrompt[];
  candidateById: Map<string, SAM3ConceptDetection>;
} {
  const centres = candidates.map((candidate) =>
    promptPoints?.get(candidate) ?? bboxCentre(candidate.bbox)
  );
  const neighbourRadius = 2 * (
    exemplarDiameter && exemplarDiameter > 0
      ? exemplarDiameter
      : medianCandidateDiameter(candidates)
  );
  const candidateById = new Map<string, SAM3ConceptDetection>();
  const prompts = candidates.map((candidate, index) => {
    const baseId = `${assetId}:${conceptCandidateKey(candidate)}`;
    let id = baseId;
    let duplicateIndex = 1;
    while (candidateById.has(id)) {
      id = `${baseId}:${duplicateIndex}`;
      duplicateIndex += 1;
    }
    candidateById.set(id, candidate);
    const centre = centres[index];
    const negativePoints = centres
      .map((otherCentre, otherIndex) => ({
        centre: otherCentre,
        otherIndex,
        distance: Math.hypot(otherCentre[0] - centre[0], otherCentre[1] - centre[1]),
      }))
      .filter((entry) =>
        entry.otherIndex !== index && entry.distance <= neighbourRadius
      )
      .sort((left, right) =>
        left.distance - right.distance || left.otherIndex - right.otherIndex
      )
      .slice(0, 4)
      .map((entry) => entry.centre);

    return {
      id,
      box: candidate.bbox,
      positive_points: [centre],
      ...(negativePoints.length > 0 ? { negative_points: negativePoints } : {}),
    };
  });

  return { prompts, candidateById };
}

function scalePointToResized(
  point: [number, number],
  scaleFactor: number
): [number, number] {
  return [
    Math.round(point[0] * scaleFactor),
    Math.round(point[1] * scaleFactor),
  ];
}

function scaleInstanceRefinementPrompt(
  prompt: SAM3RefineInstancePrompt,
  scaleFactor: number
): SAM3RefineInstancePrompt {
  if (scaleFactor === 1) {
    return prompt;
  }

  const box = bboxToBoxCoordinate(prompt.box, scaleFactor);
  return {
    ...prompt,
    box: [box.x1, box.y1, box.x2, box.y2],
    positive_points: prompt.positive_points?.map((point) =>
      scalePointToResized(point, scaleFactor)
    ),
    negative_points: prompt.negative_points?.map((point) =>
      scalePointToResized(point, scaleFactor)
    ),
  };
}

function hasCompleteInstanceRefinementResponse(
  prompts: SAM3RefineInstancePrompt[],
  instances: Array<{ id: string }>
): boolean {
  const requestedIds = new Set(prompts.map((prompt) => prompt.id));
  const responseCounts = new Map<string, number>();

  for (const instance of instances) {
    if (requestedIds.has(instance.id)) {
      responseCounts.set(instance.id, (responseCounts.get(instance.id) ?? 0) + 1);
    }
  }

  return prompts.every((prompt) => responseCounts.get(prompt.id) === 1);
}

function chunkItems<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

function normalizeConceptExemplarRefs(
  exemplars: string | ConceptExemplarRef[] | null
): ConceptExemplarRef[] {
  if (!exemplars) {
    return [];
  }

  if (typeof exemplars === 'string') {
    return exemplars.trim() ? [{ exemplarId: exemplars }] : [];
  }

  return exemplars.filter((exemplar) => exemplar.exemplarId.trim().length > 0);
}

function mapConceptDetectionToAssetDetection(
  detection: SAM3ConceptDetection
): AssetInferenceResult['detections'][number] {
  const score = conceptDetectionScore(detection);
  return {
    bbox: detection.bbox,
    polygon: normalizePolygon(detection.polygon, detection.bbox),
    confidence: score,
    similarity: typeof detection.similarity === 'number' ? detection.similarity : score,
  };
}

function scaleBboxToOriginal(
  bbox: [number, number, number, number],
  scaleFactor: number
): [number, number, number, number] {
  if (scaleFactor === 1) {
    return bbox;
  }

  const inverseScale = 1 / scaleFactor;
  return [
    Math.round(bbox[0] * inverseScale),
    Math.round(bbox[1] * inverseScale),
    Math.round(bbox[2] * inverseScale),
    Math.round(bbox[3] * inverseScale),
  ];
}

function scalePolygonToOriginal(
  polygon: [number, number][] | undefined,
  bbox: [number, number, number, number],
  scaleFactor: number
): [number, number][] {
  if (!Array.isArray(polygon) || polygon.length < 3) {
    return normalizePolygon(undefined, bbox);
  }

  if (scaleFactor === 1) {
    return normalizePolygon(polygon, bbox);
  }

  const inverseScale = 1 / scaleFactor;
  return polygon.map((point) => [
    Math.round(point[0] * inverseScale),
    Math.round(point[1] * inverseScale),
  ] as [number, number]);
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

function percentile(sortedValues: number[], quantile: number): number | undefined {
  if (sortedValues.length === 0) return undefined;
  if (sortedValues.length === 1) return sortedValues[0];
  const position = Math.max(0, Math.min(1, quantile)) * (sortedValues.length - 1);
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sortedValues[lower];
  const weight = position - lower;
  return sortedValues[lower] * (1 - weight) + sortedValues[upper] * weight;
}

function recenterBbox(
  bbox: [number, number, number, number],
  centre: [number, number],
  imageWidth: number,
  imageHeight: number
): [number, number, number, number] {
  const width = Math.min(imageWidth, Math.max(1, Math.round(bbox[2] - bbox[0])));
  const height = Math.min(imageHeight, Math.max(1, Math.round(bbox[3] - bbox[1])));
  const x1 = Math.max(0, Math.min(imageWidth - width, Math.round(centre[0] - width / 2)));
  const y1 = Math.max(0, Math.min(imageHeight - height, Math.round(centre[1] - height / 2)));
  return [x1, y1, x1 + width, y1 + height];
}

function polygonArea(polygon: [number, number][]): number {
  let twiceArea = 0;
  for (let index = 0; index < polygon.length; index += 1) {
    const current = polygon[index];
    const next = polygon[(index + 1) % polygon.length];
    twiceArea += current[0] * next[1] - next[0] * current[1];
  }
  return Math.abs(twiceArea) / 2;
}

function polygonBounds(
  polygon: [number, number][]
): [number, number, number, number] {
  // Loop instead of Math.min(...points): spread arguments overflow the call
  // stack on very detailed polygons.
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of polygon) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  return [minX, minY, maxX, maxY];
}

function polygonOverlap(
  first: [number, number][],
  second: [number, number][]
): { iou: number; containment: number } {
  if (first.length < 3 || second.length < 3) return { iou: 0, containment: 0 };
  const firstBounds = polygonBounds(first);
  const secondBounds = polygonBounds(second);
  const left = Math.max(firstBounds[0], secondBounds[0]);
  const right = Math.min(firstBounds[2], secondBounds[2]);
  const top = Math.max(firstBounds[1], secondBounds[1]);
  const bottom = Math.min(firstBounds[3], secondBounds[3]);
  const width = right - left;
  const height = bottom - top;
  if (width <= 0 || height <= 0) return { iou: 0, containment: 0 };

  const scale = Math.min(1, 128 / Math.max(width, height));
  const sampleWidth = Math.max(1, Math.ceil(width * scale));
  const sampleHeight = Math.max(1, Math.ceil(height * scale));
  let intersectionSamples = 0;
  for (let y = 0; y < sampleHeight; y += 1) {
    const sampleY = top + ((y + 0.5) * height) / sampleHeight;
    for (let x = 0; x < sampleWidth; x += 1) {
      const sampleX = left + ((x + 0.5) * width) / sampleWidth;
      if (
        pointInPolygon(sampleX, sampleY, first) &&
        pointInPolygon(sampleX, sampleY, second)
      ) {
        intersectionSamples += 1;
      }
    }
  }

  const sampledIntersection =
    intersectionSamples * (width / sampleWidth) * (height / sampleHeight);
  const firstArea = polygonArea(first);
  const secondArea = polygonArea(second);
  const intersection = Math.min(sampledIntersection, firstArea, secondArea);
  const union = firstArea + secondArea - intersection;
  const smallerArea = Math.min(firstArea, secondArea);
  return {
    iou: union > 0 ? intersection / union : 0,
    containment: smallerArea > 0 ? intersection / smallerArea : 0,
  };
}

function dedupeDetectionsByPolygon(
  detections: Array<{
    detection: AssetInferenceResult['detections'][number];
    greenFraction: number;
    index: number;
  }>
): Array<{
  detection: AssetInferenceResult['detections'][number];
  greenFraction: number;
  index: number;
}> {
  const ranked = [...detections].sort((left, right) =>
    right.detection.confidence - left.detection.confidence || left.index - right.index
  );
  const bounds = new Map(
    ranked.map((entry) => [entry, polygonBounds(entry.detection.polygon)])
  );
  const selected: typeof detections = [];

  for (const candidate of ranked) {
    const candidateBounds = bounds.get(candidate)!;
    const duplicate = selected.some((existing) => {
      const existingBounds = bounds.get(existing)!;
      if (
        candidateBounds[2] <= existingBounds[0] ||
        existingBounds[2] <= candidateBounds[0] ||
        candidateBounds[3] <= existingBounds[1] ||
        existingBounds[3] <= candidateBounds[1]
      ) {
        return false;
      }
      const overlap = polygonOverlap(candidate.detection.polygon, existing.detection.polygon);
      return overlap.iou >= 0.5 || overlap.containment >= 0.7;
    });
    if (!duplicate) selected.push(candidate);
  }

  return selected;
}

export class Sam3BatchV2Service {
  private readonly prisma: PrismaLike;
  private readonly awsSam3Service: AwsSam3Like;
  private readonly acquireGpuLock: typeof acquireGpuLock;
  private readonly refreshGpuLock: typeof refreshGpuLock;
  private readonly releaseGpuLock: typeof releaseGpuLock;
  private readonly sleep: Sam3BatchV2Dependencies['sleep'];
  private readonly now: Sam3BatchV2Dependencies['now'];

  constructor(dependencies: Sam3BatchV2Dependencies) {
    this.prisma = dependencies.prisma;
    this.awsSam3Service = dependencies.awsSam3Service;
    this.acquireGpuLock = dependencies.acquireGpuLock;
    this.refreshGpuLock = dependencies.refreshGpuLock;
    this.releaseGpuLock = dependencies.releaseGpuLock;
    this.sleep = dependencies.sleep;
    this.now = dependencies.now;
  }

  private async calibrateExemplarGreenMedian(
    sourceImageBuffer: Buffer,
    exemplars: BoxCoordinate[],
    sourceWidth?: number,
    sourceHeight?: number
  ): Promise<number> {
    const metadata = await sharp(sourceImageBuffer).metadata();
    const imageWidth = metadata.width ?? 0;
    const imageHeight = metadata.height ?? 0;
    if (imageWidth <= 0 || imageHeight <= 0) return 0;

    if (
      (sourceWidth != null && sourceWidth !== imageWidth) ||
      (sourceHeight != null && sourceHeight !== imageHeight)
    ) {
      // Calibration measures true image pixels; concept creation currently
      // submits the raw exemplar boxes. When these dimensions differ the two
      // stages see different pixels — a pre-existing inconsistency worth
      // surfacing, not silently absorbing.
      console.warn(
        `[SAM3 V2] Exemplar source dimensions (${sourceWidth}x${sourceHeight}) ` +
          `differ from decoded source image (${imageWidth}x${imageHeight}); ` +
          'vegetation calibration uses decoded-image coordinates.'
      );
    }
    const scaled = scaleExemplarBoxes({
      exemplars,
      sourceWidth,
      sourceHeight,
      targetWidth: imageWidth,
      targetHeight: imageHeight,
      maxBoxes: SAM3_BATCH_V2_MAX_EXEMPLARS,
    });
    const fractions = await Promise.all(
      scaled.boxes.map((box) => greenFraction(sourceImageBuffer, box))
    );
    return median(fractions);
  }

  private async applyVegetationPriorToCandidates(
    imageBuffer: Buffer,
    candidates: SAM3ConceptDetection[],
    threshold: number
  ): Promise<VegetationCandidateResult> {
    const metadata = await sharp(imageBuffer).metadata();
    const imageWidth = metadata.width ?? 0;
    const imageHeight = metadata.height ?? 0;
    if (imageWidth <= 0 || imageHeight <= 0) {
      throw createNamedError(
        'InferenceFailureError',
        'Vegetation prior could not read target image dimensions.',
        'VEGETATION_IMAGE_INVALID'
      );
    }

    const surviving: SAM3ConceptDetection[] = [];
    const promptPoints = new Map<SAM3ConceptDetection, [number, number]>();
    let recenteredCount = 0;

    for (const candidate of candidates) {
      const fraction = await greenFraction(imageBuffer, candidate.bbox);
      if (fraction < threshold) continue;

      const centre = await greenestBlobCentre(imageBuffer, candidate.bbox);
      if (!centre) {
        surviving.push(candidate);
        promptPoints.set(candidate, bboxCentre(candidate.bbox));
        continue;
      }

      const bbox = recenterBbox(candidate.bbox, centre, imageWidth, imageHeight);
      const recenteredCandidate = {
        ...candidate,
        bbox,
        polygon: normalizePolygon(undefined, bbox),
      };
      surviving.push(recenteredCandidate);
      promptPoints.set(recenteredCandidate, centre);
      recenteredCount += 1;
    }

    return {
      candidates: surviving,
      imageWidth,
      imageHeight,
      threshold,
      gatedCount: candidates.length - surviving.length,
      recenteredCount,
      promptPoints,
    };
  }

  private async applyVegetationMaskHygiene(
    assetId: string,
    imageBuffer: Buffer,
    detections: AssetInferenceResult['detections'],
    imageWidth: number,
    imageHeight: number,
    threshold: number
  ): Promise<VegetationMaskResult> {
    const measured = await Promise.all(
      detections.map(async (detection, index) => ({
        detection,
        index,
        greenFraction: await greenFractionInPolygon(
          imageBuffer,
          detection.polygon,
          imageWidth,
          imageHeight
        ),
      }))
    );
    const gated = measured.filter((entry) => entry.greenFraction >= threshold);
    const deduplicated = dedupeDetectionsByPolygon(gated);
    const fractions = deduplicated
      .map((entry) => entry.greenFraction)
      .sort((left, right) => left - right);
    const p10 = percentile(fractions, 0.1);
    const finalMedian = percentile(fractions, 0.5);
    const p90 = percentile(fractions, 0.9);

    if (
      finalMedian != null &&
      finalMedian < SAM3_BATCH_V2_VEGETATION_ALARM_MEDIAN
    ) {
      console.warn(
        `[SAM3 V2] VEGETATION_ALARM asset=${assetId} ` +
          `median=${finalMedian.toFixed(3)} threshold=${threshold.toFixed(3)}`
      );
    }

    return {
      detections: deduplicated.map((entry) => entry.detection),
      gatedCount: measured.length - gated.length,
      deduplicatedCount: gated.length - deduplicated.length,
      p10,
      median: finalMedian,
      p90,
    };
  }

  async processJob(job: Sam3BatchV2JobLike): Promise<Sam3BatchV2JobResult> {
    const attemptsMade = job.attemptsMade ?? 0;
    const batchJobId = job.data.batchJobId;
    const batchJobRecord = await this.prisma.batchJob.findUnique({
      where: { id: batchJobId },
      select: {
        kind: true,
        parentBatchJobId: true,
        stageLog: true,
      },
    });
    const stageLog = parseStageLog(batchJobRecord?.stageLog);
    const batchJobKind = (batchJobRecord?.kind || SAM3_BATCH_JOB_KINDS.SINGLE) as Sam3BatchJobKind;
    const parentBatchJobId = batchJobRecord?.parentBatchJobId || null;

    if (batchJobKind === SAM3_BATCH_JOB_KINDS.AGGREGATE) {
      await this.prisma.batchJob.update({
        where: { id: batchJobId },
        data: {
          status: 'FAILED',
          completedAt: this.now(),
          errorMessage: 'Aggregate batch jobs are coordination records and cannot be processed directly.',
        },
      });

      return {
        processedImages: 0,
        detectionsFound: 0,
        failedAssets: 0,
        terminalState: 'failed_prepare',
      };
    }

    await this.prisma.batchJob.update({
      where: { id: batchJobId },
      data: {
        status: 'PROCESSING',
        startedAt: this.now(),
        completedAt: null,
        processedImages: 0,
        detectionsFound: 0,
        errorMessage: null,
      },
    });
    if (parentBatchJobId) {
      await this.rollupParentBatchJob(parentBatchJobId);
    }

    let gpuLockToken: string | null = null;
    let gpuHeartbeat: ReturnType<typeof setInterval> | null = null;

    try {
      const prepared = await this.prepareBatch(job.data, attemptsMade, stageLog);
      const estimate = await this.estimateBatch(prepared, attemptsMade, stageLog);
      const admission = await this.admitBatch(prepared, estimate, attemptsMade, stageLog);

      if (!admission.acquired || !admission.token) {
        return this.rejectPreflight(
          batchJobId,
          parentBatchJobId,
          attemptsMade,
          stageLog,
          admission.errorCode || 'GPU_BUSY',
          admission.errorMessage || 'GPU busy (held by another process), retry later.'
        );
      }

      gpuLockToken = admission.token;
      gpuHeartbeat = setInterval(() => {
        void this.refreshGpuLock(gpuLockToken, SAM3_BATCH_V2_GPU_LOCK_TTL_MS);
      }, SAM3_BATCH_V2_GPU_LOCK_HEARTBEAT_MS);

      const assetResults = await this.runAndPersistBatch(job, prepared, attemptsMade, stageLog);
      const terminal = determineTerminalState(assetResults);
      const failedAssets = assetResults.filter(
        (result) => result.outcome === 'oom' || result.outcome === 'inference_error' || result.outcome === 'prepare_error'
      ).length;

      await this.appendStageLog(batchJobId, stageLog, {
        stage: 'terminal',
        status: terminal.topLevelStatus === 'COMPLETED' ? 'completed' : 'failed',
        attempt: attemptsMade,
        terminalState: terminal.terminalState,
        processedImages: assetResults.length,
        failedAssets,
      });

      await this.prisma.batchJob.update({
        where: { id: batchJobId },
        data: {
          status: terminal.topLevelStatus,
          completedAt: this.now(),
          errorMessage: terminal.errorMessage,
        },
      });
      if (parentBatchJobId) {
        await this.rollupParentBatchJob(parentBatchJobId);
      }

      return {
        processedImages: assetResults.length,
        detectionsFound: assetResults.reduce((sum, result) => sum + result.detections.length, 0),
        failedAssets,
        terminalState: terminal.terminalState,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unhandled v2 batch failure';
      const errorName = error instanceof Error ? error.name : 'InferenceFailureError';
      const code =
        errorName === 'PersistFailureError'
          ? 'PERSIST_FAILED'
          : errorName === 'PrepareFailureError'
            ? 'FAILED_PREPARE'
            : 'FAILED_INFERENCE';
      const terminalState =
        code === 'PERSIST_FAILED'
          ? 'failed_persist'
          : code === 'FAILED_PREPARE'
            ? 'failed_prepare'
            : 'failed_inference';

      await this.appendStageLog(batchJobId, stageLog, {
        stage: 'terminal',
        status: 'failed',
        attempt: attemptsMade,
        terminalState,
        errorCode: code,
        errorMessage: message,
      });

      await this.prisma.batchJob.update({
        where: { id: batchJobId },
        data: {
          status: 'FAILED',
          completedAt: this.now(),
          errorMessage: message,
        },
      });
      if (parentBatchJobId) {
        await this.rollupParentBatchJob(parentBatchJobId);
      }

      return {
        processedImages: 0,
        detectionsFound: 0,
        failedAssets: 0,
        terminalState,
      };
    } finally {
      if (gpuHeartbeat) {
        clearInterval(gpuHeartbeat);
      }
      if (gpuLockToken) {
        await this.releaseGpuLock(gpuLockToken);
      }
    }
  }

  private async appendStageLog(
    batchJobId: string,
    stageLog: Sam3BatchV2StageLogEntry[],
    entry: Omit<Sam3BatchV2StageLogEntry, 'timestamp'>
  ) {
    stageLog.push(createStageLogEntry(entry, this.now()));
    await this.prisma.batchJob.update({
      where: { id: batchJobId },
      data: {
        stageLog: toBatchStageLogJson(stageLog),
      },
    });
  }

  private async prepareBatch(
    data: Sam3BatchV2JobData,
    attemptsMade: number,
    stageLog: Sam3BatchV2StageLogEntry[]
  ): Promise<PreparedBatchContext> {
    const startedAt = this.now().getTime();
    await this.appendStageLog(data.batchJobId, stageLog, {
      stage: 'prepare',
      status: 'started',
      attempt: attemptsMade,
      mode: data.mode,
      totalAssets: data.assetIds.length,
    });

    const batchJob = await this.prisma.batchJob.findUnique({
      where: { id: data.batchJobId },
      select: {
        parentBatchJobId: true,
        sourceAssetId: true,
      },
    });

    const assets = await this.prisma.asset.findMany({
      where: {
        id: { in: data.assetIds },
        projectId: data.projectId,
      },
      select: {
        id: true,
        storageUrl: true,
        s3Key: true,
        s3Bucket: true,
        storageType: true,
        imageWidth: true,
        imageHeight: true,
      },
    });

    const orderedAssets = data.assetIds
      .map((assetId) => assets.find((asset) => asset.id === assetId))
      .filter((asset): asset is AssetRecord => Boolean(asset));
    const missingAssetIds = data.assetIds.filter((assetId) => !assets.some((asset) => asset.id === assetId));

    const sourceAssetId =
      data.sourceAssetId ||
      batchJob?.sourceAssetId ||
      orderedAssets[0]?.id;

    if (!sourceAssetId) {
      await this.appendStageLog(data.batchJobId, stageLog, {
        stage: 'prepare',
        status: 'failed',
        attempt: attemptsMade,
        errorCode: 'SOURCE_ASSET_MISSING',
        errorMessage: 'Source asset is required for v2 batch processing.',
      });
      throw createNamedError('PrepareFailureError', 'Source asset is required for v2 batch processing.');
    }

    const sourceAsset =
      orderedAssets.find((asset) => asset.id === sourceAssetId) ||
      (await this.prisma.asset.findUnique({
        where: { id: sourceAssetId },
        select: {
          id: true,
          storageUrl: true,
          s3Key: true,
          s3Bucket: true,
          storageType: true,
          imageWidth: true,
          imageHeight: true,
        },
      }));

    if (!sourceAsset) {
      await this.appendStageLog(data.batchJobId, stageLog, {
        stage: 'prepare',
        status: 'failed',
        attempt: attemptsMade,
        assetId: sourceAssetId,
        assetOutcome: 'prepare_error',
        errorCode: 'SOURCE_ASSET_NOT_FOUND',
        errorMessage: 'Source asset could not be loaded for v2 batch processing.',
      });
      throw createNamedError(
        'PrepareFailureError',
        'Source asset could not be loaded for v2 batch processing.'
      );
    }

    let sourceImageBuffer: Buffer;
    try {
      sourceImageBuffer = await fetchAssetImage(sourceAsset);
    } catch (error) {
      await this.appendStageLog(data.batchJobId, stageLog, {
        stage: 'prepare',
        status: 'failed',
        attempt: attemptsMade,
        assetId: sourceAsset.id,
        assetOutcome: 'prepare_error',
        errorCode: 'SOURCE_IMAGE_FETCH_FAILED',
        errorMessage: error instanceof Error ? error.message : 'Failed to fetch source asset image.',
      });
      throw createNamedError(
        'PrepareFailureError',
        error instanceof Error ? error.message : 'Failed to fetch source asset image.'
      );
    }
    const vegetationPrior = resolveBatchV2VegetationPrior(data.vegetationPrior);
    const exemplarGreenMedian = vegetationPrior
      ? await this.calibrateExemplarGreenMedian(
          sourceImageBuffer,
          data.exemplars,
          data.exemplarSourceWidth,
          data.exemplarSourceHeight
        )
      : 0;
    const vegetationGate = vegetationPrior
      ? resolveBatchV2VegetationGate(exemplarGreenMedian)
      : undefined;
    if (vegetationGate?.mode === 'disabled_low_exemplar_green') {
      console.info(
        `vegetation gate disabled: exemplar median green=${exemplarGreenMedian} ` +
          `< ${SAM3_VEGETATION_DISABLE_BELOW}`
      );
    }
    const normalizedCrops = normalizeExemplarCrops(data.exemplarCrops);
    let exemplarCrops = normalizedCrops;
    let visualCropSource: Sam3BatchV2StageLogEntry['visualCropSource'] | undefined =
      data.mode === 'visual_crop_match' && normalizedCrops.length > 0 ? 'operator_crops' : undefined;
    const boxCount = data.exemplars.length;

    if (boxCount <= 0) {
      const errorMessage = 'At least one exemplar is required for v2 batch processing.';
      await this.appendStageLog(data.batchJobId, stageLog, {
        stage: 'prepare',
        status: 'failed',
        attempt: attemptsMade,
        errorCode: 'NO_EXEMPLARS',
        errorMessage,
      });
      throw createNamedError(
        'PrepareFailureError',
        errorMessage
      );
    }

    if (data.mode === 'visual_crop_match' && exemplarCrops.length === 0) {
      exemplarCrops = await buildExemplarCrops({
        imageBuffer: sourceImageBuffer,
        boxes: data.exemplars.slice(0, SAM3_BATCH_V2_MAX_EXEMPLARS),
      });
      visualCropSource = exemplarCrops.length > 0 ? 'server_built_crops' : undefined;
    }

    if (data.mode === 'visual_crop_match' && exemplarCrops.length === 0) {
      const errorMessage = 'Visual crop matching requires at least one valid exemplar crop.';
      await this.appendStageLog(data.batchJobId, stageLog, {
        stage: 'prepare',
        status: 'failed',
        attempt: attemptsMade,
        errorCode: 'NO_EXEMPLAR_CROPS',
        errorMessage,
      });
      throw createNamedError(
        'PrepareFailureError',
        errorMessage
      );
    }

    const cropCount = data.mode === 'visual_crop_match' ? exemplarCrops.length : boxCount;

    await this.appendStageLog(data.batchJobId, stageLog, {
      stage: 'prepare',
      status: 'completed',
      attempt: attemptsMade,
      totalAssets: data.assetIds.length,
      cropCount,
      operatorCropCount: data.mode === 'visual_crop_match' ? normalizedCrops.length : 0,
      modeUsed: data.mode === 'visual_crop_match' ? 'visual_crops' : 'concept_propagation',
      visualCropSource,
      ...(vegetationPrior
        ? {
            vegetationPrior,
            exemplarGreenMedian,
            vegetationMode: vegetationGate?.mode,
            vegetationThreshold: vegetationGate?.threshold,
          }
        : {}),
      durationMs: this.now().getTime() - startedAt,
    });

    return {
      batchJobId: data.batchJobId,
      parentBatchJobId: batchJob?.parentBatchJobId || null,
      projectId: data.projectId,
      weedType: data.weedType,
      mode: data.mode,
      textPrompt: data.textPrompt?.trim().substring(0, 100) || data.weedType,
      sourceAssetId,
      sourceImageBuffer,
      exemplars: data.exemplars,
      exemplarSourceWidth: data.exemplarSourceWidth,
      exemplarSourceHeight: data.exemplarSourceHeight,
      exemplarCrops,
      visualCropSource,
      assets: orderedAssets,
      missingAssetIds,
      cropCount,
      operatorCropCount: data.mode === 'visual_crop_match' ? normalizedCrops.length : 0,
      vegetationPrior,
      exemplarGreenMedian,
      vegetationMode: vegetationGate?.mode,
      vegetationThreshold: vegetationGate?.threshold ?? null,
      exemplarDiameter: medianBoxDiameter(data.exemplars),
    };
  }

  private async estimateBatch(
    prepared: PreparedBatchContext,
    attemptsMade: number,
    stageLog: Sam3BatchV2StageLogEntry[]
  ) {
    const startedAt = this.now().getTime();
    await this.appendStageLog(prepared.batchJobId, stageLog, {
      stage: 'estimate',
      status: 'started',
      attempt: attemptsMade,
      cropCount: prepared.cropCount,
    });

    const admissionCropCount = getGpuAdmissionCropCount(prepared.mode, prepared.cropCount);
    const estimate = estimatePeakGpuMemoryMb(admissionCropCount);

    await this.appendStageLog(prepared.batchJobId, stageLog, {
      stage: 'estimate',
      status: 'completed',
      attempt: attemptsMade,
      cropCount: prepared.cropCount,
      admissionCropCount,
      estimatedMemoryMb: estimate.estimatedMemoryMb,
      thresholdMemoryMb: estimate.thresholdMemoryMb,
      durationMs: this.now().getTime() - startedAt,
    });

    return estimate;
  }

  private async admitBatch(
    prepared: PreparedBatchContext,
    estimate: ReturnType<typeof estimatePeakGpuMemoryMb>,
    attemptsMade: number,
    stageLog: Sam3BatchV2StageLogEntry[]
  ): Promise<GpuAdmissionResult> {
    const startedAt = this.now().getTime();
    await this.appendStageLog(prepared.batchJobId, stageLog, {
      stage: 'admit',
      status: 'started',
      attempt: attemptsMade,
      cropCount: prepared.cropCount,
      admissionCropCount: getGpuAdmissionCropCount(prepared.mode, prepared.cropCount),
      estimatedMemoryMb: estimate.estimatedMemoryMb,
      thresholdMemoryMb: estimate.thresholdMemoryMb,
    });

    if (estimate.overBudget) {
      await this.appendStageLog(prepared.batchJobId, stageLog, {
        stage: 'admit',
        status: 'failed',
        attempt: attemptsMade,
        errorCode: 'OVER_BUDGET',
        errorMessage: `Rejected at preflight: estimated ${estimate.estimatedMemoryMb}MB exceeds ${estimate.thresholdMemoryMb}MB threshold.`,
        admissionCropCount: getGpuAdmissionCropCount(prepared.mode, prepared.cropCount),
        estimatedMemoryMb: estimate.estimatedMemoryMb,
        thresholdMemoryMb: estimate.thresholdMemoryMb,
      });

      return {
        acquired: false,
        token: null,
        errorCode: 'OVER_BUDGET',
        errorMessage: `Rejected at preflight: estimated ${estimate.estimatedMemoryMb}MB exceeds ${estimate.thresholdMemoryMb}MB threshold.`,
      };
    }

    if (!this.awsSam3Service.isConfigured()) {
      await this.appendStageLog(prepared.batchJobId, stageLog, {
        stage: 'admit',
        status: 'failed',
        attempt: attemptsMade,
        errorCode: 'SAM3_UNAVAILABLE',
        errorMessage: 'SAM3 service is not configured for v2 batch processing.',
      });
      return {
        acquired: false,
        token: null,
        errorCode: 'SAM3_UNAVAILABLE',
        errorMessage: 'SAM3 service is not configured for v2 batch processing.',
      };
    }

    const lock = await this.acquireGpuLockWithRetry();
    if (!lock.acquired || !lock.token) {
      await this.appendStageLog(prepared.batchJobId, stageLog, {
        stage: 'admit',
        status: 'failed',
        attempt: attemptsMade,
        errorCode: lock.errorCode,
        errorMessage: lock.errorMessage,
      });
      return lock;
    }

    try {
      const status = await this.awsSam3Service.refreshStatus();
      if (!this.awsSam3Service.isReady()) {
        const started = await this.awsSam3Service.startInstance();
        if (!started) {
          await this.appendStageLog(prepared.batchJobId, stageLog, {
            stage: 'admit',
            status: 'failed',
            attempt: attemptsMade,
            errorCode: 'SAM3_UNAVAILABLE',
            errorMessage: 'SAM3 service is unavailable, retry later.',
          });
          await this.releaseGpuLock(lock.token);
          return {
            acquired: false,
            token: null,
            errorCode: 'SAM3_UNAVAILABLE',
            errorMessage: 'SAM3 service is unavailable, retry later.',
          };
        }
      } else if (!status.ipAddress) {
        await this.appendStageLog(prepared.batchJobId, stageLog, {
          stage: 'admit',
          status: 'failed',
          attempt: attemptsMade,
          errorCode: 'SAM3_UNAVAILABLE',
          errorMessage: 'SAM3 service is unavailable, retry later.',
        });
        await this.releaseGpuLock(lock.token);
        return {
          acquired: false,
          token: null,
          errorCode: 'SAM3_UNAVAILABLE',
          errorMessage: 'SAM3 service is unavailable, retry later.',
        };
      }
    } catch (error) {
      await this.appendStageLog(prepared.batchJobId, stageLog, {
        stage: 'admit',
        status: 'failed',
        attempt: attemptsMade,
        errorCode: 'SAM3_UNAVAILABLE',
        errorMessage: error instanceof Error ? error.message : 'SAM3 service is unavailable, retry later.',
      });
      await this.releaseGpuLock(lock.token);
      return {
        acquired: false,
        token: null,
        errorCode: 'SAM3_UNAVAILABLE',
        errorMessage: error instanceof Error ? error.message : 'SAM3 service is unavailable, retry later.',
      };
    }

    await this.appendStageLog(prepared.batchJobId, stageLog, {
      stage: 'admit',
      status: 'completed',
      attempt: attemptsMade,
      durationMs: this.now().getTime() - startedAt,
      estimatedMemoryMb: estimate.estimatedMemoryMb,
      thresholdMemoryMb: estimate.thresholdMemoryMb,
    });

    return lock;
  }

  private async acquireGpuLockWithRetry(): Promise<GpuAdmissionResult> {
    const startedAt = this.now().getTime();

    while (this.now().getTime() - startedAt < SAM3_BATCH_V2_GPU_LOCK_RETRY_TIMEOUT_MS) {
      const lock = await this.acquireGpuLock('sam3-batch-v2', SAM3_BATCH_V2_GPU_LOCK_TTL_MS);
      if (lock.acquired) {
        return {
          acquired: true,
          token: lock.token,
        };
      }

      await this.sleep(SAM3_BATCH_V2_GPU_LOCK_RETRY_INTERVAL_MS);
    }

    return {
      acquired: false,
      token: null,
      errorCode: 'GPU_BUSY',
      errorMessage: 'GPU busy (held by another process), retry later.',
    };
  }

  private async rejectPreflight(
    batchJobId: string,
    parentBatchJobId: string | null,
    attemptsMade: number,
    stageLog: Sam3BatchV2StageLogEntry[],
    errorCode: string,
    errorMessage: string
  ): Promise<Sam3BatchV2JobResult> {
    await this.appendStageLog(batchJobId, stageLog, {
      stage: 'terminal',
      status: 'failed',
      attempt: attemptsMade,
      terminalState: 'rejected_preflight',
      errorCode,
      errorMessage,
    });

    await this.prisma.batchJob.update({
      where: { id: batchJobId },
      data: {
        status: 'FAILED',
        completedAt: this.now(),
        errorMessage,
      },
    });
    if (parentBatchJobId) {
      await this.rollupParentBatchJob(parentBatchJobId);
    }

    return {
      processedImages: 0,
      detectionsFound: 0,
      failedAssets: 0,
      terminalState: 'rejected_preflight',
    };
  }

  private async runAndPersistBatch(
    job: Sam3BatchV2JobLike,
    prepared: PreparedBatchContext,
    attemptsMade: number,
    stageLog: Sam3BatchV2StageLogEntry[]
  ): Promise<AssetInferenceResult[]> {
    const results: AssetInferenceResult[] = [];
    const batchJobId = prepared.batchJobId;
    const reviewProfile = resolveBatchV2ReviewProfileForMode(prepared.mode);

    await this.appendStageLog(batchJobId, stageLog, {
      stage: 'run_sam3',
      status: 'started',
      attempt: attemptsMade,
      totalAssets: prepared.assets.length + prepared.missingAssetIds.length,
      reviewProfile,
    });
    await this.appendStageLog(batchJobId, stageLog, {
      stage: 'persist',
      status: 'started',
      attempt: attemptsMade,
      totalAssets: prepared.assets.length + prepared.missingAssetIds.length,
    });

    let conceptExemplars: ConceptExemplarRef[] = [];
    if (prepared.mode === 'concept_propagation') {
      const warmup = await this.awsSam3Service.warmupConceptService();
      if (!warmup.success) {
        throw createNamedError(
          'InferenceFailureError',
          warmup.error || 'Failed to warm up concept propagation service.'
        );
      }

      conceptExemplars = await this.createConceptExemplarEnsemble(prepared);
      await this.prisma.batchJob.update({
        where: { id: batchJobId },
        data: {
          exemplarId: conceptExemplars[0]?.exemplarId || null,
          sourceAssetId: prepared.sourceAssetId,
        },
      });
    }

    const assetsToProcess = [...prepared.assets].sort((left, right) => {
      if (left.id === prepared.sourceAssetId) return -1;
      if (right.id === prepared.sourceAssetId) return 1;
      return 0;
    });
    for (const missingAssetId of prepared.missingAssetIds) {
      const result: AssetInferenceResult = {
        assetId: missingAssetId,
        detections: [],
        outcome: 'prepare_error',
        errorCode: 'ASSET_NOT_FOUND',
        errorMessage: 'Asset no longer exists for this batch job.',
      };
      results.push(result);
      await this.appendStageLog(batchJobId, stageLog, {
        stage: 'prepare',
        status: 'failed',
        attempt: attemptsMade,
        assetId: missingAssetId,
        assetOutcome: result.outcome,
        errorCode: result.errorCode,
        errorMessage: result.errorMessage,
      });
      await this.persistAssetResult(
        batchJobId,
        prepared.parentBatchJobId,
        result,
        prepared.weedType,
        attemptsMade
      );
      await job.updateProgress(
        Math.round((results.length / (prepared.assets.length + prepared.missingAssetIds.length)) * 100)
      );
    }

    for (const asset of assetsToProcess) {
      const runStartedAt = this.now().getTime();
      let result: AssetInferenceResult;

      try {
        const imageBuffer = await fetchAssetImage(asset);
        if (prepared.mode === 'visual_crop_match') {
          result = await this.runVisualCropMatch(asset, imageBuffer, prepared);
        } else {
          result = await this.runConceptPropagation(
            asset,
            imageBuffer,
            conceptExemplars,
            prepared.weedType,
            {
              enabled:
                prepared.vegetationPrior && prepared.vegetationMode === 'active',
              exemplarGreenMedian: prepared.exemplarGreenMedian,
              exemplarDiameter: prepared.exemplarDiameter,
              mode: prepared.vegetationMode,
              threshold: prepared.vegetationThreshold,
            }
          );
        }

        await this.appendStageLog(batchJobId, stageLog, {
          stage: 'run_sam3',
          status: result.outcome === 'success' || result.outcome === 'zero_detections' ? 'completed' : 'failed',
          attempt: attemptsMade,
          assetId: asset.id,
          assetOutcome: result.outcome,
          errorCode: result.errorCode,
          errorMessage: result.errorMessage,
          detectionCount: result.detections.length,
          modeUsed:
            prepared.mode === 'visual_crop_match'
              ? 'visual_crops'
              : 'concept_propagation',
          reviewProfile,
          cropCount: prepared.mode === 'visual_crop_match' ? prepared.exemplarCrops.length : undefined,
          operatorCropCount: prepared.mode === 'visual_crop_match' ? prepared.operatorCropCount : undefined,
          visualCropSource: prepared.mode === 'visual_crop_match' ? prepared.visualCropSource : undefined,
          backendMode: result.backendMode,
          backendWarning: result.backendWarning,
          candidateExpansionUsed: result.candidateExpansionUsed,
          candidateCount: result.candidateCount,
          conceptExemplarCount:
            prepared.mode === 'concept_propagation' ? conceptExemplars.length : undefined,
          refinementBoxCount: result.refinementBoxCount,
          refinementDetectionCount: result.refinementDetectionCount,
          refinementMode: result.refinementMode,
          candidateBudget: result.candidateBudget,
          refineSentInstances: result.refineSentInstances,
          refineRefinedInstances: result.refineRefinedInstances,
          refineRejectedInstances: result.refineRejectedInstances,
          refineIncompleteChunks: result.refineIncompleteChunks,
          vegetationMode: result.vegetationMode,
          vegetationThreshold: result.vegetationThreshold,
          vegetationGatedCandidates: result.vegetationGatedCandidates,
          vegetationRecenteredCandidates: result.vegetationRecenteredCandidates,
          vegetationGatedMasks: result.vegetationGatedMasks,
          vegetationDeduplicatedMasks: result.vegetationDeduplicatedMasks,
          maskGreenFractionP10: result.maskGreenFractionP10,
          maskGreenFractionMedian: result.maskGreenFractionMedian,
          maskGreenFractionP90: result.maskGreenFractionP90,
          durationMs: this.now().getTime() - runStartedAt,
        });
      } catch (error) {
        const isInferenceFailure = error instanceof Error && error.name === 'InferenceFailureError';
        const errorCode = getErrorCode(
          error,
          isInferenceFailure ? 'SAM3_INFERENCE_FAILED' : 'ASSET_FETCH_FAILED'
        );
        result = {
          assetId: asset.id,
          detections: [],
          outcome: isInferenceFailure
            ? classifyInferenceFailure(errorCode, error instanceof Error ? error.message : undefined)
            : 'prepare_error',
          errorCode,
          errorMessage: error instanceof Error ? error.message : 'Failed to fetch asset image.',
        };

        await this.appendStageLog(batchJobId, stageLog, {
          stage: isInferenceFailure ? 'run_sam3' : 'prepare',
          status: 'failed',
          attempt: attemptsMade,
          assetId: asset.id,
          assetOutcome: result.outcome,
          errorCode: result.errorCode,
          errorMessage: result.errorMessage,
        });
      }

      results.push(result);
      await this.persistAssetResult(
        batchJobId,
        prepared.parentBatchJobId,
        result,
        prepared.weedType,
        attemptsMade
      );
      await job.updateProgress(
        Math.round((results.length / (prepared.assets.length + prepared.missingAssetIds.length)) * 100)
      );
    }

    await this.appendStageLog(batchJobId, stageLog, {
      stage: 'run_sam3',
      status: 'completed',
      attempt: attemptsMade,
      totalAssets: results.length,
      failedAssets: results.filter(
        (result) =>
          result.outcome === 'oom' || result.outcome === 'inference_error' || result.outcome === 'prepare_error'
      ).length,
    });
    await this.appendStageLog(batchJobId, stageLog, {
      stage: 'persist',
      status: 'completed',
      attempt: attemptsMade,
      totalAssets: results.length,
      failedAssets: results.filter(
        (result) =>
          result.outcome === 'oom' || result.outcome === 'inference_error' || result.outcome === 'prepare_error'
      ).length,
    });

    return results;
  }

  private async runBoxPromptMatch(
    asset: AssetRecord,
    imageBuffer: Buffer,
    prepared: PreparedBatchContext
  ): Promise<AssetInferenceResult> {
    const scaledBoxes = scaleExemplarBoxes({
      exemplars: prepared.exemplars,
      sourceWidth: prepared.exemplarSourceWidth,
      sourceHeight: prepared.exemplarSourceHeight,
      targetWidth: asset.imageWidth || prepared.exemplarSourceWidth || 0,
      targetHeight: asset.imageHeight || prepared.exemplarSourceHeight || 0,
      jobId: prepared.batchJobId,
      assetId: asset.id,
    });

    if (scaledBoxes.boxes.length === 0) {
      return {
        assetId: asset.id,
        detections: [],
        outcome: 'prepare_error',
        errorCode: 'INVALID_EXEMPLAR_BOXES',
        errorMessage: 'Exemplar boxes could not be scaled for this asset.',
      };
    }

    const resized = await this.awsSam3Service.resizeImage(imageBuffer);
    const result = await this.awsSam3Service.segment({
      image: resized.buffer.toString('base64'),
      boxes: scaledBoxes.boxes.map((box) => ({
        x1: Math.round(box.x1 * resized.scaling.scaleFactor),
        y1: Math.round(box.y1 * resized.scaling.scaleFactor),
        x2: Math.round(box.x2 * resized.scaling.scaleFactor),
        y2: Math.round(box.y2 * resized.scaling.scaleFactor),
      })),
      className: prepared.textPrompt,
    });

    if (!result.success || !result.response) {
      return {
        assetId: asset.id,
        detections: [],
        outcome: classifyInferenceFailure(result.errorCode, result.error),
        errorCode: result.errorCode || 'SAM3_BOX_PROMPT_MATCH_FAILED',
        errorMessage: result.error || 'SAM3 box-prompt matching failed.',
      };
    }

    const detections = result.response.detections.map((detection) => {
      const bbox = scaleBboxToOriginal(detection.bbox, resized.scaling.scaleFactor);
      return {
        bbox,
        polygon: scalePolygonToOriginal(detection.polygon, bbox, resized.scaling.scaleFactor),
        confidence: detection.confidence,
      };
    });

    return {
      assetId: asset.id,
      detections,
      outcome: detections.length > 0 ? 'success' : 'zero_detections',
    };
  }

  private async runVisualCropMatch(
    asset: AssetRecord,
    imageBuffer: Buffer,
    prepared: PreparedBatchContext,
    exemplarCrops: string[] = prepared.exemplarCrops
  ): Promise<AssetInferenceResult> {
    const resized = await this.awsSam3Service.resizeImage(imageBuffer);
    const result = await this.awsSam3Service.segmentWithExemplars({
      image: resized.buffer.toString('base64'),
      exemplarCrops,
      className: prepared.textPrompt,
    });

    if (!result.success || !result.response) {
      return {
        assetId: asset.id,
        detections: [],
        outcome: classifyInferenceFailure(result.errorCode, result.error),
        errorCode: result.errorCode || 'SAM3_INFERENCE_FAILED',
        errorMessage: result.error || 'SAM3 visual crop matching failed.',
      };
    }

    const detections = result.response.detections.map((detection) => {
      const bbox = scaleBboxToOriginal(detection.bbox, resized.scaling.scaleFactor);
      return {
        bbox,
        polygon: scalePolygonToOriginal(detection.polygon, bbox, resized.scaling.scaleFactor),
        confidence: detection.confidence,
      };
    });

    return {
      assetId: asset.id,
      detections,
      outcome: detections.length > 0 ? 'success' : 'zero_detections',
      backendMode: result.response.mode,
      backendWarning: result.response.warning,
    };
  }

  private async runVisualConceptMatch(
    asset: AssetRecord,
    imageBuffer: Buffer,
    exemplarId: string,
    className: string,
    vegetation?: VegetationPriorContext
  ): Promise<AssetInferenceResult> {
    const reviewProfile: Sam3BatchV2ReviewProfile = 'balanced';
    const conceptOptions = buildBatchV2ConceptApplyOptions(reviewProfile);
    const result = await this.awsSam3Service.applyConceptExemplar({
      exemplarId,
      imageBuffer,
      imageId: asset.id,
      options: conceptOptions,
    });

    if (!result.success || !result.data) {
      return {
        assetId: asset.id,
        detections: [],
        outcome: classifyInferenceFailure(result.errorCode, result.error),
        errorCode: result.errorCode || 'VISUAL_MATCH_EXEMPLAR_FAILED',
        errorMessage: result.error || 'Visual example matching failed.',
      };
    }

    const candidateResult = await this.getConceptCandidatesWithFallback({
      asset,
      imageBuffer,
      exemplarId,
      primaryDetections: result.data.detections,
      primaryOptions: conceptOptions,
      primaryBackendWarning: result.data.backendWarning,
      reviewProfile,
      failureCode: 'VISUAL_MATCH_EXEMPLAR_FALLBACK_FAILED',
    });
    const refinement = await this.refineConceptDetectionsWithBoxPrompts(
      asset,
      imageBuffer,
      className,
      candidateResult.detections,
      vegetation,
      getBatchV2MaxTargetCandidates(reviewProfile)
    );

    return {
      assetId: asset.id,
      detections: refinement.detections,
      outcome: refinement.detections.length > 0 ? 'success' : 'zero_detections',
      backendMode: refinement.usedCandidateFallback ? 'concept_candidates_unrefined' : 'concept_refined',
      backendWarning: combineBackendWarnings(
        candidateResult.backendWarning,
        refinement.backendWarning
      ),
      candidateExpansionUsed: candidateResult.candidateExpansionUsed,
      candidateCount: refinement.candidateCount,
      refinementBoxCount: refinement.refinementBoxCount,
      refinementDetectionCount: refinement.refinementDetectionCount,
      refinementMode: refinement.refinementMode,
      candidateBudget: refinement.candidateBudget,
      refineSentInstances: refinement.refineSentInstances,
      refineRefinedInstances: refinement.refineRefinedInstances,
      refineRejectedInstances: refinement.refineRejectedInstances,
      refineIncompleteChunks: refinement.refineIncompleteChunks,
      vegetationMode: refinement.vegetationMode,
      vegetationThreshold: refinement.vegetationThreshold,
      vegetationGatedCandidates: refinement.vegetationGatedCandidates,
      vegetationRecenteredCandidates: refinement.vegetationRecenteredCandidates,
      vegetationGatedMasks: refinement.vegetationGatedMasks,
      vegetationDeduplicatedMasks: refinement.vegetationDeduplicatedMasks,
      maskGreenFractionP10: refinement.maskGreenFractionP10,
      maskGreenFractionMedian: refinement.maskGreenFractionMedian,
      maskGreenFractionP90: refinement.maskGreenFractionP90,
    };
  }

  private async createConceptExemplarEnsemble(
    prepared: PreparedBatchContext
  ): Promise<ConceptExemplarRef[]> {
    const exemplars: ConceptExemplarRef[] = [];

    for (let index = 0; index < prepared.exemplars.length; index += 1) {
      const sourceBox = prepared.exemplars[index];
      const embeddingBackend = resolveBatchV2RetrievalBackend();
      const exemplarResult = await this.awsSam3Service.createConceptExemplar({
        imageBuffer: prepared.sourceImageBuffer,
        boxes: [sourceBox],
        className: prepared.weedType,
        imageId: `${prepared.sourceAssetId}-box-${index + 1}`,
        ...(embeddingBackend ? { embeddingBackend } : {}),
      });

      if (!exemplarResult.success || !exemplarResult.data?.exemplarId) {
        throw createNamedError(
          'InferenceFailureError',
          exemplarResult.error || `Failed to create concept exemplar for source box ${index + 1}.`,
          exemplarResult.errorCode || 'CONCEPT_EXEMPLAR_CREATE_FAILED'
        );
      }

      exemplars.push({
        exemplarId: exemplarResult.data.exemplarId,
        sourceBoxIndex: index,
        backendWarning: exemplarResult.data.backendWarning,
      });
    }

    if (exemplars.length === 0) {
      throw createNamedError(
        'InferenceFailureError',
        'Concept propagation requires at least one source-box concept exemplar.',
        'CONCEPT_EXEMPLAR_MISSING'
      );
    }

    return exemplars;
  }

  private async runConceptPropagation(
    asset: AssetRecord,
    imageBuffer: Buffer,
    conceptExemplars: string | ConceptExemplarRef[] | null,
    weedType: string,
    vegetation?: VegetationPriorContext
  ): Promise<AssetInferenceResult> {
    const exemplarRefs = normalizeConceptExemplarRefs(conceptExemplars);
    if (exemplarRefs.length === 0) {
      return {
        assetId: asset.id,
        detections: [],
        outcome: 'inference_error',
        errorCode: 'EXEMPLAR_MISSING',
        errorMessage: 'Concept exemplar was not created for this batch.',
      };
    }

    // Dataset propagation is intentionally high recall: every candidate still
    // enters the pending review gate before export or YOLO training.
    const reviewProfile: Sam3BatchV2ReviewProfile = 'high_recall';
    const conceptOptions = buildBatchV2ConceptApplyOptions(reviewProfile);
    const candidateResult = await this.getConceptCandidatesFromEnsemble({
      asset,
      imageBuffer,
      exemplars: exemplarRefs,
      primaryOptions: conceptOptions,
      reviewProfile,
      failureCode: 'CONCEPT_INFERENCE_FAILED',
    });
    const refinement = await this.refineConceptDetectionsWithBoxPrompts(
      asset,
      imageBuffer,
      weedType,
      candidateResult.detections,
      vegetation,
      getBatchV2MaxTargetCandidates(reviewProfile)
    );

    return {
      assetId: asset.id,
      detections: refinement.detections,
      outcome: refinement.detections.length > 0 ? 'success' : 'zero_detections',
      backendMode: refinement.usedCandidateFallback
        ? 'concept_ensemble_candidates_unrefined'
        : 'concept_ensemble_refined',
      backendWarning: combineBackendWarnings(
        candidateResult.backendWarning,
        refinement.backendWarning
      ),
      candidateExpansionUsed: candidateResult.candidateExpansionUsed,
      candidateCount: refinement.candidateCount,
      refinementBoxCount: refinement.refinementBoxCount,
      refinementDetectionCount: refinement.refinementDetectionCount,
      refinementMode: refinement.refinementMode,
      candidateBudget: refinement.candidateBudget,
      refineSentInstances: refinement.refineSentInstances,
      refineRefinedInstances: refinement.refineRefinedInstances,
      refineRejectedInstances: refinement.refineRejectedInstances,
      refineIncompleteChunks: refinement.refineIncompleteChunks,
      vegetationMode: refinement.vegetationMode,
      vegetationThreshold: refinement.vegetationThreshold,
      vegetationGatedCandidates: refinement.vegetationGatedCandidates,
      vegetationRecenteredCandidates: refinement.vegetationRecenteredCandidates,
      vegetationGatedMasks: refinement.vegetationGatedMasks,
      vegetationDeduplicatedMasks: refinement.vegetationDeduplicatedMasks,
      maskGreenFractionP10: refinement.maskGreenFractionP10,
      maskGreenFractionMedian: refinement.maskGreenFractionMedian,
      maskGreenFractionP90: refinement.maskGreenFractionP90,
    };
  }

  private async getConceptCandidatesFromEnsemble({
    asset,
    imageBuffer,
    exemplars,
    primaryOptions,
    reviewProfile = 'balanced',
    failureCode,
  }: {
    asset: AssetRecord;
    imageBuffer: Buffer;
    exemplars: ConceptExemplarRef[];
    primaryOptions: SAM3ConceptApplyOptions;
    reviewProfile?: Sam3BatchV2ReviewProfile;
    failureCode: string;
  }): Promise<ConceptCandidateResult> {
    const minTargetCandidates = getBatchV2MinTargetCandidates(reviewProfile);
    const maxTargetCandidates = getBatchV2MaxTargetCandidates(reviewProfile);
    const primaryResult = await this.collectConceptCandidatesForExemplars({
      asset,
      imageBuffer,
      exemplars,
      options: primaryOptions,
      failureCode,
    });
    const mergedPrimaryCandidates = dedupeAndLimitConceptDetections(
      primaryResult.detections,
      primaryOptions,
      maxTargetCandidates
    );

    if (mergedPrimaryCandidates.length >= minTargetCandidates) {
      return {
        detections: mergedPrimaryCandidates,
        candidateExpansionUsed: false,
        backendWarning: primaryResult.backendWarning,
      };
    }

    const fallbackOptions = buildBatchV2ConceptFallbackApplyOptions(reviewProfile);
    const fallbackResult = await this.collectConceptCandidatesForExemplars({
      asset,
      imageBuffer,
      exemplars,
      options: fallbackOptions,
      failureCode: 'CONCEPT_FALLBACK_FAILED',
    });
    const mergedCandidates = dedupeAndLimitConceptDetections(
      [...mergedPrimaryCandidates, ...fallbackResult.detections],
      fallbackOptions,
      maxTargetCandidates
    );

    if (fallbackResult.detections.length > 0) {
      console.warn(
        `[SAM3 V2] Target ${asset.id} used ensemble fallback concept threshold ` +
          `${fallbackOptions.similarityThreshold} after strict threshold ` +
          `${primaryOptions.similarityThreshold} returned ${mergedPrimaryCandidates.length} ` +
          `candidate(s), below target floor ${minTargetCandidates}.`
      );
    }

    return {
      detections: mergedCandidates,
      candidateExpansionUsed: true,
      backendWarning: combineBackendWarnings(
        primaryResult.backendWarning,
        fallbackResult.backendWarning
      ),
    };
  }

  private async collectConceptCandidatesForExemplars({
    asset,
    imageBuffer,
    exemplars,
    options,
    failureCode,
  }: {
    asset: AssetRecord;
    imageBuffer: Buffer;
    exemplars: ConceptExemplarRef[];
    options: SAM3ConceptApplyOptions;
    failureCode: string;
  }): Promise<{ detections: SAM3ConceptDetection[]; backendWarning?: string }> {
    const candidates: SAM3ConceptDetection[] = [];
    const backendWarnings = exemplars.map((exemplar) => exemplar.backendWarning);

    for (const exemplar of exemplars) {
      const result = await this.awsSam3Service.applyConceptExemplar({
        exemplarId: exemplar.exemplarId,
        imageBuffer,
        imageId: asset.id,
        options,
      });

      if (!result.success || !result.data) {
        const label =
          typeof exemplar.sourceBoxIndex === 'number'
            ? `source box ${exemplar.sourceBoxIndex + 1}`
            : `exemplar ${exemplar.exemplarId}`;
        throw createNamedError(
          'InferenceFailureError',
          `SAM3 concept propagation failed for ${asset.id} using ${label}: ` +
            `${result.error || 'unknown error'}`,
          result.errorCode || failureCode
        );
      }

      candidates.push(...filterBatchV2ConceptDetections(result.data.detections, options));
      backendWarnings.push(result.data.backendWarning);
    }

    return {
      detections: candidates,
      backendWarning: combineBackendWarnings(...backendWarnings),
    };
  }

  private async getConceptCandidatesWithFallback({
    asset,
    imageBuffer,
    exemplarId,
    primaryDetections,
    primaryOptions,
    primaryBackendWarning,
    reviewProfile = 'balanced',
    failureCode,
  }: {
    asset: AssetRecord;
    imageBuffer: Buffer;
    exemplarId: string;
    primaryDetections: SAM3ConceptDetection[];
    primaryOptions: SAM3ConceptApplyOptions;
    primaryBackendWarning?: string;
    reviewProfile?: Sam3BatchV2ReviewProfile;
    failureCode: string;
  }): Promise<ConceptCandidateResult> {
    const minTargetCandidates = getBatchV2MinTargetCandidates(reviewProfile);
    const maxTargetCandidates = getBatchV2MaxTargetCandidates(reviewProfile);
    const primaryCandidates = filterBatchV2ConceptDetections(primaryDetections, primaryOptions);
    const rankedPrimaryCandidates = dedupeAndLimitConceptDetections(
      primaryCandidates,
      primaryOptions,
      maxTargetCandidates
    );
    const primaryCandidateCountForFloor = resolveBatchV2RefineMode() === 'instances'
      ? rankedPrimaryCandidates.length
      : primaryCandidates.length;
    if (primaryCandidateCountForFloor >= minTargetCandidates) {
      return {
        detections: rankedPrimaryCandidates,
        candidateExpansionUsed: false,
        backendWarning: primaryBackendWarning,
      };
    }

    const fallbackOptions = buildBatchV2ConceptFallbackApplyOptions(reviewProfile);
    const fallbackResult = await this.awsSam3Service.applyConceptExemplar({
      exemplarId,
      imageBuffer,
      imageId: asset.id,
      options: fallbackOptions,
    });

    if (!fallbackResult.success || !fallbackResult.data) {
      const code = fallbackResult.errorCode || failureCode;
      const message = fallbackResult.error || 'Lower-threshold concept matching failed.';
      throw createNamedError(
        'InferenceFailureError',
        `SAM3 high-recall candidate expansion failed for ${asset.id}: ${message}`,
        code
      );
    }

    const fallbackCandidates = filterBatchV2ConceptDetections(
      fallbackResult.data.detections,
      fallbackOptions
    );
    const mergedCandidates = dedupeAndLimitConceptDetections(
      [...primaryCandidates, ...fallbackCandidates],
      fallbackOptions,
      maxTargetCandidates
    );

    if (fallbackCandidates.length > 0) {
      console.warn(
        `[SAM3 V2] Target ${asset.id} used fallback concept threshold ` +
          `${fallbackOptions.similarityThreshold} after strict threshold ` +
          `${primaryOptions.similarityThreshold} returned ${primaryCandidateCountForFloor} ` +
          `candidate(s), below target floor ${minTargetCandidates}.`
      );
    }

    return {
      detections: mergedCandidates,
      candidateExpansionUsed: true,
      backendWarning: combineBackendWarnings(
        primaryBackendWarning,
        fallbackResult.data.backendWarning
      ),
    };
  }

  private async refineConceptDetectionsWithBoxPrompts(
    asset: AssetRecord,
    imageBuffer: Buffer,
    className: string,
    candidates: SAM3ConceptDetection[],
    vegetation?: VegetationPriorContext,
    candidateBudget?: number
  ): Promise<ConceptRefinementResult> {
    const refinementMode = resolveBatchV2RefineMode();
    const normalizedVegetation = normalizeVegetationPriorContext(vegetation);
    const result = refinementMode === 'instances'
      ? await this.refineConceptDetectionsWithInstances(
          asset,
          imageBuffer,
          candidates,
          normalizedVegetation
        )
      : await this.refineConceptDetectionsWithLegacyBoxPrompts(
          asset,
          imageBuffer,
          className,
          candidates,
          normalizedVegetation
        );

    const disabledLowGreen =
      normalizedVegetation?.mode === 'disabled_low_exemplar_green';

    return {
      ...result,
      refinementMode,
      ...(normalizedVegetation?.mode
        ? {
            vegetationMode: normalizedVegetation.mode,
            vegetationThreshold: normalizedVegetation.threshold ?? null,
          }
        : {}),
      ...(disabledLowGreen
        ? {
            vegetationGatedCandidates: 0,
            vegetationRecenteredCandidates: 0,
            vegetationGatedMasks: 0,
            vegetationDeduplicatedMasks: 0,
          }
        : {}),
      candidateBudget: candidateBudget ?? (
        refinementMode === 'instances'
          ? resolveBatchV2CandidateBudget()
          : getBatchV2MaxTargetCandidates('balanced', 'concept')
      ),
      ...(refinementMode === 'instances'
        ? {
            refineSentInstances:
              result.refineSentInstances ?? result.refinementBoxCount,
            refineRefinedInstances: result.refineRefinedInstances ?? 0,
            refineRejectedInstances: result.refineRejectedInstances ?? 0,
            refineIncompleteChunks: result.refineIncompleteChunks ?? 0,
          }
        : {}),
    };
  }

  private async refineConceptDetectionsWithInstances(
    asset: AssetRecord,
    imageBuffer: Buffer,
    candidates: SAM3ConceptDetection[],
    vegetation?: VegetationPriorContext
  ): Promise<ConceptRefinementResult> {
    if (candidates.length === 0) {
      return {
        detections: [],
        candidateCount: 0,
        refinementBoxCount: 0,
        refinementDetectionCount: 0,
        refineSentInstances: 0,
        refineRefinedInstances: 0,
        refineRejectedInstances: 0,
      };
    }

    const originalCandidateCount = candidates.length;
    const vegetationCandidates = vegetation?.enabled
      ? await this.applyVegetationPriorToCandidates(
          imageBuffer,
          candidates,
          vegetation.threshold as number
        )
      : undefined;
    const refinementCandidates = vegetationCandidates?.candidates ?? candidates;

    if (refinementCandidates.length === 0) {
      return {
        detections: [],
        candidateCount: originalCandidateCount,
        refinementBoxCount: 0,
        refinementDetectionCount: 0,
        refineSentInstances: 0,
        refineRefinedInstances: 0,
        refineRejectedInstances: 0,
        vegetationThreshold: vegetationCandidates?.threshold,
        vegetationGatedCandidates: vegetationCandidates?.gatedCount,
        vegetationRecenteredCandidates: vegetationCandidates?.recenteredCount,
        vegetationGatedMasks: 0,
        vegetationDeduplicatedMasks: 0,
      };
    }

    const validCandidates = refinementCandidates.filter((candidate) =>
      isValidBox({
        x1: candidate.bbox[0],
        y1: candidate.bbox[1],
        x2: candidate.bbox[2],
        y2: candidate.bbox[3],
      })
    );
    const { prompts, candidateById } = buildInstanceRefinementPrompts(
      asset.id,
      validCandidates,
      vegetationCandidates?.promptPoints,
      vegetation?.exemplarDiameter
    );

    if (prompts.length === 0) {
      return this.buildConceptCandidateFallbackResult(
        asset.id,
        imageBuffer,
        refinementCandidates,
        originalCandidateCount,
        0,
        0,
        'SAM3 instance refinement could not build valid boxes.',
        vegetationCandidates
      );
    }

    let resized: Awaited<ReturnType<AwsSam3Like['resizeImage']>>;
    try {
      await this.ensureSam3ReadyForBoxRefinement(asset.id);
      resized = await this.awsSam3Service.resizeImage(imageBuffer);
    } catch (error) {
      return this.buildConceptCandidateFallbackResult(
        asset.id,
        imageBuffer,
        refinementCandidates,
        originalCandidateCount,
        0,
        0,
        error instanceof Error ? error.message : 'SAM3 instance refinement was not ready.',
        vegetationCandidates
      );
    }

    const responseById = new Map<string, {
      id: string;
      polygon: [number, number][] | null;
      bbox_from_mask: [number, number, number, number] | null;
      predicted_iou: number;
      score: number;
    }>();
    let responseInstanceCount = 0;
    let incompleteChunks = 0;
    const incompletePromptIds = new Set<string>();
    const image = resized.buffer.toString('base64');
    const scaledPrompts = prompts.map((prompt) =>
      scaleInstanceRefinementPrompt(prompt, resized.scaling.scaleFactor)
    );
    const refineInstances = this.awsSam3Service.refineInstances;
    if (!refineInstances) {
      return this.buildConceptCandidateFallbackResult(
        asset.id,
        imageBuffer,
        refinementCandidates,
        originalCandidateCount,
        0,
        0,
        'SAM3 client does not support instance refinement.',
        vegetationCandidates
      );
    }

    for (const chunk of chunkItems(scaledPrompts, SAM3_BATCH_V2_INSTANCE_REFINEMENT_CHUNK_SIZE)) {
      let completeResult: Awaited<
        ReturnType<NonNullable<AwsSam3Like['refineInstances']>>
      > | undefined;

      for (let attempt = 0; attempt < 2; attempt += 1) {
        let result: Awaited<ReturnType<NonNullable<AwsSam3Like['refineInstances']>>>;
        try {
          result = await refineInstances.call(this.awsSam3Service, {
            image,
            instances: chunk,
            return_polygons: true,
            decode_batch: 32,
            polygon_resolution: 2048,
            score_threshold: 0.5,
          });
        } catch (error) {
          return this.buildConceptCandidateFallbackResult(
            asset.id,
            imageBuffer,
            refinementCandidates,
            originalCandidateCount,
            prompts.length,
            responseInstanceCount,
            error instanceof Error ? error.message : 'SAM3 instance refinement request failed.',
            vegetationCandidates
          );
        }

        if (!result.success || !result.response) {
          return this.buildConceptCandidateFallbackResult(
            asset.id,
            imageBuffer,
            refinementCandidates,
            originalCandidateCount,
            prompts.length,
            responseInstanceCount,
            result.error || 'SAM3 instance refinement returned no response.',
            vegetationCandidates
          );
        }

        if (hasCompleteInstanceRefinementResponse(chunk, result.response.instances)) {
          completeResult = result;
          break;
        }
      }

      if (!completeResult?.response) {
        incompleteChunks += 1;
        chunk.forEach((prompt) => incompletePromptIds.add(prompt.id));
        continue;
      }

      responseInstanceCount += completeResult.response.instances.length;
      for (const instance of completeResult.response.instances) {
        if (candidateById.has(instance.id)) {
          responseById.set(instance.id, instance);
        }
      }
    }

    let rejectedInstances = 0;
    let refinedInstances = 0;
    const detections = prompts.flatMap((prompt) => {
      const sourceCandidate = candidateById.get(prompt.id);
      if (!sourceCandidate) {
        return [];
      }

      if (incompletePromptIds.has(prompt.id)) {
        return [mapConceptDetectionToAssetDetection(sourceCandidate)];
      }

      const response = responseById.get(prompt.id);
      if (!response?.polygon) {
        rejectedInstances += 1;
        return [];
      }

      const bbox = scaleBboxToOriginal(
        response.bbox_from_mask ?? polygonBounds(response.polygon),
        resized.scaling.scaleFactor
      );
      const score = conceptDetectionScore(sourceCandidate);
      refinedInstances += 1;
      return [{
        bbox,
        polygon: scalePolygonToOriginal(
          response.polygon,
          bbox,
          resized.scaling.scaleFactor
        ),
        confidence: score,
        similarity:
          typeof sourceCandidate.similarity === 'number'
            ? sourceCandidate.similarity
            : score,
      }];
    });

    const maskHygiene = vegetationCandidates
      ? await this.applyVegetationMaskHygiene(
          asset.id,
          imageBuffer,
          detections,
          vegetationCandidates.imageWidth,
          vegetationCandidates.imageHeight,
          vegetationCandidates.threshold
        )
      : undefined;
    const incompleteCandidateCount = incompletePromptIds.size;
    const backendWarning = incompleteChunks > 0
      ? `SAM3 instance refinement returned incomplete responses for ${asset.id}; ` +
        `saved ${incompleteCandidateCount} candidate(s) from ${incompleteChunks} chunk(s) ` +
        'as unrefined pending review items after retry.'
      : undefined;

    if (backendWarning) {
      console.warn(`[SAM3 V2] ${backendWarning}`);
    }

    return {
      detections: maskHygiene?.detections ?? detections,
      candidateCount: originalCandidateCount,
      refinementBoxCount: prompts.length,
      refinementDetectionCount: responseInstanceCount,
      refineSentInstances: prompts.length,
      refineRefinedInstances: refinedInstances,
      refineRejectedInstances: rejectedInstances,
      refineIncompleteChunks: incompleteChunks,
      vegetationThreshold: vegetationCandidates?.threshold,
      vegetationGatedCandidates: vegetationCandidates?.gatedCount,
      vegetationRecenteredCandidates: vegetationCandidates?.recenteredCount,
      vegetationGatedMasks: maskHygiene?.gatedCount,
      vegetationDeduplicatedMasks: maskHygiene?.deduplicatedCount,
      maskGreenFractionP10: maskHygiene?.p10,
      maskGreenFractionMedian: maskHygiene?.median,
      maskGreenFractionP90: maskHygiene?.p90,
      usedCandidateFallback: incompleteChunks > 0,
      backendWarning,
    };
  }

  private async refineConceptDetectionsWithLegacyBoxPrompts(
    asset: AssetRecord,
    imageBuffer: Buffer,
    className: string,
    candidates: SAM3ConceptDetection[],
    vegetation?: VegetationPriorContext
  ): Promise<ConceptRefinementResult> {
    if (candidates.length === 0) {
      return {
        detections: [],
        candidateCount: 0,
        refinementBoxCount: 0,
        refinementDetectionCount: 0,
      };
    }

    const originalCandidateCount = candidates.length;
    const vegetationCandidates = vegetation?.enabled
      ? await this.applyVegetationPriorToCandidates(
          imageBuffer,
          candidates,
          vegetation.threshold as number
        )
      : undefined;
    const refinementCandidates = vegetationCandidates?.candidates ?? candidates;

    if (refinementCandidates.length === 0) {
      return {
        detections: [],
        candidateCount: originalCandidateCount,
        refinementBoxCount: 0,
        refinementDetectionCount: 0,
        vegetationThreshold: vegetationCandidates?.threshold,
        vegetationGatedCandidates: vegetationCandidates?.gatedCount,
        vegetationRecenteredCandidates: vegetationCandidates?.recenteredCount,
        vegetationGatedMasks: 0,
        vegetationDeduplicatedMasks: 0,
      };
    }

    let resized: Awaited<ReturnType<AwsSam3Like['resizeImage']>>;
    let boxes: BoxCoordinate[];

    try {
      await this.ensureSam3ReadyForBoxRefinement(asset.id);
      resized = await this.awsSam3Service.resizeImage(imageBuffer);
      boxes = refinementCandidates
        .map((candidate) => bboxToBoxCoordinate(candidate.bbox, resized.scaling.scaleFactor))
        .filter(isValidBox);
    } catch (error) {
      return this.buildConceptCandidateFallbackResult(
        asset.id,
        imageBuffer,
        refinementCandidates,
        originalCandidateCount,
        0,
        0,
        error instanceof Error ? error.message : 'SAM3 box refinement could not prepare candidates.',
        vegetationCandidates
      );
    }

    if (boxes.length === 0) {
      return this.buildConceptCandidateFallbackResult(
        asset.id,
        imageBuffer,
        refinementCandidates,
        originalCandidateCount,
        0,
        0,
        'SAM3 box refinement could not build valid boxes.',
        vegetationCandidates
      );
    }

    let result: Awaited<ReturnType<AwsSam3Like['segment']>>;

    try {
      result = await this.awsSam3Service.segment({
        image: resized.buffer.toString('base64'),
        boxes,
        className,
        returnPolygons: true,
      });
    } catch (error) {
      return this.buildConceptCandidateFallbackResult(
        asset.id,
        imageBuffer,
        refinementCandidates,
        originalCandidateCount,
        boxes.length,
        0,
        error instanceof Error ? error.message : 'SAM3 box refinement request failed.',
        vegetationCandidates
      );
    }

    if (!result.success || !result.response || result.response.detections.length === 0) {
      const message = result.error || 'SAM3 box refinement returned no detections.';
      return this.buildConceptCandidateFallbackResult(
        asset.id,
        imageBuffer,
        refinementCandidates,
        originalCandidateCount,
        boxes.length,
        result.response?.detections.length ?? 0,
        message,
        vegetationCandidates
      );
    }

    const matchedCandidateKeys = new Set<string>();
    const refinedDetections = result.response.detections.flatMap((detection) => {
      const bbox = scaleBboxToOriginal(detection.bbox, resized.scaling.scaleFactor);
      const sourceCandidateMatch = bestConceptCandidateMatchForBbox(bbox, refinementCandidates);
      if (
        !sourceCandidateMatch ||
        sourceCandidateMatch.iou < SAM3_BATCH_V2_MIN_REFINEMENT_IOU
      ) {
        return [];
      }

      const sourceCandidate = sourceCandidateMatch.candidate;
      matchedCandidateKeys.add(conceptCandidateKey(sourceCandidate));
      const score = conceptDetectionScore(sourceCandidate);
      const similarity =
        typeof sourceCandidate.similarity === 'number'
          ? sourceCandidate.similarity
          : score;

      return [{
        bbox,
        polygon: scalePolygonToOriginal(detection.polygon, bbox, resized.scaling.scaleFactor),
        confidence: score,
        similarity,
      }];
    });

    const unmatchedCandidates = refinementCandidates
      .filter((candidate) => !matchedCandidateKeys.has(conceptCandidateKey(candidate)))
      .map(mapConceptDetectionToAssetDetection);

    if (refinedDetections.length === 0) {
      throw createNamedError(
        'InferenceFailureError',
        `[SAM3 V2] Target box refinement drifted away from candidates for ${asset.id}; ` +
          'no refined detection overlapped the source candidates.',
        'SAM3_REFINEMENT_DRIFT'
      );
    }

    if (unmatchedCandidates.length > 0) {
      console.warn(
        `[SAM3 V2] Target ${asset.id} dropped ${unmatchedCandidates.length} unrefined ` +
          'concept candidate(s) instead of falling back silently.'
      );
    }

    const maskHygiene = vegetationCandidates
      ? await this.applyVegetationMaskHygiene(
          asset.id,
          imageBuffer,
          refinedDetections,
          vegetationCandidates.imageWidth,
          vegetationCandidates.imageHeight,
          vegetationCandidates.threshold
        )
      : undefined;

    return {
      detections: maskHygiene?.detections ?? refinedDetections,
      candidateCount: originalCandidateCount,
      refinementBoxCount: boxes.length,
      refinementDetectionCount: result.response.detections.length,
      vegetationThreshold: vegetationCandidates?.threshold,
      vegetationGatedCandidates: vegetationCandidates?.gatedCount,
      vegetationRecenteredCandidates: vegetationCandidates?.recenteredCount,
      vegetationGatedMasks: maskHygiene?.gatedCount,
      vegetationDeduplicatedMasks: maskHygiene?.deduplicatedCount,
      maskGreenFractionP10: maskHygiene?.p10,
      maskGreenFractionMedian: maskHygiene?.median,
      maskGreenFractionP90: maskHygiene?.p90,
    };
  }

  private async buildConceptCandidateFallbackResult(
    assetId: string,
    imageBuffer: Buffer,
    candidates: SAM3ConceptDetection[],
    originalCandidateCount: number,
    refinementBoxCount: number,
    refinementDetectionCount: number,
    reason: string,
    vegetationCandidates?: VegetationCandidateResult
  ): Promise<ConceptRefinementResult> {
    const candidateDetections = candidates.map(mapConceptDetectionToAssetDetection);
    const maskHygiene = vegetationCandidates
      ? await this.applyVegetationMaskHygiene(
          assetId,
          imageBuffer,
          candidateDetections,
          vegetationCandidates.imageWidth,
          vegetationCandidates.imageHeight,
          vegetationCandidates.threshold
        )
      : undefined;
    const detections = maskHygiene?.detections ?? candidateDetections;
    const backendWarning =
      `SAM3 box refinement failed for ${assetId}; saved ${detections.length} ` +
      `unrefined concept candidate(s) as pending review items: ${reason}`;

    console.warn(`[SAM3 V2] ${backendWarning}`);

    return {
      detections,
      candidateCount: originalCandidateCount,
      refinementBoxCount,
      refinementDetectionCount,
      vegetationThreshold: vegetationCandidates?.threshold,
      vegetationGatedCandidates: vegetationCandidates?.gatedCount,
      vegetationRecenteredCandidates: vegetationCandidates?.recenteredCount,
      vegetationGatedMasks: maskHygiene?.gatedCount,
      vegetationDeduplicatedMasks: maskHygiene?.deduplicatedCount,
      maskGreenFractionP10: maskHygiene?.p10,
      maskGreenFractionMedian: maskHygiene?.median,
      maskGreenFractionP90: maskHygiene?.p90,
      usedCandidateFallback: true,
      backendWarning,
    };
  }

  private async ensureSam3ReadyForBoxRefinement(assetId: string): Promise<void> {
    let status: Awaited<ReturnType<AwsSam3Like['refreshStatus']>> | null = null;

    try {
      status = await this.awsSam3Service.refreshStatus();
    } catch (error) {
      throw createNamedError(
        'InferenceFailureError',
        `SAM3 readiness check failed before box refinement for ${assetId}: ` +
          `${error instanceof Error ? error.message : 'unknown error'}`,
        'SAM3_REFINEMENT_READINESS_FAILED'
      );
    }

    const ready = this.awsSam3Service.isReady();
    if (!ready) {
      throw createNamedError(
        'InferenceFailureError',
        `SAM3 box refinement is not ready for ${assetId} ` +
          `(state: ${status?.instanceState || 'unknown'}, ` +
          `modelLoaded: ${String(status?.modelLoaded ?? 'unknown')}, ` +
          `ipAddress: ${status?.ipAddress || 'none'}).`,
        'SAM3_REFINEMENT_NOT_READY'
      );
    }
  }

  private async persistAssetResult(
    batchJobId: string,
    parentBatchJobId: string | null,
    result: AssetInferenceResult,
    weedType: string,
    attemptsMade: number
  ) {
    try {
      await this.prisma.$transaction(async (tx) => {
        await tx.pendingAnnotation.deleteMany({
          where: {
            batchJobId,
            assetId: result.assetId,
          },
        });

        if (result.detections.length > 0) {
          await tx.pendingAnnotation.createMany({
            data: result.detections.map((detection) => ({
              batchJobId,
              assetId: result.assetId,
              weedType: normalizeDetectionType(weedType),
              confidence:
                typeof detection.similarity === 'number'
                  ? detection.similarity
                  : detection.confidence,
              similarity: detection.similarity ?? null,
              polygon: detection.polygon,
              bbox: detection.bbox,
              status: 'PENDING',
            })),
          });
        }

        await tx.batchJob.update({
          where: { id: batchJobId },
          data: {
            processedImages: {
              increment: 1,
            },
            detectionsFound: {
              increment: result.detections.length,
            },
          },
        });

        if (parentBatchJobId) {
          await tx.batchJob.update({
            where: { id: parentBatchJobId },
            data: {
              processedImages: {
                increment: 1,
              },
              detectionsFound: {
                increment: result.detections.length,
              },
            },
          });
        }
      });
    } catch (error) {
      const persistError = new Error(
        error instanceof Error ? error.message : 'Failed to persist batch asset result.'
      );
      persistError.name = 'PersistFailureError';
      throw persistError;
    }

    const batchJob = await this.prisma.batchJob.findUnique({
      where: { id: batchJobId },
      select: {
        stageLog: true,
      },
    });
    const stageLog = parseStageLog(batchJob?.stageLog);

    await this.appendStageLog(batchJobId, stageLog, {
      stage: 'persist',
      status: result.outcome === 'success' || result.outcome === 'zero_detections' ? 'completed' : 'failed',
      attempt: attemptsMade,
      assetId: result.assetId,
      assetOutcome: result.outcome,
      detectionCount: result.detections.length,
      errorCode: result.errorCode,
      errorMessage: result.errorMessage,
    });
  }

  private async rollupParentBatchJob(parentBatchJobId: string): Promise<void> {
    const childJobs = await this.prisma.batchJob.findMany({
      where: { parentBatchJobId },
      select: {
        id: true,
        status: true,
        processedImages: true,
        totalImages: true,
        detectionsFound: true,
        errorMessage: true,
        shardIndex: true,
        shardCount: true,
        startedAt: true,
        completedAt: true,
        stageLog: true,
      },
    });

    if (childJobs.length === 0) {
      return;
    }

    const childSnapshots = childJobs.map((childJob) => {
      const childStageLog = parseStageLog(childJob.stageLog);
      const childStageSummary = summarizeStageLog(childStageLog);
      const latestStageEntry = [...childStageLog]
        .reverse()
        .find((entry) => entry.stage !== 'terminal');

      return {
        id: childJob.id,
        status: childJob.status,
        processedImages: childJob.processedImages,
        totalImages: childJob.totalImages,
        detectionsFound: childJob.detectionsFound,
        errorMessage: childJob.errorMessage,
        shardIndex: childJob.shardIndex,
        shardCount: childJob.shardCount,
        latestStage: childStageSummary.latestStage,
        latestStageTimestamp: latestStageEntry?.timestamp || null,
        terminalState: childStageSummary.terminalState,
      };
    });

    const rollup = summarizeChildBatchJobs(childSnapshots);
    const startedAtValues = childJobs
      .map((childJob) => childJob.startedAt)
      .filter((value): value is Date => Boolean(value));
    const completedAtValues = childJobs
      .map((childJob) => childJob.completedAt)
      .filter((value): value is Date => Boolean(value));
    const allTerminal = childJobs.every((childJob) =>
      ['COMPLETED', 'FAILED', 'CANCELLED'].includes(childJob.status)
    );

    await this.prisma.batchJob.update({
      where: { id: parentBatchJobId },
      data: {
        status: rollup.status,
        processedImages: rollup.processedImages,
        detectionsFound: rollup.detectionsFound,
        errorMessage: rollup.errorMessage,
        startedAt:
          startedAtValues.length > 0
            ? new Date(Math.min(...startedAtValues.map((value) => value.getTime())))
            : null,
        completedAt:
          allTerminal && completedAtValues.length > 0
            ? new Date(Math.max(...completedAtValues.map((value) => value.getTime())))
            : null,
      },
    });
  }
}

export const sam3BatchV2Service = new Sam3BatchV2Service({
  prisma,
  awsSam3Service,
  acquireGpuLock,
  refreshGpuLock,
  releaseGpuLock,
  sleep: defaultSleep,
  now: () => new Date(),
});
