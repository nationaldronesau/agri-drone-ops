/**
 * YOLO Inference Service
 *
 * Runs model inference for a batch of assets and optionally saves detections.
 */
import prisma from '@/lib/db';
import { yoloService } from '@/lib/services/yolo';
import { S3Service } from '@/lib/services/s3';
import { normalizeDetectionType } from '@/lib/utils/detection-types';
import { fetchImageSafely } from '@/lib/utils/security';
import { resolveGeoCoordinates, validateGeoCoordinates } from '@/lib/utils/georeferencing';

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

export interface InferenceJobConfig {
  modelId: string;
  modelName: string;
  confidence: number;
  saveDetections: boolean;
  totalImages: number;
  processedImages: number;
  detectionsFound: number;
  skippedImages: number;
  duplicateImages: number;
  skippedReason?: string;
  errors?: string[];
}

export interface InferenceResult {
  processedImages: number;
  detectionsFound: number;
  skippedImages: number;
  duplicateImages: number;
  errors: string[];
}

const DEFAULT_ALTITUDE = 100;
const DEFAULT_BATCH_SIZE = 10;

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

async function getImageBase64(asset: InferenceAsset): Promise<string> {
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
  const storageUrl = asset.storageUrl.startsWith('/')
    ? `${baseUrl}${asset.storageUrl}`
    : asset.storageUrl;
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
      config,
    },
  });
}

export async function processInferenceJob(options: {
  jobId: string;
  projectId: string;
  modelId: string;
  modelName: string;
  assetIds: string[];
  confidence: number;
  saveDetections: boolean;
  skippedImages: number;
  duplicateImages: number;
  skippedReason?: string;
  batchSize?: number;
}): Promise<InferenceResult> {
  const {
    jobId,
    projectId,
    modelId,
    modelName,
    assetIds,
    confidence,
    saveDetections,
    skippedImages,
    duplicateImages,
    skippedReason,
    batchSize = DEFAULT_BATCH_SIZE,
  } = options;

  const totalImages = assetIds.length;
  let processedImages = 0;
  let detectionsFound = 0;
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
        saveDetections,
        totalImages,
        processedImages,
        detectionsFound,
        skippedImages,
        duplicateImages,
        skippedReason,
      } satisfies InferenceJobConfig,
    },
  });

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
        errors,
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
        const response = s3Path
          ? await yoloService.detect({
              s3_path: s3Path,
              model: modelName,
              confidence,
            })
          : await yoloService.detect({
              image: await getImageBase64(asset),
              model: modelName,
              confidence,
            });

        const detectionsToCreate: Array<Record<string, unknown>> = [];

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
              },
              customModelId: modelId,
            });
          }
        }

        if (saveDetections && detectionsToCreate.length > 0) {
          await prisma.detection.createMany({
            data: detectionsToCreate,
          });
          detectionsFound += detectionsToCreate.length;
        }

        processedImages += 1;
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
      saveDetections,
      totalImages,
      processedImages,
      detectionsFound,
      skippedImages,
      duplicateImages,
      skippedReason,
      errors: errors.slice(0, 10),
    };

    await updateJobProgress(jobId, config, progress);
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
    errors,
  };
}
