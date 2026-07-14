import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SAM3_STARTUP_TIMEOUT_MS,
  isRetryableSam3StartError,
  resolveSam3StartupTimeoutMs,
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
    expect(isRetryableSam3StartError({ code: 'RequestLimitExceeded' })).toBe(true);
    expect(isRetryableSam3StartError({ $metadata: { httpStatusCode: 503 } })).toBe(true);
  });

  it('fails fast for configuration and authorization errors', () => {
    expect(isRetryableSam3StartError({ name: 'UnauthorizedOperation' })).toBe(false);
    expect(isRetryableSam3StartError({ name: 'InvalidInstanceID.NotFound' })).toBe(false);
    expect(isRetryableSam3StartError(null)).toBe(false);
  });
});
