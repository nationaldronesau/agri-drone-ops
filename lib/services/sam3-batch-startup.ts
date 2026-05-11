export const VISUAL_CROP_BATCH_AWS_START_FAILURE_MESSAGE =
  'AWS SAM3 failed to start for visual crop batch processing. Please verify the dedicated EC2 host and runtime AWS permissions, then retry.';

interface EnsureVisualCropBatchAwsReadyOptions {
  batchJobId: string;
  useSegmentCrops: boolean;
  waitForAwsReady: () => Promise<boolean>;
  logger?: Pick<Console, 'log' | 'error'>;
}

export async function ensureVisualCropBatchAwsReady(
  options: EnsureVisualCropBatchAwsReadyOptions
): Promise<{ ok: true } | { ok: false; errorMessage: string; errorCode: 'AWS_START_FAILED' }> {
  if (!options.useSegmentCrops) {
    return { ok: true };
  }

  options.logger?.log(
    `[SAM3 Batch] Job ${options.batchJobId}: Preflighting AWS SAM3 startup before visual crop processing`
  );

  const awsReady = await options.waitForAwsReady();
  if (awsReady) {
    return { ok: true };
  }

  options.logger?.error(
    `[SAM3 Batch] Job ${options.batchJobId}: AWS SAM3 preflight failed before visual crop processing`
  );

  return {
    ok: false,
    errorCode: 'AWS_START_FAILED',
    errorMessage: VISUAL_CROP_BATCH_AWS_START_FAILURE_MESSAGE,
  };
}
