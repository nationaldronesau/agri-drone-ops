import { randomUUID } from 'crypto';
import type IORedis from 'ioredis';
import { createRedisConnection } from '@/lib/queue/redis';

const LOCK_KEY = '{agridrone}:gpu_lock';
const DEFAULT_TTL_MS = 120000;

let redis: IORedis | null = null;

function getRedis(): IORedis | null {
  if (!process.env.REDIS_URL) {
    return null;
  }
  if (!redis) {
    redis = createRedisConnection();
  }
  return redis;
}

export interface GpuLockResult {
  acquired: boolean;
  token: string | null;
  message?: string;
}

export async function acquireGpuLock(
  purpose: string,
  ttlMs: number = DEFAULT_TTL_MS
): Promise<GpuLockResult> {
  const client = getRedis();
  if (!client) {
    return { acquired: true, token: null, message: 'Redis not configured' };
  }

  const token = `${purpose}:${randomUUID()}`;
  try {
    const result = await client.set(LOCK_KEY, token, 'PX', ttlMs, 'NX');
    return { acquired: result === 'OK', token: result === 'OK' ? token : null };
  } catch (error) {
    return {
      acquired: false,
      token: null,
      message: error instanceof Error ? error.message : 'Failed to acquire GPU lock',
    };
  }
}

export async function refreshGpuLock(token: string | null, ttlMs: number = DEFAULT_TTL_MS): Promise<boolean> {
  if (!token) return false;
  const client = getRedis();
  if (!client) return false;
  const script = `
    if redis.call('get', KEYS[1]) == ARGV[1] then
      return redis.call('pexpire', KEYS[1], ARGV[2])
    else
      return 0
    end
  `;
  try {
    const result = await client.eval(script, 1, LOCK_KEY, token, String(ttlMs));
    return result === 1;
  } catch {
    return false;
  }
}

export async function releaseGpuLock(token: string | null): Promise<boolean> {
  if (!token) return false;
  const client = getRedis();
  if (!client) return false;
  const script = `
    if redis.call('get', KEYS[1]) == ARGV[1] then
      return redis.call('del', KEYS[1])
    else
      return 0
    end
  `;
  try {
    const result = await client.eval(script, 1, LOCK_KEY, token);
    return result === 1;
  } catch {
    return false;
  }
}

export async function isGpuLocked(): Promise<boolean> {
  const client = getRedis();
  if (!client) return false;
  try {
    const value = await client.get(LOCK_KEY);
    return Boolean(value);
  } catch {
    return false;
  }
}
