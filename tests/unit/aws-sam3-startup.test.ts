import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SAM3_STARTUP_TIMEOUT_MS,
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
