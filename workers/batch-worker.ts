/**
 * SAM3 Batch Processing Worker
 *
 * Background worker that processes batch SAM3 detection jobs.
 * Run with: npm run worker
 *
 * This worker:
 * 1. Connects to Redis and listens for jobs
 * 2. Processes images through SAM3 API
 * 3. Creates PendingAnnotation records
 * 4. Updates BatchJob status and progress
 */
import { Worker, Job } from 'bullmq';
import { PrismaClient } from '@prisma/client';
import { createRedisConnection } from '../lib/queue/redis';
import { BATCH_QUEUE_NAME, BatchJobData, BatchJobResult } from '../lib/queue/batch-queue';

// Initialize Prisma client
const prisma = new PrismaClient();

// Environment variables
const ROBOFLOW_API_KEY = process.env.ROBOFLOW_API_KEY;
const SAM3_API_URL = 'https://serverless.roboflow.com/sam3/concept_segment';
const BASE_URL = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';

// Processing limits
const MAX_IMAGE_SIZE = 10 * 1024 * 1024; // 10MB per image
const IMAGE_TIMEOUT = 30000; // 30 seconds per image fetch
const SAM3_TIMEOUT = 120000; // 2 minutes per SAM3 call

// SSRF protection patterns
const ALLOWED_URL_PATTERNS = [
  /^https:\/\/[^/]+\.amazonaws\.com\//,
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
  const { batchJobId, projectId, weedType, exemplars, textPrompt, assetIds } = job.data;

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
      filePath: true,
      s3Key: true,
      s3Bucket: true,
      storageType: true,
      imageWidth: true,
      imageHeight: true,
    },
  });

  const totalImages = assets.length;

  for (let i = 0; i < assets.length; i++) {
    const asset = assets[i];

    try {
      // Build and validate image URL
      let imageUrl: string;

      if (asset.storageType === 'S3' && asset.s3Key && asset.s3Bucket) {
        // Get signed URL for S3 assets
        const signedUrlResponse = await fetch(`${BASE_URL}/api/assets/${asset.id}/signed-url`, {
          headers: { 'X-Internal-Request': 'true' },
        });
        if (!signedUrlResponse.ok) {
          errors.push(`Asset ${asset.id}: Failed to get signed URL`);
          continue;
        }
        const signedUrlData = await signedUrlResponse.json();
        imageUrl = signedUrlData.url;

        if (!isUrlAllowed(imageUrl)) {
          errors.push(`Asset ${asset.id}: Invalid signed URL domain`);
          continue;
        }
      } else if (asset.storageUrl) {
        if (!asset.storageUrl.startsWith('/') && !isUrlAllowed(asset.storageUrl)) {
          errors.push(`Asset ${asset.id}: Invalid storage URL`);
          continue;
        }
        imageUrl = asset.storageUrl.startsWith('/') ? `${BASE_URL}${asset.storageUrl}` : asset.storageUrl;
      } else if (asset.filePath) {
        const urlPath = asset.filePath.replace(/^public\//, '/');
        if (urlPath.includes('..') || !urlPath.startsWith('/')) {
          errors.push(`Asset ${asset.id}: Invalid file path`);
          continue;
        }
        imageUrl = `${BASE_URL}${urlPath}`;
      } else {
        errors.push(`Asset ${asset.id}: No image URL available`);
        continue;
      }

      // Fetch image with timeout
      const imageResponse = await fetch(imageUrl, {
        signal: AbortSignal.timeout(IMAGE_TIMEOUT),
      });

      if (!imageResponse.ok) {
        errors.push(`Asset ${asset.id}: Failed to fetch image (${imageResponse.status})`);
        continue;
      }

      // Validate content type
      const contentType = imageResponse.headers.get('content-type') || '';
      if (!contentType.startsWith('image/')) {
        errors.push(`Asset ${asset.id}: Invalid content type`);
        continue;
      }

      // Check content length
      const contentLength = imageResponse.headers.get('content-length');
      if (contentLength && parseInt(contentLength) > MAX_IMAGE_SIZE) {
        errors.push(`Asset ${asset.id}: Image too large`);
        continue;
      }

      const imageBuffer = await imageResponse.arrayBuffer();
      if (imageBuffer.byteLength > MAX_IMAGE_SIZE) {
        errors.push(`Asset ${asset.id}: Image too large`);
        continue;
      }

      const imageBase64 = Buffer.from(imageBuffer).toString('base64');

      // Build prompts
      const prompts = [];

      if (textPrompt) {
        const sanitizedPrompt = textPrompt.trim().substring(0, 100).replace(/[^\w\s-]/g, '');
        prompts.push({ type: 'text', data: sanitizedPrompt });
      }

      for (const box of exemplars.slice(0, 10)) {
        prompts.push({
          type: 'box',
          data: {
            x: Math.max(0, Math.round(box.x1)),
            y: Math.max(0, Math.round(box.y1)),
            width: Math.max(1, Math.round(box.x2 - box.x1)),
            height: Math.max(1, Math.round(box.y2 - box.y1)),
          },
        });
      }

      // Call SAM3 API
      const sam3Response = await fetch(SAM3_API_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${ROBOFLOW_API_KEY}`,
        },
        body: JSON.stringify({
          image: { type: 'base64', value: imageBase64 },
          prompts,
        }),
        signal: AbortSignal.timeout(SAM3_TIMEOUT),
      });

      if (!sam3Response.ok) {
        errors.push(`Asset ${asset.id}: SAM3 API error (${sam3Response.status})`);
        continue;
      }

      const result = await sam3Response.json();

      // Parse detections
      if (result.prompt_results) {
        for (const promptResult of result.prompt_results) {
          const predictions = promptResult.predictions || [];
          for (const pred of predictions) {
            const masks = pred.masks || [];
            if (masks.length > 0 && masks[0].length >= 3) {
              const maskPoints = masks[0];
              const polygon: [number, number][] = maskPoints.map((p: number[]) => [p[0], p[1]]);
              const xs = maskPoints.map((p: number[]) => p[0]);
              const ys = maskPoints.map((p: number[]) => p[1]);
              const bbox = [
                Math.min(...xs),
                Math.min(...ys),
                Math.max(...xs),
                Math.max(...ys),
              ];

              await prisma.pendingAnnotation.create({
                data: {
                  batchJobId,
                  assetId: asset.id,
                  weedType,
                  confidence: pred.confidence ?? 0.9,
                  polygon,
                  bbox,
                  status: 'PENDING',
                },
              });

              totalDetections++;
            }
          }
        }
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
  if (!ROBOFLOW_API_KEY) {
    console.error('[Worker] ROBOFLOW_API_KEY not set. Exiting.');
    process.exit(1);
  }

  console.log('[Worker] Starting SAM3 batch processing worker...');

  const worker = new Worker<BatchJobData, BatchJobResult>(
    BATCH_QUEUE_NAME,
    async (job) => {
      return processBatchJob(job);
    },
    {
      connection: createRedisConnection(),
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
  });

  // Handle graceful shutdown
  const shutdown = async () => {
    console.log('[Worker] Shutting down...');
    await worker.close();
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
