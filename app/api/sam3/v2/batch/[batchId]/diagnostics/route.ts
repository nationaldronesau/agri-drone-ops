import { NextRequest, NextResponse } from 'next/server';
import { timingSafeEqual } from 'crypto';
import prisma from '@/lib/db';
import { checkProjectAccess } from '@/lib/auth/api-auth';
import {
  awsSam3Service,
  type SAM3ConceptApplyOptions,
  type SAM3ConceptDetection,
} from '@/lib/services/aws-sam3';
import { S3Service } from '@/lib/services/s3';
import {
  buildBatchV2ConceptApplyOptions,
  buildBatchV2ConceptFallbackApplyOptions,
  filterBatchV2ConceptDetections,
  SAM3_BATCH_V2_MIN_REFINEMENT_IOU,
  SAM3_BATCH_V2_MIN_TARGET_CANDIDATES,
} from '@/lib/services/sam3-batch-v2';
import {
  buildExemplarCrops,
  buildExemplarCropsFromDetections,
} from '@/lib/utils/exemplar-crops';
import { scaleExemplarBoxes, type BoxCoordinate } from '@/lib/utils/exemplar-scaling';
import { fetchImageSafely, checkRateLimit, getRateLimitKey } from '@/lib/utils/security';

interface RouteParams {
  params: Promise<{ batchId: string }>;
}

type DiagnosticStrategy =
  | 'box_prompt_match'
  | 'operator_visual_crops'
  | 'source_detection_crops'
  | 'concept_match'
  | 'concept_refined_box_prompt';

type DiagnosticBody = {
  strategies?: DiagnosticStrategy[];
  targetLimit?: number;
  startIfNeeded?: boolean;
  includeSourceTarget?: boolean;
  detectionLimit?: number;
  maxCrops?: number;
  sourceCropMinConfidence?: number;
  sourceCropPadding?: number;
  sourceCropMask?: boolean;
  minAnchorOverlap?: number;
  conceptSimilarityThreshold?: number;
  conceptFallbackSimilarityThreshold?: number;
  conceptTopK?: number;
  conceptFallbackTopK?: number;
};

type AssetForDiagnostics = {
  id: string;
  fileName: string;
  storageUrl: string | null;
  storageType: string | null;
  s3Key: string | null;
  s3Bucket: string | null;
  imageWidth: number | null;
  imageHeight: number | null;
};

type LoadedAsset = AssetForDiagnostics & {
  buffer: Buffer;
};

type Detection = {
  bbox: [number, number, number, number];
  polygon: [number, number][];
  confidence: number;
  similarity?: number;
};

type AssetDiagnosticResult = {
  assetId: string;
  fileName: string;
  count: number;
  outcome: 'success' | 'zero_detections' | 'error' | 'skipped';
  error?: string;
  errorCode?: string;
  topConfidence: number | null;
  detections: Detection[];
};

type StrategyDiagnosticResult = {
  name: DiagnosticStrategy;
  cropCount?: number;
  conceptOptions?: Record<string, unknown>;
  totals: {
    detections: number;
    successAssets: number;
    zeroDetectionAssets: number;
    errorAssets: number;
  };
  source?: AssetDiagnosticResult;
  targets: AssetDiagnosticResult[];
};

const BATCH_ID_REGEX = /^c[a-z0-9]{24,}$/i;
const DEFAULT_TARGET_LIMIT = 3;
const MAX_TARGET_LIMIT = 10;
const DEFAULT_DETECTION_LIMIT = 10;
const MAX_DETECTION_LIMIT = 50;
const DEFAULT_MAX_CROPS = 10;
const MAX_CROPS = 30;
const DEFAULT_SOURCE_CROP_MIN_CONFIDENCE = 0.6;
const DEFAULT_SOURCE_CROP_PADDING = 0.08;
const DEFAULT_MIN_ANCHOR_OVERLAP = 0.2;
const DIAGNOSTICS_TOKEN_HEADER = 'x-sam3-diagnostics-token';
const DEFAULT_STRATEGIES: DiagnosticStrategy[] = [
  'box_prompt_match',
  'operator_visual_crops',
  'source_detection_crops',
  'concept_match',
  'concept_refined_box_prompt',
];

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string' && item.length > 0);
}

function uniqueAssetIds(ids: string[]): string[] {
  return Array.from(new Set(ids));
}

function toBoxArray(value: unknown): BoxCoordinate[] {
  if (!Array.isArray(value)) return [];

  return value
    .map((item) => {
      if (!item || typeof item !== 'object') return null;
      const record = item as Record<string, unknown>;
      const x1 = Number(record.x1);
      const y1 = Number(record.y1);
      const x2 = Number(record.x2);
      const y2 = Number(record.y2);
      if (![x1, y1, x2, y2].every(Number.isFinite)) return null;
      if (x1 === x2 || y1 === y2) return null;
      return {
        x1: Math.min(x1, x2),
        y1: Math.min(y1, y2),
        x2: Math.max(x1, x2),
        y2: Math.max(y1, y2),
      };
    })
    .filter((box): box is BoxCoordinate => Boolean(box));
}

function parseLimit(value: unknown, fallback: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(Math.trunc(parsed), 1), max);
}

function parseRatio(value: unknown, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, 0), 1);
}

function parseStrategies(value: unknown): DiagnosticStrategy[] {
  if (!Array.isArray(value)) return DEFAULT_STRATEGIES;
  const allowed = new Set(DEFAULT_STRATEGIES);
  const parsed = value.filter((item): item is DiagnosticStrategy =>
    typeof item === 'string' && allowed.has(item as DiagnosticStrategy)
  );
  return parsed.length > 0 ? parsed : DEFAULT_STRATEGIES;
}

function secureTokenEquals(provided: string, expected: string): boolean {
  const providedBuffer = Buffer.from(provided);
  const expectedBuffer = Buffer.from(expected);
  if (providedBuffer.length !== expectedBuffer.length) return false;

  return timingSafeEqual(providedBuffer, expectedBuffer);
}

function hasDiagnosticsTokenAccess(request: NextRequest): boolean {
  const expectedToken = process.env.SAM3_DIAGNOSTICS_TOKEN?.trim();
  const providedToken = request.headers.get(DIAGNOSTICS_TOKEN_HEADER)?.trim();

  if (!expectedToken || !providedToken) return false;

  try {
    return secureTokenEquals(providedToken, expectedToken);
  } catch {
    return false;
  }
}

async function parseBody(request: NextRequest): Promise<DiagnosticBody> {
  try {
    const body = await request.json();
    return body && typeof body === 'object' ? body : {};
  } catch {
    return {};
  }
}

async function fetchAssetImage(asset: AssetForDiagnostics): Promise<Buffer> {
  let imageUrl: string;

  if (asset.storageType?.toLowerCase() === 's3' && asset.s3Key) {
    imageUrl = asset.s3Bucket
      ? await S3Service.getSignedUrl(asset.s3Key, 3600, asset.s3Bucket)
      : await S3Service.getSignedUrl(asset.s3Key);
  } else if (asset.storageUrl) {
    const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
    imageUrl = asset.storageUrl.startsWith('/') ? `${baseUrl}${asset.storageUrl}` : asset.storageUrl;
  } else {
    throw new Error(`Asset ${asset.id} has no image URL`);
  }

  return fetchImageSafely(imageUrl, `Asset ${asset.id}`);
}

function bboxArea(bbox: [number, number, number, number]): number {
  return Math.max(0, bbox[2] - bbox[0]) * Math.max(0, bbox[3] - bbox[1]);
}

function bboxIou(
  first: [number, number, number, number],
  second: [number, number, number, number]
): number {
  const x1 = Math.max(first[0], second[0]);
  const y1 = Math.max(first[1], second[1]);
  const x2 = Math.min(first[2], second[2]);
  const y2 = Math.min(first[3], second[3]);
  const intersection = bboxArea([x1, y1, x2, y2]);
  const union = bboxArea(first) + bboxArea(second) - intersection;

  return union > 0 ? intersection / union : 0;
}

function normalizePolygon(
  polygon: [number, number][] | undefined,
  bbox: [number, number, number, number]
): [number, number][] {
  if (Array.isArray(polygon) && polygon.length >= 3) {
    return polygon.map((point) => [Math.round(point[0]), Math.round(point[1])] as [number, number]);
  }

  return [
    [bbox[0], bbox[1]],
    [bbox[2], bbox[1]],
    [bbox[2], bbox[3]],
    [bbox[0], bbox[3]],
  ];
}

function scaleBboxToOriginal(
  bbox: [number, number, number, number],
  scaleFactor: number
): [number, number, number, number] {
  if (scaleFactor === 1) return bbox;
  const inverseScale = 1 / scaleFactor;
  return [
    Math.round(bbox[0] * inverseScale),
    Math.round(bbox[1] * inverseScale),
    Math.round(bbox[2] * inverseScale),
    Math.round(bbox[3] * inverseScale),
  ];
}

function scalePolygonToOriginal(
  polygon: [number, number][] | undefined,
  bbox: [number, number, number, number],
  scaleFactor: number
): [number, number][] {
  if (!Array.isArray(polygon) || polygon.length < 3) return normalizePolygon(undefined, bbox);
  if (scaleFactor === 1) return normalizePolygon(polygon, bbox);
  const inverseScale = 1 / scaleFactor;
  return polygon.map((point) => [
    Math.round(point[0] * inverseScale),
    Math.round(point[1] * inverseScale),
  ] as [number, number]);
}

function conceptDetectionScore(
  detection: Pick<SAM3ConceptDetection, 'similarity' | 'confidence'>
): number {
  if (typeof detection.similarity === 'number' && Number.isFinite(detection.similarity)) {
    return detection.similarity;
  }
  if (typeof detection.confidence === 'number' && Number.isFinite(detection.confidence)) {
    return detection.confidence;
  }
  return 0;
}

function mapConceptDetection(detection: SAM3ConceptDetection): Detection {
  const confidence = conceptDetectionScore(detection);
  return {
    bbox: detection.bbox,
    polygon: normalizePolygon(detection.polygon, detection.bbox),
    confidence,
    similarity: typeof detection.similarity === 'number' ? detection.similarity : confidence,
  };
}

function bboxToResizedBox(
  bbox: [number, number, number, number],
  scaleFactor: number
): BoxCoordinate {
  return {
    x1: Math.round(bbox[0] * scaleFactor),
    y1: Math.round(bbox[1] * scaleFactor),
    x2: Math.round(bbox[2] * scaleFactor),
    y2: Math.round(bbox[3] * scaleFactor),
  };
}

function isValidBox(box: BoxCoordinate): boolean {
  return box.x2 > box.x1 && box.y2 > box.y1;
}

function bestCandidateMatchForBbox(
  bbox: [number, number, number, number],
  candidates: SAM3ConceptDetection[]
): { candidate: SAM3ConceptDetection; iou: number } | null {
  let bestCandidate: SAM3ConceptDetection | null = null;
  let bestIou = -1;

  for (const candidate of candidates) {
    const score = bboxIou(bbox, candidate.bbox);
    if (score > bestIou) {
      bestCandidate = candidate;
      bestIou = score;
    }
  }

  return bestCandidate ? { candidate: bestCandidate, iou: bestIou } : null;
}

function limitDetections(detections: Detection[], detectionLimit: number): Detection[] {
  return [...detections]
    .sort((left, right) => right.confidence - left.confidence)
    .slice(0, detectionLimit);
}

function toAssetResult(
  asset: AssetForDiagnostics,
  detections: Detection[],
  detectionLimit: number
): AssetDiagnosticResult {
  return {
    assetId: asset.id,
    fileName: asset.fileName,
    count: detections.length,
    outcome: detections.length > 0 ? 'success' : 'zero_detections',
    topConfidence: detections.length > 0
      ? Math.max(...detections.map((detection) => detection.confidence))
      : null,
    detections: limitDetections(detections, detectionLimit),
  };
}

function toErrorResult(
  asset: AssetForDiagnostics,
  error: string,
  errorCode?: string
): AssetDiagnosticResult {
  return {
    assetId: asset.id,
    fileName: asset.fileName,
    count: 0,
    outcome: 'error',
    error,
    errorCode,
    topConfidence: null,
    detections: [],
  };
}

function summarizeStrategy(
  result: Omit<StrategyDiagnosticResult, 'totals'>
): StrategyDiagnosticResult {
  const assetResults = [
    ...(result.source ? [result.source] : []),
    ...result.targets,
  ];

  return {
    ...result,
    totals: {
      detections: assetResults.reduce((sum, asset) => sum + asset.count, 0),
      successAssets: assetResults.filter((asset) => asset.outcome === 'success').length,
      zeroDetectionAssets: assetResults.filter((asset) => asset.outcome === 'zero_detections').length,
      errorAssets: assetResults.filter((asset) => asset.outcome === 'error').length,
    },
  };
}

async function ensureSam3Ready(startIfNeeded: boolean) {
  const initial = await awsSam3Service.refreshStatus();
  if (awsSam3Service.isReady()) return { ready: true, status: initial, started: false };

  if (!startIfNeeded) {
    return { ready: false, status: initial, started: false };
  }

  const started = await awsSam3Service.startInstance();
  const status = await awsSam3Service.refreshStatus();
  return { ready: awsSam3Service.isReady(), status, started };
}

async function runBoxPromptMatch({
  asset,
  imageBuffer,
  boxes,
  className,
  detectionLimit,
}: {
  asset: AssetForDiagnostics;
  imageBuffer: Buffer;
  boxes: BoxCoordinate[];
  className: string;
  detectionLimit: number;
}): Promise<AssetDiagnosticResult> {
  const resized = await awsSam3Service.resizeImage(imageBuffer);
  const result = await awsSam3Service.segment({
    image: resized.buffer.toString('base64'),
    boxes: boxes.map((box) => ({
      x1: Math.round(box.x1 * resized.scaling.scaleFactor),
      y1: Math.round(box.y1 * resized.scaling.scaleFactor),
      x2: Math.round(box.x2 * resized.scaling.scaleFactor),
      y2: Math.round(box.y2 * resized.scaling.scaleFactor),
    })),
    className,
  });

  if (!result.success || !result.response) {
    return toErrorResult(asset, result.error || 'SAM3 box-prompt matching failed.', result.errorCode);
  }

  const detections = result.response.detections.map((detection) => {
    const bbox = scaleBboxToOriginal(detection.bbox, resized.scaling.scaleFactor);
    const polygon = (detection as { polygon?: [number, number][] }).polygon;
    return {
      bbox,
      polygon: scalePolygonToOriginal(polygon, bbox, resized.scaling.scaleFactor),
      confidence: detection.confidence,
    };
  });

  return toAssetResult(asset, detections, detectionLimit);
}

async function runVisualCropMatch({
  asset,
  imageBuffer,
  crops,
  className,
  detectionLimit,
}: {
  asset: AssetForDiagnostics;
  imageBuffer: Buffer;
  crops: string[];
  className: string;
  detectionLimit: number;
}): Promise<AssetDiagnosticResult> {
  if (crops.length === 0) {
    return toErrorResult(asset, 'No visual crops available for this strategy.', 'NO_CROPS');
  }

  const resized = await awsSam3Service.resizeImage(imageBuffer);
  const result = await awsSam3Service.segmentWithExemplars({
    image: resized.buffer.toString('base64'),
    exemplarCrops: crops,
    className,
  });

  if (!result.success || !result.response) {
    return toErrorResult(asset, result.error || 'SAM3 visual crop matching failed.', result.errorCode);
  }

  const detections = result.response.detections.map((detection) => {
    const bbox = scaleBboxToOriginal(detection.bbox, resized.scaling.scaleFactor);
    const polygon = (detection as { polygon?: [number, number][] }).polygon;
    return {
      bbox,
      polygon: scalePolygonToOriginal(polygon, bbox, resized.scaling.scaleFactor),
      confidence: detection.confidence,
    };
  });

  return toAssetResult(asset, detections, detectionLimit);
}

async function createConceptExemplar(source: LoadedAsset, sourceBoxes: BoxCoordinate[], className: string) {
  const warmup = await awsSam3Service.warmupConceptService();
  if (!warmup.success) {
    return { exemplarId: null, error: warmup.error || 'Concept service warmup failed.' };
  }

  const exemplar = await awsSam3Service.createConceptExemplar({
    imageBuffer: source.buffer,
    boxes: sourceBoxes,
    className,
    imageId: source.id,
  });

  if (!exemplar.success || !exemplar.data?.exemplarId) {
    return { exemplarId: null, error: exemplar.error || 'Concept exemplar creation failed.' };
  }

  return { exemplarId: exemplar.data.exemplarId, error: null };
}

async function getConceptCandidates({
  asset,
  imageBuffer,
  exemplarId,
  primaryOptions,
  fallbackOptions,
}: {
  asset: AssetForDiagnostics;
  imageBuffer: Buffer;
  exemplarId: string;
  primaryOptions: SAM3ConceptApplyOptions;
  fallbackOptions: SAM3ConceptApplyOptions;
}): Promise<{ candidates: SAM3ConceptDetection[]; error?: string; errorCode?: string; strictCount: number; fallbackCount: number }> {
  const primary = await awsSam3Service.applyConceptExemplar({
    exemplarId,
    imageBuffer,
    imageId: asset.id,
    options: primaryOptions,
  });

  if (!primary.success || !primary.data) {
    return {
      candidates: [],
      error: primary.error || 'Concept matching failed.',
      errorCode: primary.errorCode,
      strictCount: 0,
      fallbackCount: 0,
    };
  }

  const strictCandidates = filterBatchV2ConceptDetections(primary.data.detections, primaryOptions);
  if (strictCandidates.length >= SAM3_BATCH_V2_MIN_TARGET_CANDIDATES) {
    return {
      candidates: strictCandidates,
      strictCount: strictCandidates.length,
      fallbackCount: 0,
    };
  }

  const fallback = await awsSam3Service.applyConceptExemplar({
    exemplarId,
    imageBuffer,
    imageId: asset.id,
    options: fallbackOptions,
  });
  const fallbackCandidates =
    fallback.success && fallback.data
      ? filterBatchV2ConceptDetections(fallback.data.detections, fallbackOptions)
      : [];

  return {
    candidates: [...strictCandidates, ...fallbackCandidates]
      .sort((left, right) => conceptDetectionScore(right) - conceptDetectionScore(left)),
    strictCount: strictCandidates.length,
    fallbackCount: fallbackCandidates.length,
  };
}

async function runConceptMatch({
  asset,
  imageBuffer,
  exemplarId,
  primaryOptions,
  fallbackOptions,
  detectionLimit,
}: {
  asset: AssetForDiagnostics;
  imageBuffer: Buffer;
  exemplarId: string;
  primaryOptions: SAM3ConceptApplyOptions;
  fallbackOptions: SAM3ConceptApplyOptions;
  detectionLimit: number;
}): Promise<AssetDiagnosticResult> {
  const candidates = await getConceptCandidates({
    asset,
    imageBuffer,
    exemplarId,
    primaryOptions,
    fallbackOptions,
  });

  if (candidates.error) {
    return toErrorResult(asset, candidates.error, candidates.errorCode);
  }

  return toAssetResult(asset, candidates.candidates.map(mapConceptDetection), detectionLimit);
}

async function runConceptRefinedMatch({
  asset,
  imageBuffer,
  exemplarId,
  className,
  primaryOptions,
  fallbackOptions,
  detectionLimit,
}: {
  asset: AssetForDiagnostics;
  imageBuffer: Buffer;
  exemplarId: string;
  className: string;
  primaryOptions: SAM3ConceptApplyOptions;
  fallbackOptions: SAM3ConceptApplyOptions;
  detectionLimit: number;
}): Promise<AssetDiagnosticResult> {
  const candidatesResult = await getConceptCandidates({
    asset,
    imageBuffer,
    exemplarId,
    primaryOptions,
    fallbackOptions,
  });

  if (candidatesResult.error) {
    return toErrorResult(asset, candidatesResult.error, candidatesResult.errorCode);
  }

  const candidates = candidatesResult.candidates;
  if (candidates.length === 0) {
    return toAssetResult(asset, [], detectionLimit);
  }

  const resized = await awsSam3Service.resizeImage(imageBuffer);
  const boxes = candidates
    .slice(0, Number(primaryOptions.topK) || 120)
    .map((candidate) => bboxToResizedBox(candidate.bbox, resized.scaling.scaleFactor))
    .filter(isValidBox);

  if (boxes.length === 0) {
    return toAssetResult(asset, candidates.map(mapConceptDetection), detectionLimit);
  }

  const refined = await awsSam3Service.segment({
    image: resized.buffer.toString('base64'),
    boxes,
    className,
  });

  if (!refined.success || !refined.response || refined.response.detections.length === 0) {
    return toAssetResult(asset, candidates.map(mapConceptDetection), detectionLimit);
  }

  const matchedKeys = new Set<string>();
  const refinedDetections = refined.response.detections.flatMap((detection) => {
    const bbox = scaleBboxToOriginal(detection.bbox, resized.scaling.scaleFactor);
    const match = bestCandidateMatchForBbox(bbox, candidates);
    if (!match || match.iou < SAM3_BATCH_V2_MIN_REFINEMENT_IOU) return [];

    matchedKeys.add(`${match.candidate.bbox.join(',')}:${conceptDetectionScore(match.candidate)}`);
    const polygon = (detection as { polygon?: [number, number][] }).polygon;
    return [{
      bbox,
      polygon: scalePolygonToOriginal(polygon, bbox, resized.scaling.scaleFactor),
      confidence: conceptDetectionScore(match.candidate),
      similarity: match.candidate.similarity,
    }];
  });

  const unmatchedCandidates = candidates
    .filter((candidate) => !matchedKeys.has(`${candidate.bbox.join(',')}:${conceptDetectionScore(candidate)}`))
    .map(mapConceptDetection);

  return toAssetResult(asset, [...refinedDetections, ...unmatchedCandidates], detectionLimit);
}

function applyConceptOverrides(
  options: SAM3ConceptApplyOptions,
  overrides: Partial<DiagnosticBody>,
  prefix: 'concept' | 'conceptFallback'
): SAM3ConceptApplyOptions {
  const next = { ...options };
  const similarityKey = prefix === 'concept'
    ? 'conceptSimilarityThreshold'
    : 'conceptFallbackSimilarityThreshold';
  const topKKey = prefix === 'concept' ? 'conceptTopK' : 'conceptFallbackTopK';

  if (overrides[similarityKey] != null) {
    next.similarityThreshold = parseRatio(overrides[similarityKey], Number(next.similarityThreshold ?? 0));
  }
  if (overrides[topKKey] != null) {
    next.topK = parseLimit(overrides[topKKey], Number(next.topK ?? 120), 500);
  }

  return next;
}

export async function POST(
  request: NextRequest,
  { params }: RouteParams
): Promise<NextResponse> {
  const diagnosticsTokenAccess = hasDiagnosticsTokenAccess(request);
  const rateLimitKey = diagnosticsTokenAccess
    ? 'sam3-v2-diagnostics-token'
    : 'sam3-v2-diagnostics';
  const rateLimit = checkRateLimit(getRateLimitKey(request, rateLimitKey), {
    maxRequests: diagnosticsTokenAccess ? 30 : 4,
    windowMs: 60000,
  });

  if (!rateLimit.allowed) {
    return NextResponse.json(
      { success: false, error: 'Too many diagnostics requests' },
      {
        status: 429,
        headers: {
          'Retry-After': String(Math.ceil((rateLimit.resetTime - Date.now()) / 1000)),
        },
      }
    );
  }

  const { batchId } = await params;
  if (!BATCH_ID_REGEX.test(batchId)) {
    return NextResponse.json(
      { success: false, error: 'Invalid batch job ID format' },
      { status: 400 }
    );
  }

  const body = await parseBody(request);
  const targetLimit = parseLimit(body.targetLimit, DEFAULT_TARGET_LIMIT, MAX_TARGET_LIMIT);
  const detectionLimit = parseLimit(body.detectionLimit, DEFAULT_DETECTION_LIMIT, MAX_DETECTION_LIMIT);
  const maxCrops = parseLimit(body.maxCrops, DEFAULT_MAX_CROPS, MAX_CROPS);
  const strategies = parseStrategies(body.strategies);
  const includeSourceTarget = body.includeSourceTarget !== false;
  const sourceCropMinConfidence = parseRatio(
    body.sourceCropMinConfidence,
    DEFAULT_SOURCE_CROP_MIN_CONFIDENCE
  );
  const sourceCropPadding = parseRatio(body.sourceCropPadding, DEFAULT_SOURCE_CROP_PADDING);
  const minAnchorOverlap = parseRatio(body.minAnchorOverlap, DEFAULT_MIN_ANCHOR_OVERLAP);

  const batchJob = await prisma.batchJob.findUnique({
    where: { id: batchId },
    include: {
      project: {
        select: {
          id: true,
          name: true,
        },
      },
      childBatchJobs: {
        orderBy: [
          { shardIndex: 'asc' },
          { createdAt: 'asc' },
        ],
        select: {
          id: true,
          assetIds: true,
        },
      },
    },
  });

  if (!batchJob) {
    return NextResponse.json(
      { success: false, error: 'Batch job not found' },
      { status: 404 }
    );
  }

  if (!diagnosticsTokenAccess) {
    const projectAccess = await checkProjectAccess(batchJob.projectId);
    if (!projectAccess.authenticated) {
      return NextResponse.json(
        { success: false, error: 'Authentication required' },
        { status: 401 }
      );
    }
    if (!projectAccess.hasAccess) {
      return NextResponse.json(
        { success: false, error: projectAccess.error || 'Access denied' },
        { status: 403 }
      );
    }
  }

  const rawExemplars = toBoxArray(batchJob.exemplars);
  if (rawExemplars.length === 0) {
    return NextResponse.json(
      { success: false, error: 'Batch job does not contain replayable source boxes' },
      { status: 400 }
    );
  }

  const childAssetIds = batchJob.childBatchJobs.flatMap((childJob) =>
    toStringArray(childJob.assetIds)
  );
  const directAssetIds = toStringArray(batchJob.assetIds);
  let assetIdSource = directAssetIds.length > 0
    ? 'batch_asset_ids'
    : childAssetIds.length > 0
      ? 'child_batch_jobs'
      : 'pending_annotations';
  let batchAssetIds = uniqueAssetIds(directAssetIds.length > 0 ? directAssetIds : childAssetIds);

  if (batchAssetIds.length === 0) {
    // Some older successful v2 runs persisted annotations but did not backfill BatchJob.assetIds.
    const pendingAssetRows = await prisma.pendingAnnotation.findMany({
      where: { batchJobId: batchJob.id },
      select: { assetId: true },
      orderBy: [
        { createdAt: 'asc' },
        { assetId: 'asc' },
      ],
    });
    batchAssetIds = uniqueAssetIds(pendingAssetRows.map((row) => row.assetId));
    assetIdSource = 'pending_annotations';
  }
  const sourceAssetId = batchJob.sourceAssetId || batchAssetIds[0];

  if (!sourceAssetId) {
    return NextResponse.json(
      { success: false, error: 'Batch job does not contain a source asset' },
      { status: 400 }
    );
  }

  const targetAssetIds = batchAssetIds.filter((assetId) => assetId !== sourceAssetId);
  const diagnosticTargetIds = targetAssetIds.slice(0, targetLimit);
  const assetIdsToLoad = uniqueAssetIds([
    sourceAssetId,
    ...(includeSourceTarget ? [sourceAssetId] : []),
    ...diagnosticTargetIds,
  ]);

  const assets: AssetForDiagnostics[] = await prisma.asset.findMany({
    where: {
      id: { in: assetIdsToLoad },
      projectId: batchJob.projectId,
    },
    select: {
      id: true,
      fileName: true,
      storageUrl: true,
      storageType: true,
      s3Key: true,
      s3Bucket: true,
      imageWidth: true,
      imageHeight: true,
    },
  });
  const assetById = new Map(assets.map((asset) => [asset.id, asset]));
  const sourceAsset = assetById.get(sourceAssetId);
  if (!sourceAsset) {
    return NextResponse.json(
      { success: false, error: 'Source asset could not be found' },
      { status: 400 }
    );
  }

  const orderedTargets: AssetForDiagnostics[] = [];
  for (const assetId of diagnosticTargetIds) {
    const asset = assetById.get(assetId);
    if (asset) orderedTargets.push(asset);
  }

  const sourceBoxes = scaleExemplarBoxes({
    exemplars: rawExemplars,
    sourceWidth: batchJob.exemplarSourceWidth || undefined,
    sourceHeight: batchJob.exemplarSourceHeight || undefined,
    targetWidth: sourceAsset.imageWidth || batchJob.exemplarSourceWidth || 0,
    targetHeight: sourceAsset.imageHeight || batchJob.exemplarSourceHeight || 0,
    maxBoxes: rawExemplars.length,
    jobId: batchJob.id,
    assetId: sourceAsset.id,
  });

  if (sourceBoxes.boxes.length === 0) {
    return NextResponse.json(
      { success: false, error: 'Source boxes could not be scaled for diagnostics' },
      { status: 400 }
    );
  }

  const sam3Ready = await ensureSam3Ready(Boolean(body.startIfNeeded));
  if (!sam3Ready.ready) {
    return NextResponse.json(
      {
        success: false,
        error: 'SAM3 is not ready for diagnostics',
        sam3: {
          started: sam3Ready.started,
          status: sam3Ready.status,
          retryWith: { startIfNeeded: true },
        },
      },
      { status: 409 }
    );
  }

  const className = batchJob.textPrompt || batchJob.weedType;
  const loadedSource: LoadedAsset = {
    ...sourceAsset,
    buffer: await fetchAssetImage(sourceAsset),
  };
  const loadedTargets: LoadedAsset[] = [];
  for (const target of orderedTargets) {
    loadedTargets.push({
      ...target,
      buffer: await fetchAssetImage(target),
    });
  }

  const sourceBoxResult = await runBoxPromptMatch({
    asset: loadedSource,
    imageBuffer: loadedSource.buffer,
    boxes: sourceBoxes.boxes,
    className,
    detectionLimit,
  });

  const operatorCrops = await buildExemplarCrops({
    imageBuffer: loadedSource.buffer,
    boxes: sourceBoxes.boxes,
    maxCrops,
  });
  const sourceDetectionCropInputs = sourceBoxResult.detections.filter((detection) =>
    sourceBoxes.boxes.some((box) =>
      bboxIou(detection.bbox, [box.x1, box.y1, box.x2, box.y2]) >= minAnchorOverlap
    )
  );
  const sourceDetectionCrops = await buildExemplarCropsFromDetections({
    imageBuffer: loadedSource.buffer,
    detections: sourceDetectionCropInputs,
    maxCrops,
    minConfidence: sourceCropMinConfidence,
    paddingRatio: sourceCropPadding,
    maskPolygons: body.sourceCropMask !== false,
  });

  const strategyResults: StrategyDiagnosticResult[] = [];

  if (strategies.includes('box_prompt_match')) {
    const targets = [];
    for (const target of loadedTargets) {
      const targetBoxes = scaleExemplarBoxes({
        exemplars: rawExemplars,
        sourceWidth: batchJob.exemplarSourceWidth || undefined,
        sourceHeight: batchJob.exemplarSourceHeight || undefined,
        targetWidth: target.imageWidth || batchJob.exemplarSourceWidth || 0,
        targetHeight: target.imageHeight || batchJob.exemplarSourceHeight || 0,
        maxBoxes: rawExemplars.length,
        jobId: batchJob.id,
        assetId: target.id,
      });
      targets.push(
        await runBoxPromptMatch({
          asset: target,
          imageBuffer: target.buffer,
          boxes: targetBoxes.boxes,
          className,
          detectionLimit,
        })
      );
    }

    strategyResults.push(summarizeStrategy({
      name: 'box_prompt_match',
      cropCount: sourceBoxes.boxes.length,
      source: includeSourceTarget ? sourceBoxResult : undefined,
      targets,
    }));
  }

  if (strategies.includes('operator_visual_crops')) {
    const targets = [];
    for (const target of loadedTargets) {
      targets.push(
        await runVisualCropMatch({
          asset: target,
          imageBuffer: target.buffer,
          crops: operatorCrops,
          className,
          detectionLimit,
        })
      );
    }

    strategyResults.push(summarizeStrategy({
      name: 'operator_visual_crops',
      cropCount: operatorCrops.length,
      targets,
    }));
  }

  if (strategies.includes('source_detection_crops')) {
    const targets = [];
    for (const target of loadedTargets) {
      targets.push(
        await runVisualCropMatch({
          asset: target,
          imageBuffer: target.buffer,
          crops: sourceDetectionCrops,
          className,
          detectionLimit,
        })
      );
    }

    strategyResults.push(summarizeStrategy({
      name: 'source_detection_crops',
      cropCount: sourceDetectionCrops.length,
      targets,
    }));
  }

  const needsConcept = strategies.includes('concept_match') || strategies.includes('concept_refined_box_prompt');
  const primaryConceptOptions = applyConceptOverrides(
    buildBatchV2ConceptApplyOptions(),
    body,
    'concept'
  );
  const fallbackConceptOptions = applyConceptOverrides(
    buildBatchV2ConceptFallbackApplyOptions(),
    body,
    'conceptFallback'
  );

  if (needsConcept) {
    const concept = await createConceptExemplar(loadedSource, sourceBoxes.boxes, className);
    if (!concept.exemplarId) {
      const errorTargets = loadedTargets.map((target) =>
        toErrorResult(target, concept.error || 'Concept exemplar unavailable.', 'CONCEPT_EXEMPLAR_FAILED')
      );

      if (strategies.includes('concept_match')) {
        strategyResults.push(summarizeStrategy({
          name: 'concept_match',
          conceptOptions: primaryConceptOptions as Record<string, unknown>,
          targets: errorTargets,
        }));
      }
      if (strategies.includes('concept_refined_box_prompt')) {
        strategyResults.push(summarizeStrategy({
          name: 'concept_refined_box_prompt',
          conceptOptions: primaryConceptOptions as Record<string, unknown>,
          targets: errorTargets,
        }));
      }
    } else {
      if (strategies.includes('concept_match')) {
        const targets = [];
        for (const target of loadedTargets) {
          targets.push(
            await runConceptMatch({
              asset: target,
              imageBuffer: target.buffer,
              exemplarId: concept.exemplarId,
              primaryOptions: primaryConceptOptions,
              fallbackOptions: fallbackConceptOptions,
              detectionLimit,
            })
          );
        }

        strategyResults.push(summarizeStrategy({
          name: 'concept_match',
          conceptOptions: primaryConceptOptions as Record<string, unknown>,
          targets,
        }));
      }

      if (strategies.includes('concept_refined_box_prompt')) {
        const targets = [];
        for (const target of loadedTargets) {
          targets.push(
            await runConceptRefinedMatch({
              asset: target,
              imageBuffer: target.buffer,
              exemplarId: concept.exemplarId,
              className,
              primaryOptions: primaryConceptOptions,
              fallbackOptions: fallbackConceptOptions,
              detectionLimit,
            })
          );
        }

        strategyResults.push(summarizeStrategy({
          name: 'concept_refined_box_prompt',
          conceptOptions: primaryConceptOptions as Record<string, unknown>,
          targets,
        }));
      }
    }
  }

  const bestStrategy = [...strategyResults].sort(
    (left, right) => right.totals.detections - left.totals.detections
  )[0];

  return NextResponse.json({
    success: true,
    persisted: false,
    createdAt: new Date().toISOString(),
    batchJob: {
      id: batchJob.id,
      projectId: batchJob.projectId,
      projectName: batchJob.project.name,
      weedType: batchJob.weedType,
      textPrompt: batchJob.textPrompt,
      kind: batchJob.kind,
      mode: batchJob.mode,
      status: batchJob.status,
      totalImages: batchJob.totalImages,
      detectionsFound: batchJob.detectionsFound,
    },
    sam3: {
      started: sam3Ready.started,
      status: sam3Ready.status,
    },
    request: {
      authMode: diagnosticsTokenAccess ? 'diagnostics_token' : 'session',
      assetIdSource,
      targetLimit,
      includedTargetCount: loadedTargets.length,
      availableTargetCount: targetAssetIds.length,
      strategies,
      detectionLimit,
      maxCrops,
    },
    source: {
      id: loadedSource.id,
      fileName: loadedSource.fileName,
      width: loadedSource.imageWidth,
      height: loadedSource.imageHeight,
      sourceBoxes: sourceBoxes.boxes,
      sourceBoxScalingWarnings: sourceBoxes.warnings,
      sourceBoxDetectionCount: sourceBoxResult.count,
      operatorCropCount: operatorCrops.length,
      sourceDetectionCropCount: sourceDetectionCrops.length,
    },
    strategies: strategyResults,
    recommendation: {
      currentProductionStrategy: 'box_prompt_match',
      bestStrategyByDetectionCount: bestStrategy
        ? {
            name: bestStrategy.name,
            detections: bestStrategy.totals.detections,
          }
        : null,
      interpretation:
        bestStrategy && bestStrategy.name !== 'box_prompt_match'
          ? 'A non-production strategy produced more candidates; inspect returned boxes before promoting it.'
          : 'Current production strategy produced the highest candidate count in this diagnostic slice.',
    },
  });
}
