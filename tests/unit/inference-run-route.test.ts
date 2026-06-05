import { describe, expect, it } from 'vitest';
import { shouldRunInferenceSynchronously } from '@/app/api/inference/run/route';

describe('inference run route sync policy', () => {
  it('queues project-level runs even when the project has a small image count', () => {
    expect(
      shouldRunInferenceSynchronously({
        totalImages: 10,
        explicitAssetSelection: false,
        maxSyncImages: 50,
      })
    ).toBe(false);
  });

  it('preserves synchronous processing for one explicit asset', () => {
    expect(
      shouldRunInferenceSynchronously({
        totalImages: 1,
        explicitAssetSelection: true,
        maxSyncImages: 1,
      })
    ).toBe(true);
  });

  it('queues multi-asset explicit runs by default', () => {
    expect(
      shouldRunInferenceSynchronously({
        totalImages: 2,
        explicitAssetSelection: true,
        maxSyncImages: 1,
      })
    ).toBe(false);
  });
});
