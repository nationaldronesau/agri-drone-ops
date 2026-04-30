export const REVIEWABLE_BATCH_JOB_STATUSES = new Set([
  'COMPLETED',
  'FAILED',
  'CANCELLED',
]);

export function isBatchReviewReadyStatus(status: string | null | undefined): boolean {
  return typeof status === 'string' && REVIEWABLE_BATCH_JOB_STATUSES.has(status);
}
