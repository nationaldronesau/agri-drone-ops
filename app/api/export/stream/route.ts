import { NextRequest, NextResponse } from 'next/server';
import JSZip from 'jszip';
import prisma from '@/lib/db';
import { getAuthenticatedUser, getUserTeamIds } from '@/lib/auth/api-auth';
import {
  polygonToCenterBox,
  pixelToGeo,
  rescaleToOriginalWithMeta,
  validateGeoParams,
} from '@/lib/utils/georeferencing';
import { generateShapefileExport, type DetectionRecord, type AnnotationRecord } from '@/lib/services/shapefile';
import type { CenterBox, YOLOPreprocessingMeta } from '@/lib/types/detection';

const EXPORT_ITEM_LIMIT = 5000;
const DEFAULT_EXPORT_CAMERA_FOV = 84;
const MIN_EXPORT_MAX_OFFSET_M = 2000;
const MAX_EXPORT_LRF_GPS_OFFSET_M = 2000;

interface ExportManifest {
  exportedAt: string;
  format: 'shapefile' | 'csv' | 'kml';
  crs: 'EPSG:4326';
  totalItems: number;
  exportedCount: number;
  skippedCount: number;
  skippedItems: Array<{
    assetId: string;
    assetName: string;
    annotationId: string;
    reason: string;
  }>;
  warnings: string[];
}

function escapeCSV(field: unknown): string {
  const str = String(field ?? '');
  if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function escapeXML(str: unknown): string {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
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

function manualConfidenceToScore(confidence: string | null): number {
  if (confidence === 'CERTAIN') return 0.95;
  if (confidence === 'LIKELY') return 0.75;
  return 0.5;
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry) => typeof entry === 'string') as string[];
}

function normalizeGeoPoint(lat: unknown, lon: unknown): { lat: number; lon: number } | null {
  if (
    typeof lat !== 'number' ||
    typeof lon !== 'number' ||
    !Number.isFinite(lat) ||
    !Number.isFinite(lon) ||
    lat < -90 ||
    lat > 90 ||
    lon < -180 ||
    lon > 180
  ) {
    return null;
  }
  return { lat, lon };
}

function extractExportCameraFov(metadata: unknown): number {
  if (!metadata || typeof metadata !== 'object') return DEFAULT_EXPORT_CAMERA_FOV;
  const record = metadata as Record<string, unknown>;
  const candidates = [
    record.FieldOfView,
    record.CameraFOV,
    record.FOV,
  ];
  for (const value of candidates) {
    if (typeof value === 'number' && Number.isFinite(value) && value > 0 && value < 180) {
      return value;
    }
  }
  return DEFAULT_EXPORT_CAMERA_FOV;
}

function haversineDistanceMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const earthRadiusM = 6371000;
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
      Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return earthRadiusM * c;
}

function hasPlausibleLrf(asset: {
  gpsLatitude: number | null;
  gpsLongitude: number | null;
  lrfDistance?: number | null;
  lrfTargetLat?: number | null;
  lrfTargetLon?: number | null;
}): boolean {
  if (
    typeof asset.gpsLatitude !== 'number' ||
    typeof asset.gpsLongitude !== 'number' ||
    typeof asset.lrfDistance !== 'number' ||
    typeof asset.lrfTargetLat !== 'number' ||
    typeof asset.lrfTargetLon !== 'number' ||
    !Number.isFinite(asset.gpsLatitude) ||
    !Number.isFinite(asset.gpsLongitude) ||
    !Number.isFinite(asset.lrfDistance) ||
    !Number.isFinite(asset.lrfTargetLat) ||
    !Number.isFinite(asset.lrfTargetLon) ||
    asset.lrfDistance <= 0
  ) {
    return false;
  }

  const gpsToLrfMeters = haversineDistanceMeters(
    asset.gpsLatitude,
    asset.gpsLongitude,
    asset.lrfTargetLat,
    asset.lrfTargetLon
  );
  const maxExpectedOffset = Math.max(
    MAX_EXPORT_LRF_GPS_OFFSET_M,
    asset.lrfDistance * 8 + 500
  );
  return Number.isFinite(gpsToLrfMeters) && gpsToLrfMeters <= maxExpectedOffset;
}

async function computeExportGeo(
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
  pixel: { x: number; y: number }
): Promise<{ lat: number; lon: number } | null> {
  const gpsLat = asset.gpsLatitude;
  const gpsLon = asset.gpsLongitude;
  const width = asset.imageWidth;
  const height = asset.imageHeight;
  if (
    typeof gpsLat !== 'number' ||
    typeof gpsLon !== 'number' ||
    typeof width !== 'number' ||
    typeof height !== 'number' ||
    !Number.isFinite(gpsLat) ||
    !Number.isFinite(gpsLon) ||
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width <= 0 ||
    height <= 0
  ) {
    return null;
  }

  const altitude =
    typeof asset.altitude === 'number' && Number.isFinite(asset.altitude) && asset.altitude > 0
      ? asset.altitude
      : 100;
  const cameraFov =
    typeof asset.cameraFov === 'number' &&
    Number.isFinite(asset.cameraFov) &&
    asset.cameraFov > 0 &&
    asset.cameraFov < 180
      ? asset.cameraFov
      : extractExportCameraFov(asset.metadata);

  // Use the standard pixelToGeo path only when LRF metadata is plausibly valid.
  // Otherwise, prefer the stable export projection below (it avoids pitch singularities).
  if (hasPlausibleLrf(asset)) {
    try {
      const standardGeoResult = pixelToGeo(
        {
          gpsLatitude: gpsLat,
          gpsLongitude: gpsLon,
          altitude,
          gimbalRoll: asset.gimbalRoll ?? 0,
          gimbalPitch: asset.gimbalPitch ?? 0,
          gimbalYaw: asset.gimbalYaw ?? 0,
          cameraFov,
          imageWidth: width,
          imageHeight: height,
          lrfDistance:
            typeof asset.lrfDistance === 'number' && Number.isFinite(asset.lrfDistance)
              ? asset.lrfDistance
              : undefined,
          lrfTargetLat:
            typeof asset.lrfTargetLat === 'number' && Number.isFinite(asset.lrfTargetLat)
              ? asset.lrfTargetLat
              : undefined,
          lrfTargetLon:
            typeof asset.lrfTargetLon === 'number' && Number.isFinite(asset.lrfTargetLon)
              ? asset.lrfTargetLon
              : undefined,
        },
        pixel,
        true
      );
      const standardGeo = standardGeoResult instanceof Promise
        ? await standardGeoResult
        : standardGeoResult;
      const normalizedStandardGeo = normalizeGeoPoint(standardGeo.lat, standardGeo.lon);
      if (normalizedStandardGeo) {
        const projectedOffsetMeters = haversineDistanceMeters(
          gpsLat,
          gpsLon,
          normalizedStandardGeo.lat,
          normalizedStandardGeo.lon
        );
        const maxOffsetMeters = Math.max(MIN_EXPORT_MAX_OFFSET_M, altitude * 20);
        if (Number.isFinite(projectedOffsetMeters) && projectedOffsetMeters <= maxOffsetMeters) {
          return normalizedStandardGeo;
        }
        console.warn(
          `[export] ignoring implausible LRF projected point (${projectedOffsetMeters.toFixed(1)}m from asset GPS, max ${maxOffsetMeters.toFixed(1)}m)`
        );
      }
    } catch {
      // Continue to stable projection fallback
    }
  }

  const hFovRad = (cameraFov * Math.PI) / 180;
  const vFovRad = hFovRad * (height / width);

  const normalizedX = pixel.x / width - 0.5;
  const normalizedY = pixel.y / height - 0.5;

  const angleX = normalizedX * hFovRad;
  const angleY = normalizedY * vFovRad;

  if (!Number.isFinite(angleX) || !Number.isFinite(angleY)) {
    return null;
  }

  // Stable footprint projection: avoids singularities from extreme gimbal pitch during export.
  let offsetEast = altitude * Math.tan(angleX);
  let offsetNorth = -altitude * Math.tan(angleY);
  if (!Number.isFinite(offsetEast) || !Number.isFinite(offsetNorth)) {
    return null;
  }

  const yaw = ((asset.gimbalYaw ?? 0) * Math.PI) / 180;
  if (Number.isFinite(yaw)) {
    const rotatedEast = offsetEast * Math.cos(yaw) - offsetNorth * Math.sin(yaw);
    const rotatedNorth = offsetEast * Math.sin(yaw) + offsetNorth * Math.cos(yaw);
    offsetEast = rotatedEast;
    offsetNorth = rotatedNorth;
  }

  const metersPerLat = 111111;
  const metersPerLon = 111111 * Math.cos((gpsLat * Math.PI) / 180);
  if (!Number.isFinite(metersPerLon) || Math.abs(metersPerLon) < 1e-6) {
    return null;
  }

  const lat = gpsLat + offsetNorth / metersPerLat;
  const lon = gpsLon + offsetEast / metersPerLon;
  return normalizeGeoPoint(lat, lon);
}

export async function GET(request: NextRequest) {
  try {
    const auth = await getAuthenticatedUser();
    if (!auth.authenticated) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const membership = await getUserTeamIds();
    if (membership.dbError) {
      return NextResponse.json({ error: 'Database error' }, { status: 500 });
    }

    const searchParams = request.nextUrl.searchParams;
    const format = (searchParams.get('format') || 'csv') as 'csv' | 'kml' | 'shapefile';
    const projectId = searchParams.get('projectId');
    const sessionId = searchParams.get('sessionId');
    const includeAI = searchParams.get('includeAI') !== 'false';
    const includeManual = searchParams.get('includeManual') !== 'false';
    const needsReview = searchParams.get('needsReview') === 'true';
    const minConfidenceParam = searchParams.get('minConfidence');
    let minConfidence: number | null = null;
    if (minConfidenceParam) {
      const parsed = Number(minConfidenceParam);
      if (Number.isFinite(parsed)) {
        minConfidence = Math.max(0, Math.min(1, parsed > 1 ? parsed / 100 : parsed));
      }
    }
    const includePendingParam = searchParams.get('includePending');
    const includePending =
      includePendingParam === 'true' || (Boolean(sessionId) && includeAI && includePendingParam !== 'false');
    const classFilter = searchParams.get('classes')?.split(',').filter(Boolean) || [];
    // GEO_DEBUG=1 logs a single JSON payload per request; optional GEO_DEBUG_ASSET_ID/GEO_DEBUG_ITEM_ID filter it.
    const geoDebugEnabled = process.env.GEO_DEBUG === '1';
    const geoDebugAssetFilter = process.env.GEO_DEBUG_ASSET_ID;
    const geoDebugItemFilter = process.env.GEO_DEBUG_ITEM_ID;
    let geoDebugLogged = false;
    const logGeoDebugOnce = (payload: Record<string, unknown>) => {
      if (!geoDebugEnabled || geoDebugLogged) return;
      const assetId = payload.assetId;
      const itemId = payload.itemId;
      if (geoDebugAssetFilter && assetId !== geoDebugAssetFilter) return;
      if (geoDebugItemFilter && itemId !== geoDebugItemFilter) return;
      geoDebugLogged = true;
      console.log(JSON.stringify(payload));
    };

    if (!['csv', 'kml', 'shapefile'].includes(format)) {
      return NextResponse.json({ error: 'Invalid format. Use csv, kml, or shapefile.' }, { status: 400 });
    }

    const baseWhere: Record<string, unknown> = {
      asset: {
        project: {
          teamId: { in: membership.teamIds },
        },
      },
    };

    let assetIds: string[] | null = null;
    let createdAfter: Date | null = null;
    let sessionBatchJobIds: string[] | null = null;
    let sessionInferenceJobIds: string[] = [];
    let sessionProjectId: string | null = null;
    let isBatchReviewSession = false;
    let aiProcessingJobIds: string[] = [];
    let yoloInferenceJobIds: string[] = [];
    if (sessionId) {
      const session = await prisma.reviewSession.findUnique({
        where: { id: sessionId },
        select: {
          assetIds: true,
          teamId: true,
          projectId: true,
          createdAt: true,
          batchJobIds: true,
          inferenceJobIds: true,
          workflowType: true,
        },
      });
      if (!session) {
        return NextResponse.json({ error: 'Review session not found' }, { status: 404 });
      }
      if (!membership.teamIds.includes(session.teamId)) {
        return NextResponse.json({ error: 'Access denied' }, { status: 403 });
      }
      assetIds = toStringArray(session.assetIds);
      createdAfter = session.createdAt;
      sessionProjectId = session.projectId;
      sessionBatchJobIds = toStringArray(session.batchJobIds);
      sessionInferenceJobIds = toStringArray(session.inferenceJobIds);
      isBatchReviewSession = session.workflowType === 'batch_review';
      baseWhere.asset = {
        ...(baseWhere.asset as Record<string, unknown>),
        id: { in: assetIds },
      };

      if (sessionInferenceJobIds.length > 0) {
        const [yoloJobs, processingJobs] = await Promise.all([
          prisma.yOLOInferenceJob.findMany({
            where: { id: { in: sessionInferenceJobIds }, projectId: sessionProjectId },
            select: { id: true },
          }),
          prisma.processingJob.findMany({
            where: {
              id: { in: sessionInferenceJobIds },
              projectId: sessionProjectId,
              type: 'AI_DETECTION',
            },
            select: { id: true },
          }),
        ]);
        yoloInferenceJobIds = yoloJobs.map((job) => job.id);
        aiProcessingJobIds = processingJobs.map((job) => job.id);
      }
    }

    if (projectId && projectId !== 'all') {
      (baseWhere.asset as Record<string, unknown>).projectId = projectId;
    }

    const [aiDetections, yoloDetections, annotations, pendingAnnotations] = await Promise.all([
      includeAI && !isBatchReviewSession
        ? prisma.detection.findMany({
            where: {
              ...baseWhere,
              type: 'AI',
              rejected: false,
              ...(needsReview
                ? { verified: false, userCorrected: false }
                : { OR: [{ verified: true }, { userCorrected: true }] }),
              ...(sessionId
                ? aiProcessingJobIds.length > 0
                  ? { jobId: { in: aiProcessingJobIds } }
                  : (createdAfter ? { createdAt: { gte: createdAfter } } : {})
                : {}),
              ...(minConfidence != null ? { confidence: { gte: minConfidence } } : {}),
              ...(classFilter.length > 0 ? { className: { in: classFilter } } : {}),
            },
            include: {
              asset: {
                select: {
                  id: true,
                  fileName: true,
                  gpsLatitude: true,
                  gpsLongitude: true,
                  altitude: true,
                  gimbalPitch: true,
                  gimbalRoll: true,
                  gimbalYaw: true,
                  cameraFov: true,
                  imageWidth: true,
                  imageHeight: true,
                  metadata: true,
                  lrfDistance: true,
                  lrfTargetLat: true,
                  lrfTargetLon: true,
                  project: {
                    select: {
                      name: true,
                      location: true,
                    },
                  },
                },
              },
            },
          })
        : Promise.resolve([]),
      includeAI && !isBatchReviewSession && (!sessionId || yoloInferenceJobIds.length > 0)
        ? prisma.detection.findMany({
            where: {
              ...baseWhere,
              type: 'YOLO_LOCAL',
              rejected: false,
              ...(needsReview
                ? { verified: false, userCorrected: false }
                : { OR: [{ verified: true }, { userCorrected: true }] }),
              ...(sessionId ? { inferenceJobId: { in: yoloInferenceJobIds } } : {}),
              ...(minConfidence != null ? { confidence: { gte: minConfidence } } : {}),
              ...(classFilter.length > 0 ? { className: { in: classFilter } } : {}),
            },
            include: {
              asset: {
                select: {
                  id: true,
                  fileName: true,
                  gpsLatitude: true,
                  gpsLongitude: true,
                  altitude: true,
                  gimbalPitch: true,
                  gimbalRoll: true,
                  gimbalYaw: true,
                  cameraFov: true,
                  imageWidth: true,
                  imageHeight: true,
                  metadata: true,
                  lrfDistance: true,
                  lrfTargetLat: true,
                  lrfTargetLon: true,
                  project: {
                    select: {
                      name: true,
                      location: true,
                    },
                  },
                },
              },
            },
          })
        : Promise.resolve([]),
      includeManual && !isBatchReviewSession
        ? prisma.manualAnnotation.findMany({
            where: {
              ...(needsReview ? { verified: false, verifiedAt: null } : { verified: true }),
              session: {
                asset: baseWhere.asset,
              },
              ...(createdAfter ? { createdAt: { gte: createdAfter } } : {}),
              ...(classFilter.length > 0 ? { weedType: { in: classFilter } } : {}),
            },
            include: {
              session: {
                select: {
                  asset: {
                    select: {
                      id: true,
                      fileName: true,
                      gpsLatitude: true,
                      gpsLongitude: true,
                      altitude: true,
                      gimbalPitch: true,
                      gimbalRoll: true,
                      gimbalYaw: true,
                      cameraFov: true,
                      imageWidth: true,
                      imageHeight: true,
                      metadata: true,
                      lrfDistance: true,
                      lrfTargetLat: true,
                      lrfTargetLon: true,
                      project: {
                        select: {
                          name: true,
                          location: true,
                        },
                      },
                    },
                  },
                },
              },
            },
          })
        : Promise.resolve([]),
      includePending && (!sessionId || (sessionBatchJobIds?.length ?? 0) > 0)
        ? prisma.pendingAnnotation.findMany({
            where: {
              asset: baseWhere.asset,
              ...(needsReview ? { status: 'PENDING' } : { status: { not: 'REJECTED' } }),
              ...(sessionId && sessionBatchJobIds && sessionBatchJobIds.length > 0
                ? { batchJobId: { in: sessionBatchJobIds } }
                : {}),
              ...(
                sessionId && sessionBatchJobIds && sessionBatchJobIds.length > 0
                  ? {}
                  : (createdAfter ? { createdAt: { gte: createdAfter } } : {})
              ),
              ...(minConfidence != null ? { confidence: { gte: minConfidence } } : {}),
              ...(classFilter.length > 0 ? { weedType: { in: classFilter } } : {}),
            },
            include: {
              asset: {
                select: {
                  id: true,
                  fileName: true,
                  gpsLatitude: true,
                  gpsLongitude: true,
                  altitude: true,
                  gimbalPitch: true,
                  gimbalRoll: true,
                  gimbalYaw: true,
                  cameraFov: true,
                  imageWidth: true,
                  imageHeight: true,
                  metadata: true,
                  lrfDistance: true,
                  lrfTargetLat: true,
                  lrfTargetLon: true,
                  project: {
                    select: {
                      name: true,
                      location: true,
                    },
                  },
                },
              },
            },
          })
        : Promise.resolve([]),
    ]);
    const detections = [...aiDetections, ...yoloDetections];

    const skippedItems: ExportManifest['skippedItems'] = [];
    const exportableDetections: DetectionRecord[] = [];
    const exportableAnnotations: AnnotationRecord[] = [];

    for (const detection of detections) {
      const asset = detection.asset;
      const storedGeo = normalizeGeoPoint(detection.centerLat, detection.centerLon);

      const validation = validateGeoParams(asset);
      let centerBox = parseCenterBox(detection.boundingBox);
      const preRescaleBox = centerBox ? { ...centerBox } : null;
      let meta = detection.preprocessingMeta as YOLOPreprocessingMeta | null;
      if (meta && typeof meta === 'string') {
        try {
          meta = JSON.parse(meta) as YOLOPreprocessingMeta;
        } catch {
          meta = null;
        }
      }
      const didRescale = Boolean(centerBox && detection.type === 'YOLO_LOCAL' && meta);
      if (centerBox && detection.type === 'YOLO_LOCAL' && meta) {
        centerBox = rescaleToOriginalWithMeta(centerBox, meta);
      }

      if (!centerBox && !storedGeo) {
        skippedItems.push({
          assetId: asset.id,
          assetName: asset.fileName,
          annotationId: detection.id,
          reason: 'Invalid bounding box',
        });
        continue;
      }

      let finalGeo = storedGeo;
      if (centerBox) {
        logGeoDebugOnce({
          format,
          itemKind: 'detection',
          itemId: detection.id,
          assetId: asset.id,
          fileName: asset.fileName,
          pixel: { x: centerBox.x, y: centerBox.y },
          bboxPreRescale: preRescaleBox,
          bboxPostRescale: didRescale ? { ...centerBox } : null,
          imageWidth: asset.imageWidth,
          imageHeight: asset.imageHeight,
          gpsLatitude: asset.gpsLatitude,
          gpsLongitude: asset.gpsLongitude,
          altitude: asset.altitude,
          gimbalPitch: asset.gimbalPitch,
          gimbalRoll: asset.gimbalRoll,
          gimbalYaw: asset.gimbalYaw,
          geoMethod: 'pixelToGeoFastExport',
        });
        const computedGeo = await computeExportGeo(asset, { x: centerBox.x, y: centerBox.y });
        if (computedGeo) {
          finalGeo = computedGeo;
        }
      }

      if (!finalGeo) {
        const reason = centerBox
          ? 'Georeferencing failed (fast export mode)'
          : (validation.warnings[0] || 'Missing EXIF data');
        skippedItems.push({
          assetId: asset.id,
          assetName: asset.fileName,
          annotationId: detection.id,
          reason,
        });
        continue;
      }

      exportableDetections.push({
        id: detection.id,
        className: detection.className,
        confidence: detection.confidence ?? 0,
        centerLat: finalGeo.lat,
        centerLon: finalGeo.lon,
        createdAt: detection.createdAt,
        asset: {
          fileName: asset.fileName,
          project: asset.project,
        },
      });
    }

    for (const annotation of annotations) {
      if (minConfidence != null && manualConfidenceToScore(annotation.confidence) < minConfidence) {
        continue;
      }

      const asset = annotation.session.asset;
      const storedGeo = normalizeGeoPoint(annotation.centerLat, annotation.centerLon);

      const validation = validateGeoParams(asset);
      const polygon = Array.isArray(annotation.coordinates)
        ? (annotation.coordinates as number[][])
        : [];
      const centerBox = polygonToCenterBox(polygon);
      if (!centerBox && !storedGeo) {
        skippedItems.push({
          assetId: asset.id,
          assetName: asset.fileName,
          annotationId: annotation.id,
          reason: 'Invalid polygon geometry',
        });
        continue;
      }

      let finalGeo = storedGeo;
      if (centerBox) {
        logGeoDebugOnce({
          format,
          itemKind: 'annotation',
          itemId: annotation.id,
          assetId: asset.id,
          fileName: asset.fileName,
          pixel: { x: centerBox.x, y: centerBox.y },
          bboxPreRescale: { ...centerBox },
          bboxPostRescale: null,
          imageWidth: asset.imageWidth,
          imageHeight: asset.imageHeight,
          gpsLatitude: asset.gpsLatitude,
          gpsLongitude: asset.gpsLongitude,
          altitude: asset.altitude,
          gimbalPitch: asset.gimbalPitch,
          gimbalRoll: asset.gimbalRoll,
          gimbalYaw: asset.gimbalYaw,
          geoMethod: 'pixelToGeoFastExport',
        });
        const computedGeo = await computeExportGeo(asset, { x: centerBox.x, y: centerBox.y });
        if (computedGeo) {
          finalGeo = computedGeo;
        }
      }

      if (!finalGeo) {
        const reason = centerBox
          ? 'Georeferencing failed (fast export mode)'
          : (validation.warnings[0] || 'Invalid polygon geometry');
        skippedItems.push({
          assetId: asset.id,
          assetName: asset.fileName,
          annotationId: annotation.id,
          reason,
        });
        continue;
      }

      exportableAnnotations.push({
        id: annotation.id,
        weedType: annotation.weedType,
        confidence: annotation.confidence,
        centerLat: finalGeo.lat,
        centerLon: finalGeo.lon,
        coordinates: annotation.coordinates,
        notes: annotation.notes,
        createdAt: annotation.createdAt,
        session: {
          asset: {
            fileName: asset.fileName,
            project: asset.project,
          },
        },
      });
    }

    for (const pending of pendingAnnotations) {
      const asset = pending.asset;
      const storedGeo = normalizeGeoPoint(pending.centerLat, pending.centerLon);

      const validation = validateGeoParams(asset);
      const bboxCenter = parseCenterBox(pending.bbox);
      const polygon = Array.isArray(pending.polygon)
        ? (pending.polygon as number[][])
        : [];
      const centerBox = bboxCenter || polygonToCenterBox(polygon);

      if (!centerBox && !storedGeo) {
        skippedItems.push({
          assetId: asset.id,
          assetName: asset.fileName,
          annotationId: pending.id,
          reason: 'Invalid pending annotation geometry',
        });
        continue;
      }

      let finalGeo = storedGeo;
      if (centerBox) {
        logGeoDebugOnce({
          format,
          itemKind: 'pending',
          itemId: pending.id,
          assetId: asset.id,
          fileName: asset.fileName,
          pixel: { x: centerBox.x, y: centerBox.y },
          bboxPreRescale: { ...centerBox },
          bboxPostRescale: null,
          imageWidth: asset.imageWidth,
          imageHeight: asset.imageHeight,
          gpsLatitude: asset.gpsLatitude,
          gpsLongitude: asset.gpsLongitude,
          altitude: asset.altitude,
          gimbalPitch: asset.gimbalPitch,
          gimbalRoll: asset.gimbalRoll,
          gimbalYaw: asset.gimbalYaw,
          geoMethod: 'pixelToGeoFastExport',
        });
        const computedGeo = await computeExportGeo(asset, { x: centerBox.x, y: centerBox.y });
        if (computedGeo) {
          finalGeo = computedGeo;
        }
      }

      if (!finalGeo) {
        const reason = centerBox
          ? 'Georeferencing failed (fast export mode)'
          : (validation.warnings[0] || 'Invalid pending annotation geometry');
        skippedItems.push({
          assetId: asset.id,
          assetName: asset.fileName,
          annotationId: pending.id,
          reason,
        });
        continue;
      }

      exportableDetections.push({
        id: pending.id,
        className: pending.weedType,
        confidence: pending.confidence ?? 0,
        centerLat: finalGeo.lat,
        centerLon: finalGeo.lon,
        createdAt: pending.createdAt,
        asset: {
          fileName: asset.fileName,
          project: asset.project,
        },
      });
    }

    const totalItems = detections.length + annotations.length + pendingAnnotations.length;
    const exportedCount = exportableDetections.length + exportableAnnotations.length;

    if (exportedCount > EXPORT_ITEM_LIMIT) {
      return NextResponse.json(
        {
          error: 'Export limit exceeded',
          message: `Cannot export more than ${EXPORT_ITEM_LIMIT} items. You have ${exportedCount} exportable items (${skippedItems.length} already skipped due to missing EXIF). Please apply additional filters.`,
          exportableCount: exportedCount,
          skippedCount: skippedItems.length,
          limit: EXPORT_ITEM_LIMIT,
        },
        { status: 400 }
      );
    }

    if (exportedCount === 0) {
      const reasonCounts = skippedItems.reduce<Record<string, number>>((acc, item) => {
        const key = item.reason || 'Unknown';
        acc[key] = (acc[key] || 0) + 1;
        return acc;
      }, {});
      const topReasons = Object.entries(reasonCounts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([reason, count]) => `${reason} (${count})`);

      return NextResponse.json(
        {
          error: 'No exportable records found for the selected filters',
          message: topReasons.length > 0 ? `Top skip reasons: ${topReasons.join('; ')}` : undefined,
          totalItems,
          skippedCount: skippedItems.length,
        },
        { status: 400 }
      );
    }

    const manifest: ExportManifest = {
      exportedAt: new Date().toISOString(),
      format,
      crs: 'EPSG:4326',
      totalItems,
      exportedCount,
      skippedCount: skippedItems.length,
      skippedItems,
      warnings:
        skippedItems.length > 0
          ? [`${skippedItems.length} items skipped - see skippedItems for details`]
          : [],
    };

    const zip = new JSZip();

    if (format === 'csv') {
      const rows = [
        'ID,Type,Class,Latitude,Longitude,Confidence,Image,Project,Location,Date',
      ];

      for (const detection of exportableDetections) {
        rows.push(
          [
            escapeCSV(detection.id),
            'AI',
            escapeCSV(detection.className),
            detection.centerLat?.toFixed(8) || '',
            detection.centerLon?.toFixed(8) || '',
            `${((detection.confidence || 0) * 100).toFixed(1)}%`,
            escapeCSV(detection.asset.fileName),
            escapeCSV(detection.asset.project?.name || ''),
            escapeCSV(detection.asset.project?.location || ''),
            detection.createdAt.toISOString().split('T')[0],
          ].join(',')
        );
      }

      for (const annotation of exportableAnnotations) {
        rows.push(
          [
            escapeCSV(annotation.id),
            'Manual',
            escapeCSV(annotation.weedType),
            annotation.centerLat?.toFixed(8) || '',
            annotation.centerLon?.toFixed(8) || '',
            `${(manualConfidenceToScore(annotation.confidence) * 100).toFixed(1)}%`,
            escapeCSV(annotation.session.asset.fileName),
            escapeCSV(annotation.session.asset.project?.name || ''),
            escapeCSV(annotation.session.asset.project?.location || ''),
            annotation.createdAt.toISOString().split('T')[0],
          ].join(',')
        );
      }

      zip.file('export.csv', rows.join('\n'));
    } else if (format === 'kml') {
      const placemarks: string[] = [];

      for (const detection of exportableDetections) {
        placemarks.push(`    <Placemark>
      <name>${escapeXML(detection.className)} (AI)</name>
      <description>${escapeXML(`Confidence: ${((detection.confidence || 0) * 100).toFixed(1)}%\nImage: ${detection.asset.fileName}`)}</description>
      <Point>
        <coordinates>${detection.centerLon},${detection.centerLat},0</coordinates>
      </Point>
    </Placemark>`);
      }

      for (const annotation of exportableAnnotations) {
        placemarks.push(`    <Placemark>
      <name>${escapeXML(annotation.weedType)} (Manual)</name>
      <description>${escapeXML(`Confidence: ${(manualConfidenceToScore(annotation.confidence) * 100).toFixed(1)}%\nImage: ${annotation.session.asset.fileName}`)}</description>
      <Point>
        <coordinates>${annotation.centerLon},${annotation.centerLat},0</coordinates>
      </Point>
    </Placemark>`);
      }

      const kmlContent = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Document>
    <name>Weed Detections</name>
    <description>Exported from AgriDrone Ops</description>
${placemarks.join('\n')}
  </Document>
</kml>
`;

      zip.file('export.kml', kmlContent);
    } else {
      const { buffer } = await generateShapefileExport(
        exportableDetections,
        exportableAnnotations
      );

      const shapefileZip = await JSZip.loadAsync(buffer);
      const entries = Object.values(shapefileZip.files).filter((file) => !file.dir);

      for (const entry of entries) {
        const content = await entry.async('nodebuffer');
        const baseName = entry.name.split('/').pop() || entry.name;
        const renamed = baseName.replace(/^detections\./, 'export.');
        zip.file(renamed, content);
      }
    }

    zip.file('manifest.json', JSON.stringify(manifest, null, 2));

    const zipBuffer = await zip.generateAsync({ type: 'nodebuffer' });
    const filename = `export-${format}-${sessionId || projectId || 'all'}.zip`;

    return new Response(zipBuffer, {
      headers: {
        'Content-Type': 'application/zip',
        'Content-Disposition': `attachment; filename="${filename}"`,
      },
    });
  } catch (error) {
    console.error('Export error:', error);
    return NextResponse.json(
      { error: 'Failed to generate export' },
      { status: 500 }
    );
  }
}
