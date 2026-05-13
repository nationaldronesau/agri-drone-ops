import { describe, expect, it } from 'vitest';
import {
  chunkAssetIds,
  guardLegacySam3BatchScope,
  summarizeChildBatchJobs,
} from '@/lib/utils/sam3-batch-jobs';

describe('sam3-batch-job-utils', () => {
  it.each([
    [1, [1]],
    [10, [10]],
    [500, [500]],
    [501, [500, 1]],
    [2200, [500, 500, 500, 500, 200]],
  ])('chunks %i-image v2 dataset runs deterministically', (assetCount, expectedSizes) => {
    const assetIds = Array.from({ length: assetCount }, (_, index) => `asset-${index + 1}`);

    const chunks = chunkAssetIds(assetIds, 500);

    expect(chunks.map((chunk) => chunk.length)).toEqual(expectedSizes);
    expect(chunks.flat()).toEqual(assetIds);
  });

  it('chunks a 2200-image dataset into deterministic 500-image shards', () => {
    const assetIds = Array.from({ length: 2200 }, (_, index) => `asset-${index + 1}`);

    const chunks = chunkAssetIds(assetIds, 500);

    expect(chunks).toHaveLength(5);
    expect(chunks.map((chunk) => chunk.length)).toEqual([500, 500, 500, 500, 200]);
    expect(chunks[0][0]).toBe('asset-1');
    expect(chunks[4][199]).toBe('asset-2200');
  });

  it('blocks project-wide legacy SAM3 batch calls before they can silently run', () => {
    expect(guardLegacySam3BatchScope(undefined)).toEqual({
      allowed: false,
      response: {
        success: false,
        error: 'Multi-image Apply to Dataset requires SAM3 v2 visual matching.',
        requiresV2: true,
        recommendedEndpoint: '/api/sam3/v2/batch',
      },
    });
  });

  it('blocks multi-asset legacy SAM3 batch calls before they can silently run', () => {
    expect(guardLegacySam3BatchScope(['asset-1', 'asset-2'])).toMatchObject({
      allowed: false,
      response: {
        requiresV2: true,
        recommendedEndpoint: '/api/sam3/v2/batch',
      },
    });
  });

  it('allows only a single explicit legacy SAM3 debug asset', () => {
    expect(guardLegacySam3BatchScope(['asset-1'])).toEqual({ allowed: true });
  });

  it('summarizes mixed shard outcomes as a completed dataset run with warnings', () => {
    const summary = summarizeChildBatchJobs([
      {
        id: 'shard-1',
        status: 'COMPLETED',
        processedImages: 500,
        totalImages: 500,
        detectionsFound: 22,
        shardIndex: 1,
        shardCount: 5,
        latestStage: 'persist',
        latestStageTimestamp: '2026-04-22T01:00:00.000Z',
        terminalState: 'completed',
      },
      {
        id: 'shard-2',
        status: 'FAILED',
        processedImages: 120,
        totalImages: 500,
        detectionsFound: 4,
        errorMessage: 'GPU busy',
        shardIndex: 2,
        shardCount: 5,
        latestStage: 'run_sam3',
        latestStageTimestamp: '2026-04-22T01:01:00.000Z',
        terminalState: 'failed_inference',
      },
    ]);

    expect(summary.status).toBe('COMPLETED');
    expect(summary.completedWithWarnings).toBe(true);
    expect(summary.completedShards).toBe(1);
    expect(summary.failedShards).toBe(1);
    expect(summary.processedImages).toBe(620);
    expect(summary.totalImages).toBe(1000);
    expect(summary.detectionsFound).toBe(26);
    expect(summary.terminalState).toBe('completed_partial');
    expect(summary.latestStage).toBe('run_sam3');
    expect(summary.childStatuses.map((child) => child.id)).toEqual(['shard-1', 'shard-2']);
    expect(summary.errorMessage).toContain('1 shard failed');
  });
});
