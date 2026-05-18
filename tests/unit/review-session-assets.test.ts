import { describe, expect, it, vi } from 'vitest';
import {
  resolveReviewSessionAssetIds,
  toStringArray,
} from '@/lib/services/review-session-assets';
import { isBatchReviewReadyStatus } from '@/lib/utils/batch-review';

describe('review-session-assets', () => {
  it('returns stored asset ids for non-batch sessions without querying pending annotations', async () => {
    const findMany = vi.fn();

    const assetIds = await resolveReviewSessionAssetIds(
      { pendingAnnotation: { findMany } },
      {
        workflowType: 'custom',
        assetIds: ['asset-1', 'asset-2'],
      }
    );

    expect(assetIds).toEqual(['asset-1', 'asset-2']);
    expect(findMany).not.toHaveBeenCalled();
  });

  it('keeps stored batch review assets even when only one asset has pending annotations', async () => {
    const findMany = vi.fn();

    const assetIds = await resolveReviewSessionAssetIds(
      { pendingAnnotation: { findMany } },
      {
        workflowType: 'batch_review',
        assetIds: ['asset-1', 'asset-2', 'asset-3'],
        batchJobIds: ['batch-1'],
      }
    );

    expect(findMany).not.toHaveBeenCalled();
    expect(assetIds).toEqual(['asset-1', 'asset-2', 'asset-3']);
  });

  it('falls back to pending asset ids when an old batch session has no stored asset snapshot', async () => {
    const findMany = vi.fn().mockResolvedValue([
      { assetId: 'asset-2' },
      { assetId: 'asset-5' },
      { assetId: 'asset-1' },
    ]);

    const assetIds = await resolveReviewSessionAssetIds(
      { pendingAnnotation: { findMany } },
      {
        workflowType: 'batch_review',
        assetIds: [],
        batchJobIds: ['batch-1'],
      }
    );

    expect(findMany).toHaveBeenCalledWith({
      where: {
        batchJobId: { in: ['batch-1'] },
      },
      select: { assetId: true },
      distinct: ['assetId'],
    });
    expect(assetIds).toEqual(['asset-1', 'asset-2', 'asset-5']);
  });

  it('falls back to stored asset ids when a batch session has no pending annotations yet', async () => {
    const assetIds = await resolveReviewSessionAssetIds(
      {
        pendingAnnotation: {
          findMany: vi.fn().mockResolvedValue([]),
        },
      },
      {
        workflowType: 'batch_review',
        assetIds: ['asset-7'],
        batchJobIds: ['batch-2'],
      }
    );

    expect(assetIds).toEqual(['asset-7']);
  });

  it('normalizes mixed arrays with toStringArray', () => {
    expect(toStringArray(['asset-1', 2, null, 'asset-3'])).toEqual(['asset-1', 'asset-3']);
  });

  it('only allows batch review after terminal batch states', () => {
    expect(isBatchReviewReadyStatus('COMPLETED')).toBe(true);
    expect(isBatchReviewReadyStatus('FAILED')).toBe(true);
    expect(isBatchReviewReadyStatus('CANCELLED')).toBe(true);
    expect(isBatchReviewReadyStatus('PROCESSING')).toBe(false);
    expect(isBatchReviewReadyStatus('QUEUED')).toBe(false);
    expect(isBatchReviewReadyStatus(undefined)).toBe(false);
  });
});
