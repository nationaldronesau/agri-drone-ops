/**
 * SAM3 Batch Processing Queue
 *
 * Defines the job queue for processing batch SAM3 detection jobs.
 * Jobs are processed by the worker in workers/batch-worker.ts
 */
import { Queue } from 'bullmq';
import { createRedisConnection } from './redis';

// Job data structure
export interface BatchJobData {
  batchJobId: string;
  projectId: string;
  weedType: string;
  exemplars: Array<{
    x1: number;
    y1: number;
    x2: number;
    y2: number;
  }>;
  textPrompt?: string;
  assetIds: string[];
}

// Job result structure
export interface BatchJobResult {
  processedImages: number;
  detectionsFound: number;
  errors: string[];
}

// Queue name
export const BATCH_QUEUE_NAME = 'sam3-batch-processing';

// Create queue instance (lazy initialization)
let batchQueue: Queue<BatchJobData, BatchJobResult> | null = null;

export function getBatchQueue(): Queue<BatchJobData, BatchJobResult> {
  if (!batchQueue) {
    batchQueue = new Queue<BatchJobData, BatchJobResult>(BATCH_QUEUE_NAME, {
      connection: createRedisConnection(),
      defaultJobOptions: {
        attempts: 3,
        backoff: {
          type: 'exponential',
          delay: 5000,
        },
        removeOnComplete: {
          age: 24 * 60 * 60, // Keep completed jobs for 24 hours
          count: 1000,
        },
        removeOnFail: {
          age: 7 * 24 * 60 * 60, // Keep failed jobs for 7 days
        },
      },
    });
  }
  return batchQueue;
}

// Add a batch job to the queue
export async function enqueueBatchJob(data: BatchJobData): Promise<string> {
  const queue = getBatchQueue();
  const job = await queue.add('process-batch', data, {
    jobId: data.batchJobId, // Use the batch job ID as the queue job ID
  });
  return job.id || data.batchJobId;
}

// Get queue statistics
export async function getQueueStats() {
  const queue = getBatchQueue();
  const [waiting, active, completed, failed] = await Promise.all([
    queue.getWaitingCount(),
    queue.getActiveCount(),
    queue.getCompletedCount(),
    queue.getFailedCount(),
  ]);
  return { waiting, active, completed, failed };
}
