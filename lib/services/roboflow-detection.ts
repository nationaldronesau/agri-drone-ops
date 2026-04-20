import { Prisma } from "@prisma/client";
import prisma from "@/lib/db";
import {
  ROBOFLOW_MODELS,
  roboflowService,
  type ModelType,
} from "@/lib/services/roboflow";
import { S3Service } from "@/lib/services/s3";
import { normalizeDetectionType } from "@/lib/utils/detection-types";
import {
  resolveGeoCoordinates,
  validateGeoCoordinates,
} from "@/lib/utils/georeferencing";
import { fetchImageSafely } from "@/lib/utils/security";
import type { RoboflowDynamicModelConfig } from "@/lib/queue/roboflow-detection-queue";

interface RoboflowDetectionAsset {
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

export interface RoboflowDetectionJobConfig {
  source: "roboflow_batch_detection";
  modelSource: "dynamic" | "legacy";
  modelNames: string[];
  totalImages: number;
  processedImages: number;
  detectionsFound: number;
  skippedImages: number;
  duplicateImages: number;
  errors?: string[];
}

export interface RoboflowDetectionResult {
  processedImages: number;
  detectionsFound: number;
  skippedImages: number;
  errors: string[];
}

const DEFAULT_ALTITUDE = 100;
const DEFAULT_BATCH_SIZE = 10;

function getImageUrl(asset: RoboflowDetectionAsset): string {
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";
  return asset.storageUrl.startsWith("/")
    ? `${baseUrl}${asset.storageUrl}`
    : asset.storageUrl;
}

async function getImageBuffer(asset: RoboflowDetectionAsset): Promise<Buffer> {
  if (asset.s3Key) {
    return S3Service.downloadFile(
      asset.s3Key,
      asset.s3Bucket || S3Service.bucketName
    );
  }

  return fetchImageSafely(getImageUrl(asset), `Asset ${asset.id}`);
}

async function updateJobProgress(
  jobId: string,
  config: Prisma.InputJsonValue,
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

export async function processRoboflowDetectionJob(options: {
  jobId: string;
  projectId: string;
  assetIds: string[];
  dynamicModels?: RoboflowDynamicModelConfig[];
  detectionModels?: ModelType[];
  skippedImages: number;
  batchSize?: number;
}): Promise<RoboflowDetectionResult> {
  const {
    jobId,
    projectId,
    assetIds,
    dynamicModels = [],
    detectionModels = [],
    skippedImages: initialSkippedImages,
    batchSize = DEFAULT_BATCH_SIZE,
  } = options;

  const useDynamicModels = dynamicModels.length > 0;
  const modelsToRun =
    detectionModels.length > 0
      ? detectionModels
      : (roboflowService.getEnabledModels() as ModelType[]);
  const modelNames = useDynamicModels
    ? dynamicModels.map((model) => model.projectName)
    : modelsToRun.map((modelType) => ROBOFLOW_MODELS[modelType].name);

  const totalImages = assetIds.length;
  let processedImages = 0;
  let detectionsFound = 0;
  let skippedImages = initialSkippedImages;
  const errors: string[] = [];

  await prisma.processingJob.update({
    where: { id: jobId },
    data: {
      status: "PROCESSING",
      startedAt: new Date(),
      progress: 0,
      config: {
        source: "roboflow_batch_detection",
        modelSource: useDynamicModels ? "dynamic" : "legacy",
        modelNames,
        totalImages,
        processedImages,
        detectionsFound,
        skippedImages,
        duplicateImages: 0,
      } as Prisma.InputJsonObject,
    },
  });

  for (let index = 0; index < assetIds.length; index += batchSize) {
    const batchIds = assetIds.slice(index, index + batchSize);

    const currentJob = await prisma.processingJob.findUnique({
      where: { id: jobId },
      select: { status: true },
    });

    if (currentJob?.status === "CANCELLED") {
      return {
        processedImages,
        detectionsFound,
        skippedImages,
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

    for (const asset of assets as RoboflowDetectionAsset[]) {
      try {
        if (
          asset.gpsLatitude == null ||
          asset.gpsLongitude == null ||
          asset.imageWidth == null ||
          asset.imageHeight == null
        ) {
          skippedImages += 1;
          continue;
        }

        const geoValid = validateGeoCoordinates(
          asset.gpsLatitude,
          asset.gpsLongitude,
          "asset"
        );
        if (!geoValid.valid) {
          skippedImages += 1;
          continue;
        }

        const imageBuffer = await getImageBuffer(asset);
        const imageBase64 = imageBuffer.toString("base64");
        const result = useDynamicModels
          ? await roboflowService.detectWithDynamicModels(imageBase64, dynamicModels)
          : await roboflowService.detectMultipleModels(imageBase64, modelsToRun);

        if (result.failures.length > 0) {
          errors.push(
            `Asset ${asset.id}: ${result.failures
              .map((failure) => `${failure.model} failed`)
              .join(", ")}`
          );
        }

        const detectionsToCreate: Prisma.DetectionCreateManyInput[] = [];

        for (const detection of result.detections) {
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
            { x: detection.x, y: detection.y }
          );

          if (!resolved) {
            errors.push(`Asset ${asset.id}: Georeference failed`);
            continue;
          }

          const geoCoords = resolved.geo;
          const computedValid = validateGeoCoordinates(
            geoCoords.lat,
            geoCoords.lon,
            `roboflow detection for asset ${asset.id}`
          );

          if (!computedValid.valid) {
            errors.push(computedValid.error || `Asset ${asset.id}: invalid coordinates`);
            continue;
          }

          detectionsToCreate.push({
            jobId,
            assetId: asset.id,
            type: "AI",
            className: normalizeDetectionType(detection.class),
            confidence: detection.confidence,
            boundingBox: {
              x: detection.x,
              y: detection.y,
              width: detection.width,
              height: detection.height,
            },
            geoCoordinates: {
              type: "Point",
              coordinates: [geoCoords.lon, geoCoords.lat],
            },
            centerLat: geoCoords.lat,
            centerLon: geoCoords.lon,
            metadata: {
              source: "roboflow_batch_detection",
              modelType: detection.modelType,
              modelName:
                (detection as { modelName?: string }).modelName ??
                detection.modelType ??
                detection.class,
              color: detection.color,
              geoMethod: resolved.method,
            },
          });
        }

        if (detectionsToCreate.length > 0) {
          await prisma.detection.createMany({
            data: detectionsToCreate,
          });
          detectionsFound += detectionsToCreate.length;
        }

        processedImages += 1;
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error";
        errors.push(`Asset ${asset.id}: ${message}`);
      }
    }

    const progress =
      totalImages === 0 ? 0 : Math.round((processedImages / totalImages) * 100);
    const config = {
      source: "roboflow_batch_detection",
      modelSource: useDynamicModels ? "dynamic" : "legacy",
      modelNames,
      totalImages,
      processedImages,
      detectionsFound,
      skippedImages,
      duplicateImages: 0,
      errors: errors.slice(0, 10),
    } as Prisma.InputJsonObject;

    await updateJobProgress(jobId, config, progress);
  }

  const status = processedImages === 0 && errors.length > 0 ? "FAILED" : "COMPLETED";
  await prisma.processingJob.update({
    where: { id: jobId },
    data: {
      status,
      completedAt: new Date(),
      errorMessage: errors.length > 0 ? errors.slice(0, 10).join("; ") : null,
    },
  });

  return {
    processedImages,
    detectionsFound,
    skippedImages,
    errors,
  };
}
