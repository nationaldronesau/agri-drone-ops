export const SAM3_BATCH_JOB_KINDS = {
  SINGLE: 'SINGLE',
  AGGREGATE: 'AGGREGATE',
  SHARD: 'SHARD',
} as const;

export type Sam3BatchJobKind =
  (typeof SAM3_BATCH_JOB_KINDS)[keyof typeof SAM3_BATCH_JOB_KINDS];

export const SAM3_V2_BATCH_ENDPOINT = '/api/sam3/v2/batch';

export const LEGACY_SAM3_REQUIRES_V2_MESSAGE =
  'Multi-image Apply to Dataset requires SAM3 v2 visual matching.';

export interface LegacySam3BatchGuardResult {
  allowed: boolean;
  response?: {
    success: false;
    error: string;
    requiresV2: true;
    recommendedEndpoint: typeof SAM3_V2_BATCH_ENDPOINT;
  };
}

export function guardLegacySam3BatchScope(
  assetIds: string[] | undefined | null
): LegacySam3BatchGuardResult {
  if (Array.isArray(assetIds) && assetIds.length === 1) {
    return { allowed: true };
  }

  return {
    allowed: false,
    response: {
      success: false,
      error: LEGACY_SAM3_REQUIRES_V2_MESSAGE,
      requiresV2: true,
      recommendedEndpoint: SAM3_V2_BATCH_ENDPOINT,
    },
  };
}

export interface BatchJobChildSnapshot {
  id: string;
  status: string;
  processedImages: number;
  totalImages: number;
  detectionsFound: number;
  errorMessage?: string | null;
  shardIndex?: number | null;
  shardCount?: number | null;
  latestStage?: string | null;
  latestStageTimestamp?: string | null;
  terminalState?: string | null;
}

export interface BatchJobChildStatus {
  id: string;
  status: string;
  processedImages: number;
  totalImages: number;
  shardIndex: number | null;
  shardCount: number | null;
  errorMessage: string | null;
}

export interface BatchJobChildAggregateSummary {
  status: 'QUEUED' | 'PROCESSING' | 'COMPLETED' | 'FAILED' | 'CANCELLED';
  processedImages: number;
  totalImages: number;
  detectionsFound: number;
  completedShards: number;
  failedShards: number;
  completedWithWarnings: boolean;
  errorMessage: string | null;
  terminalState: string | null;
  latestStage: string | null;
  childStatuses: BatchJobChildStatus[];
}

const TERMINAL_BATCH_JOB_STATUSES = new Set(['COMPLETED', 'FAILED', 'CANCELLED']);

export function isTerminalBatchJobStatus(status: string): boolean {
  return TERMINAL_BATCH_JOB_STATUSES.has(status);
}

export function chunkAssetIds(assetIds: string[], chunkSize: number): string[][] {
  if (!Number.isFinite(chunkSize) || chunkSize <= 0) {
    throw new Error('chunkSize must be a positive integer');
  }

  const chunks: string[][] = [];
  for (let index = 0; index < assetIds.length; index += chunkSize) {
    chunks.push(assetIds.slice(index, index + chunkSize));
  }
  return chunks;
}

function summarizeChildFailures(children: BatchJobChildSnapshot[]): string | null {
  const failed = children.filter(
    (child) => child.status === 'FAILED' || child.status === 'CANCELLED'
  );

  if (failed.length === 0) {
    return null;
  }

  const failedCount = failed.filter((child) => child.status === 'FAILED').length;
  const cancelledCount = failed.filter((child) => child.status === 'CANCELLED').length;
  const parts: string[] = [];

  if (failedCount > 0) {
    parts.push(`${failedCount} shard${failedCount === 1 ? '' : 's'} failed`);
  }
  if (cancelledCount > 0) {
    parts.push(`${cancelledCount} shard${cancelledCount === 1 ? '' : 's'} cancelled`);
  }

  const sampleMessage = failed.find((child) => child.errorMessage)?.errorMessage;
  return sampleMessage ? `${parts.join('; ')}. ${sampleMessage}` : parts.join('; ');
}

export function summarizeChildBatchJobs(
  children: BatchJobChildSnapshot[]
): BatchJobChildAggregateSummary {
  const sortedChildren = [...children].sort((left, right) => {
    const leftShard = left.shardIndex ?? Number.MAX_SAFE_INTEGER;
    const rightShard = right.shardIndex ?? Number.MAX_SAFE_INTEGER;
    if (leftShard !== rightShard) {
      return leftShard - rightShard;
    }
    return left.id.localeCompare(right.id);
  });

  const processedImages = sortedChildren.reduce(
    (sum, child) => sum + child.processedImages,
    0
  );
  const totalImages = sortedChildren.reduce((sum, child) => sum + child.totalImages, 0);
  const detectionsFound = sortedChildren.reduce(
    (sum, child) => sum + child.detectionsFound,
    0
  );
  const completedShards = sortedChildren.filter(
    (child) => child.status === 'COMPLETED'
  ).length;
  const failedShards = sortedChildren.filter(
    (child) => child.status === 'FAILED' || child.status === 'CANCELLED'
  ).length;
  const hasProcessing = sortedChildren.some((child) => child.status === 'PROCESSING');
  const hasQueued = sortedChildren.some((child) => child.status === 'QUEUED');

  let status: BatchJobChildAggregateSummary['status'] = 'QUEUED';
  if (hasProcessing) {
    status = 'PROCESSING';
  } else if (hasQueued) {
    status = completedShards > 0 || failedShards > 0 ? 'PROCESSING' : 'QUEUED';
  } else if (failedShards === 0 && completedShards > 0) {
    status = 'COMPLETED';
  } else if (completedShards > 0) {
    status = 'COMPLETED';
  } else if (
    sortedChildren.length > 0 &&
    sortedChildren.every((child) => child.status === 'CANCELLED')
  ) {
    status = 'CANCELLED';
  } else if (failedShards > 0) {
    status = 'FAILED';
  }

  const latestStageEntry = [...sortedChildren]
    .filter((child) => child.latestStage && child.latestStageTimestamp)
    .sort((left, right) =>
      (right.latestStageTimestamp || '').localeCompare(left.latestStageTimestamp || '')
    )[0];

  const allTerminal =
    sortedChildren.length > 0 &&
    sortedChildren.every((child) => isTerminalBatchJobStatus(child.status));
  const completedWithWarnings = status === 'COMPLETED' && failedShards > 0;

  let terminalState: string | null = null;
  if (allTerminal) {
    if (status === 'COMPLETED' && failedShards === 0) {
      terminalState = 'completed';
    } else if (status === 'COMPLETED') {
      terminalState = 'completed_partial';
    } else {
      terminalState =
        sortedChildren.find((child) => child.terminalState)?.terminalState ||
        'failed_inference';
    }
  }

  return {
    status,
    processedImages,
    totalImages,
    detectionsFound,
    completedShards,
    failedShards,
    completedWithWarnings,
    errorMessage: summarizeChildFailures(sortedChildren),
    terminalState,
    latestStage: latestStageEntry?.latestStage || null,
    childStatuses: sortedChildren.map((child) => ({
      id: child.id,
      status: child.status,
      processedImages: child.processedImages,
      totalImages: child.totalImages,
      shardIndex: child.shardIndex ?? null,
      shardCount: child.shardCount ?? null,
      errorMessage: child.errorMessage ?? null,
    })),
  };
}
