import { describe, expect, it, vi } from 'vitest';
import {
  resolvePineStocktakeSam3Endpoint,
  type PineSam3Pool,
} from '@/lib/services/pine-stocktake-sam3-endpoint';

function pool(overrides: Partial<PineSam3Pool> = {}): PineSam3Pool {
  return {
    isConfigured: vi.fn(() => true),
    startInstance: vi.fn(async () => true),
    getStatus: vi.fn(() => ({ ipAddress: '172.31.19.222' })),
    discoverInstanceIp: vi.fn(async () => null),
    updateActivity: vi.fn(),
    ...overrides,
  };
}

describe('Pine Stocktake SAM3 endpoint', () => {
  it('uses the configured fixed Pine endpoint when pool mode is disabled', async () => {
    const service = pool();
    await expect(resolvePineStocktakeSam3Endpoint({
      PINE_STOCKTAKE_SAM3_URL: 'http://pine:8000/api/v1/pine-stocktake/',
      PINE_STOCKTAKE_USE_SAM3_INSTANCE_POOL: 'false',
    }, service)).resolves.toBe('http://pine:8000/api/v1/pine-stocktake');
    expect(service.startInstance).not.toHaveBeenCalled();
  });

  it('starts and discovers the configured EC2 pool on demand', async () => {
    const service = pool({
      getStatus: vi.fn(() => ({ ipAddress: null })),
      discoverInstanceIp: vi.fn(async () => '172.31.3.135'),
    });
    await expect(resolvePineStocktakeSam3Endpoint({
      PINE_STOCKTAKE_USE_SAM3_INSTANCE_POOL: 'true',
      PINE_STOCKTAKE_SAM3_PORT: '8000',
    }, service)).resolves.toBe('http://172.31.3.135:8000/api/v1/pine-stocktake');
    expect(service.startInstance).toHaveBeenCalledOnce();
    expect(service.updateActivity).toHaveBeenCalledOnce();
  });

  it('does not use a fixed URL when explicit pool startup fails', async () => {
    const service = pool({ startInstance: vi.fn(async () => false) });
    await expect(resolvePineStocktakeSam3Endpoint({
      PINE_STOCKTAKE_USE_SAM3_INSTANCE_POOL: 'true',
      PINE_STOCKTAKE_SAM3_URL: 'http://unapproved-backend:8000/api/v1/pine-stocktake',
    }, service)).rejects.toThrow('did not become ready');
  });

  it('rejects missing configuration instead of selecting another backend', async () => {
    await expect(resolvePineStocktakeSam3Endpoint({}, pool())).rejects.toThrow(
      'no fallback backend is permitted'
    );
  });
});
