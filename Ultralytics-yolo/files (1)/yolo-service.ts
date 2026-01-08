/**
 * YOLO Training Service Client
 * 
 * TypeScript client for the EC2-hosted YOLO training and inference service.
 * Location: lib/services/yolo.ts
 */

// ===========================================
// TYPES
// ===========================================

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
  progress: number; // 0-100
  metrics?: TrainingMetrics;
  started_at?: string;
  completed_at?: string;
  error_message?: string;
  s3_output_path?: string; // Set when completed
}

export interface TrainingHistory {
  job_id: string;
  epochs: TrainingMetrics[];
}

export interface DetectionRequest {
  image?: string; // Base64 encoded
  s3_path?: string; // Or S3 path
  model: string; // Model name, e.g., "wattle-detector-v1" or "base"
  confidence?: number;
  iou_threshold?: number;
}

export interface Detection {
  class: string;
  confidence: number;
  bbox: [number, number, number, number]; // [x1, y1, x2, y2]
  polygon?: [number, number][]; // If segmentation model
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

// ===========================================
// SERVICE CLASS
// ===========================================

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

  constructor(options?: { baseUrl?: string; timeout?: number }) {
    // Default to environment variable or localhost for development
    this.baseUrl = options?.baseUrl || 
      process.env.YOLO_SERVICE_URL || 
      'http://54.252.225.139:8001';
    this.timeout = options?.timeout || 30000; // 30 seconds default
  }

  // ===========================================
  // PRIVATE HELPERS
  // ===========================================

  private async request<T>(
    endpoint: string,
    options: RequestInit = {}
  ): Promise<T> {
    const url = `${this.baseUrl}${endpoint}`;
    
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    try {
      const response = await fetch(url, {
        ...options,
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          ...options.headers,
        },
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        const errorBody = await response.text();
        let errorDetails;
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

  // ===========================================
  // HEALTH CHECK
  // ===========================================

  async checkHealth(): Promise<HealthResponse> {
    return this.request<HealthResponse>('/health');
  }

  async isAvailable(): Promise<boolean> {
    try {
      const health = await this.checkHealth();
      return health.status === 'healthy';
    } catch {
      return false;
    }
  }

  // ===========================================
  // TRAINING
  // ===========================================

  /**
   * Start a new training job
   */
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

  /**
   * Get current status of a training job
   */
  async getTrainingStatus(jobId: string): Promise<TrainingStatus> {
    return this.request<TrainingStatus>(`/api/v1/train/${jobId}`);
  }

  /**
   * Get full training history (all epochs) for charting
   */
  async getTrainingHistory(jobId: string): Promise<TrainingHistory> {
    return this.request<TrainingHistory>(`/api/v1/train/${jobId}/metrics`);
  }

  /**
   * Cancel a running training job
   */
  async cancelTraining(jobId: string): Promise<{ success: boolean; message: string }> {
    return this.request(`/api/v1/train/${jobId}/cancel`, {
      method: 'POST',
    });
  }

  // ===========================================
  // INFERENCE
  // ===========================================

  /**
   * Run detection on an image
   */
  async detect(request: DetectionRequest): Promise<DetectionResponse> {
    if (!request.image && !request.s3_path) {
      throw new YOLOServiceError('Either image (base64) or s3_path must be provided');
    }

    // Use longer timeout for inference (images can be large)
    const originalTimeout = this.timeout;
    this.timeout = 60000; // 60 seconds for inference

    try {
      return await this.request<DetectionResponse>('/api/v1/detect', {
        method: 'POST',
        body: JSON.stringify({
          image: request.image,
          s3_path: request.s3_path,
          model: request.model || 'base',
          confidence: request.confidence || 0.25,
          iou_threshold: request.iou_threshold || 0.45,
        }),
      });
    } finally {
      this.timeout = originalTimeout;
    }
  }

  /**
   * Convenience method for detecting with base64 image
   */
  async detectFromBase64(
    imageBase64: string,
    model: string,
    options?: { confidence?: number; iou_threshold?: number }
  ): Promise<DetectionResponse> {
    return this.detect({
      image: imageBase64,
      model,
      ...options,
    });
  }

  /**
   * Convenience method for detecting from S3
   */
  async detectFromS3(
    s3Path: string,
    model: string,
    options?: { confidence?: number; iou_threshold?: number }
  ): Promise<DetectionResponse> {
    return this.detect({
      s3_path: s3Path,
      model,
      ...options,
    });
  }

  // ===========================================
  // MODEL MANAGEMENT
  // ===========================================

  /**
   * List all available models from S3
   */
  async listModels(): Promise<ModelListResponse> {
    return this.request<ModelListResponse>('/api/v1/models');
  }

  /**
   * List models currently cached in memory on EC2
   */
  async listCachedModels(): Promise<{ models: string[] }> {
    return this.request('/api/v1/models/cached');
  }

  /**
   * Activate/cache a specific model for faster inference
   */
  async activateModel(modelName: string): Promise<{ success: boolean; message: string }> {
    return this.request(`/api/v1/models/${modelName}/activate`, {
      method: 'POST',
    });
  }
}

// ===========================================
// SINGLETON INSTANCE
// ===========================================

// Export a singleton instance for convenience
export const yoloService = new YOLOService();

// Also export the class for custom instances
export default YOLOService;


// ===========================================
// REACT HOOK (Optional - for client components)
// ===========================================

/**
 * React hook for polling training job status
 * 
 * Usage:
 * const { status, metrics, error, isLoading } = useTrainingJobStatus(jobId);
 */
export function useTrainingJobStatus(jobId: string | null, pollInterval = 5000) {
  // Note: This would need to be in a separate file if using 'use client'
  // Included here for reference
  
  /* 
  const [status, setStatus] = useState<TrainingStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    if (!jobId) return;

    const fetchStatus = async () => {
      setIsLoading(true);
      try {
        const response = await fetch(`/api/training/jobs/${jobId}`);
        if (!response.ok) throw new Error('Failed to fetch status');
        const data = await response.json();
        setStatus(data);
        setError(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Unknown error');
      } finally {
        setIsLoading(false);
      }
    };

    fetchStatus();

    // Only poll if job is still running
    if (status?.status === 'running' || status?.status === 'queued' || status?.status === 'preparing') {
      const interval = setInterval(fetchStatus, pollInterval);
      return () => clearInterval(interval);
    }
  }, [jobId, pollInterval, status?.status]);

  return { status, error, isLoading, metrics: status?.metrics };
  */
}


// ===========================================
// UTILITY FUNCTIONS
// ===========================================

/**
 * Convert image file to base64
 */
export async function imageToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      // Remove data URL prefix if present
      const base64 = result.includes(',') ? result.split(',')[1] : result;
      resolve(base64);
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

/**
 * Format model identifier
 * "wattle-detector" + 3 => "wattle-detector-v3"
 */
export function formatModelId(name: string, version: number): string {
  return `${name}-v${version}`;
}

/**
 * Parse model identifier
 * "wattle-detector-v3" => { name: "wattle-detector", version: 3 }
 */
export function parseModelId(modelId: string): { name: string; version?: number } {
  const match = modelId.match(/^(.+)-v(\d+)$/);
  if (match) {
    return { name: match[1], version: parseInt(match[2], 10) };
  }
  return { name: modelId };
}

/**
 * Estimate training time based on dataset size and config
 */
export function estimateTrainingTime(
  imageCount: number,
  epochs: number,
  batchSize: number = 16
): { minutes: number; formatted: string } {
  // Rough estimates based on T4 GPU
  // ~0.5 seconds per batch, varies with image size
  const batchesPerEpoch = Math.ceil(imageCount / batchSize);
  const secondsPerEpoch = batchesPerEpoch * 0.5;
  const totalSeconds = secondsPerEpoch * epochs;
  const minutes = Math.ceil(totalSeconds / 60);
  
  let formatted: string;
  if (minutes < 60) {
    formatted = `~${minutes} minutes`;
  } else {
    const hours = Math.floor(minutes / 60);
    const remainingMinutes = minutes % 60;
    formatted = `~${hours}h ${remainingMinutes}m`;
  }
  
  return { minutes, formatted };
}
