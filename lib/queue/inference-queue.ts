/**
 * YOLO Inference Processing Queue
 *
 * Defines the job queue for batch inference jobs.
 * Jobs are processed by workers/inference-worker.ts
 */
import { Queue } from 'bullmq';
import { createRedisConnection, QUEUE_PREFIX } from './redis';

export interface InferenceJobData {
  processingJobId: string;
  modelId: string;
  modelName: string;
  projectId: string;
  assetIds: string[];
  confidence: number;
  saveDetections: boolean;
}

export interface InferenceJobResult {
  processedImages: number;
  detectionsFound: number;
  skippedImages: number;
  duplicateImages: number;
  errors: string[];
}

export const INFERENCE_QUEUE_NAME = 'yolo-inference-processing';

let inferenceQueue: Queue<InferenceJobData, InferenceJobResult> | null = null;

export function getInferenceQueue(): Queue<InferenceJobData, InferenceJobResult> {
  if (!inferenceQueue) {
    inferenceQueue = new Queue<InferenceJobData, InferenceJobResult>(INFERENCE_QUEUE_NAME, {
      connection: createRedisConnection(),
      prefix: QUEUE_PREFIX, // Hash tag prefix for Redis Cluster compatibility
      defaultJobOptions: {
        attempts: 2,
        backoff: {
          type: 'exponential',
          delay: 5000,
        },
        removeOnComplete: {
          age: 24 * 60 * 60,
          count: 500,
        },
        removeOnFail: {
          age: 7 * 24 * 60 * 60,
        },
      },
    });
  }
  return inferenceQueue;
}

export async function enqueueInferenceJob(data: InferenceJobData): Promise<string> {
  const queue = getInferenceQueue();
  const job = await queue.add('process-inference', data, {
    jobId: data.processingJobId,
  });
  return job.id || data.processingJobId;
}

export async function removeInferenceJob(jobId: string): Promise<void> {
  const queue = getInferenceQueue();
  await queue.remove(jobId);
}

export async function getInferenceQueueStats() {
  const queue = getInferenceQueue();
  const [waiting, active, completed, failed] = await Promise.all([
    queue.getWaitingCount(),
    queue.getActiveCount(),
    queue.getCompletedCount(),
    queue.getFailedCount(),
  ]);
  return { waiting, active, completed, failed };
}
