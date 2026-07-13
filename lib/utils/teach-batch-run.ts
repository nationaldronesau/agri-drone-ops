import type { Sam3BatchExecutionSummary } from '@/lib/utils/sam3-batch-execution';

export const TEACH_BATCH_RUN_STORAGE_KEY = 'agri:teach-batch-run:v1';

export interface TeachBatchRun {
  batchJobId: string;
  pollUrl: string;
  projectId: string;
  target: string;
  submittedAt: string;
  reviewSessionId?: string;
}

export interface TeachBatchJobStatus {
  id: string;
  projectId: string;
  weedType: string;
  status: string;
  mode?: string | null;
  processedImages: number;
  totalImages: number;
  detectionsFound: number;
  errorMessage?: string | null;
  latestStage?: string | null;
  terminalState?: string | null;
  completedWithWarnings?: boolean;
}

export interface TeachBatchStatusResponse {
  batchJob: TeachBatchJobStatus;
  summary?: {
    total: number;
    pending: number;
    accepted: number;
    rejected: number;
  };
  execution?: Sam3BatchExecutionSummary;
}

export function parseTeachBatchRun(value: string | null): TeachBatchRun | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Partial<TeachBatchRun>;
    const expectedPollUrl = typeof parsed.batchJobId === 'string'
      ? `/api/sam3/v2/batch/${parsed.batchJobId}`
      : null;
    if (
      typeof parsed.batchJobId !== 'string' ||
      !/^[A-Za-z0-9_-]+$/.test(parsed.batchJobId) ||
      typeof parsed.pollUrl !== 'string' ||
      parsed.pollUrl !== expectedPollUrl ||
      typeof parsed.projectId !== 'string' ||
      typeof parsed.target !== 'string' ||
      typeof parsed.submittedAt !== 'string'
    ) {
      return null;
    }
    return {
      batchJobId: parsed.batchJobId,
      pollUrl: parsed.pollUrl,
      projectId: parsed.projectId,
      target: parsed.target,
      submittedAt: parsed.submittedAt,
      ...(typeof parsed.reviewSessionId === 'string'
        ? { reviewSessionId: parsed.reviewSessionId }
        : {}),
    };
  } catch {
    return null;
  }
}

export function isTeachBatchTerminal(status: string | null | undefined): boolean {
  return Boolean(status && ['COMPLETED', 'FAILED', 'CANCELLED'].includes(status));
}

export function getTeachBatchProgress(processed: number, total: number): number {
  if (!Number.isFinite(processed) || !Number.isFinite(total) || total <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((processed / total) * 100)));
}

export function describeTeachBatchStage(status: TeachBatchJobStatus): string {
  if (status.status === 'QUEUED') return 'Waiting for an inference worker';
  if (status.status === 'FAILED') return 'Search failed';
  if (status.status === 'CANCELLED') return 'Search cancelled';
  if (status.status === 'COMPLETED') {
    return status.completedWithWarnings ? 'Ready for review with warnings' : 'Ready for review';
  }

  switch (status.latestStage) {
    case 'prepare':
      return 'Preparing source examples';
    case 'estimate':
      return 'Checking processing requirements';
    case 'admit':
      return 'Waiting for GPU capacity';
    case 'run_sam3':
      return `Searching image ${Math.min(status.processedImages + 1, status.totalImages)} of ${status.totalImages}`;
    case 'persist':
      return 'Preparing review suggestions';
    default:
      return 'Searching the image batch';
  }
}
