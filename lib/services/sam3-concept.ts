import { awsSam3Service, type ScalingInfo } from './aws-sam3';

const SAM3_SERVICE_URL = process.env.SAM3_SERVICE_URL || process.env.SAM3_API_URL;
const SAM3_CONCEPT_API_URL =
  process.env.SAM3_CONCEPT_API_URL || process.env.SAM3_CONCEPT_URL;
const SAM3_CONCEPT_PORT = process.env.SAM3_CONCEPT_PORT || '8002';
const SAM3_CONCEPT_API_KEY =
  process.env.SAM3_CONCEPT_API_KEY || process.env.SAM3_API_KEY;
const REQUEST_TIMEOUT_MS = 180000;

const parseOptionalNumber = (value: string | undefined): number | undefined => {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
};

const parseOptionalInt = (value: string | undefined): number | undefined => {
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
};

const DEFAULT_SIMILARITY_THRESHOLD = parseOptionalNumber(
  process.env.SAM3_CONCEPT_SIMILARITY_THRESHOLD
);
const DEFAULT_TOP_K = parseOptionalInt(process.env.SAM3_CONCEPT_TOP_K);
const DEFAULT_MIN_BOX_SIZE = parseOptionalInt(process.env.SAM3_CONCEPT_MIN_BOX_SIZE);
const DEFAULT_MAX_BOX_SIZE = parseOptionalInt(process.env.SAM3_CONCEPT_MAX_BOX_SIZE);
const DEFAULT_NMS_THRESHOLD = parseOptionalNumber(process.env.SAM3_CONCEPT_NMS_THRESHOLD);

const resolveDerivedBaseUrl = (): string | null => {
  if (!SAM3_SERVICE_URL) return null;
  try {
    const parsed = new URL(SAM3_SERVICE_URL);
    const port = SAM3_CONCEPT_PORT;
    const host = port ? `${parsed.hostname}:${port}` : parsed.host;
    return `${parsed.protocol}//${host}`;
  } catch {
    return null;
  }
};

const SAM3_CONCEPT_BASE_URL = SAM3_CONCEPT_API_URL || resolveDerivedBaseUrl();

export interface ConceptBox {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export interface ConceptDetection {
  bbox: [number, number, number, number];
  confidence: number;
  similarity: number;
  polygon?: [number, number][];
  class_name: string;
}

export interface ConceptExemplarResponse {
  exemplar_id: string;
  class_name: string;
  num_crops: number;
  avg_box_size: [number, number];
  created_at: string;
}

export interface ConceptApplyOptions {
  similarityThreshold?: number;
  topK?: number;
  minBoxSize?: number;
  maxBoxSize?: number;
  nmsThreshold?: number;
  returnPolygons?: boolean;
}

export interface ConceptApplyResult {
  detections: ConceptDetection[];
  processingTimeMs: number;
}

export interface ConceptServiceResult<T> {
  success: boolean;
  data: T | null;
  error?: string;
}

class SAM3ConceptService {
  isConfigured(): boolean {
    return Boolean(SAM3_CONCEPT_BASE_URL) || awsSam3Service.isConfigured();
  }

  private buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (SAM3_CONCEPT_API_KEY) {
      headers['X-API-Key'] = SAM3_CONCEPT_API_KEY;
    }
    return headers;
  }

  private async resolveBaseUrl(ensureReady: boolean): Promise<string | null> {
    if (SAM3_CONCEPT_BASE_URL) {
      return SAM3_CONCEPT_BASE_URL.replace(/\/+$/, '');
    }

    if (!awsSam3Service.isConfigured()) {
      return null;
    }

    if (ensureReady && !awsSam3Service.isReady()) {
      await awsSam3Service.startInstance();
    }

    const cachedIp = awsSam3Service.getStatus().ipAddress;
    const ip = cachedIp || (await awsSam3Service.discoverInstanceIp());
    if (!ip) {
      return null;
    }

    return `http://${ip}:${SAM3_CONCEPT_PORT}`;
  }

  private scaleBoxesToResized(boxes: ConceptBox[], scaling: ScalingInfo): ConceptBox[] {
    return boxes.map((box) => ({
      x1: Math.round(box.x1 * scaling.scaleFactor),
      y1: Math.round(box.y1 * scaling.scaleFactor),
      x2: Math.round(box.x2 * scaling.scaleFactor),
      y2: Math.round(box.y2 * scaling.scaleFactor),
    }));
  }

  private scaleDetectionsToOriginal(
    detections: ConceptDetection[],
    scaling: ScalingInfo
  ): ConceptDetection[] {
    if (scaling.scaleFactor === 1) {
      return detections;
    }

    const inverseScale = 1 / scaling.scaleFactor;
    return detections.map((det) => {
      const bbox: [number, number, number, number] = [
        Math.round(det.bbox[0] * inverseScale),
        Math.round(det.bbox[1] * inverseScale),
        Math.round(det.bbox[2] * inverseScale),
        Math.round(det.bbox[3] * inverseScale),
      ];

      const hasPolygon = Array.isArray(det.polygon) && det.polygon.length >= 3;
      const polygon = hasPolygon
        ? det.polygon!.map((point) => [
            Math.round(point[0] * inverseScale),
            Math.round(point[1] * inverseScale),
          ]) as [number, number][]
        : ([
            [bbox[0], bbox[1]],
            [bbox[2], bbox[1]],
            [bbox[2], bbox[3]],
            [bbox[0], bbox[3]],
          ] as [number, number][]);

      return {
        ...det,
        bbox,
        polygon,
      };
    });
  }

  async checkHealth(): Promise<ConceptServiceResult<{ sam3Loaded: boolean; dinoLoaded: boolean }>> {
    const baseUrl = await this.resolveBaseUrl(false);
    if (!baseUrl) {
      return { success: false, data: null, error: 'Concept service not configured' };
    }

    try {
      const response = await fetch(`${baseUrl}/health`, {
        signal: AbortSignal.timeout(5000),
      });

      if (!response.ok) {
        return { success: false, data: null, error: `Health check failed: ${response.status}` };
      }

      const data = await response.json();
      return {
        success: true,
        data: {
          sam3Loaded: Boolean(data.sam3_loaded),
          dinoLoaded: Boolean(data.dino_loaded),
        },
      };
    } catch (error) {
      return {
        success: false,
        data: null,
        error: error instanceof Error ? error.message : 'Health check failed',
      };
    }
  }

  async warmup(): Promise<ConceptServiceResult<{ sam3Loaded: boolean; dinoLoaded: boolean }>> {
    const baseUrl = await this.resolveBaseUrl(true);
    if (!baseUrl) {
      return { success: false, data: null, error: 'Concept service not configured' };
    }

    try {
      const response = await fetch(`${baseUrl}/warmup`, {
        method: 'POST',
        headers: this.buildHeaders(),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => '');
        return {
          success: false,
          data: null,
          error: `Warmup failed: ${response.status} ${errorText}`.trim(),
        };
      }

      const data = await response.json();
      return {
        success: true,
        data: {
          sam3Loaded: Boolean(data.sam3_loaded),
          dinoLoaded: Boolean(data.dino_loaded),
        },
      };
    } catch (error) {
      return {
        success: false,
        data: null,
        error: error instanceof Error ? error.message : 'Warmup failed',
      };
    }
  }

  async createExemplar(params: {
    imageBuffer: Buffer;
    boxes: ConceptBox[];
    className: string;
    imageId?: string;
  }): Promise<ConceptServiceResult<ConceptExemplarResponse>> {
    const baseUrl = await this.resolveBaseUrl(true);
    if (!baseUrl) {
      return { success: false, data: null, error: 'Concept service not configured' };
    }

    try {
      const { buffer, scaling } = await awsSam3Service.resizeImage(params.imageBuffer);
      const scaledBoxes = this.scaleBoxesToResized(params.boxes, scaling);

      const response = await fetch(`${baseUrl}/api/v1/exemplars/create`, {
        method: 'POST',
        headers: this.buildHeaders(),
        body: JSON.stringify({
          image: buffer.toString('base64'),
          boxes: scaledBoxes,
          class_name: params.className,
          image_id: params.imageId,
        }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => '');
        return {
          success: false,
          data: null,
          error: `Create exemplar failed: ${response.status} ${errorText}`.trim(),
        };
      }

      const data = await response.json();
      awsSam3Service.updateActivity();
      return {
        success: true,
        data,
      };
    } catch (error) {
      return {
        success: false,
        data: null,
        error: error instanceof Error ? error.message : 'Create exemplar failed',
      };
    }
  }

  async applyExemplar(params: {
    exemplarId: string;
    imageBuffer: Buffer;
    imageId?: string;
    options?: ConceptApplyOptions;
  }): Promise<ConceptServiceResult<ConceptApplyResult>> {
    const baseUrl = await this.resolveBaseUrl(true);
    if (!baseUrl) {
      return { success: false, data: null, error: 'Concept service not configured' };
    }

    try {
      const { buffer, scaling } = await awsSam3Service.resizeImage(params.imageBuffer);

      const similarityThreshold =
        params.options?.similarityThreshold ?? DEFAULT_SIMILARITY_THRESHOLD;
      const topK = params.options?.topK ?? DEFAULT_TOP_K;
      const minBoxSize = params.options?.minBoxSize ?? DEFAULT_MIN_BOX_SIZE;
      const maxBoxSize = params.options?.maxBoxSize ?? DEFAULT_MAX_BOX_SIZE;
      const nmsThreshold = params.options?.nmsThreshold ?? DEFAULT_NMS_THRESHOLD;

      const payload: Record<string, unknown> = {
        exemplar_id: params.exemplarId,
        images: [buffer.toString('base64')],
        return_polygons: params.options?.returnPolygons ?? true,
      };

      if (params.imageId) {
        payload.image_ids = [params.imageId];
      }
      if (similarityThreshold !== undefined) {
        payload.similarity_threshold = similarityThreshold;
      }
      if (topK !== undefined) {
        payload.top_k = topK;
      }
      if (minBoxSize !== undefined) {
        payload.min_box_size = minBoxSize;
      }
      if (maxBoxSize !== undefined) {
        payload.max_box_size = maxBoxSize;
      }
      if (nmsThreshold !== undefined) {
        payload.nms_threshold = nmsThreshold;
      }

      const response = await fetch(`${baseUrl}/api/v1/exemplars/apply`, {
        method: 'POST',
        headers: this.buildHeaders(),
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => '');
        return {
          success: false,
          data: null,
          error: `Apply exemplar failed: ${response.status} ${errorText}`.trim(),
        };
      }

      const result = await response.json();
      const resultItem = Array.isArray(result.results) ? result.results[0] : null;
      const detections: ConceptDetection[] = resultItem?.detections ?? [];
      const scaledDetections = this.scaleDetectionsToOriginal(detections, scaling);

      awsSam3Service.updateActivity();
      return {
        success: true,
        data: {
          detections: scaledDetections,
          processingTimeMs: result.processing_time_ms ?? 0,
        },
      };
    } catch (error) {
      return {
        success: false,
        data: null,
        error: error instanceof Error ? error.message : 'Apply exemplar failed',
      };
    }
  }
}

export const sam3ConceptService = new SAM3ConceptService();
