/**
 * Redis Connection for BullMQ
 *
 * Provides a shared Redis connection for job queues.
 * Uses REDIS_URL from environment variables.
 */
import IORedis from 'ioredis';

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';

// Connection options for BullMQ
export const redisConnection = {
  connection: new IORedis(REDIS_URL, {
    maxRetriesPerRequest: null, // Required for BullMQ
    enableReadyCheck: false,
  }),
};

// Create a new connection for workers (BullMQ requires separate connections)
export function createRedisConnection() {
  return new IORedis(REDIS_URL, {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
  });
}

// Check if Redis is available
export async function checkRedisConnection(): Promise<boolean> {
  try {
    const redis = new IORedis(REDIS_URL, {
      maxRetriesPerRequest: 1,
      connectTimeout: 5000,
    });
    await redis.ping();
    await redis.quit();
    return true;
  } catch {
    return false;
  }
}
