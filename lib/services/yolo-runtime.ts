import {
  EC2Client,
  DescribeInstancesCommand,
  StartInstancesCommand,
} from '@aws-sdk/client-ec2';

type EC2Sender = Pick<EC2Client, 'send'>;

export type YOLORuntimeState =
  | 'not_configured'
  | 'stopped'
  | 'starting'
  | 'running'
  | 'ready'
  | 'stopping'
  | 'error';

export interface YOLORuntimeStatus {
  configured: boolean;
  managedInstance: boolean;
  instanceId: string | null;
  state: YOLORuntimeState;
  ipAddress: string | null;
  baseUrl: string | null;
  healthy: boolean;
  lastError: string | null;
}

export interface YOLORuntimeReadyResult extends YOLORuntimeStatus {
  ready: boolean;
}

interface YOLORuntimeOptions {
  env?: NodeJS.ProcessEnv;
  ec2Client?: EC2Sender;
  fetchFn?: typeof fetch;
  sleepFn?: (ms: number) => Promise<void>;
}

const DEFAULT_REGION = 'ap-southeast-2';
const DEFAULT_PORT = '8001';
const DEFAULT_DISCOVERY_TTL_MS = 60_000;
const DEFAULT_STARTUP_TIMEOUT_MS = 300_000;
const DEFAULT_HEALTH_INTERVAL_MS = 5_000;
const DEFAULT_HEALTH_TIMEOUT_MS = 5_000;

function normalizeUrl(url: string | undefined | null): string | null {
  const trimmed = url?.trim();
  return trimmed ? trimmed.replace(/\/$/, '') : null;
}

function readPositiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value || '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function mapEc2State(state?: string): YOLORuntimeState {
  switch (state) {
    case 'pending':
      return 'starting';
    case 'running':
      return 'running';
    case 'stopping':
      return 'stopping';
    case 'shutting-down':
    case 'terminated':
    case 'stopped':
      return 'stopped';
    default:
      return 'error';
  }
}

function isHealthyPayload(data: unknown): boolean {
  if (!data || typeof data !== 'object') return false;
  const payload = data as Record<string, unknown>;
  return (
    payload.status === 'healthy' ||
    payload.status === 'ready' ||
    payload.ready === true ||
    payload.available === true
  );
}

function responseBodyPreview(data: unknown): string {
  if (typeof data === 'string') return data.slice(0, 200);
  try {
    return JSON.stringify(data).slice(0, 200);
  } catch {
    return String(data).slice(0, 200);
  }
}

export class YOLORuntimeService {
  private env: NodeJS.ProcessEnv;
  private ec2Client: EC2Sender | null = null;
  private fetchFn: typeof fetch;
  private sleepFn: (ms: number) => Promise<void>;
  private instanceId: string | null;
  private region: string;
  private port: string;
  private explicitBaseUrl: string | null;
  private discoveryTtlMs: number;
  private startupTimeoutMs: number;
  private healthIntervalMs: number;
  private healthTimeoutMs: number;
  private ipAddress: string | null = null;
  private state: YOLORuntimeState;
  private healthy = false;
  private lastError: string | null = null;
  private lastDiscoveredAt = 0;
  private startupPromise: Promise<YOLORuntimeReadyResult> | null = null;

  constructor(options: YOLORuntimeOptions = {}) {
    this.env = options.env || process.env;
    this.fetchFn = options.fetchFn || fetch;
    this.sleepFn = options.sleepFn || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.instanceId =
      this.env.YOLO_EC2_INSTANCE_ID ||
      this.env.YOLO_INSTANCE_ID ||
      null;
    this.region =
      this.env.YOLO_EC2_REGION ||
      this.env.YOLO_AWS_REGION ||
      this.env.AWS_REGION ||
      DEFAULT_REGION;
    this.port = this.env.YOLO_PORT || DEFAULT_PORT;
    this.explicitBaseUrl = normalizeUrl(this.env.YOLO_INFERENCE_URL || this.env.YOLO_SERVICE_URL);
    this.discoveryTtlMs = readPositiveInteger(this.env.YOLO_DISCOVERY_TTL_MS, DEFAULT_DISCOVERY_TTL_MS);
    this.startupTimeoutMs = readPositiveInteger(this.env.YOLO_STARTUP_TIMEOUT_MS, DEFAULT_STARTUP_TIMEOUT_MS);
    this.healthIntervalMs = readPositiveInteger(this.env.YOLO_HEALTH_CHECK_INTERVAL_MS, DEFAULT_HEALTH_INTERVAL_MS);
    this.healthTimeoutMs = readPositiveInteger(this.env.YOLO_HEALTH_TIMEOUT_MS, DEFAULT_HEALTH_TIMEOUT_MS);
    this.ec2Client = options.ec2Client || null;
    this.state = this.isConfigured() ? 'stopped' : 'not_configured';
  }

  isConfigured(): boolean {
    return Boolean(this.instanceId || this.explicitBaseUrl);
  }

  hasManagedInstance(): boolean {
    return Boolean(this.instanceId);
  }

  getStatusSnapshot(): YOLORuntimeStatus {
    return {
      configured: this.isConfigured(),
      managedInstance: this.hasManagedInstance(),
      instanceId: this.instanceId,
      state: this.state,
      ipAddress: this.ipAddress,
      baseUrl: this.getCurrentBaseUrl(),
      healthy: this.healthy,
      lastError: this.lastError,
    };
  }

  async getStatus(options: { refresh?: boolean; checkHealth?: boolean } = {}): Promise<YOLORuntimeStatus> {
    if (!this.isConfigured()) {
      this.state = 'not_configured';
      this.lastError = 'YOLO runtime is not configured';
      return this.getStatusSnapshot();
    }

    if (options.refresh || this.shouldRefreshDiscovery()) {
      await this.refreshEc2Status();
    }

    if (options.checkHealth) {
      await this.checkHealth();
    }

    return this.getStatusSnapshot();
  }

  async resolveBaseUrl(forceRefresh: boolean = false): Promise<string | null> {
    if (this.hasManagedInstance()) {
      if (forceRefresh || this.shouldRefreshDiscovery()) {
        await this.refreshEc2Status();
      }
      if (this.ipAddress) {
        return `http://${this.ipAddress}:${this.port}`;
      }
      return null;
    }

    return this.explicitBaseUrl;
  }

  async ensureReady(): Promise<YOLORuntimeReadyResult> {
    if (!this.isConfigured()) {
      this.state = 'not_configured';
      this.lastError = 'YOLO runtime is not configured';
      return { ...this.getStatusSnapshot(), ready: false };
    }

    if (this.startupPromise) {
      return this.startupPromise;
    }

    this.startupPromise = this.ensureReadyInternal().finally(() => {
      this.startupPromise = null;
    });
    return this.startupPromise;
  }

  private async ensureReadyInternal(): Promise<YOLORuntimeReadyResult> {
    await this.getStatus({ refresh: true, checkHealth: true });
    if (this.healthy) {
      this.state = 'ready';
      return { ...this.getStatusSnapshot(), ready: true };
    }

    if (!this.hasManagedInstance()) {
      this.lastError = this.lastError || 'YOLO service is unavailable';
      return { ...this.getStatusSnapshot(), ready: false };
    }

    if (this.state === 'stopped') {
      const started = await this.startInstance();
      if (!started) {
        return { ...this.getStatusSnapshot(), ready: false };
      }
    }

    return this.waitForReady();
  }

  private async startInstance(): Promise<boolean> {
    if (!this.instanceId) return false;
    const client = this.getEc2Client();
    if (!client) {
      this.lastError = 'AWS EC2 client is not available for YOLO runtime';
      this.state = 'error';
      return false;
    }

    try {
      console.log(`[YOLO-Runtime] Requesting EC2 start for ${this.instanceId}`);
      this.state = 'starting';
      await client.send(new StartInstancesCommand({ InstanceIds: [this.instanceId] }));
      this.lastError = null;
      return true;
    } catch (error) {
      this.state = 'error';
      this.lastError = error instanceof Error ? error.message : 'Failed to start YOLO EC2 instance';
      console.error('[YOLO-Runtime] Failed to start EC2 instance:', error);
      return false;
    }
  }

  private async waitForReady(): Promise<YOLORuntimeReadyResult> {
    const startedAt = Date.now();

    while (Date.now() - startedAt < this.startupTimeoutMs) {
      await this.sleepFn(this.healthIntervalMs);
      await this.getStatus({ refresh: true, checkHealth: true });
      if (this.healthy) {
        this.state = 'ready';
        this.lastError = null;
        return { ...this.getStatusSnapshot(), ready: true };
      }
    }

    this.state = 'error';
    this.lastError = `Timed out waiting for YOLO runtime after ${this.startupTimeoutMs}ms`;
    return { ...this.getStatusSnapshot(), ready: false };
  }

  private shouldRefreshDiscovery(): boolean {
    if (!this.hasManagedInstance()) return false;
    if (!this.ipAddress) return true;
    return Date.now() - this.lastDiscoveredAt > this.discoveryTtlMs;
  }

  private getCurrentBaseUrl(): string | null {
    if (this.hasManagedInstance() && this.ipAddress) {
      return `http://${this.ipAddress}:${this.port}`;
    }
    if (this.hasManagedInstance()) {
      return null;
    }
    return this.explicitBaseUrl;
  }

  private getEc2Client(): EC2Sender | null {
    if (!this.instanceId) return null;
    if (!this.ec2Client) {
      this.ec2Client = new EC2Client({ region: this.region });
    }
    return this.ec2Client;
  }

  private async refreshEc2Status(): Promise<void> {
    if (!this.instanceId) return;
    const client = this.getEc2Client();
    if (!client) return;

    try {
      const response = await client.send(
        new DescribeInstancesCommand({ InstanceIds: [this.instanceId] })
      );
      const instance = response.Reservations?.[0]?.Instances?.[0];
      if (!instance) {
        this.state = 'error';
        this.ipAddress = null;
        this.healthy = false;
        this.lastError = `YOLO EC2 instance ${this.instanceId} was not found`;
        return;
      }

      this.ipAddress = instance.PublicIpAddress || null;
      this.state = mapEc2State(instance.State?.Name);
      this.lastDiscoveredAt = Date.now();
      if (this.state !== 'running' && this.state !== 'ready') {
        this.healthy = false;
      }
      this.lastError = null;
    } catch (error) {
      this.state = 'error';
      this.healthy = false;
      this.lastError = error instanceof Error ? error.message : 'Failed to describe YOLO EC2 instance';
      console.error('[YOLO-Runtime] Failed to refresh EC2 status:', error);
    }
  }

  private async checkHealth(): Promise<boolean> {
    const baseUrl = this.getCurrentBaseUrl();
    if (!baseUrl) {
      this.healthy = false;
      if (!this.lastError) {
        this.lastError = 'YOLO runtime base URL is unavailable';
      }
      return false;
    }

    const endpoints = ['/health', '/api/v1/health', '/api/v1/yolo/status'];
    for (const endpoint of endpoints) {
      try {
        const response = await this.fetchFn(`${baseUrl}${endpoint}`, {
          signal: AbortSignal.timeout(this.healthTimeoutMs),
        });
        const text = await response.text();
        let data: unknown = text;
        try {
          data = text ? JSON.parse(text) : {};
        } catch {
          // Keep text for diagnostics.
        }

        if (response.ok && isHealthyPayload(data)) {
          this.healthy = true;
          this.state = 'ready';
          this.lastError = null;
          return true;
        }

        this.lastError = `YOLO health ${endpoint} returned ${response.status}: ${responseBodyPreview(data)}`;
      } catch (error) {
        this.lastError = error instanceof Error ? error.message : 'YOLO health check failed';
      }
    }

    this.healthy = false;
    if (this.state === 'ready') {
      this.state = 'running';
    }
    return false;
  }
}

export const yoloRuntimeService = new YOLORuntimeService();
