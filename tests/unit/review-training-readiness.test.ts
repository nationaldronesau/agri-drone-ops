import { describe, expect, it, vi } from 'vitest';
import { resolveTrainingReadyAssetIds } from '@/lib/services/review-training-readiness';

describe('review training readiness', () => {
  it('leaves non-batch review assets unchanged', async () => {
    const findMany = vi.fn();
    const result = await resolveTrainingReadyAssetIds(
      { pendingAnnotation: { findMany } },
      { workflowType: 'standard_review' },
      ['asset-a', 'asset-b']
    );

    expect(result).toEqual(['asset-a', 'asset-b']);
    expect(findMany).not.toHaveBeenCalled();
  });

  it('excludes batch images that still contain pending suggestions', async () => {
    const findMany = vi.fn().mockResolvedValue([
      { assetId: 'asset-a' },
      { assetId: 'asset-c' },
    ]);
    const result = await resolveTrainingReadyAssetIds(
      { pendingAnnotation: { findMany } },
      { workflowType: 'batch_review', batchJobIds: ['batch-1'] },
      ['asset-a', 'asset-b', 'asset-c']
    );

    expect(result).toEqual(['asset-b']);
    expect(findMany).toHaveBeenCalledWith({
      where: {
        assetId: { in: ['asset-a', 'asset-b', 'asset-c'] },
        batchJobId: { in: ['batch-1'] },
        status: 'PENDING',
      },
      select: { assetId: true },
      distinct: ['assetId'],
    });
  });

  it('fails closed for old batch sessions without job scope', async () => {
    const findMany = vi.fn();
    const result = await resolveTrainingReadyAssetIds(
      { pendingAnnotation: { findMany } },
      { workflowType: 'batch_review', batchJobIds: [] },
      ['asset-a']
    );

    expect(result).toEqual([]);
    expect(findMany).not.toHaveBeenCalled();
  });
});
