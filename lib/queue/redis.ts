/**
 * Redis Connection for BullMQ
 *
 * Provides a shared Redis connection for job queues.
 * Uses REDIS_URL from environment variables.
 *
 * IMPORTANT: Uses hash tag prefix for Redis Cluster compatibility.
 * In Redis Cluster, all keys for a queue must hash to the same slot.
 * The {agridrone} hash tag ensures all BullMQ keys are in the same slot.
 */
import IORedis from 'ioredis';

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';

/**
 * Queue prefix with hash tag for Redis Cluster compatibility.
 * All keys with {agridrone} will hash to the same slot, preventing CROSSSLOT errors.
 */
export const QUEUE_PREFIX = '{agridrone}';

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
