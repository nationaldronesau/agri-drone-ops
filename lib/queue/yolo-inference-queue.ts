import { Queue } from 'bullmq';
import { createRedisConnection, QUEUE_PREFIX } from './redis';

export interface YoloInferenceJobData {
  jobId: string;
}

export interface YoloInferenceJobResult {
  processedImages: number;
  detectionsFound: number;
  errors: string[];
}

export const YOLO_INFERENCE_QUEUE_NAME = 'yolo-inference-jobs';

let yoloInferenceQueue: Queue<YoloInferenceJobData, YoloInferenceJobResult> | null = null;

export function getYoloInferenceQueue(): Queue<YoloInferenceJobData, YoloInferenceJobResult> {
  if (!yoloInferenceQueue) {
    yoloInferenceQueue = new Queue<YoloInferenceJobData, YoloInferenceJobResult>(
      YOLO_INFERENCE_QUEUE_NAME,
      {
        connection: createRedisConnection(),
        prefix: QUEUE_PREFIX,
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
      }
    );
  }
  return yoloInferenceQueue;
}

export async function enqueueYoloInferenceJob(jobId: string): Promise<string> {
  const queue = getYoloInferenceQueue();
  const job = await queue.add('process-yolo-inference', { jobId }, { jobId });
  return job.id || jobId;
}

export async function removeYoloInferenceJob(jobId: string): Promise<void> {
  const queue = getYoloInferenceQueue();
  await queue.remove(jobId);
}
