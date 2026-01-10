/**
 * YOLO Inference Worker
 *
 * Background worker that processes batch inference jobs.
 * Run with: npm run worker:inference
 */
import { Worker, Job } from 'bullmq';
import { PrismaClient } from '@prisma/client';
import { createRedisConnection, QUEUE_PREFIX } from '../lib/queue/redis';
import {
  INFERENCE_QUEUE_NAME,
  InferenceJobData,
  InferenceJobResult,
} from '../lib/queue/inference-queue';
import { processInferenceJob } from '../lib/services/inference';

const prisma = new PrismaClient();

function parseConfig(config: unknown) {
  if (!config || typeof config !== 'object') return {};
  return config as Record<string, unknown>;
}

async function handleInferenceJob(
  job: Job<InferenceJobData>
): Promise<InferenceJobResult> {
  const storedJob = await prisma.processingJob.findUnique({
    where: { id: job.data.processingJobId },
    select: { config: true },
  });

  const config = parseConfig(storedJob?.config);
  const skippedImages = Number(config.skippedImages || 0);
  const duplicateImages = Number(config.duplicateImages || 0);
  const skippedReason = typeof config.skippedReason === 'string' ? config.skippedReason : undefined;

  const result = await processInferenceJob({
    jobId: job.data.processingJobId,
    projectId: job.data.projectId,
    modelId: job.data.modelId,
    modelName: job.data.modelName,
    assetIds: job.data.assetIds,
    confidence: job.data.confidence,
    saveDetections: job.data.saveDetections,
    skippedImages,
    duplicateImages,
    skippedReason,
  });

  await job.updateProgress(100);

  return {
    processedImages: result.processedImages,
    detectionsFound: result.detectionsFound,
    skippedImages: result.skippedImages,
    duplicateImages: result.duplicateImages,
    errors: result.errors,
  };
}

async function startWorker() {
  console.log('[InferenceWorker] Starting YOLO inference worker...');

  const redisConnection = createRedisConnection();
  redisConnection.on('error', (err) => {
    console.error('[InferenceWorker] Redis connection error:', err.message);
  });
  redisConnection.on('close', () => {
    console.warn('[InferenceWorker] Redis connection closed');
  });
  redisConnection.on('reconnecting', () => {
    console.log('[InferenceWorker] Reconnecting to Redis...');
  });

  try {
    await redisConnection.ping();
    console.log('[InferenceWorker] Redis connection established');
  } catch (err) {
    console.error('[InferenceWorker] Failed to connect to Redis:', err);
    process.exit(1);
  }

  const worker = new Worker<InferenceJobData, InferenceJobResult>(
    INFERENCE_QUEUE_NAME,
    async (job) => handleInferenceJob(job),
    {
      connection: redisConnection,
      prefix: QUEUE_PREFIX, // Hash tag prefix for Redis Cluster compatibility
      concurrency: 2,
    }
  );

  worker.on('completed', (job, result) => {
    console.log(`[InferenceWorker] Job ${job.id} completed:`, result);
  });

  worker.on('failed', (job, err) => {
    console.error(`[InferenceWorker] Job ${job?.id} failed:`, err.message);
  });
}

startWorker().catch((err) => {
  console.error('[InferenceWorker] Fatal error:', err);
  process.exit(1);
});
