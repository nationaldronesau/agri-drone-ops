import { Queue } from "bullmq";
import { createRedisConnection, QUEUE_PREFIX } from "./redis";

export interface RapidMapJobData {
  runId: string;
  projectId: string;
  teamId: string;
}

export interface RapidMapJobResult {
  runId: string;
  orthomosaicId?: string;
  sourceImageCount?: number;
  renderedImageCount?: number;
  excludedImageCount?: number;
  artifactCount?: number;
  storageType: "s3" | "local";
}

export const RAPID_MAP_QUEUE_NAME = "rapid-map-processing";

let rapidMapQueue: Queue<RapidMapJobData, RapidMapJobResult> | null = null;

export function getRapidMapQueue(): Queue<RapidMapJobData, RapidMapJobResult> {
  if (!rapidMapQueue) {
    rapidMapQueue = new Queue<RapidMapJobData, RapidMapJobResult>(
      RAPID_MAP_QUEUE_NAME,
      {
        connection: createRedisConnection(),
        prefix: QUEUE_PREFIX,
        defaultJobOptions: {
          attempts: 2,
          backoff: {
            type: "exponential",
            delay: 60_000,
          },
          removeOnComplete: {
            age: 24 * 60 * 60,
            count: 200,
          },
          removeOnFail: {
            age: 7 * 24 * 60 * 60,
          },
        },
      }
    );
  }

  return rapidMapQueue;
}

export async function enqueueRapidMapRun(data: RapidMapJobData): Promise<string> {
  const queue = getRapidMapQueue();
  const existingJob = await queue.getJob(data.runId);

  if (existingJob) {
    const state = await existingJob.getState();
    if (state === "waiting" || state === "active" || state === "delayed") {
      return existingJob.id || data.runId;
    }

    try {
      await existingJob.remove();
    } catch {
      // Let the replacement add fail if BullMQ still owns the old record.
    }
  }

  const job = await queue.add("process-rapid-map", data, {
    jobId: data.runId,
  });

  return job.id || data.runId;
}

export async function getRapidMapQueueStats() {
  const queue = getRapidMapQueue();
  const [waiting, active, completed, failed] = await Promise.all([
    queue.getWaitingCount(),
    queue.getActiveCount(),
    queue.getCompletedCount(),
    queue.getFailedCount(),
  ]);

  return { waiting, active, completed, failed };
}
