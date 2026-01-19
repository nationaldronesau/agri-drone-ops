import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/db';
import { getAuthenticatedUser } from '@/lib/auth/api-auth';
import {
  centerBoxToCorner,
  polygonToCenterBox,
  rescaleToOriginalWithMeta,
  validateGeoParams,
} from '@/lib/utils/georeferencing';
import type { CenterBox, YOLOPreprocessingMeta } from '@/lib/types/detection';

type ReviewStatus = 'pending' | 'accepted' | 'rejected';

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

    const assetIds = toStringArray(session.assetIds);
    const inferenceJobIds = toStringArray(session.inferenceJobIds);
    const batchJobIds = toStringArray(session.batchJobIds);
    const isBatchReview = session.workflowType === 'batch_review';
    const createdAfter = session.createdAt;

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
      imageWidth: true,
      imageHeight: true,
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
            createdAt: { gte: createdAfter },
          },
          include: {
            asset: { select: assetSelect },
            customModel: {
              select: { id: true, name: true, version: true, displayName: true },
            },
          },
        })
      : Promise.resolve([]);

    const yoloDetectionsPromise = !isBatchReview && inferenceJobIds.length > 0
      ? prisma.detection.findMany({
          where: {
            assetId: { in: filteredAssetIds },
            type: 'YOLO_LOCAL',
            inferenceJobId: { in: inferenceJobIds },
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

    const items = [
      ...manualAnnotations.map((annotation) => {
        const asset = annotation.session.asset;
        const validation = validateGeoParams(asset);
        const polygon = Array.isArray(annotation.coordinates)
          ? (annotation.coordinates as number[][])
          : [];
        const centerBox = polygonToCenterBox(polygon);
        const cornerBox = centerBox ? centerBoxToCorner(centerBox) : undefined;

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
          geometry: {
            type: 'polygon' as const,
            polygon,
            ...(centerBox ? { bboxCenter: centerBox } : {}),
            ...(cornerBox ? { bbox: cornerBox } : {}),
          },
          status,
          correctedClass: null,
          hasGeoData: annotation.centerLat != null && annotation.centerLon != null,
          canExport: validation.valid,
          warnings: validation.warnings,
        };
      }),
      ...aiDetections.map((detection) => {
        const asset = detection.asset;
        const validation = validateGeoParams(asset);
        let centerBox = parseCenterBox(detection.boundingBox);
        const cornerBox = centerBox ? centerBoxToCorner(centerBox) : undefined;

        return {
          id: detection.id,
          source: 'detection' as const,
          sourceId: detection.id,
          assetId: detection.assetId,
          asset,
          className: detection.className,
          confidence: detection.confidence ?? 0,
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
          hasGeoData: detection.centerLat != null && detection.centerLon != null,
          canExport: validation.valid,
          warnings: validation.warnings,
          _sourceData: {
            type: detection.type,
            customModel: detection.customModel,
          },
        };
      }),
      ...yoloDetections.map((detection) => {
        const asset = detection.asset;
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
        const warnings = [...validation.warnings];
        if (detection.centerLat == null || detection.centerLon == null) {
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
          hasGeoData: detection.centerLat != null && detection.centerLon != null,
          canExport: validation.valid,
          warnings,
          _sourceData: {
            type: detection.type,
            inferenceJobId: detection.inferenceJobId,
          },
        };
      }),
      ...pendingAnnotations.map((pending) => {
        const asset = pending.asset;
        const validation = validateGeoParams(asset);
        const polygon = Array.isArray(pending.polygon)
          ? (pending.polygon as number[][])
          : [];
        const centerBox = polygon.length > 0
          ? polygonToCenterBox(polygon)
          : null;
        const cornerBox =
          centerBox ? centerBoxToCorner(centerBox) : parseCornerBox(pending.bbox);

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
          geometry: {
            type: 'polygon' as const,
            polygon,
            ...(centerBox ? { bboxCenter: centerBox } : {}),
            ...(cornerBox ? { bbox: cornerBox } : {}),
          },
          status,
          correctedClass: null,
          hasGeoData: pending.centerLat != null && pending.centerLon != null,
          canExport: validation.valid,
          warnings: validation.warnings,
          _sourceData: {
            batchJobId: pending.batchJobId,
            sourceType: pending.batchJob?.exemplarId ? 'CONCEPT' : 'SAM3_BATCH',
          },
        };
      }),
    ];

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
