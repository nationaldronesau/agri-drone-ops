import YOLOService, { yoloService } from '@/lib/services/yolo';
import { roboflowService, ROBOFLOW_MODELS, ModelType } from '@/lib/services/roboflow';
import { fetchImageSafely } from '@/lib/utils/security';

export type InferenceBackend = 'local' | 'roboflow' | 'auto';

export interface DetectionRequest {
  modelName: string;
  confidence?: number;
  backend?: InferenceBackend;
  s3Path?: string | null;
  imageBase64?: string;
  imageUrl?: string;
  roboflowModels?: ModelType[];
}

export interface DetectionResult {
  detections: Array<{ class: string; confidence: number; bbox: [number, number, number, number] }>;
  backend: 'local' | 'roboflow';
  inferenceTimeMs?: number;
}

const inferenceBaseUrl =
  process.env.YOLO_INFERENCE_URL ||
  process.env.SAM3_SERVICE_URL ||
  process.env.SAM3_API_URL ||
  null;

const yoloInferenceClient = inferenceBaseUrl
  ? new YOLOService({
      baseUrl: inferenceBaseUrl,
      apiKey: process.env.YOLO_SERVICE_API_KEY,
    })
  : yoloService;

function getDefaultRoboflowModels(): ModelType[] {
  return Object.entries(ROBOFLOW_MODELS)
    .filter(([, model]) => !model.disabled)
    .map(([key]) => key as ModelType);
}

function toRoboflowBBox(detection: { x: number; y: number; width: number; height: number }): [number, number, number, number] {
  const x1 = detection.x - detection.width / 2;
  const y1 = detection.y - detection.height / 2;
  const x2 = detection.x + detection.width / 2;
  const y2 = detection.y + detection.height / 2;
  return [x1, y1, x2, y2];
}

async function ensureBase64Image(request: DetectionRequest): Promise<string> {
  if (request.imageBase64) return request.imageBase64;
  if (!request.imageUrl) {
    throw new Error('Image base64 or URL is required for Roboflow inference');
  }
  const buffer = await fetchImageSafely(request.imageUrl, 'Roboflow inference image');
  return buffer.toString('base64');
}

class YOLOInferenceService {
  async detect(request: DetectionRequest): Promise<DetectionResult> {
    const backend = request.backend || 'auto';

    if (backend === 'local') {
      return this.detectLocal(request);
    }

    if (backend === 'roboflow') {
      return this.detectRoboflow(request);
    }

    try {
      return await this.detectLocal(request);
    } catch (error) {
      console.warn('Local YOLO inference failed, falling back to Roboflow:', error);
      return this.detectRoboflow(request);
    }
  }

  private async detectLocal(request: DetectionRequest): Promise<DetectionResult> {
    if (!request.s3Path && !request.imageBase64) {
      throw new Error('Local inference requires s3Path or imageBase64');
    }

    const response = await yoloInferenceClient.detect({
      s3_path: request.s3Path ?? undefined,
      image: request.imageBase64,
      model: request.modelName,
      confidence: request.confidence,
    });

    return {
      detections: response.detections.map((d) => ({
        class: d.class,
        confidence: d.confidence,
        bbox: d.bbox,
      })),
      backend: 'local',
      inferenceTimeMs: response.inference_time_ms,
    };
  }

  private async detectRoboflow(request: DetectionRequest): Promise<DetectionResult> {
    const imageBase64 = await ensureBase64Image(request);
    const models = request.roboflowModels && request.roboflowModels.length > 0
      ? request.roboflowModels
      : getDefaultRoboflowModels();

    const result = await roboflowService.detectMultipleModels(imageBase64, models);
    const detections = result.detections.map((d) => ({
      class: d.class,
      confidence: d.confidence,
      bbox: toRoboflowBBox(d),
    }));

    return {
      detections,
      backend: 'roboflow',
    };
  }
}

export const yoloInferenceService = new YOLOInferenceService();
export { yoloInferenceClient };
