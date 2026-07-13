import { describe, expect, it } from 'vitest';
import {
  describeTeachBatchStage,
  getTeachBatchProgress,
  isTeachBatchTerminal,
  parseTeachBatchRun,
} from '@/lib/utils/teach-batch-run';

describe('Teach batch run utilities', () => {
  it('restores only traceable v2 batch records', () => {
    expect(parseTeachBatchRun(JSON.stringify({
      batchJobId: 'batch-1',
      pollUrl: '/api/sam3/v2/batch/batch-1',
      projectId: 'project-1',
      target: 'Lantana',
      submittedAt: '2026-07-13T00:00:00.000Z',
      reviewSessionId: 'review-1',
    }))).toMatchObject({ batchJobId: 'batch-1', reviewSessionId: 'review-1' });

    expect(parseTeachBatchRun(JSON.stringify({
      batchJobId: 'batch-1',
      pollUrl: 'https://untrusted.example/batch-1',
      projectId: 'project-1',
      target: 'Lantana',
      submittedAt: '2026-07-13T00:00:00.000Z',
    }))).toBeNull();

    expect(parseTeachBatchRun(JSON.stringify({
      batchJobId: 'batch-1',
      pollUrl: '/api/sam3/v2/batch/batch-1/../../review',
      projectId: 'project-1',
      target: 'Lantana',
      submittedAt: '2026-07-13T00:00:00.000Z',
    }))).toBeNull();
  });

  it('clamps progress and identifies terminal states', () => {
    expect(getTeachBatchProgress(45, 100)).toBe(45);
    expect(getTeachBatchProgress(120, 100)).toBe(100);
    expect(getTeachBatchProgress(1, 0)).toBe(0);
    expect(isTeachBatchTerminal('COMPLETED')).toBe(true);
    expect(isTeachBatchTerminal('PROCESSING')).toBe(false);
  });

  it('translates technical stages into operator language', () => {
    expect(describeTeachBatchStage({
      id: 'batch-1',
      projectId: 'project-1',
      weedType: 'Lantana',
      status: 'PROCESSING',
      processedImages: 17,
      totalImages: 100,
      detectionsFound: 41,
      latestStage: 'run_sam3',
    })).toBe('Searching image 18 of 100');
  });
});
