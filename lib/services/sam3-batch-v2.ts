import type { Prisma } from '@prisma/client';
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
} from '@/lib/services/aws-sam3';
import { S3Service } from '@/lib/services/s3';
import { normalizeDetectionType } from '@/lib/utils/detection-types';
import {
  buildExemplarCrops,
  buildExemplarCropsFromDetections,
  normalizeExemplarCrops,
} from '@/lib/utils/exemplar-crops';
import {
  SAM3_BATCH_JOB_KINDS,
  summarizeChildBatchJobs,
  type Sam3BatchJobKind,
} from '@/lib/utils/sam3-batch-jobs';
import { scaleExemplarBoxes, type BoxCoordinate } from '@/lib/utils/exemplar-scaling';
import { fetchImageSafely } from '@/lib/utils/security';

const BASE_URL = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';

export const SAM3_BATCH_V2_MAX_IMAGES = 500;
export const SAM3_BATCH_V2_MAX_EXEMPLARS = 10;
export const SAM3_BATCH_V2_GPU_LOCK_TTL_MS = 300000;
export const SAM3_BATCH_V2_GPU_LOCK_HEARTBEAT_MS = 45000;
export const SAM3_BATCH_V2_GPU_LOCK_RETRY_INTERVAL_MS = 5000;
export const SAM3_BATCH_V2_GPU_LOCK_RETRY_TIMEOUT_MS = 60000;
export const SAM3_BATCH_V2_GPU_MEMORY_THRESHOLD_MB = 12 * 1024;
export const SAM3_BATCH_V2_MODEL_OVERHEAD_MB = 4096;

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
export const SAM3_BATCH_V2_MIN_TARGET_CANDIDATES = Math.max(
  0,
  parseOptionalInt(process.env.SAM3_CONCEPT_MIN_TARGET_CANDIDATES) ?? 25
);
export const SAM3_BATCH_V2_MAX_TARGET_CANDIDATES = Math.max(
  SAM3_BATCH_V2_MIN_TARGET_CANDIDATES,
  parseOptionalInt(process.env.SAM3_CONCEPT_MAX_TARGET_CANDIDATES) ??
    SAM3_BATCH_V2_DEFAULT_TOP_K
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
export const SAM3_VISUAL_SOURCE_CROP_MAX = Math.max(
  1,
  parseOptionalInt(process.env.SAM3_VISUAL_SOURCE_CROP_MAX) ?? 30
);
export const SAM3_VISUAL_SOURCE_CROP_MIN_CONFIDENCE = Math.max(
  0,
  Math.min(
    1,
    parseOptionalNumber(process.env.SAM3_VISUAL_SOURCE_CROP_MIN_CONFIDENCE) ?? 0.6
  )
);
export const SAM3_VISUAL_SOURCE_CROP_PADDING = Math.max(
  0,
  Math.min(
    1,
    parseOptionalNumber(process.env.SAM3_VISUAL_SOURCE_CROP_PADDING) ?? 0.08
  )
);

export function buildBatchV2ConceptApplyOptions(): SAM3ConceptApplyOptions {
  return {
    returnPolygons: true,
    similarityThreshold: SAM3_BATCH_V2_DEFAULT_SIMILARITY_THRESHOLD,
    topK: SAM3_BATCH_V2_DEFAULT_TOP_K,
    minBoxSize: SAM3_BATCH_V2_DEFAULT_MIN_BOX_SIZE,
    maxBoxSize: SAM3_BATCH_V2_DEFAULT_MAX_BOX_SIZE,
    nmsThreshold: SAM3_BATCH_V2_DEFAULT_NMS_THRESHOLD,
  };
}

export function buildBatchV2ConceptFallbackApplyOptions(): SAM3ConceptApplyOptions {
  return {
    returnPolygons: true,
    similarityThreshold: SAM3_BATCH_V2_FALLBACK_SIMILARITY_THRESHOLD,
    topK: SAM3_BATCH_V2_FALLBACK_TOP_K,
    minBoxSize: SAM3_BATCH_V2_DEFAULT_MIN_BOX_SIZE,
    maxBoxSize: SAM3_BATCH_V2_DEFAULT_MAX_BOX_SIZE,
    nmsThreshold: SAM3_BATCH_V2_DEFAULT_NMS_THRESHOLD,
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
  operatorCropCount?: number;
  sourceDetectionCropCount?: number;
  visualCropSource?: 'operator' | 'source_detections';
  detectionCount?: number;
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
  warmupConceptService(): Promise<{ success: boolean; data: { sam3Loaded: boolean; dinoLoaded: boolean } | null; error?: string }>;
  createConceptExemplar(request: {
    imageBuffer: Buffer;
    boxes: BoxCoordinate[];
    className: string;
    imageId?: string;
  }): Promise<{ success: boolean; data: { exemplarId: string } | null; error?: string; errorCode?: string }>;
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
  assets: AssetRecord[];
  missingAssetIds: string[];
  cropCount: number;
  operatorCropCount: number;
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

function createNamedError(name: string, message: string) {
  const error = new Error(message);
  error.name = name;
  return error;
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

function boxArea(box: BoxCoordinate): number {
  return Math.max(0, box.x2 - box.x1) * Math.max(0, box.y2 - box.y1);
}

function boxIntersectionArea(first: BoxCoordinate, second: BoxCoordinate): number {
  const x1 = Math.max(first.x1, second.x1);
  const y1 = Math.max(first.y1, second.y1);
  const x2 = Math.min(first.x2, second.x2);
  const y2 = Math.min(first.y2, second.y2);

  return Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
}

function boxesOverlapEnough(
  detectionBox: BoxCoordinate,
  anchorBox: BoxCoordinate
): boolean {
  const smallerArea = Math.min(boxArea(detectionBox), boxArea(anchorBox));
  if (smallerArea <= 0) {
    return false;
  }

  return (
    boxIntersectionArea(detectionBox, anchorBox) / smallerArea >=
    SAM3_BATCH_V2_SOURCE_DETECTION_MIN_ANCHOR_OVERLAP
  );
}

function boxesAreNearDuplicates(first: BoxCoordinate, second: BoxCoordinate): boolean {
  const intersection = boxIntersectionArea(first, second);
  const union = boxArea(first) + boxArea(second) - intersection;

  return union > 0 && intersection / union >= 0.9;
}

function sourceDetectionExemplarBoxes(
  sourceResult: AssetInferenceResult | null,
  anchorBoxes: BoxCoordinate[]
): BoxCoordinate[] {
  if (!sourceResult || sourceResult.outcome !== 'success') {
    return [];
  }

  const validAnchors = anchorBoxes.filter(isValidBox);

  return sourceResult.detections
    .map((detection) => ({
      box: bboxToBoxCoordinate(detection.bbox),
      confidence: detection.confidence,
    }))
    .filter(({ box }) => isValidBox(box))
    .filter(({ box }) =>
      validAnchors.length === 0
        ? true
        : validAnchors.some((anchorBox) => boxesOverlapEnough(box, anchorBox))
    )
    .sort((left, right) => right.confidence - left.confidence)
    .slice(0, SAM3_BATCH_V2_SOURCE_DETECTION_EXEMPLAR_LIMIT)
    .map(({ box }) => box);
}

function mergeConceptExemplarBoxes(
  anchorBoxes: BoxCoordinate[],
  sourceBoxes: BoxCoordinate[]
): BoxCoordinate[] {
  const merged: BoxCoordinate[] = [];

  for (const box of [...anchorBoxes, ...sourceBoxes]) {
    if (!isValidBox(box)) {
      continue;
    }

    const duplicate = merged.some((existing) => boxesAreNearDuplicates(box, existing));
    if (!duplicate) {
      merged.push(box);
    }

    if (merged.length >= SAM3_BATCH_V2_SOURCE_DETECTION_EXEMPLAR_LIMIT) {
      break;
    }
  }

  return merged;
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
  limit = SAM3_BATCH_V2_MAX_TARGET_CANDIDATES
): SAM3ConceptDetection[] {
  const nmsThreshold =
    typeof options.nmsThreshold === 'number'
      ? options.nmsThreshold
      : SAM3_BATCH_V2_DEFAULT_NMS_THRESHOLD;
  const selected: SAM3ConceptDetection[] = [];

  for (const detection of [...detections].sort(
    (left, right) => conceptDetectionScore(right) - conceptDetectionScore(left)
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
    const normalizedCrops = normalizeExemplarCrops(data.exemplarCrops);
    let exemplarCrops = normalizedCrops;

    if (data.mode === 'visual_crop_match' && exemplarCrops.length === 0) {
      const scaled = scaleExemplarBoxes({
        exemplars: data.exemplars,
        sourceWidth: data.exemplarSourceWidth,
        sourceHeight: data.exemplarSourceHeight,
        targetWidth: sourceAsset.imageWidth || data.exemplarSourceWidth || 0,
        targetHeight: sourceAsset.imageHeight || data.exemplarSourceHeight || 0,
        jobId: data.batchJobId,
        assetId: sourceAsset.id,
      });
      exemplarCrops = await buildExemplarCrops({
        imageBuffer: sourceImageBuffer,
        boxes: scaled.boxes.length > 0 ? scaled.boxes : data.exemplars,
      });
    }

    const cropCount = data.mode === 'visual_crop_match'
      ? exemplarCrops.length || data.exemplars.length
      : data.exemplars.length;

    if (cropCount <= 0) {
      await this.appendStageLog(data.batchJobId, stageLog, {
        stage: 'prepare',
        status: 'failed',
        attempt: attemptsMade,
        errorCode: 'NO_EXEMPLARS',
        errorMessage: 'At least one exemplar is required for v2 batch processing.',
      });
      throw createNamedError(
        'PrepareFailureError',
        'At least one exemplar is required for v2 batch processing.'
      );
    }

    await this.appendStageLog(data.batchJobId, stageLog, {
      stage: 'prepare',
      status: 'completed',
      attempt: attemptsMade,
      totalAssets: data.assetIds.length,
      cropCount,
      operatorCropCount: data.mode === 'visual_crop_match' ? exemplarCrops.length : 0,
      visualCropSource: data.mode === 'visual_crop_match' ? 'operator' : undefined,
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
      assets: orderedAssets,
      missingAssetIds,
      cropCount,
      operatorCropCount: data.mode === 'visual_crop_match' ? exemplarCrops.length : 0,
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

    const estimate = estimatePeakGpuMemoryMb(prepared.cropCount);

    await this.appendStageLog(prepared.batchJobId, stageLog, {
      stage: 'estimate',
      status: 'completed',
      attempt: attemptsMade,
      cropCount: prepared.cropCount,
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

    await this.appendStageLog(batchJobId, stageLog, {
      stage: 'run_sam3',
      status: 'started',
      attempt: attemptsMade,
      totalAssets: prepared.assets.length + prepared.missingAssetIds.length,
    });
    await this.appendStageLog(batchJobId, stageLog, {
      stage: 'persist',
      status: 'started',
      attempt: attemptsMade,
      totalAssets: prepared.assets.length + prepared.missingAssetIds.length,
    });

    let conceptExemplarId: string | null = null;
    if (prepared.mode === 'concept_propagation') {
      const warmup = await this.awsSam3Service.warmupConceptService();
      if (!warmup.success) {
        throw createNamedError(
          'InferenceFailureError',
          warmup.error || 'Failed to warm up concept propagation service.'
        );
      }

      const exemplarResult = await this.awsSam3Service.createConceptExemplar({
        imageBuffer: prepared.sourceImageBuffer,
        boxes: prepared.exemplars,
        className: prepared.weedType,
        imageId: prepared.sourceAssetId,
      });

      if (!exemplarResult.success || !exemplarResult.data?.exemplarId) {
        throw createNamedError(
          'InferenceFailureError',
          exemplarResult.error || 'Failed to create concept exemplar.'
        );
      }

      conceptExemplarId = exemplarResult.data.exemplarId;
      await this.prisma.batchJob.update({
        where: { id: batchJobId },
        data: {
          exemplarId: conceptExemplarId,
          sourceAssetId: prepared.sourceAssetId,
        },
      });
    }

    const assetsToProcess = [...prepared.assets].sort((left, right) => {
      if (left.id === prepared.sourceAssetId) return -1;
      if (right.id === prepared.sourceAssetId) return 1;
      return 0;
    });
    let activeVisualCrops = prepared.exemplarCrops;
    let visualCropSource: Sam3BatchV2StageLogEntry['visualCropSource'] = 'operator';
    let sourceDetectionCropCount = 0;

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
        const isSourceAsset = asset.id === prepared.sourceAssetId;

        if (prepared.mode === 'visual_crop_match') {
          if (isSourceAsset) {
            result = await this.runSourceBoxMatch(asset, imageBuffer, prepared);
            const sourceCrops = await this.buildSourceDetectionVisualCrops(
              imageBuffer,
              result
            );
            sourceDetectionCropCount = sourceCrops.length;
            if (sourceCrops.length > 0) {
              activeVisualCrops = sourceCrops;
              visualCropSource = 'source_detections';
            }
          } else {
            result = await this.runVisualCropMatch(
              asset,
              imageBuffer,
              prepared,
              activeVisualCrops
            );
          }
        } else {
          result = await this.runConceptPropagation(asset, imageBuffer, conceptExemplarId, prepared.weedType);
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
          cropCount: prepared.mode === 'visual_crop_match' ? activeVisualCrops.length : undefined,
          operatorCropCount: prepared.mode === 'visual_crop_match' ? prepared.operatorCropCount : undefined,
          sourceDetectionCropCount: prepared.mode === 'visual_crop_match' ? sourceDetectionCropCount : undefined,
          visualCropSource: prepared.mode === 'visual_crop_match' ? visualCropSource : undefined,
          durationMs: this.now().getTime() - runStartedAt,
        });
      } catch (error) {
        result = {
          assetId: asset.id,
          detections: [],
          outcome: 'prepare_error',
          errorCode: 'ASSET_FETCH_FAILED',
          errorMessage: error instanceof Error ? error.message : 'Failed to fetch asset image.',
        };

        await this.appendStageLog(batchJobId, stageLog, {
          stage: 'prepare',
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

  private async initializeVisualMatchExemplar(
    prepared: PreparedBatchContext,
    sourceResult: AssetInferenceResult | null
  ): Promise<string | null> {
    const warmup = await this.awsSam3Service.warmupConceptService();
    if (!warmup.success) {
      return null;
    }

    const sourceBoxes = sourceDetectionExemplarBoxes(sourceResult, prepared.exemplars);
    const conceptBoxes = mergeConceptExemplarBoxes(prepared.exemplars, sourceBoxes);
    const exemplarResult = await this.awsSam3Service.createConceptExemplar({
      imageBuffer: prepared.sourceImageBuffer,
      boxes: conceptBoxes.length > 0 ? conceptBoxes : prepared.exemplars,
      className: prepared.textPrompt,
      imageId: prepared.sourceAssetId,
    });

    if (!exemplarResult.success || !exemplarResult.data?.exemplarId) {
      return null;
    }

    return exemplarResult.data.exemplarId;
  }

  private async runSourceBoxMatch(
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
        errorMessage: 'Source exemplar boxes could not be scaled for the source asset.',
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
        errorCode: result.errorCode || 'SAM3_SOURCE_MATCH_FAILED',
        errorMessage: result.error || 'SAM3 source-image box matching failed.',
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

  private async buildSourceDetectionVisualCrops(
    sourceImageBuffer: Buffer,
    sourceResult: AssetInferenceResult
  ): Promise<string[]> {
    if (sourceResult.outcome !== 'success' || sourceResult.detections.length === 0) {
      return [];
    }

    try {
      return await buildExemplarCropsFromDetections({
        imageBuffer: sourceImageBuffer,
        detections: sourceResult.detections,
        maxCrops: SAM3_VISUAL_SOURCE_CROP_MAX,
        minConfidence: SAM3_VISUAL_SOURCE_CROP_MIN_CONFIDENCE,
        paddingRatio: SAM3_VISUAL_SOURCE_CROP_PADDING,
        maskPolygons: true,
      });
    } catch (error) {
      console.warn(
        '[SAM3 V2] Failed to build source-derived visual crops:',
        error instanceof Error ? error.message : error
      );
      return [];
    }
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
    };
  }

  private async runVisualConceptMatch(
    asset: AssetRecord,
    imageBuffer: Buffer,
    exemplarId: string,
    className: string
  ): Promise<AssetInferenceResult> {
    const conceptOptions = buildBatchV2ConceptApplyOptions();
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

    const candidates = await this.getConceptCandidatesWithFallback({
      asset,
      imageBuffer,
      exemplarId,
      primaryDetections: result.data.detections,
      primaryOptions: conceptOptions,
      failureCode: 'VISUAL_MATCH_EXEMPLAR_FALLBACK_FAILED',
    });
    const detections = await this.refineConceptDetectionsWithBoxPrompts(
      asset,
      imageBuffer,
      className,
      candidates
    );

    return {
      assetId: asset.id,
      detections,
      outcome: detections.length > 0 ? 'success' : 'zero_detections',
    };
  }

  private async runConceptPropagation(
    asset: AssetRecord,
    imageBuffer: Buffer,
    conceptExemplarId: string | null,
    weedType: string
  ): Promise<AssetInferenceResult> {
    if (!conceptExemplarId) {
      return {
        assetId: asset.id,
        detections: [],
        outcome: 'inference_error',
        errorCode: 'EXEMPLAR_MISSING',
        errorMessage: 'Concept exemplar was not created for this batch.',
      };
    }

    const conceptOptions = buildBatchV2ConceptApplyOptions();
    const result = await this.awsSam3Service.applyConceptExemplar({
      exemplarId: conceptExemplarId,
      imageBuffer,
      imageId: asset.id,
      options: conceptOptions,
    });

    if (!result.success || !result.data) {
      return {
        assetId: asset.id,
        detections: [],
        outcome: classifyInferenceFailure(result.errorCode, result.error),
        errorCode: result.errorCode || 'CONCEPT_INFERENCE_FAILED',
        errorMessage: result.error || `Concept propagation failed for ${weedType}.`,
      };
    }

    const candidates = await this.getConceptCandidatesWithFallback({
      asset,
      imageBuffer,
      exemplarId: conceptExemplarId,
      primaryDetections: result.data.detections,
      primaryOptions: conceptOptions,
      failureCode: 'CONCEPT_FALLBACK_FAILED',
    });
    const detections = await this.refineConceptDetectionsWithBoxPrompts(
      asset,
      imageBuffer,
      weedType,
      candidates
    );

    return {
      assetId: asset.id,
      detections,
      outcome: detections.length > 0 ? 'success' : 'zero_detections',
    };
  }

  private async getConceptCandidatesWithFallback({
    asset,
    imageBuffer,
    exemplarId,
    primaryDetections,
    primaryOptions,
    failureCode,
  }: {
    asset: AssetRecord;
    imageBuffer: Buffer;
    exemplarId: string;
    primaryDetections: SAM3ConceptDetection[];
    primaryOptions: SAM3ConceptApplyOptions;
    failureCode: string;
  }): Promise<SAM3ConceptDetection[]> {
    const primaryCandidates = filterBatchV2ConceptDetections(primaryDetections, primaryOptions);
    if (primaryCandidates.length >= SAM3_BATCH_V2_MIN_TARGET_CANDIDATES) {
      return dedupeAndLimitConceptDetections(primaryCandidates, primaryOptions);
    }

    const fallbackOptions = buildBatchV2ConceptFallbackApplyOptions();
    const fallbackResult = await this.awsSam3Service.applyConceptExemplar({
      exemplarId,
      imageBuffer,
      imageId: asset.id,
      options: fallbackOptions,
    });

    if (!fallbackResult.success || !fallbackResult.data) {
      const code = fallbackResult.errorCode || failureCode;
      const message = fallbackResult.error ? ` ${fallbackResult.error}` : '';
      console.warn(
        `[SAM3 V2] Target fallback matching failed for ${asset.id}: ${code}${message}`
      );
      return dedupeAndLimitConceptDetections(primaryCandidates, primaryOptions);
    }

    const fallbackCandidates = filterBatchV2ConceptDetections(
      fallbackResult.data.detections,
      fallbackOptions
    );
    const mergedCandidates = dedupeAndLimitConceptDetections(
      [...primaryCandidates, ...fallbackCandidates],
      fallbackOptions
    );

    if (fallbackCandidates.length > 0) {
      console.warn(
        `[SAM3 V2] Target ${asset.id} used fallback concept threshold ` +
          `${fallbackOptions.similarityThreshold} after strict threshold ` +
          `${primaryOptions.similarityThreshold} returned ${primaryCandidates.length} ` +
          `candidate(s), below target floor ${SAM3_BATCH_V2_MIN_TARGET_CANDIDATES}.`
      );
    }

    return mergedCandidates;
  }

  private async refineConceptDetectionsWithBoxPrompts(
    asset: AssetRecord,
    imageBuffer: Buffer,
    className: string,
    candidates: SAM3ConceptDetection[]
  ): Promise<AssetInferenceResult['detections']> {
    if (candidates.length === 0) {
      return [];
    }

    const resized = await this.awsSam3Service.resizeImage(imageBuffer);
    const boxes = candidates
      .map((candidate) => bboxToBoxCoordinate(candidate.bbox, resized.scaling.scaleFactor))
      .filter(isValidBox);

    if (boxes.length === 0) {
      return [];
    }

    const result = await this.awsSam3Service.segment({
      image: resized.buffer.toString('base64'),
      boxes,
      className,
    });

    if (!result.success || !result.response || result.response.detections.length === 0) {
      console.warn(
        `[SAM3 V2] Target box refinement failed for ${asset.id}; falling back to concept candidates.`
      );
      return candidates.map(mapConceptDetectionToAssetDetection);
    }

    const matchedCandidateKeys = new Set<string>();
    const refinedDetections = result.response.detections.flatMap((detection) => {
      const bbox = scaleBboxToOriginal(detection.bbox, resized.scaling.scaleFactor);
      const sourceCandidateMatch = bestConceptCandidateMatchForBbox(bbox, candidates);
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

    const unmatchedCandidates = candidates
      .filter((candidate) => !matchedCandidateKeys.has(conceptCandidateKey(candidate)))
      .map(mapConceptDetectionToAssetDetection);

    if (refinedDetections.length === 0) {
      console.warn(
        `[SAM3 V2] Target box refinement drifted away from candidates for ${asset.id}; ` +
          'falling back to concept candidates.'
      );
      return candidates.map(mapConceptDetectionToAssetDetection);
    }

    return [...refinedDetections, ...unmatchedCandidates];
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
