import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SAM3_STARTUP_TIMEOUT_MS,
  isRetryableSam3StartError,
  resolveSam3InstanceIds,
  resolveSam3StartupTimeoutMs,
  tryStartSam3InstancePool,
} from '@/lib/services/aws-sam3';

describe('SAM3 cold-start timeout', () => {
  it('allows eight minutes for GPU and model readiness by default', () => {
    expect(DEFAULT_SAM3_STARTUP_TIMEOUT_MS).toBe(480000);
    expect(resolveSam3StartupTimeoutMs(undefined)).toBe(480000);
  });

  it('accepts a configured startup timeout of at least one minute', () => {
    expect(resolveSam3StartupTimeoutMs('60000')).toBe(60000);
    expect(resolveSam3StartupTimeoutMs('720000')).toBe(720000);
  });

  it('falls back safely for invalid or dangerously short values', () => {
    expect(resolveSam3StartupTimeoutMs('not-a-number')).toBe(480000);
    expect(resolveSam3StartupTimeoutMs('59999')).toBe(480000);
  });
});

describe('SAM3 EC2 start retry classification', () => {
  it('retries capacity, throttling, and AWS 5xx failures', () => {
    expect(isRetryableSam3StartError({ name: 'InsufficientInstanceCapacity' })).toBe(true);
    expect(isRetryableSam3StartError({ name: 'IncorrectInstanceState' })).toBe(true);
    expect(isRetryableSam3StartError({ code: 'RequestLimitExceeded' })).toBe(true);
    expect(isRetryableSam3StartError({ $metadata: { httpStatusCode: 503 } })).toBe(true);
  });

  it('fails fast for configuration and authorization errors', () => {
    expect(isRetryableSam3StartError({ name: 'UnauthorizedOperation' })).toBe(false);
    expect(isRetryableSam3StartError({ name: 'InvalidInstanceID.NotFound' })).toBe(false);
    expect(isRetryableSam3StartError(null)).toBe(false);
  });
});

describe('SAM3 EC2 instance pool', () => {
  it('keeps the legacy instance first and de-duplicates configured fallbacks', () => {
    expect(resolveSam3InstanceIds(' i-fallback-b, i-primary, i-fallback-c ', 'i-primary')).toEqual([
      'i-primary',
      'i-fallback-b',
      'i-fallback-c',
    ]);
  });

  it('supports pool-only configuration', () => {
    expect(resolveSam3InstanceIds('i-pool-a,i-pool-b', undefined)).toEqual(['i-pool-a', 'i-pool-b']);
  });

  it('moves immediately to the next host after a capacity failure', async () => {
    const attempts: string[] = [];
    const result = await tryStartSam3InstancePool(
      ['i-primary', 'i-fallback-b', 'i-fallback-c'],
      async (instanceId) => {
        attempts.push(instanceId);
        if (instanceId === 'i-primary') {
          throw Object.assign(new Error('no capacity'), { name: 'InsufficientInstanceCapacity' });
        }
      }
    );

    expect(result.instanceId).toBe('i-fallback-b');
    expect(attempts).toEqual(['i-primary', 'i-fallback-b']);
  });

  it('rotates from the active pool member and reports retryable exhaustion', async () => {
    const attempts: string[] = [];
    const result = await tryStartSam3InstancePool(
      ['i-primary', 'i-fallback-b', 'i-fallback-c'],
      async (instanceId) => {
        attempts.push(instanceId);
        throw Object.assign(new Error('no capacity'), { name: 'InsufficientInstanceCapacity' });
      },
      1
    );

    expect(result.instanceId).toBeNull();
    expect(result.lastError).toBeInstanceOf(Error);
    expect(attempts).toEqual(['i-fallback-b', 'i-fallback-c', 'i-primary']);
  });

  it('fails fast instead of hiding permanent AWS errors', async () => {
    await expect(
      tryStartSam3InstancePool(['i-primary', 'i-fallback-b'], async () => {
        throw Object.assign(new Error('denied'), { name: 'UnauthorizedOperation' });
      })
    ).rejects.toMatchObject({ name: 'UnauthorizedOperation' });
  });
});
