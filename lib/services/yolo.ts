/**
 * YOLO Training Service Client
 *
 * TypeScript client for the EC2-hosted YOLO training and inference service.
 */
import { awsSam3Service } from '@/lib/services/aws-sam3';

const YOLO_PORT = process.env.YOLO_PORT || '8001';
const YOLO_DISCOVERY_TTL_MS = Number.parseInt(
  process.env.YOLO_DISCOVERY_TTL_MS || '60000',
  10
);

export interface TrainingConfig {
  dataset_s3_path: string;
  model_name: string;
  base_model?: 'yolo11n' | 'yolo11s' | 'yolo11m' | 'yolo11l' | 'yolo11x';
  epochs?: number;
  batch_size?: number;
  image_size?: number;
  learning_rate?: number;
  checkpoint_s3_path?: string;
  augmentation?: Record<string, unknown>;
}

export interface TrainingJobResponse {
  job_id: string;
  status: 'queued' | 'preparing' | 'running' | 'completed' | 'failed' | 'cancelled';
  message?: string;
}

export interface TrainingMetrics {
  epoch: number;
  mAP50: number;
  mAP5095: number;
  precision: number;
  recall: number;
  box_loss: number;
  cls_loss: number;
  dfl_loss?: number;
  learning_rate?: number;
}

export interface TrainingStatus {
  job_id: string;
  status: 'queued' | 'preparing' | 'running' | 'completed' | 'failed' | 'cancelled';
  current_epoch: number;
  total_epochs: number;
  progress: number;
  metrics?: TrainingMetrics;
  started_at?: string;
  completed_at?: string;
  error_message?: string;
  s3_output_path?: string;
}

export interface TrainingHistory {
  job_id: string;
  epochs: TrainingMetrics[];
}

export interface DetectionRequest {
  image?: string; // Base64 encoded
  s3_path?: string;
  model: string;
  confidence?: number;
  iou_threshold?: number;
}

export interface Detection {
  class: string;
  confidence: number;
  bbox: [number, number, number, number];
  polygon?: [number, number][];
}

export interface DetectionResponse {
  detections: Detection[];
  inference_time_ms: number;
  model_used: string;
}

export interface ModelInfo {
  name: string;
  versions: string[];
  latest_version: string;
  latest_mAP50?: number;
}

export interface ModelListResponse {
  models: ModelInfo[];
}

export interface HealthResponse {
  status: 'healthy' | 'unhealthy';
  gpu_available: boolean;
  gpu_name?: string;
  active_training_jobs: number;
  cached_models: string[];
}

class YOLOServiceError extends Error {
  constructor(
    message: string,
    public statusCode?: number,
    public details?: unknown
  ) {
    super(message);
    this.name = 'YOLOServiceError';
  }
}

export class YOLOService {
  private explicitBaseUrl: string | null;
  private cachedBaseUrl: string | null = null;
  private lastResolvedAt = 0;
  private resolvePromise: Promise<string | null> | null = null;
  private lastResolveError: string | null = null;
  private port: string;
  private discoveryTtlMs: number;
  private timeout: number;
  private apiKey?: string;
  private detectEndpoint: '/api/v1/yolo/detect' | '/api/v1/detect' | null = null;

  constructor(options?: { baseUrl?: string; timeout?: number; apiKey?: string }) {
    const configuredUrl = options?.baseUrl || process.env.YOLO_SERVICE_URL || null;
    this.explicitBaseUrl = configuredUrl ? configuredUrl.replace(/\/$/, '') : null;
    this.timeout = options?.timeout || 30000;
    this.apiKey = options?.apiKey || process.env.YOLO_SERVICE_API_KEY;
    this.port = YOLO_PORT;
    this.discoveryTtlMs = Number.isFinite(YOLO_DISCOVERY_TTL_MS) ? YOLO_DISCOVERY_TTL_MS : 60000;
  }

  private async resolveBaseUrl(forceRefresh: boolean = false): Promise<string | null> {
    if (this.explicitBaseUrl) {
      return this.explicitBaseUrl;
    }

    const now = Date.now();
    if (!forceRefresh && this.cachedBaseUrl && now - this.lastResolvedAt < this.discoveryTtlMs) {
      return this.cachedBaseUrl;
    }

    if (this.resolvePromise) {
      return this.resolvePromise;
    }

    this.resolvePromise = this.resolveBaseUrlInternal();
    try {
      return await this.resolvePromise;
    } finally {
      this.resolvePromise = null;
    }
  }

  private async resolveBaseUrlInternal(): Promise<string | null> {
    if (!awsSam3Service.isConfigured()) {
      const configError = awsSam3Service.getConfigError();
      this.lastResolveError = configError
        ? `YOLO auto-discovery unavailable: ${configError}`
        : 'YOLO service URL not configured';
      return null;
    }

    let ip = awsSam3Service.getStatus().ipAddress;
    if (!ip) {
      ip = await awsSam3Service.discoverInstanceIp();
    }
    if (!ip) {
      this.lastResolveError = 'Unable to discover EC2 IP for YOLO service';
      return null;
    }

    const baseUrl = `http://${ip}:${this.port}`;
    this.cachedBaseUrl = baseUrl;
    this.lastResolvedAt = Date.now();
    this.lastResolveError = null;
    return baseUrl;
  }

  private async request<T>(
    endpoint: string,
    options: RequestInit = {},
    timeoutOverride?: number,
    retryAttempted: boolean = false
  ): Promise<T> {
    const method = (options.method || 'GET').toUpperCase();
    const canRetry = !retryAttempted && !this.explicitBaseUrl && (method === 'GET' || method === 'HEAD');

    const baseUrl = await this.resolveBaseUrl();
    if (!baseUrl) {
      throw new YOLOServiceError(
        this.lastResolveError || 'YOLO service URL not configured',
        503
      );
    }

    const url = `${baseUrl}${endpoint}`;
    const controller = new AbortController();
    const timeoutMs = timeoutOverride ?? this.timeout;
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(url, {
        ...options,
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
          ...options.headers,
        },
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        const errorBody = await response.text();
        let errorDetails: unknown;
        try {
          errorDetails = JSON.parse(errorBody);
        } catch {
          errorDetails = errorBody;
        }
        throw new YOLOServiceError(
          `YOLO service error: ${response.status} ${response.statusText}`,
          response.status,
          errorDetails
        );
      }

      return response.json();
    } catch (error) {
      clearTimeout(timeoutId);

      if (error instanceof YOLOServiceError) {
        throw error;
      }

      if (error instanceof Error && error.name === 'AbortError') {
        throw new YOLOServiceError('Request timeout', 408);
      }

      let refreshedBaseUrl: string | null = null;
      if (!this.explicitBaseUrl) {
        refreshedBaseUrl = await this.resolveBaseUrl(true);
      }

      if (canRetry) {
        if (refreshedBaseUrl && refreshedBaseUrl !== baseUrl) {
          return this.request(endpoint, options, timeoutOverride, true);
        }
      }

      throw new YOLOServiceError(
        `Failed to connect to YOLO service: ${error instanceof Error ? error.message : 'Unknown error'}`,
        503
      );
    }
  }

  async checkHealth(): Promise<HealthResponse> {
    try {
      return this.request<HealthResponse>('/health');
    } catch (error) {
      if (
        error instanceof YOLOServiceError &&
        (error.statusCode === 404 || error.statusCode === 405)
      ) {
        return this.request<HealthResponse>('/api/v1/health');
      }
      throw error;
    }
  }

  async isAvailable(): Promise<boolean> {
    try {
      const health = await this.checkHealth();
      return health.status === 'healthy';
    } catch {
      return false;
    }
  }

  async startTraining(config: TrainingConfig): Promise<TrainingJobResponse> {
    const basePayload: Record<string, unknown> = {
      dataset_s3_path: config.dataset_s3_path,
      model_name: config.model_name,
      base_model: config.base_model || 'yolo11m',
      epochs: config.epochs || 100,
      batch_size: config.batch_size || 16,
      image_size: config.image_size || 640,
      learning_rate: config.learning_rate || 0.01,
      ...(config.checkpoint_s3_path ? { checkpoint_s3_path: config.checkpoint_s3_path } : {}),
    };

    const augmentationPayload = config.augmentation && typeof config.augmentation === 'object'
      ? {
          ...basePayload,
          augmentation: config.augmentation,
          ...(typeof config.augmentation.fliplr === 'number'
            ? { fliplr: config.augmentation.fliplr }
            : {}),
          ...(typeof config.augmentation.flipud === 'number'
            ? { flipud: config.augmentation.flipud }
            : {}),
          ...(typeof config.augmentation.degrees === 'number'
            ? { degrees: config.augmentation.degrees }
            : {}),
          ...(typeof config.augmentation.hsv_v === 'number'
            ? { hsv_v: config.augmentation.hsv_v }
            : {}),
          ...(typeof config.augmentation.hsv_s === 'number'
            ? { hsv_s: config.augmentation.hsv_s }
            : {}),
        }
      : null;

    try {
      return await this.request<TrainingJobResponse>('/api/v1/train', {
        method: 'POST',
        body: JSON.stringify(augmentationPayload || basePayload),
      });
    } catch (error) {
      // Backward-compatible fallback for older YOLO services that reject augmentation fields.
      if (
        augmentationPayload &&
        error instanceof YOLOServiceError &&
        (error.statusCode === 400 || error.statusCode === 422)
      ) {
        return this.request<TrainingJobResponse>('/api/v1/train', {
          method: 'POST',
          body: JSON.stringify(basePayload),
        });
      }
      throw error;
    }
  }

  async getTrainingStatus(jobId: string): Promise<TrainingStatus> {
    return this.request<TrainingStatus>(`/api/v1/train/${jobId}`);
  }

  async getTrainingHistory(jobId: string): Promise<TrainingHistory> {
    return this.request<TrainingHistory>(`/api/v1/train/${jobId}/metrics`);
  }

  async cancelTraining(jobId: string): Promise<{ success: boolean; message: string }> {
    return this.request(`/api/v1/train/${jobId}/cancel`, { method: 'POST' });
  }

  async detect(request: DetectionRequest): Promise<DetectionResponse> {
    if (!request.image && !request.s3_path) {
      throw new YOLOServiceError('Either image (base64) or s3_path must be provided');
    }

    const model = request.model || 'base';
    const basePayload = {
      image: request.image,
      s3_path: request.s3_path,
      confidence: request.confidence || 0.25,
      iou_threshold: request.iou_threshold || 0.45,
    };
    const yoloPayload = { ...basePayload, model_id: model, model };
    const legacyPayload = { ...basePayload, model };

    const endpoints = this.detectEndpoint
      ? [this.detectEndpoint]
      : ['/api/v1/yolo/detect', '/api/v1/detect'];

    for (const endpoint of endpoints) {
      const payload = endpoint === '/api/v1/yolo/detect' ? yoloPayload : legacyPayload;
      try {
        const response = await this.request<DetectionResponse>(
          endpoint,
          {
            method: 'POST',
            body: JSON.stringify(payload),
          },
          60000
        );
        if (!this.detectEndpoint) {
          this.detectEndpoint = endpoint;
        }
        return response;
      } catch (error) {
        if (
          error instanceof YOLOServiceError &&
          (error.statusCode === 404 || error.statusCode === 405)
        ) {
          if (endpoint === '/api/v1/yolo/detect') {
            continue;
          }
        }
        throw error;
      }
    }

    throw new YOLOServiceError('YOLO detect endpoint not available', 404);
  }

  async runInference(options: {
    imageBase64?: string;
    s3Path?: string;
    modelName: string;
    confidence?: number;
    iouThreshold?: number;
  }): Promise<DetectionResponse> {
    return this.detect({
      image: options.imageBase64,
      s3_path: options.s3Path,
      model: options.modelName,
      confidence: options.confidence,
      iou_threshold: options.iouThreshold,
    });
  }

  async detectFromBase64(
    imageBase64: string,
    model: string,
    options?: { confidence?: number; iou_threshold?: number }
  ): Promise<DetectionResponse> {
    return this.detect({ image: imageBase64, model, ...options });
  }

  async detectFromS3(
    s3Path: string,
    model: string,
    options?: { confidence?: number; iou_threshold?: number }
  ): Promise<DetectionResponse> {
    return this.detect({ s3_path: s3Path, model, ...options });
  }

  async listModels(): Promise<ModelListResponse> {
    return this.request<ModelListResponse>('/api/v1/models');
  }

  async listCachedModels(): Promise<{ models: string[] }> {
    return this.request('/api/v1/models/cached');
  }

  async activateModel(modelName: string): Promise<{ success: boolean; message: string }> {
    // Prefer the SAM3 YOLO load endpoint when available.
    try {
      const response = await this.request<{ status?: string; model_id?: string }>(
        '/api/v1/yolo/load',
        {
          method: 'POST',
          body: JSON.stringify({ model_id: modelName, model: modelName }),
        },
        60000
      );
      if (response?.status === 'loaded') {
        return { success: true, message: `Model ${modelName} loaded on YOLO service` };
      }
    } catch (error) {
      if (
        error instanceof YOLOServiceError &&
        (error.statusCode === 404 || error.statusCode === 405)
      ) {
        // fall through to legacy model discovery
      } else {
        throw error;
      }
    }

    // Legacy path: models are loaded on-demand; check cached/available lists.
    try {
      const cached = await this.listCachedModels();
      const cachedModels = cached.cached_models || cached.models || [];
      if (cachedModels.includes(modelName)) {
        return { success: true, message: `Model ${modelName} is already cached and ready` };
      }

      // Check if model exists in available models
      const available = await this.listModels();
      const modelExists = available.models?.some(
        (m) => m.name === modelName || `${m.name}-${m.latest}` === modelName
      );

      if (modelExists) {
        return { success: true, message: `Model ${modelName} is available and will load on first use` };
      }

      throw new Error(`Model ${modelName} not found on YOLO service`);
    } catch (error) {
      if (error instanceof Error && error.message.includes('not found')) {
        throw error;
      }
      throw new Error(`Failed to verify model ${modelName}: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }
}

export const yoloService = new YOLOService();
export default YOLOService;

export function formatModelId(name: string, version: number): string {
  return `${name}-v${version}`;
}

export function parseModelId(modelId: string): { name: string; version?: number } {
  const match = modelId.match(/^(.+)-v(\d+)$/);
  if (match) {
    return { name: match[1], version: parseInt(match[2], 10) };
  }
  return { name: modelId };
}

export function estimateTrainingTime(
  imageCount: number,
  epochs: number,
  batchSize: number = 16
): { minutes: number; formatted: string } {
  const batchesPerEpoch = Math.ceil(imageCount / batchSize);
  const secondsPerEpoch = batchesPerEpoch * 0.5;
  const totalSeconds = secondsPerEpoch * epochs;
  const minutes = Math.ceil(totalSeconds / 60);

  if (minutes < 60) {
    return { minutes, formatted: `~${minutes} minutes` };
  }
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return { minutes, formatted: `~${hours}h ${remainingMinutes}m` };
}
