import { Queue } from 'bullmq';
import { createRedisConnection, QUEUE_PREFIX } from './redis';

export type Sam3BatchV2Mode = 'visual_crop_match' | 'concept_propagation';

export interface Sam3BatchV2Box {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export interface Sam3BatchV2JobData {
  batchJobId: string;
  projectId: string;
  weedType: string;
  mode: Sam3BatchV2Mode;
  exemplars: Sam3BatchV2Box[];
  exemplarSourceWidth?: number;
  exemplarSourceHeight?: number;
  exemplarCrops?: string[];
  sourceAssetId?: string;
  textPrompt?: string;
  assetIds: string[];
}

export interface Sam3BatchV2JobResult {
  processedImages: number;
  detectionsFound: number;
  failedAssets: number;
  terminalState:
    | 'completed'
    | 'completed_partial'
    | 'rejected_preflight'
    | 'failed_prepare'
    | 'failed_inference'
    | 'failed_persist';
}

export const SAM3_BATCH_V2_QUEUE_NAME = 'sam3-batch-v2-processing';
export const SAM3_BATCH_V2_GLOBAL_CONCURRENCY = 1;

let batchQueueV2: Queue<Sam3BatchV2JobData, Sam3BatchV2JobResult> | null = null;
let queueConfigurationPromise: Promise<void> | null = null;

export async function configureSam3BatchV2Queue(
  queue: Pick<Queue<Sam3BatchV2JobData, Sam3BatchV2JobResult>, 'setGlobalConcurrency'>,
  concurrency: number = SAM3_BATCH_V2_GLOBAL_CONCURRENCY
): Promise<void> {
  await queue.setGlobalConcurrency(concurrency);
}

export async function getBatchQueueV2(): Promise<Queue<Sam3BatchV2JobData, Sam3BatchV2JobResult>> {
  if (!batchQueueV2) {
    batchQueueV2 = new Queue<Sam3BatchV2JobData, Sam3BatchV2JobResult>(
      SAM3_BATCH_V2_QUEUE_NAME,
      {
        connection: createRedisConnection(),
        prefix: QUEUE_PREFIX,
        defaultJobOptions: {
          attempts: 2,
          backoff: {
            type: 'fixed',
            delay: 10000,
          },
          removeOnComplete: {
            age: 24 * 60 * 60,
            count: 1000,
          },
          removeOnFail: {
            age: 7 * 24 * 60 * 60,
          },
        },
      }
    );
  }

  if (!queueConfigurationPromise) {
    queueConfigurationPromise = configureSam3BatchV2Queue(batchQueueV2).catch((error) => {
      queueConfigurationPromise = null;
      throw error;
    });
  }

  await queueConfigurationPromise;
  return batchQueueV2;
}

export async function enqueueBatchJobV2(data: Sam3BatchV2JobData): Promise<string> {
  const queue = await getBatchQueueV2();
  const job = await queue.add('process-batch-v2', data, {
    jobId: data.batchJobId,
  });

  return job.id || data.batchJobId;
}

export async function getQueueStatsV2() {
  const queue = await getBatchQueueV2();
  const [waiting, active, completed, failed] = await Promise.all([
    queue.getWaitingCount(),
    queue.getActiveCount(),
    queue.getCompletedCount(),
    queue.getFailedCount(),
  ]);

  return { waiting, active, completed, failed };
}
