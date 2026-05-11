import { describe, expect, it } from 'vitest';
import {
  chunkAssetIds,
  summarizeChildBatchJobs,
} from '@/lib/utils/sam3-batch-jobs';

describe('sam3-batch-job-utils', () => {
  it('chunks a 2200-image dataset into deterministic 500-image shards', () => {
    const assetIds = Array.from({ length: 2200 }, (_, index) => `asset-${index + 1}`);

    const chunks = chunkAssetIds(assetIds, 500);

    expect(chunks).toHaveLength(5);
    expect(chunks.map((chunk) => chunk.length)).toEqual([500, 500, 500, 500, 200]);
    expect(chunks[0][0]).toBe('asset-1');
    expect(chunks[4][199]).toBe('asset-2200');
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
