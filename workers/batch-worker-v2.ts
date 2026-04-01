import { Job, Worker } from 'bullmq';
import {
  SAM3_BATCH_V2_QUEUE_NAME,
  type Sam3BatchV2JobData,
  type Sam3BatchV2JobResult,
  getBatchQueueV2,
} from '../lib/queue/batch-queue-v2';
import { QUEUE_PREFIX, createRedisConnection } from '../lib/queue/redis';
import prisma from '../lib/db';
import { sam3BatchV2Service } from '../lib/services/sam3-batch-v2';

async function processBatchJob(job: Job<Sam3BatchV2JobData>): Promise<Sam3BatchV2JobResult> {
  return sam3BatchV2Service.processJob(job);
}

async function startWorker() {
  console.log('[Worker:v2] Starting SAM3 batch v2 worker...');

  await getBatchQueueV2();

  const redisConnection = createRedisConnection();

  redisConnection.on('error', (error) => {
    console.error('[Worker:v2] Redis connection error:', error.message);
  });

  redisConnection.on('close', () => {
    console.warn('[Worker:v2] Redis connection closed');
  });

  redisConnection.on('reconnecting', () => {
    console.log('[Worker:v2] Reconnecting to Redis...');
  });

  try {
    await redisConnection.ping();
    console.log('[Worker:v2] Redis connection established');
  } catch (error) {
    console.error('[Worker:v2] Failed to connect to Redis:', error);
    process.exit(1);
  }

  const worker = new Worker<Sam3BatchV2JobData, Sam3BatchV2JobResult>(
    SAM3_BATCH_V2_QUEUE_NAME,
    async (job) => processBatchJob(job),
    {
      connection: redisConnection,
      prefix: QUEUE_PREFIX,
      concurrency: 1,
    }
  );

  worker.on('completed', (job, result) => {
    console.log(`[Worker:v2] Job ${job.id} completed:`, result);
  });

  worker.on('failed', (job, error) => {
    console.error(`[Worker:v2] Job ${job?.id} failed:`, error.message);
  });

  worker.on('error', (error) => {
    console.error('[Worker:v2] Worker error:', error.message);
  });

  worker.on('stalled', (jobId) => {
    console.warn(`[Worker:v2] Job ${jobId} stalled - BullMQ will retry it`);
  });

  const shutdown = async () => {
    console.log('[Worker:v2] Shutting down...');
    await worker.close();
    await redisConnection.quit();
    await prisma.$disconnect();
    process.exit(0);
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  console.log('[Worker:v2] Worker started. Waiting for jobs...');
}

startWorker().catch((error) => {
  console.error('[Worker:v2] Failed to start worker:', error);
  process.exit(1);
});
