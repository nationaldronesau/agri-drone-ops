import YOLOService, { yoloService } from '@/lib/services/yolo';
import { yoloRuntimeService } from '@/lib/services/yolo-runtime';
import { roboflowService, ROBOFLOW_MODELS, ModelType } from '@/lib/services/roboflow';
import { fetchImageSafely } from '@/lib/utils/security';
import {
  buildYoloTilePlan,
  mergeYoloDetectionsWithNms,
  offsetDetectionToImage,
  shouldTileYoloImage,
  type YoloDetectionLike,
  type YoloTile,
} from '@/lib/utils/yolo-tiling';
import sharp from 'sharp';

export type InferenceBackend = 'local' | 'roboflow' | 'auto';

export interface DetectionRequest {
  modelName: string;
  confidence?: number;
  backend?: InferenceBackend;
  s3Path?: string | null;
  imageBase64?: string;
  imageUrl?: string;
  imageWidth?: number | null;
  imageHeight?: number | null;
  roboflowModels?: ModelType[];
}

export interface YoloTilingSummary {
  enabled: boolean;
  imageWidth?: number;
  imageHeight?: number;
  tileSize?: number;
  overlap?: number;
  tileCount?: number;
  rawDetections?: number;
  mergedDetections?: number;
  nmsIouThreshold?: number;
}

export interface DetectionResult {
  detections: Array<{ class: string; confidence: number; bbox: [number, number, number, number] }>;
  backend: 'local' | 'roboflow';
  inferenceTimeMs?: number;
  tiling?: YoloTilingSummary;
}

const inferenceBaseUrl =
  yoloRuntimeService.hasManagedInstance()
    ? null
    : process.env.YOLO_INFERENCE_URL ||
      process.env.SAM3_SERVICE_URL ||
      process.env.SAM3_API_URL ||
      null;

const yoloInferenceClient = inferenceBaseUrl
  ? new YOLOService({
      baseUrl: inferenceBaseUrl,
      apiKey: process.env.YOLO_SERVICE_API_KEY,
    })
  : yoloService;

const DEFAULT_TILE_SIZE = 1536;
const DEFAULT_TILE_OVERLAP = 512;
const DEFAULT_TILE_MIN_DIMENSION = 2048;
const DEFAULT_TILE_NMS_IOU = 0.45;
const DEFAULT_TILE_MAX_TILES = 80;

function readPositiveIntegerEnv(name: string, fallback: number): number {
  const parsed = Number.parseInt(process.env[name] || '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function readNumberEnv(name: string, fallback: number): number {
  const parsed = Number.parseFloat(process.env[name] || '');
  return Number.isFinite(parsed) ? parsed : fallback;
}

function readTilingConfig() {
  const tileSize = readPositiveIntegerEnv('YOLO_TILE_SIZE', DEFAULT_TILE_SIZE);
  return {
    enabled: process.env.YOLO_TILING_ENABLED !== 'false',
    tileSize,
    overlap: Math.min(
      tileSize - 1,
      readPositiveIntegerEnv('YOLO_TILE_OVERLAP', DEFAULT_TILE_OVERLAP)
    ),
    minDimension: readPositiveIntegerEnv('YOLO_TILE_MIN_DIMENSION', DEFAULT_TILE_MIN_DIMENSION),
    nmsIouThreshold: Math.max(0, Math.min(1, readNumberEnv('YOLO_TILE_NMS_IOU', DEFAULT_TILE_NMS_IOU))),
    maxTiles: readPositiveIntegerEnv('YOLO_TILE_MAX_TILES', DEFAULT_TILE_MAX_TILES),
  };
}

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

function normalizeBase64Image(imageBase64: string): string {
  const [, payload] = imageBase64.match(/^data:image\/[^;]+;base64,(.+)$/) || [];
  return payload || imageBase64;
}

function imageBufferFromBase64(imageBase64: string): Buffer {
  return Buffer.from(normalizeBase64Image(imageBase64), 'base64');
}

async function getRequestImageBuffer(request: DetectionRequest): Promise<Buffer | null> {
  if (request.imageBase64) {
    return imageBufferFromBase64(request.imageBase64);
  }
  if (!request.imageUrl) {
    return null;
  }
  return fetchImageSafely(request.imageUrl, 'YOLO tiled inference image');
}

function mapLocalDetections(detections: YoloDetectionLike[]) {
  return detections.map((detection) => ({
    class: detection.class,
    confidence: detection.confidence,
    bbox: detection.bbox,
  }));
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
    if (!request.s3Path && !request.imageBase64 && !request.imageUrl) {
      throw new Error('Local inference requires s3Path, imageBase64, or imageUrl');
    }

    const tilingConfig = readTilingConfig();
    let imageBuffer: Buffer | null = null;
    let imageWidth = request.imageWidth ?? null;
    let imageHeight = request.imageHeight ?? null;
    const knownSizeIsLarge = imageWidth != null && imageHeight != null && shouldTileYoloImage(
      imageWidth,
      imageHeight,
      {
        enabled: tilingConfig.enabled,
        minDimension: tilingConfig.minDimension,
        tileSize: tilingConfig.tileSize,
      }
    );
    const needsImagePayload = Boolean(!request.s3Path && !request.imageBase64 && request.imageUrl);
    const shouldInspectImage = needsImagePayload || Boolean(
      tilingConfig.enabled &&
      (request.imageBase64 || request.imageUrl) &&
      (knownSizeIsLarge || imageWidth == null || imageHeight == null || !request.s3Path)
    );

    if (shouldInspectImage) {
      imageBuffer = await getRequestImageBuffer(request);
      if (imageBuffer) {
        const metadata = await sharp(imageBuffer).metadata();
        imageWidth = imageWidth ?? metadata.width ?? null;
        imageHeight = imageHeight ?? metadata.height ?? null;
      }
    }

    if (
      imageBuffer &&
      imageWidth != null &&
      imageHeight != null &&
      shouldTileYoloImage(imageWidth, imageHeight, {
        enabled: tilingConfig.enabled,
        minDimension: tilingConfig.minDimension,
        tileSize: tilingConfig.tileSize,
      })
    ) {
      return this.detectLocalTiled(
        request,
        imageBuffer,
        imageWidth,
        imageHeight,
        tilingConfig
      );
    }

    const response = await yoloInferenceClient.detect({
      s3_path: request.s3Path ?? undefined,
      image: request.imageBase64 ?? (imageBuffer ? imageBuffer.toString('base64') : undefined),
      model: request.modelName,
      confidence: request.confidence,
    });

    return {
      detections: mapLocalDetections(response.detections),
      backend: 'local',
      inferenceTimeMs: response.inference_time_ms,
      tiling: {
        enabled: false,
        imageWidth: imageWidth ?? undefined,
        imageHeight: imageHeight ?? undefined,
      },
    };
  }

  private async detectLocalTiled(
    request: DetectionRequest,
    imageBuffer: Buffer,
    imageWidth: number,
    imageHeight: number,
    config: ReturnType<typeof readTilingConfig>
  ): Promise<DetectionResult> {
    const startedAt = Date.now();
    const tiles = buildYoloTilePlan(imageWidth, imageHeight, {
      tileSize: config.tileSize,
      overlap: config.overlap,
    });
    if (tiles.length > config.maxTiles) {
      throw new Error(
        `YOLO tiled inference would create ${tiles.length} tiles, exceeding YOLO_TILE_MAX_TILES=${config.maxTiles}`
      );
    }

    const rawDetections: YoloDetectionLike[] = [];
    for (const tile of tiles) {
      const tileDetections = await this.detectTile(request, imageBuffer, tile);
      for (const detection of tileDetections) {
        const offsetDetection = offsetDetectionToImage(detection, tile, imageWidth, imageHeight);
        if (offsetDetection) {
          rawDetections.push(offsetDetection);
        }
      }
    }

    const mergedDetections = mergeYoloDetectionsWithNms(rawDetections, config.nmsIouThreshold);

    return {
      detections: mapLocalDetections(mergedDetections),
      backend: 'local',
      inferenceTimeMs: Date.now() - startedAt,
      tiling: {
        enabled: true,
        imageWidth,
        imageHeight,
        tileSize: config.tileSize,
        overlap: config.overlap,
        tileCount: tiles.length,
        rawDetections: rawDetections.length,
        mergedDetections: mergedDetections.length,
        nmsIouThreshold: config.nmsIouThreshold,
      },
    };
  }

  private async detectTile(
    request: DetectionRequest,
    imageBuffer: Buffer,
    tile: YoloTile
  ): Promise<YoloDetectionLike[]> {
    const tileBuffer = await sharp(imageBuffer)
      .extract({
        left: tile.x,
        top: tile.y,
        width: tile.width,
        height: tile.height,
      })
      .jpeg({ quality: 90 })
      .toBuffer();

    const response = await yoloInferenceClient.detect({
      image: tileBuffer.toString('base64'),
      model: request.modelName,
      confidence: request.confidence,
    });

    return response.detections.map((detection) => ({
      class: detection.class,
      confidence: detection.confidence,
      bbox: detection.bbox,
    }));
  }

  private async detectRoboflow(request: DetectionRequest): Promise<DetectionResult> {
    const imageBase64 = await ensureBase64Image(request);
    const models = request.roboflowModels && request.roboflowModels.length > 0
      ? request.roboflowModels
      : getDefaultRoboflowModels();

    const result = await roboflowService.detectMultipleModels(imageBase64, models);
    if (result.failures.length > 0 && result.detections.length === 0) {
      const details = result.failures
        .map((failure) => `${failure.model}: ${failure.error}`)
        .join('; ');
      throw new Error(`Roboflow fallback failed for all models (${details})`);
    }

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
