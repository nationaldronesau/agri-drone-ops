/**
 * SAM3 Batch Processing Worker
 *
 * Background worker that processes batch SAM3 detection jobs.
 * Run with: npm run worker
 *
 * This worker:
 * 1. Connects to Redis and listens for jobs
 * 2. Processes images through SAM3 API (AWS primary, Roboflow fallback)
 * 3. Creates PendingAnnotation records
 * 4. Updates BatchJob status and progress
 * 5. Runs auto-shutdown scheduler for AWS instance cost control
 */
import { Worker, Job } from 'bullmq';
import { PrismaClient } from '@prisma/client';
import { createRedisConnection, QUEUE_PREFIX } from '../lib/queue/redis';
import { BATCH_QUEUE_NAME, BatchJobData, BatchJobResult } from '../lib/queue/batch-queue';
import { sam3Orchestrator } from '../lib/services/sam3-orchestrator';
import { sam3ConceptService, type ConceptDetection } from '../lib/services/sam3-concept';
import { normalizeDetectionType } from '../lib/utils/detection-types';
import { scaleExemplarBoxes } from '../lib/utils/exemplar-scaling';
import { buildExemplarCrops, normalizeExemplarCrops } from '../lib/utils/exemplar-crops';
import {
  startShutdownScheduler,
  stopShutdownScheduler,
} from '../lib/services/sam3-shutdown-scheduler';

// Initialize Prisma client
const prisma = new PrismaClient();

// Environment variables
const BASE_URL = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';

// Processing limits - drone images can be 20-50MB
const MAX_IMAGE_SIZE = 100 * 1024 * 1024; // 100MB per image
const IMAGE_TIMEOUT = 30000; // 30 seconds per image fetch

// SSRF protection patterns
const ALLOWED_URL_PATTERNS = [
  /^https:\/\/[^/]+\.amazonaws\.com\//,
  /^https:\/\/[^/]+\.cloudfront\.net\//,
  /^https:\/\/staticagridrone\.ndsmartdata\.com\//,
  /^https:\/\/storage\.googleapis\.com\//,
  /^https:\/\/[^/]+\.blob\.core\.windows\.net\//,
  /^http:\/\/localhost(:\d+)?\//,
  /^http:\/\/127\.0\.0\.1(:\d+)?\//,
];

function isUrlAllowed(url: string): boolean {
  if (url.startsWith('/')) return true;
  return ALLOWED_URL_PATTERNS.some(pattern => pattern.test(url));
}

// Process a single batch job
async function processBatchJob(job: Job<BatchJobData>): Promise<BatchJobResult> {
  const {
    batchJobId,
    projectId,
    weedType,
    exemplarId,
    exemplars,
    exemplarSourceWidth,
    exemplarSourceHeight,
    exemplarCrops,  // NEW: Visual crop images from source
    useVisualCrops,
    sourceAssetId,  // NEW: Asset ID where exemplars were drawn
    textPrompt,
    assetIds
  } = job.data;

  console.log(`[Worker] Starting batch job ${batchJobId} with ${assetIds.length} images`);

  // Update job status to PROCESSING
  await prisma.batchJob.update({
    where: { id: batchJobId },
    data: {
      status: 'PROCESSING',
      startedAt: new Date(),
    },
  });

  let processedCount = 0;
  let totalDetections = 0;
  const errors: string[] = [];

  // Get assets
  const assets = await prisma.asset.findMany({
    where: {
      id: { in: assetIds },
      projectId,
    },
    select: {
      id: true,
      storageUrl: true,
      s3Key: true,
      s3Bucket: true,
      storageType: true,
      imageWidth: true,
      imageHeight: true,
    },
  });

  type AssetForProcessing = (typeof assets)[number];
  const totalImages = assets.length;

  const batchJobRecord = await prisma.batchJob.findUnique({
    where: { id: batchJobId },
    select: { exemplarId: true, sourceAssetId: true },
  });

  const fetchAssetImage = async (
    asset: AssetForProcessing
  ): Promise<{ buffer: Buffer } | null> => {
    let imageUrl: string;

    if (asset.storageType?.toLowerCase() === 's3' && asset.s3Key && asset.s3Bucket) {
      const signedUrlResponse = await fetch(`${BASE_URL}/api/assets/${asset.id}/signed-url`, {
        headers: { 'X-Internal-Request': 'true' },
      });
      if (!signedUrlResponse.ok) {
        errors.push(`Asset ${asset.id}: Failed to get signed URL`);
        return null;
      }
      const signedUrlData = await signedUrlResponse.json();
      imageUrl = signedUrlData.url;

      if (!isUrlAllowed(imageUrl)) {
        errors.push(`Asset ${asset.id}: Invalid signed URL domain`);
        return null;
      }
    } else if (asset.storageUrl) {
      if (!asset.storageUrl.startsWith('/') && !isUrlAllowed(asset.storageUrl)) {
        errors.push(`Asset ${asset.id}: Invalid storage URL`);
        return null;
      }
      imageUrl = asset.storageUrl.startsWith('/') ? `${BASE_URL}${asset.storageUrl}` : asset.storageUrl;
    } else {
      errors.push(`Asset ${asset.id}: No image URL available`);
      return null;
    }

    const imageResponse = await fetch(imageUrl, {
      signal: AbortSignal.timeout(IMAGE_TIMEOUT),
    });

    if (!imageResponse.ok) {
      errors.push(`Asset ${asset.id}: Failed to fetch image (${imageResponse.status})`);
      return null;
    }

    const contentType = imageResponse.headers.get('content-type') || '';
    if (!contentType.startsWith('image/')) {
      errors.push(`Asset ${asset.id}: Invalid content type`);
      return null;
    }

    const contentLength = imageResponse.headers.get('content-length');
    if (contentLength && parseInt(contentLength) > MAX_IMAGE_SIZE) {
      errors.push(`Asset ${asset.id}: Image too large`);
      return null;
    }

    const imageBuffer = await imageResponse.arrayBuffer();
    if (imageBuffer.byteLength > MAX_IMAGE_SIZE) {
      errors.push(`Asset ${asset.id}: Image too large`);
      return null;
    }

    return { buffer: Buffer.from(imageBuffer) };
  };

  let conceptExemplarId = exemplarId || batchJobRecord?.exemplarId || null;
  let resolvedSourceAssetId = sourceAssetId || batchJobRecord?.sourceAssetId || null;
  let resolvedExemplarCrops = normalizeExemplarCrops(exemplarCrops);
  const conceptConfigured = sam3ConceptService.isConfigured();
  const allowConcept = conceptConfigured && !useVisualCrops;
  let useConcept = false;
  let sourceImageBuffer: Buffer | null = null;

  if (!resolvedSourceAssetId && assets.length > 0) {
    resolvedSourceAssetId = assets[0].id;
  }

  if (resolvedSourceAssetId) {
    const sourceAsset =
      assets.find((asset) => asset.id === resolvedSourceAssetId) ||
      (await prisma.asset.findUnique({
        where: { id: resolvedSourceAssetId },
        select: {
          id: true,
          storageUrl: true,
          s3Key: true,
          s3Bucket: true,
          storageType: true,
          imageWidth: true,
          imageHeight: true,
        },
      }));

    if (sourceAsset) {
      const sourceImage = await fetchAssetImage(sourceAsset);
      if (sourceImage) {
        sourceImageBuffer = sourceImage.buffer;
      }
    }
  }

  if (conceptConfigured && useVisualCrops) {
    console.log(`[Worker] Job ${batchJobId}: Visual crops only requested, skipping concept propagation`);
  }

  if (allowConcept) {
    if (!conceptExemplarId && resolvedSourceAssetId && sourceImageBuffer) {
      const createResult = await sam3ConceptService.createExemplar({
        imageBuffer: sourceImageBuffer,
        boxes: exemplars,
        className: weedType,
        imageId: resolvedSourceAssetId,
      });

      if (createResult.success && createResult.data) {
        conceptExemplarId = createResult.data.exemplar_id;
        await prisma.batchJob.update({
          where: { id: batchJobId },
          data: {
            exemplarId: conceptExemplarId,
            sourceAssetId: resolvedSourceAssetId,
          },
        });
      } else {
        console.warn('[Worker] Concept exemplar creation failed:', createResult.error);
      }
    }

    if (conceptExemplarId) {
      const warmupResult = await sam3ConceptService.warmup();
      if (!warmupResult.success) {
        console.warn('[Worker] Concept warmup failed:', warmupResult.error);
        conceptExemplarId = null;
      }
    }
    useConcept = Boolean(conceptExemplarId);
  }

  if (!resolvedExemplarCrops.length && sourceImageBuffer) {
    resolvedExemplarCrops = await buildExemplarCrops({
      imageBuffer: sourceImageBuffer,
      boxes: exemplars,
    });
  }

  for (let i = 0; i < assets.length; i++) {
    const asset = assets[i];

    try {
      const imageData = await fetchAssetImage(asset);
      if (!imageData) {
        continue;
      }

      // Get current image dimensions for scaling
      const currentWidth = asset.imageWidth || 4000;
      const currentHeight = asset.imageHeight || 3000;

      // Log if using fallback dimensions
      if (!asset.imageWidth || !asset.imageHeight) {
        console.warn(
          `[Worker] Job ${batchJobId}, Asset ${asset.id}: Missing dimensions, using fallback ${currentWidth}x${currentHeight}`
        );
      }

      // Scale exemplar boxes using shared utility
      const { boxes } = scaleExemplarBoxes({
        exemplars,
        sourceWidth: exemplarSourceWidth,
        sourceHeight: exemplarSourceHeight,
        targetWidth: currentWidth,
        targetHeight: currentHeight,
        jobId: batchJobId,
        assetId: asset.id,
      });

      // Skip if all boxes became invalid after scaling
      if (boxes.length === 0 && exemplars.length > 0) {
        errors.push(`Asset ${asset.id}: All exemplar boxes became invalid after scaling`);
        continue;
      }

      // Sanitize text prompt if provided
      const sanitizedPrompt = textPrompt
        ? textPrompt.trim().substring(0, 100).replace(/[^\w\s-]/g, '')
        : undefined;

      let detections: Array<{ bbox: [number, number, number, number]; polygon: [number, number][]; confidence: number; similarity?: number }> = [];
      let conceptApplied = false;

      if (useConcept && conceptExemplarId) {
        const conceptResult = await sam3ConceptService.applyExemplar({
          exemplarId: conceptExemplarId,
          imageBuffer: imageData.buffer,
          imageId: asset.id,
          options: { returnPolygons: true },
        });

        if (conceptResult.success && conceptResult.data) {
          conceptApplied = true;
          detections = conceptResult.data.detections.map((det: ConceptDetection) => ({
            bbox: det.bbox,
            polygon: det.polygon || [],
            confidence: det.confidence,
            similarity: det.similarity,
          }));
          if (processedCount === 0) {
            console.log(`[Worker] Job ${batchJobId}: Using CONCEPT backend`);
          }
        } else {
          console.warn(`[Worker] Job ${batchJobId}, Asset ${asset.id}: Concept apply failed (${conceptResult.error}), falling back`);
        }
      }

      if (!conceptApplied) {
        // Determine if this is the source image (where exemplars were drawn)
        const isSourceImage = resolvedSourceAssetId ? asset.id === resolvedSourceAssetId : i === 0;

        // Call SAM3 via orchestrator with appropriate method
        let result;

        if (isSourceImage) {
          // Source image: use box-based detection (boxes point to actual content)
          console.log(`[Worker] Job ${batchJobId}, Asset ${asset.id}: Processing as SOURCE image with ${boxes.length} boxes`);
          result = await sam3Orchestrator.predict({
            imageBuffer: imageData.buffer,
            boxes: boxes.length > 0 ? boxes : undefined,
            textPrompt: sanitizedPrompt,
            className: weedType,
          });
        } else if (resolvedExemplarCrops.length > 0) {
          // Target image with visual crops: use crop-based detection
          console.log(`[Worker] Job ${batchJobId}, Asset ${asset.id}: Processing as TARGET image with ${resolvedExemplarCrops.length} visual exemplar crops`);
          result = await sam3Orchestrator.predictWithExemplars({
            imageBuffer: imageData.buffer,
            exemplarCrops: resolvedExemplarCrops,
            className: weedType,
          });
          if (!result.success) {
            console.warn(`[Worker] Job ${batchJobId}, Asset ${asset.id}: Exemplar prediction failed (${result.error}), falling back`);
            result = await sam3Orchestrator.predict({
              imageBuffer: imageData.buffer,
              boxes: boxes.length > 0 ? boxes : undefined,
              textPrompt: sanitizedPrompt,
              className: weedType,
            });
          }
        } else {
          // Fallback: text-only or box-based (may not work well for domain-specific objects)
          console.log(`[Worker] Job ${batchJobId}, Asset ${asset.id}: Processing as TARGET image with fallback (text/boxes)`);
          result = await sam3Orchestrator.predict({
            imageBuffer: imageData.buffer,
            boxes: boxes.length > 0 ? boxes : undefined,
            textPrompt: sanitizedPrompt,
            className: weedType,
          });
        }

        if (!result.success) {
          errors.push(`Asset ${asset.id}: SAM3 error - ${result.error || 'Unknown error'}`);
          continue;
        }

        // Log which backend was used (first image only to avoid spam)
        if (processedCount === 0) {
          console.log(`[Worker] Job ${batchJobId}: Using ${result.backend.toUpperCase()} backend`);
          if (result.startupMessage) {
            console.log(`[Worker] ${result.startupMessage}`);
          }
        }

        detections = result.detections.map((det) => ({
          bbox: det.bbox,
          polygon: det.polygon,
          confidence: det.score,
        }));
      }

      // Create pending annotations from detections
      for (const detection of detections) {
        const confidenceScore =
          typeof detection.similarity === 'number' ? detection.similarity : detection.confidence;
        await prisma.pendingAnnotation.create({
          data: {
            batchJobId,
            assetId: asset.id,
            weedType: normalizeDetectionType(weedType),
            confidence: confidenceScore,
            similarity: detection.similarity ?? null,
            polygon: detection.polygon ?? [],
            bbox: detection.bbox,
            status: 'PENDING',
          },
        });

        totalDetections++;
      }

      processedCount++;

      // Update progress
      await prisma.batchJob.update({
        where: { id: batchJobId },
        data: {
          processedImages: processedCount,
          detectionsFound: totalDetections,
        },
      });

      // Update job progress for BullMQ
      await job.updateProgress(Math.round((processedCount / totalImages) * 100));

      console.log(`[Worker] Job ${batchJobId}: Processed ${processedCount}/${totalImages} images, ${totalDetections} detections`);

    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Unknown error';
      errors.push(`Asset ${asset.id}: ${errorMessage}`);
      console.error(`[Worker] Error processing asset ${asset.id}:`, errorMessage);
    }
  }

  // Mark job complete
  const finalStatus = errors.length > 0 && processedCount === 0 ? 'FAILED' : 'COMPLETED';
  await prisma.batchJob.update({
    where: { id: batchJobId },
    data: {
      status: finalStatus,
      processedImages: processedCount,
      detectionsFound: totalDetections,
      completedAt: new Date(),
      errorMessage: errors.length > 0 ? errors.slice(0, 10).join('; ') : null,
    },
  });

  console.log(`[Worker] Job ${batchJobId} completed: ${processedCount} images, ${totalDetections} detections, ${errors.length} errors`);

  return {
    processedImages: processedCount,
    detectionsFound: totalDetections,
    errors: errors.slice(0, 10),
  };
}

// Create and start the worker
async function startWorker() {
  console.log('[Worker] Starting SAM3 batch processing worker...');

  // Check SAM3 backend availability
  const status = await sam3Orchestrator.getStatus();
  if (status.preferredBackend === 'none') {
    console.error('[Worker] No SAM3 backend configured (AWS or Roboflow). Exiting.');
    process.exit(1);
  }
  console.log(`[Worker] SAM3 preferred backend: ${status.preferredBackend.toUpperCase()}`);
  if (status.awsConfigured) {
    console.log(`[Worker] AWS SAM3 state: ${status.awsState}`);
  }
  if (status.roboflowConfigured) {
    console.log('[Worker] Roboflow fallback: configured');
  }

  // Start auto-shutdown scheduler for AWS cost control
  startShutdownScheduler();

  // Create Redis connection with error handling
  const redisConnection = createRedisConnection();

  // Handle Redis connection errors
  redisConnection.on('error', (err) => {
    console.error('[Worker] Redis connection error:', err.message);
  });

  redisConnection.on('close', () => {
    console.warn('[Worker] Redis connection closed');
  });

  redisConnection.on('reconnecting', () => {
    console.log('[Worker] Reconnecting to Redis...');
  });

  // Test Redis connection before starting
  try {
    await redisConnection.ping();
    console.log('[Worker] Redis connection established');
  } catch (err) {
    console.error('[Worker] Failed to connect to Redis:', err);
    console.error('[Worker] Please ensure Redis is running. Exiting.');
    process.exit(1);
  }

  const worker = new Worker<BatchJobData, BatchJobResult>(
    BATCH_QUEUE_NAME,
    async (job) => {
      return processBatchJob(job);
    },
    {
      connection: redisConnection,
      prefix: QUEUE_PREFIX, // Hash tag prefix for Redis Cluster compatibility
      concurrency: 2, // Process up to 2 jobs in parallel
    }
  );

  worker.on('completed', (job, result) => {
    console.log(`[Worker] Job ${job.id} completed:`, result);
  });

  worker.on('failed', (job, err) => {
    console.error(`[Worker] Job ${job?.id} failed:`, err.message);
  });

  worker.on('error', (err) => {
    console.error('[Worker] Worker error:', err.message);
    // If it's a connection error, log additional info
    if (err.message.includes('ECONNREFUSED') || err.message.includes('ENOTFOUND')) {
      console.error('[Worker] Redis connection lost. Worker will attempt to reconnect.');
    }
  });

  // Handle stalled jobs (jobs that stopped responding)
  worker.on('stalled', (jobId) => {
    console.warn(`[Worker] Job ${jobId} stalled - will be retried`);
  });

  // Handle graceful shutdown
  const shutdown = async () => {
    console.log('[Worker] Shutting down...');
    stopShutdownScheduler();
    await worker.close();
    await redisConnection.quit();
    await prisma.$disconnect();
    process.exit(0);
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  console.log('[Worker] Worker started. Waiting for jobs...');
}

// Start the worker
startWorker().catch((err) => {
  console.error('[Worker] Failed to start worker:', err);
  process.exit(1);
});
