import { Job, Worker } from "bullmq";
import { createRedisConnection, QUEUE_PREFIX } from "../lib/queue/redis";
import {
  RAPID_MAP_QUEUE_NAME,
  RapidMapJobData,
  RapidMapJobResult,
} from "../lib/queue/rapid-map-queue";
import { processRapidMapRun } from "../lib/services/rapid-map";

async function handleRapidMapJob(
  job: Job<RapidMapJobData>
): Promise<RapidMapJobResult> {
  return processRapidMapRun(job.data.runId, {
    reportProgress: (progress) => job.updateProgress(progress),
  });
}

async function startWorker() {
  console.log("[RapidMapWorker] Starting Rapid Map worker...");

  const redisConnection = createRedisConnection();
  redisConnection.on("error", (error) => {
    console.error("[RapidMapWorker] Redis connection error:", error.message);
  });
  redisConnection.on("close", () => {
    console.warn("[RapidMapWorker] Redis connection closed");
  });
  redisConnection.on("reconnecting", () => {
    console.log("[RapidMapWorker] Reconnecting to Redis...");
  });

  try {
    await redisConnection.ping();
    console.log("[RapidMapWorker] Redis connection established");
  } catch (error) {
    console.error("[RapidMapWorker] Failed to connect to Redis:", error);
    process.exit(1);
  }

  const concurrency = Number(process.env.RAPID_MAP_WORKER_CONCURRENCY || 1);
  const worker = new Worker<RapidMapJobData, RapidMapJobResult>(
    RAPID_MAP_QUEUE_NAME,
    async (job) => handleRapidMapJob(job),
    {
      connection: redisConnection,
      prefix: QUEUE_PREFIX,
      concurrency,
    }
  );

  worker.on("completed", (job, result) => {
    console.log("[RapidMapWorker] Job completed:", {
      jobId: job.id,
      runId: result.runId,
      orthomosaicId: result.orthomosaicId,
      artifactCount: result.artifactCount,
    });
  });

  worker.on("failed", (job, error) => {
    console.error(
      `[RapidMapWorker] Job ${job?.id || "unknown"} failed:`,
      error.message
    );
  });
}

startWorker().catch((error) => {
  console.error("[RapidMapWorker] Fatal error:", error);
  process.exit(1);
});
