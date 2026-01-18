/**
 * YOLO Training Service Client
 *
 * TypeScript client for the EC2-hosted YOLO training and inference service.
 */

export interface TrainingConfig {
  dataset_s3_path: string;
  model_name: string;
  base_model?: 'yolo11n' | 'yolo11s' | 'yolo11m' | 'yolo11l' | 'yolo11x';
  epochs?: number;
  batch_size?: number;
  image_size?: number;
  learning_rate?: number;
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
  private baseUrl: string;
  private timeout: number;
  private apiKey?: string;

  constructor(options?: { baseUrl?: string; timeout?: number; apiKey?: string }) {
    this.baseUrl = (options?.baseUrl ||
      process.env.YOLO_SERVICE_URL ||
      'http://localhost:8001').replace(/\/$/, '');
    this.timeout = options?.timeout || 30000;
    this.apiKey = options?.apiKey || process.env.YOLO_SERVICE_API_KEY;
  }

  private async request<T>(
    endpoint: string,
    options: RequestInit = {},
    timeoutOverride?: number
  ): Promise<T> {
    const url = `${this.baseUrl}${endpoint}`;
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
    return this.request<TrainingJobResponse>('/api/v1/train', {
      method: 'POST',
      body: JSON.stringify({
        dataset_s3_path: config.dataset_s3_path,
        model_name: config.model_name,
        base_model: config.base_model || 'yolo11m',
        epochs: config.epochs || 100,
        batch_size: config.batch_size || 16,
        image_size: config.image_size || 640,
        learning_rate: config.learning_rate || 0.01,
      }),
    });
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

    return this.request<DetectionResponse>(
      '/api/v1/detect',
      {
        method: 'POST',
        body: JSON.stringify({
          image: request.image,
          s3_path: request.s3_path,
          model: request.model || 'base',
          confidence: request.confidence || 0.25,
          iou_threshold: request.iou_threshold || 0.45,
        }),
      },
      60000
    );
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
    return this.request(`/api/v1/models/${modelName}/activate`, { method: 'POST' });
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
