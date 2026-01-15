/**
 * SAM3 Batch Processing API Route
 *
 * Enqueues batch detection jobs for background processing.
 * Jobs are processed by the BullMQ worker (workers/batch-worker.ts).
 *
 * FALLBACK: If Redis is unavailable, processes synchronously for small batches.
 * This ensures "Apply to All Images" works even without the background worker.
 *
 * Security:
 * - Authentication required (team membership verified)
 * - Rate limiting per IP
 * - Project ownership validation through team membership
 *
 * The actual image processing happens in the background worker,
 * allowing this endpoint to return immediately with the job ID.
 * Clients can poll GET /api/sam3/batch/[id] for status updates.
 */
import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/db';
import { checkProjectAccess } from '@/lib/auth/api-auth';
import { enqueueBatchJob, getQueueStats } from '@/lib/queue/batch-queue';
import { checkRedisConnection } from '@/lib/queue/redis';
import { sam3Orchestrator } from '@/lib/services/sam3-orchestrator';
import { sam3ConceptService, type ConceptDetection } from '@/lib/services/sam3-concept';
import { normalizeDetectionType } from '@/lib/utils/detection-types';
import { scaleExemplarBoxes } from '@/lib/utils/exemplar-scaling';
import { buildExemplarCrops, normalizeExemplarCrops } from '@/lib/utils/exemplar-crops';

// Rate limiting (per-instance; use Redis for production multi-instance)
const rateLimitMap = new Map<string, { count: number; resetTime: number }>();
const RATE_LIMIT_WINDOW_MS = 60000; // 1 minute
const RATE_LIMIT_MAX_REQUESTS = 10; // 10 batch jobs per minute

// Maximum images per batch (reasonable limit for queue)
const MAX_IMAGES_PER_BATCH = 500;

// Maximum images for synchronous processing (when Redis unavailable)
const MAX_SYNC_IMAGES = 20;

// Image processing limits
const MAX_IMAGE_SIZE = 100 * 1024 * 1024; // 100MB per image
const IMAGE_TIMEOUT = 30000; // 30 seconds per image fetch

// Maximum wall-clock time for synchronous processing to avoid HTTP 504 timeouts
// Most serverless platforms timeout at 60s, Vercel Pro at 300s
const MAX_SYNC_PROCESSING_MS = 240000; // 4 minutes - leave buffer for response

// Base URL for internal API calls
const BASE_URL = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';

// SSRF protection patterns - include CloudFront for S3 CDN delivery
const ALLOWED_URL_PATTERNS = [
  /^https:\/\/[^/]+\.amazonaws\.com\//,
  /^https:\/\/[^/]+\.cloudfront\.net\//,  // CloudFront CDN for S3
  /^https:\/\/staticagridrone\.ndsmartdata\.com\//, // Custom CloudFront domain
  /^https:\/\/storage\.googleapis\.com\//,
  /^https:\/\/[^/]+\.blob\.core\.windows\.net\//,
  /^http:\/\/localhost(:\d+)?\//,
  /^http:\/\/127\.0\.0\.1(:\d+)?\//,
];

function isUrlAllowed(url: string): boolean {
  if (url.startsWith('/')) return true;
  return ALLOWED_URL_PATTERNS.some(pattern => pattern.test(url));
}

function getClientIp(request: NextRequest): string {
  return request.headers.get('x-forwarded-for')?.split(',')[0].trim()
    || request.headers.get('x-real-ip')
    || 'unknown';
}

function checkRateLimit(ip: string): { allowed: boolean; retryAfter?: number } {
  const now = Date.now();
  const record = rateLimitMap.get(ip);

  if (!record || now > record.resetTime) {
    rateLimitMap.set(ip, { count: 1, resetTime: now + RATE_LIMIT_WINDOW_MS });
    return { allowed: true };
  }

  if (record.count >= RATE_LIMIT_MAX_REQUESTS) {
    const retryAfter = Math.ceil((record.resetTime - now) / 1000);
    return { allowed: false, retryAfter };
  }

  record.count++;
  return { allowed: true };
}

interface BoxExemplar {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

interface BatchRequest {
  projectId: string;
  weedType: string;
  exemplarId?: string;            // Existing concept exemplar ID (optional)
  exemplars: BoxExemplar[];
  exemplarSourceWidth?: number;  // Width of image where exemplars were drawn
  exemplarSourceHeight?: number; // Height of image where exemplars were drawn
  // NEW: Visual crop-based exemplars for cross-image detection
  exemplarCrops?: string[];      // Base64 encoded crop images from source
  useVisualCrops?: boolean;      // Skip concept propagation and use visual crops only
  sourceAssetId?: string;        // Asset ID where exemplars were drawn
  assetIds?: string[];
  textPrompt?: string;
}

interface AssetForProcessing {
  id: string;
  storageUrl: string | null;
  s3Key: string | null;
  s3Bucket: string | null;
  storageType: string;
  imageWidth: number | null;
  imageHeight: number | null;
}

/**
 * Process batch synchronously when Redis is unavailable.
 * This is a fallback for small batches to ensure "Apply to All Images" works
 * even without the background worker running.
 */
async function processSynchronously(
  batchJobId: string,
  projectId: string,
  weedType: string,
  exemplarId: string | undefined,
  exemplars: BoxExemplar[],
  exemplarSourceWidth: number | undefined,
  exemplarSourceHeight: number | undefined,
  exemplarCrops: string[] | undefined,  // NEW: Visual crop images
  useVisualCrops: boolean | undefined,
  sourceAssetId: string | undefined,    // NEW: Source asset ID
  textPrompt: string | undefined,
  assets: AssetForProcessing[]
): Promise<{ processedImages: number; detectionsFound: number; errors: string[] }> {
  let processedCount = 0;
  let totalDetections = 0;
  const errors: string[] = [];
  const startTime = Date.now();

  // Update job status to PROCESSING
  await prisma.batchJob.update({
    where: { id: batchJobId },
    data: {
      status: 'PROCESSING',
      startedAt: new Date(),
    },
  });

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
    console.log(`[Sync] Job ${batchJobId}: Visual crops only requested, skipping concept propagation`);
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
        console.warn('[Sync] Concept exemplar creation failed:', createResult.error);
      }
    }

    if (conceptExemplarId) {
      const warmupResult = await sam3ConceptService.warmup();
      if (!warmupResult.success) {
        console.warn('[Sync] Concept warmup failed:', warmupResult.error);
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
    // Check timeout to avoid HTTP 504 errors
    const elapsed = Date.now() - startTime;
    if (elapsed > MAX_SYNC_PROCESSING_MS) {
      console.warn(`[Sync] Job ${batchJobId}: Timeout after ${Math.round(elapsed / 1000)}s, processed ${processedCount}/${assets.length}`);
      errors.push(`Processing timeout - completed ${processedCount} of ${assets.length} images`);
      break;
    }

    const asset = assets[i];

    try {
      const imageData = await fetchAssetImage(asset);
      if (!imageData) {
        continue;
      }

      // Get current image dimensions (fallback to default if not stored)
      const currentWidth = asset.imageWidth || 4000;
      const currentHeight = asset.imageHeight || 3000;

      // Log if using fallback dimensions
      if (!asset.imageWidth || !asset.imageHeight) {
        console.warn(
          `[Sync] Job ${batchJobId}, Asset ${asset.id}: Missing dimensions, using fallback ${currentWidth}x${currentHeight}`
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
        } else {
          console.warn(`[Sync] Job ${batchJobId}, Asset ${asset.id}: Concept apply failed (${conceptResult.error}), falling back`);
        }
      }

      if (!conceptApplied) {
        // Determine if this is the source image (where exemplars were drawn)
        const isSourceImage = resolvedSourceAssetId ? asset.id === resolvedSourceAssetId : i === 0;

        // Call SAM3 via orchestrator with appropriate method
        let result;

        if (isSourceImage) {
          // Source image: use box-based detection (boxes point to actual content)
          console.log(`[Sync] Job ${batchJobId}, Asset ${asset.id}: Processing as SOURCE image with ${boxes.length} boxes`);
          result = await sam3Orchestrator.predict({
            imageBuffer: imageData.buffer,
            boxes: boxes.length > 0 ? boxes : undefined,
            textPrompt: sanitizedPrompt,
            className: weedType,
          });
        } else if (resolvedExemplarCrops.length > 0) {
          // Target image with visual crops: use crop-based detection
          console.log(`[Sync] Job ${batchJobId}, Asset ${asset.id}: Processing as TARGET image with ${resolvedExemplarCrops.length} visual exemplar crops`);
          result = await sam3Orchestrator.predictWithExemplars({
            imageBuffer: imageData.buffer,
            exemplarCrops: resolvedExemplarCrops,
            className: weedType,
          });
          if (!result.success) {
            console.warn(`[Sync] Job ${batchJobId}, Asset ${asset.id}: Exemplar prediction failed (${result.error}), falling back`);
            result = await sam3Orchestrator.predict({
              imageBuffer: imageData.buffer,
              boxes: boxes.length > 0 ? boxes : undefined,
              textPrompt: sanitizedPrompt,
              className: weedType,
            });
          }
        } else {
          // Fallback: text-only or box-based (may not work well for domain-specific objects)
          console.log(`[Sync] Job ${batchJobId}, Asset ${asset.id}: Processing as TARGET image with fallback (text/boxes)`);
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

      console.log(`[Sync] Job ${batchJobId}: Processed ${processedCount}/${assets.length} images, ${totalDetections} detections`);

    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Unknown error';
      errors.push(`Asset ${asset.id}: ${errorMessage}`);
      console.error(`[Sync] Error processing asset ${asset.id}:`, errorMessage);
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

  console.log(`[Sync] Job ${batchJobId} completed: ${processedCount} images, ${totalDetections} detections, ${errors.length} errors`);

  return {
    processedImages: processedCount,
    detectionsFound: totalDetections,
    errors: errors.slice(0, 10),
  };
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  // Rate limiting
  const clientIp = getClientIp(request);
  const rateLimit = checkRateLimit(clientIp);

  if (!rateLimit.allowed) {
    return NextResponse.json(
      { error: 'Too many batch requests', success: false },
      {
        status: 429,
        headers: { 'Retry-After': String(rateLimit.retryAfter) }
      }
    );
  }

  try {
    // Parse request body with specific error handling
    let body: BatchRequest;
    try {
      body = await request.json();
    } catch (parseError) {
      console.error('Failed to parse request body:', parseError);
      return NextResponse.json(
        { error: 'Invalid request body - could not parse JSON', success: false },
        { status: 400 }
      );
    }

    console.log('[Batch] Request received:', {
      projectId: body.projectId,
      weedType: body.weedType,
      exemplarCount: body.exemplars?.length,
      exemplarCropCount: body.exemplarCrops?.length,
      sourceAssetId: body.sourceAssetId,
      useVisualCrops: body.useVisualCrops,
      assetIdCount: body.assetIds?.length,
    });

    // Validate required fields
    if (!body.projectId || !body.weedType || !body.exemplars?.length) {
      return NextResponse.json(
        { error: 'Missing required fields', success: false },
        { status: 400 }
      );
    }

    // Validate projectId format (CUID)
    if (!/^c[a-z0-9]{24,}$/i.test(body.projectId)) {
      console.log('[Batch] Invalid projectId format:', body.projectId);
      return NextResponse.json(
        { error: 'Invalid project ID format', success: false },
        { status: 400 }
      );
    }

    // Authentication and project access check
    let projectAccess;
    try {
      projectAccess = await checkProjectAccess(body.projectId);
    } catch (authError) {
      console.error('[Batch] Auth check failed:', authError);
      return NextResponse.json(
        { error: 'Authentication check failed', success: false },
        { status: 500 }
      );
    }
    if (!projectAccess.authenticated) {
      return NextResponse.json(
        { error: 'Authentication required', success: false },
        { status: 401 }
      );
    }
    if (!projectAccess.hasAccess) {
      return NextResponse.json(
        { error: projectAccess.error || 'Access denied', success: false },
        { status: 403 }
      );
    }

    // Validate exemplars (max 10, valid coordinates)
    if (body.exemplars.length > 10) {
      return NextResponse.json(
        { error: 'Maximum 10 exemplars allowed', success: false },
        { status: 400 }
      );
    }

    // Validate exemplar coordinates (support high-res images up to 50MP - approx 8000x6000)
    const MAX_COORD = 20000;
    for (const exemplar of body.exemplars) {
      if (typeof exemplar.x1 !== 'number' || typeof exemplar.y1 !== 'number' ||
          typeof exemplar.x2 !== 'number' || typeof exemplar.y2 !== 'number' ||
          exemplar.x1 < 0 || exemplar.y1 < 0 || exemplar.x2 < 0 || exemplar.y2 < 0 ||
          exemplar.x1 > MAX_COORD || exemplar.y1 > MAX_COORD || exemplar.x2 > MAX_COORD || exemplar.y2 > MAX_COORD) {
        console.log('[Batch] Invalid exemplar coordinates:', exemplar);
        return NextResponse.json(
          { error: 'Invalid exemplar coordinates', success: false },
          { status: 400 }
        );
      }
    }

    // Validate source dimensions if provided
    if (body.exemplarSourceWidth !== undefined || body.exemplarSourceHeight !== undefined) {
      // Both must be provided together
      if (body.exemplarSourceWidth === undefined || body.exemplarSourceHeight === undefined) {
        console.log('[Batch] Incomplete source dimensions:', {
          width: body.exemplarSourceWidth,
          height: body.exemplarSourceHeight,
        });
        return NextResponse.json(
          { error: 'Both exemplarSourceWidth and exemplarSourceHeight must be provided together', success: false },
          { status: 400 }
        );
      }
      // Must be positive finite numbers
      if (
        body.exemplarSourceWidth <= 0 ||
        body.exemplarSourceHeight <= 0 ||
        !Number.isFinite(body.exemplarSourceWidth) ||
        !Number.isFinite(body.exemplarSourceHeight)
      ) {
        console.log('[Batch] Invalid source dimensions:', {
          width: body.exemplarSourceWidth,
          height: body.exemplarSourceHeight,
        });
        return NextResponse.json(
          { error: 'Source dimensions must be positive finite numbers', success: false },
          { status: 400 }
        );
      }
    }

    if (body.useVisualCrops !== undefined && typeof body.useVisualCrops !== 'boolean') {
      return NextResponse.json(
        { error: 'useVisualCrops must be a boolean', success: false },
        { status: 400 }
      );
    }

    // Validate exemplar crops if provided
    if (body.exemplarCrops && body.exemplarCrops.length > 0) {
      // Limit number of crops (same as exemplar boxes)
      if (body.exemplarCrops.length > 10) {
        return NextResponse.json(
          { error: 'Maximum 10 exemplar crops allowed', success: false },
          { status: 400 }
        );
      }

      // Validate each crop is a base64 data URL or raw base64 string
      for (const crop of body.exemplarCrops) {
        const isDataUrl = typeof crop === 'string' && crop.startsWith('data:image/');
        const isBase64 = typeof crop === 'string' && /^[A-Za-z0-9+/]+={0,2}$/.test(crop);
        if (!isDataUrl && !isBase64) {
          console.log('[Batch] Invalid exemplar crop format');
          return NextResponse.json(
            { error: 'Exemplar crops must be base64 encoded images', success: false },
            { status: 400 }
          );
        }
        // Limit individual crop size to 5MB (base64 encoded)
        if (crop.length > 5 * 1024 * 1024 * 1.37) {
          return NextResponse.json(
            { error: 'Exemplar crop too large (max 5MB each)', success: false },
            { status: 400 }
          );
        }
      }
      console.log(`[Batch] Received ${body.exemplarCrops.length} visual exemplar crops`);
    }

    // Validate sourceAssetId if provided
    if (body.sourceAssetId && !/^c[a-z0-9]{24,}$/i.test(body.sourceAssetId)) {
      return NextResponse.json(
        { error: 'Invalid source asset ID format', success: false },
        { status: 400 }
      );
    }

    // Get target asset IDs
    let assetIds: string[];
    try {
      if (body.assetIds?.length) {
        // Validate asset IDs format
        for (const assetId of body.assetIds) {
          if (!/^c[a-z0-9]{24,}$/i.test(assetId)) {
            return NextResponse.json(
              { error: 'Invalid asset ID format', success: false },
              { status: 400 }
            );
          }
        }

        // Verify assets exist and belong to project
        const assets = await prisma.asset.findMany({
          where: {
            id: { in: body.assetIds.slice(0, MAX_IMAGES_PER_BATCH) },
            projectId: body.projectId,
          },
          select: { id: true },
        });
        assetIds = assets.map(a => a.id);
      } else {
        // Get all project assets (up to limit)
        const assets = await prisma.asset.findMany({
          where: { projectId: body.projectId },
          select: { id: true },
          take: MAX_IMAGES_PER_BATCH,
        });
        assetIds = assets.map(a => a.id);
      }
    } catch (dbError) {
      console.error('[Batch] Database error fetching assets:', dbError);
      return NextResponse.json(
        { error: 'Database error while fetching assets', success: false },
        { status: 500 }
      );
    }

    if (assetIds.length === 0) {
      return NextResponse.json(
        { error: 'No assets found', success: false },
        { status: 404 }
      );
    }

    // Check if Redis is available for queue-based processing
    let redisAvailable = false;
    try {
      redisAvailable = await checkRedisConnection();
      console.log(`[Batch] Redis available: ${redisAvailable}`);
    } catch (redisError) {
      console.error('[Batch] Redis check error:', redisError);
      // Continue with sync processing
    }

    const useSyncProcessing = !redisAvailable && assetIds.length <= MAX_SYNC_IMAGES;
    console.log(`[Batch] Processing mode: ${useSyncProcessing ? 'sync' : 'queue'}, ${assetIds.length} images`);

    // If Redis unavailable and batch too large, return error with guidance
    if (!redisAvailable && assetIds.length > MAX_SYNC_IMAGES) {
      return NextResponse.json(
        {
          error: `Queue service unavailable. For batches larger than ${MAX_SYNC_IMAGES} images, please ensure the background worker is running. Try with fewer images or contact support.`,
          success: false,
          suggestion: `Select up to ${MAX_SYNC_IMAGES} images to process without the queue service.`,
        },
        { status: 503 }
      );
    }

    // Create batch job record
    let batchJob;
    try {
      batchJob = await prisma.batchJob.create({
        data: {
          projectId: body.projectId,
          weedType: body.weedType,
          exemplars: body.exemplars,
          exemplarSourceWidth: body.exemplarSourceWidth,
          exemplarSourceHeight: body.exemplarSourceHeight,
          exemplarId: body.exemplarId,
          sourceAssetId: body.sourceAssetId,
          textPrompt: body.textPrompt?.substring(0, 100) || body.weedType.replace('Suspected ', ''),
          totalImages: assetIds.length,
          status: useSyncProcessing ? 'PROCESSING' : 'QUEUED',
        },
      });
      console.log(`[Batch] Created batch job: ${batchJob.id}`);
    } catch (createError) {
      console.error('[Batch] Failed to create batch job record:', createError);
      return NextResponse.json(
        { error: 'Failed to create batch job in database', success: false },
        { status: 500 }
      );
    }

    // SYNCHRONOUS PROCESSING PATH
    // When Redis is unavailable but batch is small enough, process inline
    if (useSyncProcessing) {
      console.log(`[Sync] Processing ${assetIds.length} images synchronously (Redis unavailable)`);

      // Fetch full asset data for synchronous processing
      const assetsForProcessing = await prisma.asset.findMany({
        where: {
          id: { in: assetIds },
          projectId: body.projectId,
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

      try {
        const result = await processSynchronously(
          batchJob.id,
          body.projectId,
          body.weedType,
          body.exemplarId,
          body.exemplars,
          body.exemplarSourceWidth,
          body.exemplarSourceHeight,
          body.exemplarCrops,    // NEW: Visual crop images
          body.useVisualCrops,
          body.sourceAssetId,   // NEW: Source asset ID
          body.textPrompt,
          assetsForProcessing
        );

        return NextResponse.json({
          success: true,
          batchJobId: batchJob.id,
          totalImages: assetIds.length,
          processedImages: result.processedImages,
          detectionsFound: result.detectionsFound,
          status: result.errors.length > 0 && result.processedImages === 0 ? 'FAILED' : 'COMPLETED',
          message: `Processed ${result.processedImages} of ${assetIds.length} images with ${result.detectionsFound} detections.`,
          errors: result.errors.length > 0 ? result.errors : undefined,
          pollUrl: `/api/sam3/batch/${batchJob.id}`,
          processedSynchronously: true,
        });
      } catch (syncError) {
        console.error('Synchronous processing failed:', syncError);
        await prisma.batchJob.update({
          where: { id: batchJob.id },
          data: {
            status: 'FAILED',
            errorMessage: syncError instanceof Error ? syncError.message : 'Synchronous processing failed',
            completedAt: new Date(),
          },
        });
        return NextResponse.json(
          { error: 'Failed to process images', success: false },
          { status: 500 }
        );
      }
    }

    // QUEUE-BASED PROCESSING PATH
    // Enqueue job for background processing
    // If enqueue fails, mark the job as FAILED to avoid stuck jobs
    try {
      await enqueueBatchJob({
        batchJobId: batchJob.id,
        projectId: body.projectId,
        weedType: body.weedType,
        exemplarId: body.exemplarId,
        exemplars: body.exemplars,
        exemplarSourceWidth: body.exemplarSourceWidth,
        exemplarSourceHeight: body.exemplarSourceHeight,
        // NEW: Visual crop-based exemplars for cross-image detection
        exemplarCrops: body.exemplarCrops,
        useVisualCrops: body.useVisualCrops,
        sourceAssetId: body.sourceAssetId,
        textPrompt: body.textPrompt,
        assetIds,
      });
    } catch (enqueueError) {
      console.error('Failed to enqueue batch job:', enqueueError);
      // Mark job as failed so it doesn't stay stuck in QUEUED
      await prisma.batchJob.update({
        where: { id: batchJob.id },
        data: {
          status: 'FAILED',
          errorMessage: 'Failed to enqueue job - Redis may be unavailable',
          completedAt: new Date(),
        },
      });
      return NextResponse.json(
        { error: 'Failed to enqueue batch job. Please try again later.', success: false },
        { status: 503 }
      );
    }

    // Get queue stats for response
    const queueStats = await getQueueStats();

    return NextResponse.json({
      success: true,
      batchJobId: batchJob.id,
      totalImages: assetIds.length,
      status: 'QUEUED',
      message: `Batch job queued for processing. ${assetIds.length} images will be processed in the background.`,
      queuePosition: queueStats.waiting + 1,
      pollUrl: `/api/sam3/batch/${batchJob.id}`,
      processedSynchronously: false,
    });

  } catch (error) {
    // Log detailed error for debugging
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    const errorStack = error instanceof Error ? error.stack : undefined;
    console.error('Batch enqueue error:', {
      message: errorMessage,
      stack: errorStack,
      errorType: error?.constructor?.name,
    });

    // Return more specific error message
    let clientError = 'Failed to create batch job';
    if (errorMessage.includes('prisma') || errorMessage.includes('database')) {
      clientError = 'Database error - please try again';
    } else if (errorMessage.includes('JSON') || errorMessage.includes('parse')) {
      clientError = 'Invalid request format';
    } else if (errorMessage.includes('connect')) {
      clientError = 'Service connection error';
    }

    return NextResponse.json(
      {
        error: clientError,
        success: false,
        details: process.env.NODE_ENV === 'development' ? errorMessage : undefined,
      },
      { status: 500 }
    );
  }
}

// GET: List batch jobs for a project
export async function GET(request: NextRequest): Promise<NextResponse> {
  const { searchParams } = new URL(request.url);
  const projectId = searchParams.get('projectId');

  if (!projectId) {
    return NextResponse.json(
      { error: 'projectId required', success: false },
      { status: 400 }
    );
  }

  // Validate projectId format
  if (!/^c[a-z0-9]{24,}$/i.test(projectId)) {
    return NextResponse.json(
      { error: 'Invalid project ID format', success: false },
      { status: 400 }
    );
  }

  // Check project access
  const projectAccess = await checkProjectAccess(projectId);
  if (!projectAccess.authenticated) {
    return NextResponse.json(
      { error: 'Authentication required', success: false },
      { status: 401 }
    );
  }
  if (!projectAccess.hasAccess) {
    return NextResponse.json(
      { error: projectAccess.error || 'Access denied', success: false },
      { status: 403 }
    );
  }

  try {
    const batchJobs = await prisma.batchJob.findMany({
      where: { projectId },
      orderBy: { createdAt: 'desc' },
      include: {
        _count: {
          select: { pendingAnnotations: true }
        }
      },
      take: 50,
    });

    // Get queue stats
    let queueStats = null;
    try {
      queueStats = await getQueueStats();
    } catch {
      // Queue might not be available
    }

    return NextResponse.json({
      success: true,
      batchJobs,
      queueStats,
    });
  } catch (error) {
    console.error('Failed to list batch jobs:', error);
    return NextResponse.json(
      { error: 'Failed to list batch jobs', success: false },
      { status: 500 }
    );
  }
}
