import { Queue } from 'bullmq';
import { createRedisConnection, QUEUE_PREFIX } from './redis';

export interface TemporalJobData {
  runId: string;
  projectId: string;
  teamId: string;
}

export interface TemporalJobResult {
  processedSignals: number;
  changeItems: number;
  hotspots: number;
  summary: unknown;
}

export const TEMPORAL_QUEUE_NAME = 'temporal-comparison-processing';

let temporalQueue: Queue<TemporalJobData, TemporalJobResult> | null = null;

export function getTemporalQueue(): Queue<TemporalJobData, TemporalJobResult> {
  if (!temporalQueue) {
    temporalQueue = new Queue<TemporalJobData, TemporalJobResult>(TEMPORAL_QUEUE_NAME, {
      connection: createRedisConnection(),
      prefix: QUEUE_PREFIX,
      defaultJobOptions: {
        attempts: 2,
        backoff: {
          type: 'exponential',
          delay: 4000,
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
  return temporalQueue;
}

export async function enqueueTemporalJob(data: TemporalJobData): Promise<string> {
  const queue = getTemporalQueue();
  const job = await queue.add('process-temporal-comparison', data, {
    jobId: data.runId,
  });
  return job.id || data.runId;
}
