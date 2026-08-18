import { awsSam3Service } from '@/lib/services/aws-sam3';

export interface PineSam3Pool {
  isConfigured(): boolean;
  startInstance(): Promise<boolean>;
  getStatus(): { ipAddress: string | null };
  discoverInstanceIp(): Promise<string | null>;
  updateActivity(): void;
}

type PineSam3Environment = Partial<Pick<
  NodeJS.ProcessEnv,
  | 'PINE_STOCKTAKE_SAM3_URL'
  | 'PINE_STOCKTAKE_USE_SAM3_INSTANCE_POOL'
  | 'PINE_STOCKTAKE_SAM3_PORT'
  | 'SAM3_PORT'
>>;

function enabled(value: string | undefined): boolean {
  return ['1', 'true', 'yes'].includes((value || '').trim().toLowerCase());
}

function resolvePort(environment: PineSam3Environment): string {
  const value = (environment.PINE_STOCKTAKE_SAM3_PORT || environment.SAM3_PORT || '8000').trim();
  const port = Number.parseInt(value, 10);
  if (!/^\d+$/.test(value) || port < 1 || port > 65_535) {
    throw new Error('PINE_STOCKTAKE_SAM3_PORT must be a valid TCP port');
  }
  return value;
}

/**
 * Resolve the pinned Pine Stocktake backend.
 *
 * Pool mode is explicit. It starts and discovers only the configured SAM3 EC2
 * pool. A fixed URL is ignored in pool mode, so a capacity or identity failure
 * cannot silently route the job to another backend.
 */
export async function resolvePineStocktakeSam3Endpoint(
  environment: PineSam3Environment = process.env as PineSam3Environment,
  pool: PineSam3Pool = awsSam3Service
): Promise<string> {
  if (!enabled(environment.PINE_STOCKTAKE_USE_SAM3_INSTANCE_POOL)) {
    const fixedUrl = environment.PINE_STOCKTAKE_SAM3_URL?.trim();
    if (!fixedUrl) {
      throw new Error('PINE_STOCKTAKE_SAM3_URL is not configured; no fallback backend is permitted');
    }
    return fixedUrl.replace(/\/+$/, '');
  }

  if (!pool.isConfigured()) {
    throw new Error('Pine Stocktake SAM3 instance pool is not configured');
  }
  if (!await pool.startInstance()) {
    throw new Error('Pine Stocktake SAM3 instance pool did not become ready');
  }

  const statusIp = pool.getStatus().ipAddress;
  const ipAddress = statusIp || await pool.discoverInstanceIp();
  if (!ipAddress) {
    throw new Error('Pine Stocktake SAM3 instance pool has no reachable IP address');
  }

  pool.updateActivity();
  return `http://${ipAddress}:${resolvePort(environment)}/api/v1/pine-stocktake`;
}
