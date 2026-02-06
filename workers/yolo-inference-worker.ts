/**
 * YOLO Inference Worker (Review Sessions)
 *
 * Background worker that processes YOLOInferenceJob entries.
 * Run with: npm run worker:yolo-inference
 */
import { Worker, Job } from 'bullmq';
import { PrismaClient } from '@prisma/client';
import { createRedisConnection, QUEUE_PREFIX } from '../lib/queue/redis';
import {
  YOLO_INFERENCE_QUEUE_NAME,
  type YoloInferenceJobData,
  type YoloInferenceJobResult,
} from '../lib/queue/yolo-inference-queue';
import { yoloInferenceClient } from '../lib/services/yolo-inference';
import { S3Service } from '../lib/services/s3';
import { fetchImageSafely } from '../lib/utils/security';
import { normalizeDetectionType } from '../lib/utils/detection-types';
import type { CenterBox, YOLOPreprocessingMeta } from '../lib/types/detection';

const prisma = new PrismaClient();

const DEFAULT_INFERENCE_SIZE = 640;

function toCenterBox(bbox: [number, number, number, number]): CenterBox | null {
  const [x1, y1, x2, y2] = bbox;
  if ([x1, y1, x2, y2].some((value) => typeof value !== 'number')) {
    return null;
  }
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

function buildPreprocessingMeta(
  originalWidth: number,
  originalHeight: number,
  inferenceWidth: number,
  inferenceHeight: number
): YOLOPreprocessingMeta {
  const aspectOriginal = originalWidth / originalHeight;
  const aspectInference = inferenceWidth / inferenceHeight;
  const useLetterbox = Math.abs(aspectOriginal - aspectInference) > 0.0001;

  if (!useLetterbox) {
    return {
      originalWidth,
      originalHeight,
      inferenceWidth,
      inferenceHeight,
      letterbox: null,
      tiling: null,
    };
  }

  const scale = Math.min(inferenceWidth / originalWidth, inferenceHeight / originalHeight);
  const resizedWidth = originalWidth * scale;
  const resizedHeight = originalHeight * scale;
  const padLeft = (inferenceWidth - resizedWidth) / 2;
  const padTop = (inferenceHeight - resizedHeight) / 2;

  return {
    originalWidth,
    originalHeight,
    inferenceWidth,
    inferenceHeight,
    letterbox: {
      enabled: true,
      padLeft,
      padTop,
      scale,
    },
    tiling: null,
  };
}

function getS3Path(asset: { s3Key: string | null; s3Bucket: string | null }): string | null {
  if (!asset.s3Key) return null;
  const bucket = asset.s3Bucket || S3Service.bucketName;
  return `s3://${bucket}/${asset.s3Key}`;
}

async function getImageBase64(asset: { id: string; storageUrl: string }): Promise<string> {
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
  const storageUrl = asset.storageUrl.startsWith('/')
    ? `${baseUrl}${asset.storageUrl}`
    : asset.storageUrl;
  const buffer = await fetchImageSafely(storageUrl, `Asset ${asset.id}`);
  return buffer.toString('base64');
}

async function handleInferenceJob(
  job: Job<YoloInferenceJobData>
): Promise<YoloInferenceJobResult> {
  const storedJob = await prisma.yOLOInferenceJob.findUnique({
    where: { id: job.data.jobId },
    include: { reviewSession: { select: { assetIds: true } } },
  });

  if (!storedJob) {
    throw new Error('YOLO inference job not found');
  }

  const assetIds = storedJob.reviewSessionId
    ? (Array.isArray(storedJob.reviewSession?.assetIds) ? storedJob.reviewSession?.assetIds : [])
    : (Array.isArray(storedJob.assetIds) ? storedJob.assetIds : []);

  if (!assetIds || assetIds.length === 0) {
    await prisma.yOLOInferenceJob.update({
      where: { id: storedJob.id },
      data: {
        status: 'FAILED',
        errorMessage: 'No assets provided for inference',
        completedAt: new Date(),
      },
    });
    return { processedImages: 0, detectionsFound: 0, errors: ['No assets provided'] };
  }

  await prisma.yOLOInferenceJob.update({
    where: { id: storedJob.id },
    data: {
      status: 'PROCESSING',
    },
  });

  const assets = await prisma.asset.findMany({
    where: {
      id: { in: assetIds as string[] },
      projectId: storedJob.projectId,
    },
    select: {
      id: true,
      storageUrl: true,
      s3Key: true,
      s3Bucket: true,
      imageWidth: true,
      imageHeight: true,
    },
  });

  let processedImages = 0;
  let detectionsFound = 0;
  const errors: string[] = [];

  for (const asset of assets) {
    try {
      if (!asset.imageWidth || !asset.imageHeight) {
        processedImages += 1;
        continue;
      }

      const s3Path = getS3Path(asset);
      const response = s3Path
        ? await yoloInferenceClient.detect({
            s3_path: s3Path,
            model: storedJob.modelName,
            confidence: storedJob.confidence,
          })
        : await yoloInferenceClient.detect({
            image: await getImageBase64({ id: asset.id, storageUrl: asset.storageUrl }),
            model: storedJob.modelName,
            confidence: storedJob.confidence,
          });

      const preprocessingMeta = buildPreprocessingMeta(
        asset.imageWidth,
        asset.imageHeight,
        DEFAULT_INFERENCE_SIZE,
        DEFAULT_INFERENCE_SIZE
      );

      const detectionsToCreate: Array<Record<string, unknown>> = [];
      for (const detection of response.detections || []) {
        const bbox = Array.isArray(detection.bbox)
          ? (detection.bbox as [number, number, number, number])
          : null;
        if (!bbox) continue;
        const centerBox = toCenterBox(bbox);
        if (!centerBox) continue;
        detectionsToCreate.push({
          assetId: asset.id,
          type: 'YOLO_LOCAL',
          className: normalizeDetectionType(detection.class),
          confidence: detection.confidence,
          boundingBox: centerBox,
          preprocessingMeta,
          inferenceJobId: storedJob.id,
          centerLat: null,
          centerLon: null,
          geoDsmCorrected: false,
          metadata: {
            source: 'yolo_local',
            modelName: storedJob.modelName,
            inferenceWidth: DEFAULT_INFERENCE_SIZE,
            inferenceHeight: DEFAULT_INFERENCE_SIZE,
          },
        });
      }

      if (detectionsToCreate.length > 0) {
        await prisma.detection.createMany({ data: detectionsToCreate });
        detectionsFound += detectionsToCreate.length;
      }

      processedImages += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      errors.push(`Asset ${asset.id}: ${message}`);
      processedImages += 1;
    }

    await prisma.yOLOInferenceJob.update({
      where: { id: storedJob.id },
      data: {
        processedImages,
        detectionsFound,
      },
    });
  }

  await prisma.yOLOInferenceJob.update({
    where: { id: storedJob.id },
    data: {
      status: errors.length > 0 && processedImages === 0 ? 'FAILED' : 'COMPLETED',
      processedImages,
      detectionsFound,
      errorMessage: errors.length > 0 ? errors.slice(0, 5).join('; ') : null,
      completedAt: new Date(),
    },
  });

  return { processedImages, detectionsFound, errors };
}

async function startWorker() {
  console.log('[YOLOInferenceWorker] Starting YOLO inference worker...');

  const redisConnection = createRedisConnection();
  redisConnection.on('error', (err) => {
    console.error('[YOLOInferenceWorker] Redis connection error:', err.message);
  });
  redisConnection.on('close', () => {
    console.warn('[YOLOInferenceWorker] Redis connection closed');
  });
  redisConnection.on('reconnecting', () => {
    console.log('[YOLOInferenceWorker] Reconnecting to Redis...');
  });

  try {
    await redisConnection.ping();
    console.log('[YOLOInferenceWorker] Redis connection established');
  } catch (err) {
    console.error('[YOLOInferenceWorker] Failed to connect to Redis:', err);
    process.exit(1);
  }

  const worker = new Worker<YoloInferenceJobData, YoloInferenceJobResult>(
    YOLO_INFERENCE_QUEUE_NAME,
    async (job) => handleInferenceJob(job),
    {
      connection: redisConnection,
      prefix: QUEUE_PREFIX,
      concurrency: 2,
    }
  );

  worker.on('completed', (job, result) => {
    console.log(`[YOLOInferenceWorker] Job ${job.id} completed:`, result);
  });

  worker.on('failed', (job, err) => {
    console.error(`[YOLOInferenceWorker] Job ${job?.id} failed:`, err.message);
  });
}

startWorker().catch((err) => {
  console.error('[YOLOInferenceWorker] Fatal error:', err);
  process.exit(1);
});
