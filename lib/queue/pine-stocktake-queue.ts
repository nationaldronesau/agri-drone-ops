import { Queue } from 'bullmq';
import { createRedisConnection, QUEUE_PREFIX } from './redis';

export type PineStocktakeQueueStage =
  | 'validate_mission'
  | 'detect_exemplars'
  | 'build_flat_map'
  | 'map_lidar'
  | 'export_results';

export interface PineStocktakeJobData {
  stocktakeJobId: string;
  stage: PineStocktakeQueueStage;
  idempotencyKey: string;
}
export interface PineStocktakeJobResult {
  stocktakeJobId: string;
  stage: PineStocktakeQueueStage;
  status: 'completed' | 'review_required' | 'blocked';
  processed: number;
  failureReason?: string;
}

export const PINE_STOCKTAKE_QUEUE_NAME = 'pine-stocktake-v1';
let queue: Queue<PineStocktakeJobData, PineStocktakeJobResult> | null = null;

export function getPineStocktakeQueue(): Queue<PineStocktakeJobData, PineStocktakeJobResult> {
  if (!queue) {
    queue = new Queue(PINE_STOCKTAKE_QUEUE_NAME, {
      connection: createRedisConnection(),
      prefix: QUEUE_PREFIX,
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 5_000 },
        removeOnComplete: { age: 7 * 24 * 60 * 60, count: 2_000 },
        removeOnFail: { age: 30 * 24 * 60 * 60 },
      },
    });
  }
  return queue;
}

export async function enqueuePineStocktakeStage(data: PineStocktakeJobData): Promise<string> {
  const pineQueue = getPineStocktakeQueue();
  const jobId = `${data.stocktakeJobId}-${data.stage}-${data.idempotencyKey}`;
  const existing = await pineQueue.getJob(jobId);
  if (existing) {
    const state = await existing.getState();
    if (state === 'failed') await existing.remove();
    else return existing.id ?? jobId;
  }
  const job = await pineQueue.add(data.stage, data, { jobId });
  return job.id ?? jobId;
}
