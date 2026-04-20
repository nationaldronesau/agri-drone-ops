import { Job, Worker } from "bullmq";
import { PrismaClient } from "@prisma/client";
import { createRedisConnection, QUEUE_PREFIX } from "../lib/queue/redis";
import {
  ROBOFLOW_DETECTION_QUEUE_NAME,
  type RoboflowDetectionJobData,
  type RoboflowDetectionJobResult,
} from "../lib/queue/roboflow-detection-queue";
import { processRoboflowDetectionJob } from "../lib/services/roboflow-detection";

const prisma = new PrismaClient();

function parseConfig(config: unknown) {
  if (!config || typeof config !== "object") return {};
  return config as Record<string, unknown>;
}

async function handleRoboflowDetectionJob(
  job: Job<RoboflowDetectionJobData>
): Promise<RoboflowDetectionJobResult> {
  const storedJob = await prisma.processingJob.findUnique({
    where: { id: job.data.processingJobId },
    select: { config: true },
  });

  const config = parseConfig(storedJob?.config);
  const skippedImages = Number(config.skippedImages || 0);

  const result = await processRoboflowDetectionJob({
    jobId: job.data.processingJobId,
    projectId: job.data.projectId,
    assetIds: job.data.assetIds,
    dynamicModels: job.data.dynamicModels,
    detectionModels: job.data.detectionModels,
    skippedImages,
  });

  await job.updateProgress(100);

  return {
    processedImages: result.processedImages,
    detectionsFound: result.detectionsFound,
    skippedImages: result.skippedImages,
    errors: result.errors,
  };
}

async function startWorker() {
  console.log("[RoboflowDetectionWorker] Starting background Roboflow detection worker...");

  const redisConnection = createRedisConnection();
  redisConnection.on("error", (error) => {
    console.error("[RoboflowDetectionWorker] Redis connection error:", error.message);
  });
  redisConnection.on("close", () => {
    console.warn("[RoboflowDetectionWorker] Redis connection closed");
  });
  redisConnection.on("reconnecting", () => {
    console.log("[RoboflowDetectionWorker] Reconnecting to Redis...");
  });

  try {
    await redisConnection.ping();
    console.log("[RoboflowDetectionWorker] Redis connection established");
  } catch (error) {
    console.error("[RoboflowDetectionWorker] Failed to connect to Redis:", error);
    process.exit(1);
  }

  const worker = new Worker<RoboflowDetectionJobData, RoboflowDetectionJobResult>(
    ROBOFLOW_DETECTION_QUEUE_NAME,
    async (job) => handleRoboflowDetectionJob(job),
    {
      connection: redisConnection,
      prefix: QUEUE_PREFIX,
      concurrency: 1,
    }
  );

  worker.on("completed", (job, result) => {
    console.log(`[RoboflowDetectionWorker] Job ${job.id} completed:`, result);
  });

  worker.on("failed", (job, error) => {
    console.error(`[RoboflowDetectionWorker] Job ${job?.id} failed:`, error.message);
  });
}

startWorker().catch((error) => {
  console.error("[RoboflowDetectionWorker] Fatal error:", error);
  process.exit(1);
});
