import { describe, expect, it, vi } from 'vitest';
import {
  ensureVisualCropBatchAwsReady,
  VISUAL_CROP_BATCH_AWS_START_FAILURE_MESSAGE,
} from '@/lib/services/sam3-batch-startup';

describe('sam3-batch-startup', () => {
  it('skips AWS preflight when visual crops are not being used', async () => {
    const waitForAwsReady = vi.fn();

    const result = await ensureVisualCropBatchAwsReady({
      batchJobId: 'batch-1',
      useSegmentCrops: false,
      waitForAwsReady,
    });

    expect(result).toEqual({ ok: true });
    expect(waitForAwsReady).not.toHaveBeenCalled();
  });

  it('returns ok when AWS becomes ready for visual crop batches', async () => {
    const waitForAwsReady = vi.fn().mockResolvedValue(true);

    const result = await ensureVisualCropBatchAwsReady({
      batchJobId: 'batch-2',
      useSegmentCrops: true,
      waitForAwsReady,
    });

    expect(result).toEqual({ ok: true });
    expect(waitForAwsReady).toHaveBeenCalledTimes(1);
  });

  it('returns a single actionable failure when AWS does not start', async () => {
    const logger = {
      log: vi.fn(),
      error: vi.fn(),
    };

    const result = await ensureVisualCropBatchAwsReady({
      batchJobId: 'batch-3',
      useSegmentCrops: true,
      waitForAwsReady: vi.fn().mockResolvedValue(false),
      logger,
    });

    expect(result).toEqual({
      ok: false,
      errorCode: 'AWS_START_FAILED',
      errorMessage: VISUAL_CROP_BATCH_AWS_START_FAILURE_MESSAGE,
    });
    expect(logger.error).toHaveBeenCalledTimes(1);
  });
});
