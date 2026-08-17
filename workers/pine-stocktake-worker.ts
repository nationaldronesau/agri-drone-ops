import { Worker } from 'bullmq';
import {
  PINE_STOCKTAKE_QUEUE_NAME,
  type PineStocktakeJobData,
  type PineStocktakeJobResult,
} from '../lib/queue/pine-stocktake-queue';
import { createRedisConnection, QUEUE_PREFIX } from '../lib/queue/redis';
import { processPineStocktakeStage } from '../lib/services/pine-stocktake-jobs';
import prisma from '../lib/db';

const connection = createRedisConnection();
const worker = new Worker<PineStocktakeJobData, PineStocktakeJobResult>(
  PINE_STOCKTAKE_QUEUE_NAME,
  async (job) => processPineStocktakeStage(job.data),
  { connection, prefix: QUEUE_PREFIX, concurrency: 1 }
);

worker.on('completed', (job, result) => console.log('[PineStocktake]', job.id, result.status));
worker.on('failed', (job, error) => console.error('[PineStocktake]', job?.id, error.message));

async function shutdown() {
  await worker.close();
  await connection.quit();
  await prisma.$disconnect();
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
