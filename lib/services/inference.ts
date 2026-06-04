/**
 * YOLO Inference Service
 *
 * Runs model inference for a batch of assets and optionally saves detections.
 */
import type { Prisma } from '@prisma/client';
import prisma from '@/lib/db';
import {
  yoloInferenceService,
  type InferenceBackend,
} from '@/lib/services/yolo-inference';
import { S3Service } from '@/lib/services/s3';
import { normalizeDetectionType } from '@/lib/utils/detection-types';
import { fetchImageSafely } from '@/lib/utils/security';
import { resolveGeoCoordinates, validateGeoCoordinates } from '@/lib/utils/georeferencing';
import { sam3Orchestrator } from '@/lib/services/sam3-orchestrator';
import { acquireGpuLock, refreshGpuLock, releaseGpuLock } from '@/lib/services/gpu-lock';

interface InferenceAsset {
  id: string;
  projectId: string;
  storageUrl: string;
  s3Key: string | null;
  s3Bucket: string | null;
  imageWidth: number | null;
  imageHeight: number | null;
  gpsLatitude: number | null;
  gpsLongitude: number | null;
  altitude: number | null;
  gimbalPitch: number | null;
  gimbalRoll: number | null;
  gimbalYaw: number | null;
  cameraFov: number | null;
  lrfDistance: number | null;
  lrfTargetLat: number | null;
  lrfTargetLon: number | null;
  metadata?: unknown | null;
}

export interface InferenceTilingSummary {
  tiledImages: number;
  tilesProcessed: number;
  rawDetections: number;
  mergedDetections: number;
}

export interface InferenceJobConfig {
  modelId: string;
  modelName: string;
  confidence: number;
  inferenceMode?: string;
  inferenceModeLabel?: string;
  saveDetections: boolean;
  totalImages: number;
  processedImages: number;
  detectionsFound: number;
  skippedImages: number;
  duplicateImages: number;
  replaceDraftDetections?: boolean;
  replaceableDuplicateImages?: number;
  reviewedDuplicateImages?: number;
  draftDetectionsReplaced?: number;
  skippedReason?: string;
  errors?: string[];
  backend?: InferenceBackend;
  tiling?: InferenceTilingSummary;
}

export interface InferenceResult {
  processedImages: number;
  detectionsFound: number;
  skippedImages: number;
  duplicateImages: number;
  draftDetectionsReplaced: number;
  errors: string[];
  tiling?: InferenceTilingSummary;
}

const DEFAULT_ALTITUDE = 100;
const DEFAULT_BATCH_SIZE = 10;
const DEFAULT_YOLO_GPU_LOCK_TTL_MS = 30 * 60 * 1000;

function readPositiveIntegerEnv(name: string, fallback: number): number {
  const parsed = Number.parseInt(process.env[name] || '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function buildTilingSummary(stats: InferenceTilingSummary): InferenceTilingSummary | undefined {
  return stats.tiledImages > 0 ? { ...stats } : undefined;
}

function toCenterBox(bbox: [number, number, number, number]) {
  const [x1, y1, x2, y2] = bbox;
  const width = x2 - x1;
  const height = y2 - y1;
  if (width <= 0 || height <= 0) {
    return null;
  }
  return {
    x: x1 + width / 2,
    y: y1 + height / 2,
    width,
    height,
  };
}

function getS3Path(asset: InferenceAsset): string | null {
  if (!asset.s3Key) return null;
  const bucket = asset.s3Bucket || S3Service.bucketName;
  return `s3://${bucket}/${asset.s3Key}`;
}

function getImageUrl(asset: InferenceAsset): string {
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
  return asset.storageUrl.startsWith('/')
    ? `${baseUrl}${asset.storageUrl}`
    : asset.storageUrl;
}

async function getImageBase64(asset: InferenceAsset): Promise<string> {
  const storageUrl = getImageUrl(asset);
  const buffer = await fetchImageSafely(storageUrl, `Asset ${asset.id}`);
  return buffer.toString('base64');
}

async function updateJobProgress(
  jobId: string,
  config: InferenceJobConfig,
  progress: number
) {
  await prisma.processingJob.update({
    where: { id: jobId },
    data: {
      progress,
      config: config as unknown as Prisma.InputJsonObject,
    },
  });
}

async function deleteDraftDetectionsForRerun(assetId: string, modelId: string): Promise<number> {
  const deleted = await prisma.detection.deleteMany({
    where: {
      assetId,
      customModelId: modelId,
      verified: false,
      rejected: false,
      userCorrected: false,
      reviewedAt: null,
    },
  });
  return deleted.count;
}

export async function processInferenceJob(options: {
  jobId: string;
  projectId: string;
  modelId: string;
  modelName: string;
  assetIds: string[];
  confidence: number;
  inferenceMode?: string;
  inferenceModeLabel?: string;
  saveDetections: boolean;
  replaceDraftDetections?: boolean;
  skippedImages: number;
  duplicateImages: number;
  replaceableDuplicateImages?: number;
  reviewedDuplicateImages?: number;
  skippedReason?: string;
  batchSize?: number;
  backend?: InferenceBackend;
}): Promise<InferenceResult> {
  const {
    jobId,
    projectId,
    modelId,
    modelName,
    assetIds,
    confidence,
    inferenceMode,
    inferenceModeLabel,
    saveDetections,
    replaceDraftDetections = false,
    skippedImages,
    duplicateImages,
    replaceableDuplicateImages = 0,
    reviewedDuplicateImages = 0,
    skippedReason,
    batchSize = DEFAULT_BATCH_SIZE,
    backend = 'auto',
  } = options;

  const totalImages = assetIds.length;
  let processedImages = 0;
  let detectionsFound = 0;
  let tiledImages = 0;
  let tilesProcessed = 0;
  let rawTileDetections = 0;
  let mergedTileDetections = 0;
  let draftDetectionsReplaced = 0;
  const errors: string[] = [];

  await prisma.processingJob.update({
    where: { id: jobId },
    data: {
      status: 'PROCESSING',
      startedAt: new Date(),
      progress: 0,
      config: {
        modelId,
        modelName,
        confidence,
        inferenceMode,
        inferenceModeLabel,
        saveDetections,
        replaceDraftDetections,
        totalImages,
        processedImages,
        detectionsFound,
        skippedImages,
        duplicateImages,
        replaceableDuplicateImages,
        reviewedDuplicateImages,
        draftDetectionsReplaced,
        skippedReason,
      } satisfies InferenceJobConfig as unknown as Prisma.InputJsonObject,
    },
  });

  let effectiveBackend = backend;
  const gpuLockTtlMs = readPositiveIntegerEnv('YOLO_GPU_LOCK_TTL_MS', DEFAULT_YOLO_GPU_LOCK_TTL_MS);
  const gpuLock = backend !== 'roboflow'
    ? await acquireGpuLock('yolo-inference', gpuLockTtlMs)
    : { acquired: true, token: null };

  if (backend !== 'roboflow' && !gpuLock.acquired) {
    if (backend === 'auto') {
      effectiveBackend = 'roboflow';
    } else {
      await prisma.processingJob.update({
        where: { id: jobId },
        data: {
          status: 'FAILED',
          errorMessage: 'GPU lock unavailable for local inference',
        },
      });
      return {
        processedImages: 0,
        detectionsFound: 0,
        skippedImages,
        duplicateImages,
        draftDetectionsReplaced,
        errors: ['GPU lock unavailable for local inference'],
      };
    }
  }

  if (effectiveBackend !== 'roboflow') {
    const gpuResult = await sam3Orchestrator.ensureGPUAvailable();
    if (!gpuResult.success) {
      if (backend === 'auto') {
        effectiveBackend = 'roboflow';
      } else {
        await prisma.processingJob.update({
          where: { id: jobId },
          data: {
            status: 'FAILED',
            errorMessage: `GPU not available for local inference: ${gpuResult.message}`,
          },
        });
        if (gpuLock.token) {
          await releaseGpuLock(gpuLock.token);
        }
        return {
          processedImages: 0,
          detectionsFound: 0,
          skippedImages,
          duplicateImages,
          draftDetectionsReplaced,
          errors: [`GPU not available: ${gpuResult.message}`],
        };
      }
    }
  }

  try {
    for (let index = 0; index < assetIds.length; index += batchSize) {
    const batchIds = assetIds.slice(index, index + batchSize);

    const currentJob = await prisma.processingJob.findUnique({
      where: { id: jobId },
      select: { status: true },
    });
    if (currentJob?.status === 'CANCELLED') {
      return {
        processedImages,
        detectionsFound,
        skippedImages,
        duplicateImages,
        draftDetectionsReplaced,
        errors,
        tiling: buildTilingSummary({
          tiledImages,
          tilesProcessed,
          rawDetections: rawTileDetections,
          mergedDetections: mergedTileDetections,
        }),
      };
    }

    const assets = await prisma.asset.findMany({
      where: {
        id: { in: batchIds },
        projectId,
      },
      select: {
        id: true,
        projectId: true,
        storageUrl: true,
        s3Key: true,
        s3Bucket: true,
        imageWidth: true,
        imageHeight: true,
        gpsLatitude: true,
        gpsLongitude: true,
        altitude: true,
        gimbalPitch: true,
        gimbalRoll: true,
        gimbalYaw: true,
        cameraFov: true,
        lrfDistance: true,
        lrfTargetLat: true,
        lrfTargetLon: true,
        metadata: true,
      },
    });

    for (const asset of assets as InferenceAsset[]) {
      try {
        if (
          asset.gpsLatitude == null ||
          asset.gpsLongitude == null ||
          asset.imageWidth == null ||
          asset.imageHeight == null
        ) {
          continue;
        }

        const geoValid = validateGeoCoordinates(asset.gpsLatitude, asset.gpsLongitude, 'asset');
        if (!geoValid.valid) {
          continue;
        }

        const s3Path = getS3Path(asset);
        const imageUrl = getImageUrl(asset);
        const imageBase64 = s3Path ? undefined : await getImageBase64(asset);

        const response = await yoloInferenceService.detect({
          s3Path,
          imageBase64,
          imageUrl,
          imageWidth: asset.imageWidth,
          imageHeight: asset.imageHeight,
          modelName,
          confidence,
          backend: effectiveBackend,
        });
        if (response.tiling?.enabled) {
          tiledImages += 1;
          tilesProcessed += response.tiling.tileCount ?? 0;
          rawTileDetections += response.tiling.rawDetections ?? 0;
          mergedTileDetections += response.tiling.mergedDetections ?? 0;
        }

        const detectionsToCreate: Prisma.DetectionCreateManyInput[] = [];

        for (const detection of response.detections || []) {
          if (typeof detection.confidence === 'number' && detection.confidence < confidence) {
            continue;
          }
          const bbox = toCenterBox(detection.bbox);
          if (!bbox) continue;

          const resolved = await resolveGeoCoordinates(
            {
              gpsLatitude: asset.gpsLatitude,
              gpsLongitude: asset.gpsLongitude,
              altitude: asset.altitude ?? DEFAULT_ALTITUDE,
              gimbalPitch: asset.gimbalPitch ?? 0,
              gimbalRoll: asset.gimbalRoll ?? 0,
              gimbalYaw: asset.gimbalYaw ?? 0,
              cameraFov: asset.cameraFov ?? null,
              imageWidth: asset.imageWidth,
              imageHeight: asset.imageHeight,
              lrfDistance: asset.lrfDistance ?? undefined,
              lrfTargetLat: asset.lrfTargetLat ?? undefined,
              lrfTargetLon: asset.lrfTargetLon ?? undefined,
              metadata: asset.metadata,
            },
            { x: bbox.x, y: bbox.y }
          );

          if (!resolved) {
            errors.push(`Asset ${asset.id}: Georeference failed`);
            continue;
          }
          const geoCoords = resolved.geo;

          if (saveDetections) {
            detectionsToCreate.push({
              jobId,
              assetId: asset.id,
              type: 'AI',
              className: normalizeDetectionType(detection.class),
              confidence: detection.confidence,
              boundingBox: bbox,
              geoCoordinates: {
                type: 'Point',
                coordinates: [geoCoords.lon, geoCoords.lat],
              },
              centerLat: geoCoords.lat,
              centerLon: geoCoords.lon,
              metadata: {
                source: 'custom_model',
                modelId,
                modelName,
                geoMethod: resolved.method,
                backend: response.backend,
                ...(response.tiling ? { tiling: response.tiling } : {}),
              } as unknown as Prisma.InputJsonObject,
              customModelId: modelId,
            });
          }
        }

        if (saveDetections && detectionsToCreate.length > 0) {
          if (replaceDraftDetections) {
            draftDetectionsReplaced += await deleteDraftDetectionsForRerun(asset.id, modelId);
          }
          await prisma.detection.createMany({
            data: detectionsToCreate,
          });
          detectionsFound += detectionsToCreate.length;
        } else if (saveDetections && replaceDraftDetections) {
          draftDetectionsReplaced += await deleteDraftDetectionsForRerun(asset.id, modelId);
        }

        processedImages += 1;
        if (gpuLock.token) {
          await refreshGpuLock(gpuLock.token, gpuLockTtlMs);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        errors.push(`Asset ${asset.id}: ${message}`);
      }
    }

    const progress = totalImages === 0 ? 0 : Math.round((processedImages / totalImages) * 100);
    const config: InferenceJobConfig = {
      modelId,
      modelName,
      confidence,
      inferenceMode,
      inferenceModeLabel,
      saveDetections,
      replaceDraftDetections,
      totalImages,
      processedImages,
      detectionsFound,
      skippedImages,
      duplicateImages,
      replaceableDuplicateImages,
      reviewedDuplicateImages,
      draftDetectionsReplaced,
      skippedReason,
      errors: errors.slice(0, 10),
      backend: effectiveBackend,
      tiling: buildTilingSummary({
        tiledImages,
        tilesProcessed,
        rawDetections: rawTileDetections,
        mergedDetections: mergedTileDetections,
      }),
    };

      await updateJobProgress(jobId, config, progress);
      if (gpuLock.token) {
        await refreshGpuLock(gpuLock.token, gpuLockTtlMs);
      }
    }
  } finally {
    if (gpuLock.token) {
      await releaseGpuLock(gpuLock.token);
    }
  }

  const status = processedImages === 0 && errors.length > 0 ? 'FAILED' : 'COMPLETED';
  await prisma.processingJob.update({
    where: { id: jobId },
    data: {
      status,
      completedAt: new Date(),
      errorMessage: errors.length > 0 ? errors.slice(0, 10).join('; ') : null,
    },
  });

  return {
    processedImages,
    detectionsFound,
    skippedImages,
    duplicateImages,
    draftDetectionsReplaced,
    errors,
    tiling: buildTilingSummary({
      tiledImages,
      tilesProcessed,
      rawDetections: rawTileDetections,
      mergedDetections: mergedTileDetections,
    }),
  };
}
