import { Queue } from "bullmq";
import { createRedisConnection, QUEUE_PREFIX } from "./redis";
import type { ModelType } from "@/lib/services/roboflow";

export interface RoboflowDynamicModelConfig {
  id: string;
  projectId: string;
  projectName: string;
  version: number;
  endpoint: string;
  classes: string[];
}

export interface RoboflowDetectionJobData {
  processingJobId: string;
  projectId: string;
  assetIds: string[];
  dynamicModels?: RoboflowDynamicModelConfig[];
  detectionModels?: ModelType[];
}

export interface RoboflowDetectionJobResult {
  processedImages: number;
  detectionsFound: number;
  skippedImages: number;
  errors: string[];
}

export const ROBOFLOW_DETECTION_QUEUE_NAME = "roboflow-detection-processing";

let roboflowDetectionQueue:
  | Queue<RoboflowDetectionJobData, RoboflowDetectionJobResult>
  | null = null;

export function getRoboflowDetectionQueue(): Queue<
  RoboflowDetectionJobData,
  RoboflowDetectionJobResult
> {
  if (!roboflowDetectionQueue) {
    roboflowDetectionQueue = new Queue<
      RoboflowDetectionJobData,
      RoboflowDetectionJobResult
    >(ROBOFLOW_DETECTION_QUEUE_NAME, {
      connection: createRedisConnection(),
      prefix: QUEUE_PREFIX,
      defaultJobOptions: {
        attempts: 2,
        backoff: {
          type: "exponential",
          delay: 5_000,
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

  return roboflowDetectionQueue;
}

export async function enqueueRoboflowDetectionJob(
  data: RoboflowDetectionJobData
): Promise<string> {
  const queue = getRoboflowDetectionQueue();
  const job = await queue.add("process-roboflow-detection", data, {
    jobId: data.processingJobId,
  });
  return job.id || data.processingJobId;
}

export async function getRoboflowDetectionQueueStats() {
  const queue = getRoboflowDetectionQueue();
  const [waiting, active, completed, failed] = await Promise.all([
    queue.getWaitingCount(),
    queue.getActiveCount(),
    queue.getCompletedCount(),
    queue.getFailedCount(),
  ]);

  return { waiting, active, completed, failed };
}
