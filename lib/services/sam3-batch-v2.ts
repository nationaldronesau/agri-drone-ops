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
import { buildExemplarCrops, normalizeExemplarCrops } from '@/lib/utils/exemplar-crops';
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
  sourceAssetId?: string | null;
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
  projectId: string;
  weedType: string;
  mode: Sam3BatchV2Mode;
  textPrompt: string;
  sourceAssetId: string;
  sourceImageBuffer: Buffer;
  exemplars: BoxCoordinate[];
  exemplarCrops: string[];
  assets: AssetRecord[];
  missingAssetIds: string[];
  cropCount: number;
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
    const stageLog = await this.loadStageLog(batchJobId);

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

    let gpuLockToken: string | null = null;
    let gpuHeartbeat: ReturnType<typeof setInterval> | null = null;

    try {
      const prepared = await this.prepareBatch(job.data, attemptsMade, stageLog);
      const estimate = await this.estimateBatch(prepared, attemptsMade, stageLog);
      const admission = await this.admitBatch(prepared, estimate, attemptsMade, stageLog);

      if (!admission.acquired || !admission.token) {
        return this.rejectPreflight(
          batchJobId,
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

  private async loadStageLog(batchJobId: string): Promise<Sam3BatchV2StageLogEntry[]> {
    const batchJob = await this.prisma.batchJob.findUnique({
      where: { id: batchJobId },
      select: {
        stageLog: true,
      },
    });

    return parseStageLog(batchJob?.stageLog);
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
      durationMs: this.now().getTime() - startedAt,
    });

    return {
      batchJobId: data.batchJobId,
      projectId: data.projectId,
      weedType: data.weedType,
      mode: data.mode,
      textPrompt: data.textPrompt?.trim().substring(0, 100) || data.weedType,
      sourceAssetId,
      sourceImageBuffer,
      exemplars: data.exemplars,
      exemplarCrops,
      assets: orderedAssets,
      missingAssetIds,
      cropCount,
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
      await this.persistAssetResult(batchJobId, result, prepared.weedType, attemptsMade);
      await job.updateProgress(
        Math.round((results.length / (prepared.assets.length + prepared.missingAssetIds.length)) * 100)
      );
    }

    for (const asset of prepared.assets) {
      const runStartedAt = this.now().getTime();
      let result: AssetInferenceResult;

      try {
        const imageBuffer = await fetchAssetImage(asset);

        if (prepared.mode === 'visual_crop_match') {
          result = await this.runVisualCropMatch(asset, imageBuffer, prepared);
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
      await this.persistAssetResult(batchJobId, result, prepared.weedType, attemptsMade);
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

  private async runVisualCropMatch(
    asset: AssetRecord,
    imageBuffer: Buffer,
    prepared: PreparedBatchContext
  ): Promise<AssetInferenceResult> {
    const resized = await this.awsSam3Service.resizeImage(imageBuffer);
    const result = await this.awsSam3Service.segmentWithExemplars({
      image: resized.buffer.toString('base64'),
      exemplarCrops: prepared.exemplarCrops,
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

    const detections = result.response.detections.map((detection) => ({
      bbox: detection.bbox,
      polygon: normalizePolygon(detection.polygon, detection.bbox),
      confidence: detection.confidence,
    }));

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

    const result = await this.awsSam3Service.applyConceptExemplar({
      exemplarId: conceptExemplarId,
      imageBuffer,
      imageId: asset.id,
      options: { returnPolygons: true },
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

    const detections = result.data.detections.map((detection) => ({
      bbox: detection.bbox,
      polygon: normalizePolygon(detection.polygon, detection.bbox),
      confidence: detection.confidence,
      similarity: detection.similarity,
    }));

    return {
      assetId: asset.id,
      detections,
      outcome: detections.length > 0 ? 'success' : 'zero_detections',
    };
  }

  private async persistAssetResult(
    batchJobId: string,
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
