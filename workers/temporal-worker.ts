import { Job, Worker } from 'bullmq';
import { PrismaClient } from '@prisma/client';
import { createRedisConnection, QUEUE_PREFIX } from '../lib/queue/redis';
import {
  TEMPORAL_QUEUE_NAME,
  TemporalJobData,
  TemporalJobResult,
} from '../lib/queue/temporal-queue';
import { runTemporalComparisonRun } from '../lib/services/temporal-comparison';

const prisma = new PrismaClient();

async function handleTemporalJob(job: Job<TemporalJobData>): Promise<TemporalJobResult> {
  const result = await runTemporalComparisonRun(job.data.runId);
  await job.updateProgress(100);
  return result;
}

async function startWorker() {
  console.log('[TemporalWorker] Starting temporal comparison worker...');

  const redisConnection = createRedisConnection();
  redisConnection.on('error', (err) => {
    console.error('[TemporalWorker] Redis connection error:', err.message);
  });
  redisConnection.on('close', () => {
    console.warn('[TemporalWorker] Redis connection closed');
  });
  redisConnection.on('reconnecting', () => {
    console.log('[TemporalWorker] Reconnecting to Redis...');
  });

  await redisConnection.ping();

  const worker = new Worker<TemporalJobData, TemporalJobResult>(
    TEMPORAL_QUEUE_NAME,
    async (job) => handleTemporalJob(job),
    {
      connection: redisConnection,
      prefix: QUEUE_PREFIX,
      concurrency: 1,
    }
  );

  worker.on('completed', (job, result) => {
    console.log(`[TemporalWorker] Job ${job.id} completed`, result);
  });

  worker.on('failed', (job, error) => {
    console.error(`[TemporalWorker] Job ${job?.id} failed`, error.message);
  });

  const shutdown = async () => {
    console.log('[TemporalWorker] Shutting down...');
    await worker.close();
    await redisConnection.quit();
    await prisma.$disconnect();
    process.exit(0);
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

startWorker().catch((error) => {
  console.error('[TemporalWorker] Fatal startup error:', error);
  process.exit(1);
});

