import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/db';
import { getAuthenticatedUser } from '@/lib/auth/api-auth';
import {
  centerBoxToCorner,
  computeExportProjectionGeo,
  polygonToCenterBox,
  rescaleToOriginalWithMeta,
  validateGeoParams,
} from '@/lib/utils/georeferencing';
import {
  applySessionBiasCorrection,
  solveSessionAssetBias,
} from '@/lib/utils/session-bias';
import type { CenterBox, YOLOPreprocessingMeta } from '@/lib/types/detection';

type ReviewStatus = 'pending' | 'accepted' | 'rejected';
const DEFAULT_SESSION_BIAS_RADIUS_M = 2.5;
const MIN_SESSION_BIAS_RADIUS_M = 0.8;
const MAX_SESSION_BIAS_RADIUS_M = 6;

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry) => typeof entry === 'string') as string[];
}

function parseCenterBox(value: unknown): CenterBox | null {
  if (!value) return null;
  let parsed: unknown = value;
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value);
    } catch {
      return null;
    }
  }

  if (
    parsed &&
    typeof parsed === 'object' &&
    'x' in parsed &&
    'y' in parsed &&
    'width' in parsed &&
    'height' in parsed
  ) {
    const candidate = parsed as { x: unknown; y: unknown; width: unknown; height: unknown };
    if (
      typeof candidate.x !== 'number' ||
      typeof candidate.y !== 'number' ||
      typeof candidate.width !== 'number' ||
      typeof candidate.height !== 'number' ||
      !Number.isFinite(candidate.x) ||
      !Number.isFinite(candidate.y) ||
      !Number.isFinite(candidate.width) ||
      !Number.isFinite(candidate.height) ||
      candidate.width <= 0 ||
      candidate.height <= 0
    ) {
      return null;
    }
    return {
      x: candidate.x,
      y: candidate.y,
      width: candidate.width,
      height: candidate.height,
    };
  }

  if (Array.isArray(parsed) && parsed.length >= 4) {
    const [x1, y1, x2, y2] = parsed as number[];
    if (
      !Number.isFinite(x1) ||
      !Number.isFinite(y1) ||
      !Number.isFinite(x2) ||
      !Number.isFinite(y2)
    ) {
      return null;
    }
    const width = x2 - x1;
    const height = y2 - y1;
    if (width <= 0 || height <= 0) return null;
    return {
      x: x1 + width / 2,
      y: y1 + height / 2,
      width,
      height,
    };
  }

  return null;
}

function parseCornerBox(value: unknown): [number, number, number, number] | null {
  if (!value) return null;
  let parsed: unknown = value;
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (Array.isArray(parsed) && parsed.length >= 4) {
    const [x1, y1, x2, y2] = parsed as number[];
    return [x1, y1, x2, y2];
  }
  return null;
}

function manualConfidenceToScore(confidence: string | null): number {
  if (confidence === 'CERTAIN') return 0.95;
  if (confidence === 'LIKELY') return 0.75;
  return 0.5;
}

function parseBooleanParam(value: string | null, defaultValue: boolean): boolean {
  if (value == null) return defaultValue;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'true' || normalized === '1') return true;
  if (normalized === 'false' || normalized === '0') return false;
  return defaultValue;
}

function parsePositiveNumberParam(
  value: string | null,
  defaultValue: number,
  minValue?: number,
  maxValue?: number
): number {
  if (!value) return defaultValue;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return defaultValue;
  let normalized = parsed;
  if (minValue != null) normalized = Math.max(minValue, normalized);
  if (maxValue != null) normalized = Math.min(maxValue, normalized);
  return normalized;
}

function isFiniteGeoCoordinate(lat: unknown, lon: unknown): lat is number {
  return (
    typeof lat === 'number' &&
    typeof lon === 'number' &&
    Number.isFinite(lat) &&
    Number.isFinite(lon) &&
    lat >= -90 &&
    lat <= 90 &&
    lon >= -180 &&
    lon <= 180
  );
}

function toClientAsset<T extends {
  id: string;
  fileName: string;
  storageUrl: string;
  gpsLatitude: number | null;
  gpsLongitude: number | null;
  altitude: number | null;
  gimbalPitch: number | null;
  gimbalRoll: number | null;
  gimbalYaw: number | null;
  imageWidth: number | null;
  imageHeight: number | null;
}>(asset: T) {
  return {
    id: asset.id,
    fileName: asset.fileName,
    storageUrl: asset.storageUrl,
    gpsLatitude: asset.gpsLatitude,
    gpsLongitude: asset.gpsLongitude,
    altitude: asset.altitude,
    gimbalPitch: asset.gimbalPitch,
    gimbalRoll: asset.gimbalRoll,
    gimbalYaw: asset.gimbalYaw,
    imageWidth: asset.imageWidth,
    imageHeight: asset.imageHeight,
  };
}

async function resolveCenterGeo(
  asset: {
    gpsLatitude: number | null;
    gpsLongitude: number | null;
    altitude: number | null;
    gimbalPitch: number | null;
    gimbalRoll: number | null;
    gimbalYaw: number | null;
    cameraFov: number | null;
    imageWidth: number | null;
    imageHeight: number | null;
    metadata?: unknown | null;
    lrfDistance?: number | null;
    lrfTargetLat?: number | null;
    lrfTargetLon?: number | null;
  },
  bboxCenter: CenterBox | null | undefined,
  storedLat: number | null | undefined,
  storedLon: number | null | undefined
): Promise<{ lat: number | null; lon: number | null }> {
  if (isFiniteGeoCoordinate(storedLat, storedLon)) {
    return { lat: storedLat, lon: storedLon };
  }

  if (!bboxCenter) {
    return { lat: null, lon: null };
  }

  try {
    const geo = await computeExportProjectionGeo(
      asset,
      { x: bboxCenter.x, y: bboxCenter.y }
    );
    if (geo && isFiniteGeoCoordinate(geo.lat, geo.lon)) {
      return { lat: geo.lat, lon: geo.lon };
    }
    return { lat: null, lon: null };
  } catch {
    return { lat: null, lon: null };
  }
}

export async function GET(
  request: NextRequest,
  { params }: { params: { sessionId: string } }
) {
  try {
    const auth = await getAuthenticatedUser();
    if (!auth.authenticated || !auth.userId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const session = await prisma.reviewSession.findUnique({
      where: { id: params.sessionId },
    });

    if (!session) {
      return NextResponse.json({ error: 'Review session not found' }, { status: 404 });
    }

    const membership = await prisma.teamMember.findFirst({
      where: {
        teamId: session.teamId,
        userId: auth.userId,
      },
      select: { id: true },
    });

    if (!membership) {
      return NextResponse.json({ error: 'Access denied' }, { status: 403 });
    }

    const searchParams = request.nextUrl.searchParams;
    const assetIdFilter = searchParams.get('assetId');
    const needsReview = searchParams.get('needsReview') === 'true';
    const minConfidenceParam = searchParams.get('minConfidence');
    const minConfidence = minConfidenceParam ? Number(minConfidenceParam) : null;
    const sessionBiasEnabled = parseBooleanParam(searchParams.get('sessionBias'), true);
    const sessionBiasRadiusM = parsePositiveNumberParam(
      searchParams.get('sessionBiasRadiusM'),
      DEFAULT_SESSION_BIAS_RADIUS_M,
      MIN_SESSION_BIAS_RADIUS_M,
      MAX_SESSION_BIAS_RADIUS_M
    );

    const assetIds = toStringArray(session.assetIds);
    const inferenceJobIds = toStringArray(session.inferenceJobIds);
    const batchJobIds = toStringArray(session.batchJobIds);
    const isBatchReview = session.workflowType === 'batch_review';
    const createdAfter = session.createdAt;

    let yoloInferenceJobIds: string[] = [];
    let processingJobIds: string[] = [];
    if (inferenceJobIds.length > 0) {
      const [yoloJobs, processingJobs] = await Promise.all([
        prisma.yOLOInferenceJob.findMany({
          where: { id: { in: inferenceJobIds }, projectId: session.projectId },
          select: { id: true },
        }),
        prisma.processingJob.findMany({
          where: {
            id: { in: inferenceJobIds },
            projectId: session.projectId,
            type: 'AI_DETECTION',
          },
          select: { id: true },
        }),
      ]);
      yoloInferenceJobIds = yoloJobs.map((job) => job.id);
      processingJobIds = processingJobs.map((job) => job.id);
    }

    if (assetIds.length === 0) {
      return NextResponse.json({ items: [] });
    }

    const existingAssets = await prisma.asset.findMany({
      where: { id: { in: assetIds } },
      select: { id: true },
    });
    const validAssetIds = new Set(existingAssets.map((asset) => asset.id));
    const filteredAssetIds = assetIdFilter && validAssetIds.has(assetIdFilter)
      ? [assetIdFilter]
      : Array.from(validAssetIds);

    if (filteredAssetIds.length === 0) {
      return NextResponse.json({ items: [] });
    }

    const assetSelect = {
      id: true,
      fileName: true,
      storageUrl: true,
      gpsLatitude: true,
      gpsLongitude: true,
      altitude: true,
      gimbalPitch: true,
      gimbalRoll: true,
      gimbalYaw: true,
      cameraFov: true,
      imageWidth: true,
      imageHeight: true,
      lrfDistance: true,
      lrfTargetLat: true,
      lrfTargetLon: true,
      metadata: true,
    };

    const manualAnnotationsPromise = !isBatchReview
      ? prisma.manualAnnotation.findMany({
          where: {
            session: {
              assetId: { in: filteredAssetIds },
            },
            createdAt: { gte: createdAfter },
          },
          include: {
            session: {
              select: {
                asset: { select: assetSelect },
              },
            },
          },
        })
      : Promise.resolve([]);

    const aiDetectionsPromise = !isBatchReview
      ? prisma.detection.findMany({
          where: {
            assetId: { in: filteredAssetIds },
            type: 'AI',
            ...(processingJobIds.length > 0
              ? { jobId: { in: processingJobIds } }
              : { createdAt: { gte: createdAfter } }),
          },
          include: {
            asset: { select: assetSelect },
            customModel: {
              select: { id: true, name: true, version: true, displayName: true },
            },
          },
        })
      : Promise.resolve([]);

    const yoloDetectionsPromise = !isBatchReview && yoloInferenceJobIds.length > 0
      ? prisma.detection.findMany({
          where: {
            assetId: { in: filteredAssetIds },
            type: 'YOLO_LOCAL',
            inferenceJobId: { in: yoloInferenceJobIds },
          },
          include: {
            asset: { select: assetSelect },
          },
        })
      : Promise.resolve([]);

    const pendingAnnotationsPromise = batchJobIds.length > 0
      ? prisma.pendingAnnotation.findMany({
          where: {
            assetId: { in: filteredAssetIds },
            batchJobId: { in: batchJobIds },
          },
          include: {
            asset: { select: assetSelect },
            batchJob: { select: { id: true, exemplarId: true, weedType: true } },
          },
        })
      : Promise.resolve([]);

    const [manualAnnotations, aiDetections, yoloDetections, pendingAnnotations] = await Promise.all([
      manualAnnotationsPromise,
      aiDetectionsPromise,
      yoloDetectionsPromise,
      pendingAnnotationsPromise,
    ]);

    const manualItems = await Promise.all(manualAnnotations.map(async (annotation) => {
        const assetRecord = annotation.session.asset;
        const asset = toClientAsset(assetRecord);
        const validation = validateGeoParams(asset);
        const polygon = Array.isArray(annotation.coordinates)
          ? (annotation.coordinates as number[][])
          : [];
        const centerBox = polygonToCenterBox(polygon);
        const cornerBox = centerBox ? centerBoxToCorner(centerBox) : undefined;
        const centerGeo = await resolveCenterGeo(
          assetRecord,
          centerBox,
          annotation.centerLat,
          annotation.centerLon
        );

        const status: ReviewStatus = annotation.verified
          ? 'accepted'
          : annotation.verifiedAt
            ? 'rejected'
            : 'pending';

        return {
          id: annotation.id,
          source: 'manual' as const,
          sourceId: annotation.id,
          assetId: annotation.session.asset.id,
          asset,
          className: annotation.weedType,
          confidence: manualConfidenceToScore(annotation.confidence),
          centerLat: centerGeo.lat,
          centerLon: centerGeo.lon,
          geometry: {
            type: 'polygon' as const,
            polygon,
            ...(centerBox ? { bboxCenter: centerBox } : {}),
            ...(cornerBox ? { bbox: cornerBox } : {}),
          },
          status,
          correctedClass: null,
          hasGeoData: centerGeo.lat != null && centerGeo.lon != null,
          canExport: validation.valid,
          warnings: validation.warnings,
        };
      }));
    const aiItems = await Promise.all(aiDetections.map(async (detection) => {
        const assetRecord = detection.asset;
        const asset = toClientAsset(assetRecord);
        const validation = validateGeoParams(asset);
        const centerBox = parseCenterBox(detection.boundingBox);
        const cornerBox = centerBox ? centerBoxToCorner(centerBox) : undefined;
        const centerGeo = await resolveCenterGeo(
          assetRecord,
          centerBox,
          detection.centerLat,
          detection.centerLon
        );

        return {
          id: detection.id,
          source: 'detection' as const,
          sourceId: detection.id,
          assetId: detection.assetId,
          asset,
          className: detection.className,
          confidence: detection.confidence ?? 0,
          centerLat: centerGeo.lat,
          centerLon: centerGeo.lon,
          geometry: {
            type: 'bbox' as const,
            ...(centerBox ? { bboxCenter: centerBox } : {}),
            ...(cornerBox ? { bbox: cornerBox } : {}),
          },
          status: detection.rejected
            ? ('rejected' as ReviewStatus)
            : detection.verified || detection.userCorrected
              ? ('accepted' as ReviewStatus)
              : ('pending' as ReviewStatus),
          correctedClass: detection.userCorrected ? detection.className : null,
          hasGeoData: centerGeo.lat != null && centerGeo.lon != null,
          canExport: validation.valid,
          warnings: validation.warnings,
          _sourceData: {
            type: detection.type,
            customModel: detection.customModel,
          },
        };
      }));
    const yoloItems = await Promise.all(yoloDetections.map(async (detection) => {
        const assetRecord = detection.asset;
        const asset = toClientAsset(assetRecord);
        const validation = validateGeoParams(asset);
        let centerBox = parseCenterBox(detection.boundingBox);
        let meta = detection.preprocessingMeta as YOLOPreprocessingMeta | null;
        if (meta && typeof meta === 'string') {
          try {
            meta = JSON.parse(meta) as YOLOPreprocessingMeta;
          } catch {
            meta = null;
          }
        }
        if (centerBox && meta) {
          centerBox = rescaleToOriginalWithMeta(centerBox, meta);
        }
        const cornerBox = centerBox ? centerBoxToCorner(centerBox) : undefined;
        const centerGeo = await resolveCenterGeo(
          assetRecord,
          centerBox,
          detection.centerLat,
          detection.centerLon
        );
        const warnings = [...validation.warnings];
        if (centerGeo.lat == null || centerGeo.lon == null) {
          warnings.push('Coordinates will be computed at export');
        }

        return {
          id: detection.id,
          source: 'detection' as const,
          sourceId: detection.id,
          assetId: detection.assetId,
          asset,
          className: detection.className,
          confidence: detection.confidence ?? 0,
          centerLat: centerGeo.lat,
          centerLon: centerGeo.lon,
          geometry: {
            type: 'bbox' as const,
            ...(centerBox ? { bboxCenter: centerBox } : {}),
            ...(cornerBox ? { bbox: cornerBox } : {}),
          },
          status: detection.rejected
            ? ('rejected' as ReviewStatus)
            : detection.verified || detection.userCorrected
              ? ('accepted' as ReviewStatus)
              : ('pending' as ReviewStatus),
          correctedClass: detection.userCorrected ? detection.className : null,
          hasGeoData: centerGeo.lat != null && centerGeo.lon != null,
          canExport: validation.valid,
          warnings,
          _sourceData: {
            type: detection.type,
            inferenceJobId: detection.inferenceJobId,
          },
        };
      }));
    const pendingItems = await Promise.all(pendingAnnotations.map(async (pending) => {
        const assetRecord = pending.asset;
        const asset = toClientAsset(assetRecord);
        const validation = validateGeoParams(asset);
        const bboxCenter = parseCenterBox(pending.bbox);
        const polygon = Array.isArray(pending.polygon)
          ? (pending.polygon as number[][])
          : [];
        const centerBox = bboxCenter || polygonToCenterBox(polygon);
        const cornerBox =
          centerBox ? centerBoxToCorner(centerBox) : parseCornerBox(pending.bbox);
        const centerGeo = await resolveCenterGeo(
          assetRecord,
          centerBox,
          pending.centerLat,
          pending.centerLon
        );

        const status: ReviewStatus =
          pending.status === 'ACCEPTED'
            ? 'accepted'
            : pending.status === 'REJECTED'
              ? 'rejected'
              : 'pending';

        return {
          id: pending.id,
          source: 'pending' as const,
          sourceId: pending.id,
          assetId: pending.assetId,
          asset,
          className: pending.weedType,
          confidence: pending.confidence,
          centerLat: centerGeo.lat,
          centerLon: centerGeo.lon,
          geometry: {
            type: 'polygon' as const,
            polygon,
            ...(centerBox ? { bboxCenter: centerBox } : {}),
            ...(cornerBox ? { bbox: cornerBox } : {}),
          },
          status,
          correctedClass: null,
          hasGeoData: centerGeo.lat != null && centerGeo.lon != null,
          canExport: validation.valid,
          warnings: validation.warnings,
          _sourceData: {
            batchJobId: pending.batchJobId,
            sourceType: pending.batchJob?.exemplarId ? 'CONCEPT' : 'SAM3_BATCH',
          },
        };
      }));
    const items = [...manualItems, ...aiItems, ...yoloItems, ...pendingItems];

    if (sessionBiasEnabled && items.length >= 8) {
      const biasCorrections = solveSessionAssetBias(
        items
          .filter((item) => isFiniteGeoCoordinate(item.centerLat, item.centerLon))
          .map((item) => ({
            id: item.id,
            assetId: item.assetId,
            className: item.className,
            confidence: item.confidence ?? 0,
            lat: item.centerLat as number,
            lon: item.centerLon as number,
          })),
        {
          radiusMeters: sessionBiasRadiusM,
          minAnchorsPerAsset: 3,
          maxCorrectionMeters: 1.6,
          byClass: true,
        }
      );

      if (biasCorrections.size > 0) {
        for (const item of items) {
          if (!isFiniteGeoCoordinate(item.centerLat, item.centerLon)) continue;
          const correction = biasCorrections.get(item.assetId);
          if (!correction) continue;
          const corrected = applySessionBiasCorrection(
            item.centerLat as number,
            item.centerLon as number,
            correction
          );
          item.centerLat = corrected.lat;
          item.centerLon = corrected.lon;
          item.hasGeoData = true;
        }
      }
    }

    const filteredItems = items.filter((item) => {
      if (needsReview && item.status !== 'pending') return false;
      if (minConfidence != null && item.confidence < minConfidence) return false;
      return true;
    });

    return NextResponse.json({ items: filteredItems });
  } catch (error) {
    console.error('Error fetching review items:', error);
    return NextResponse.json(
      { error: 'Failed to fetch review items' },
      { status: 500 }
    );
  }
}
