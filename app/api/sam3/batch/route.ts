/**
 * SAM3 Batch Processing API Route
 *
 * Processes multiple images using box exemplars for few-shot detection.
 * Creates PendingAnnotation records for review before acceptance.
 *
 * Security:
 * - Rate limiting per IP
 * - SSRF protection with URL allowlist
 * - Image size limits
 * - Content-type validation
 * - Project existence validation
 *
 * NOTE: For production with large batches (>10 images), this should use
 * BullMQ background jobs. Current implementation processes synchronously
 * with limits to prevent timeout.
 */
import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';

const ROBOFLOW_API_KEY = process.env.ROBOFLOW_API_KEY;
const SAM3_API_URL = 'https://serverless.roboflow.com/sam3/concept_segment';

// Rate limiting (per-instance, see predict/route.ts for scaling notes)
const rateLimitMap = new Map<string, { count: number; resetTime: number }>();
const RATE_LIMIT_WINDOW_MS = 60000; // 1 minute
const RATE_LIMIT_MAX_REQUESTS = 5; // 5 batch jobs per minute (more restrictive)

// Processing limits to prevent timeout
const MAX_IMAGES_SYNC = 10; // Max images to process synchronously
const MAX_IMAGE_SIZE = 10 * 1024 * 1024; // 10MB per image

// SSRF protection - same patterns as predict endpoint
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
  exemplars: BoxExemplar[];
  assetIds?: string[];
  textPrompt?: string;
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
    if (!ROBOFLOW_API_KEY) {
      return NextResponse.json(
        { error: 'SAM3 service not configured', success: false },
        { status: 503 }
      );
    }

    const body: BatchRequest = await request.json();

    // Validate required fields
    if (!body.projectId || !body.weedType || !body.exemplars?.length) {
      return NextResponse.json(
        { error: 'Missing required fields', success: false },
        { status: 400 }
      );
    }

    // Validate projectId format (CUID)
    if (!/^c[a-z0-9]{24,}$/i.test(body.projectId)) {
      return NextResponse.json(
        { error: 'Invalid project ID format', success: false },
        { status: 400 }
      );
    }

    // Validate exemplars (max 10, valid coordinates)
    if (body.exemplars.length > 10) {
      return NextResponse.json(
        { error: 'Maximum 10 exemplars allowed', success: false },
        { status: 400 }
      );
    }

    for (const exemplar of body.exemplars) {
      if (typeof exemplar.x1 !== 'number' || typeof exemplar.y1 !== 'number' ||
          typeof exemplar.x2 !== 'number' || typeof exemplar.y2 !== 'number' ||
          exemplar.x1 < 0 || exemplar.y1 < 0 || exemplar.x2 < 0 || exemplar.y2 < 0 ||
          exemplar.x1 > 10000 || exemplar.y1 > 10000 || exemplar.x2 > 10000 || exemplar.y2 > 10000) {
        return NextResponse.json(
          { error: 'Invalid exemplar coordinates', success: false },
          { status: 400 }
        );
      }
    }

    // Verify project exists
    const project = await prisma.project.findUnique({
      where: { id: body.projectId },
      select: { id: true },
    });

    if (!project) {
      return NextResponse.json(
        { error: 'Project not found', success: false },
        { status: 404 }
      );
    }

    // Get target assets (limited to MAX_IMAGES_SYNC for sync processing)
    let assets;
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

      assets = await prisma.asset.findMany({
        where: {
          id: { in: body.assetIds.slice(0, MAX_IMAGES_SYNC) },
          projectId: body.projectId,
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
    } else {
      assets = await prisma.asset.findMany({
        where: { projectId: body.projectId },
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
        take: MAX_IMAGES_SYNC,
      });
    }

    if (assets.length === 0) {
      return NextResponse.json(
        { error: 'No assets found', success: false },
        { status: 404 }
      );
    }

    // Create batch job
    const batchJob = await prisma.batchJob.create({
      data: {
        projectId: body.projectId,
        weedType: body.weedType,
        exemplars: body.exemplars,
        textPrompt: body.textPrompt?.substring(0, 100) || body.weedType.replace('Suspected ', ''),
        totalImages: assets.length,
        status: 'PROCESSING',
        startedAt: new Date(),
      },
    });

    // Process images (synchronous with limits)
    // TODO: For >10 images, use BullMQ background job queue
    const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
    let processedCount = 0;
    let totalDetections = 0;
    const errors: string[] = [];

    for (const asset of assets) {
      try {
        // Build and validate image URL
        let imageUrl: string;

        if (asset.storageType === 'S3' && asset.s3Key && asset.s3Bucket) {
          // Internal signed URL request (trusted)
          const signedUrlResponse = await fetch(`${baseUrl}/api/assets/${asset.id}/signed-url`, {
            headers: { 'X-Internal-Request': 'true' }
          });
          if (!signedUrlResponse.ok) {
            errors.push(`Failed to get signed URL for asset`);
            continue;
          }
          const signedUrlData = await signedUrlResponse.json();
          imageUrl = signedUrlData.url;

          // Validate signed URL domain
          if (!isUrlAllowed(imageUrl)) {
            errors.push(`Invalid signed URL domain`);
            continue;
          }
        } else if (asset.storageUrl) {
          // Validate external URL
          if (!asset.storageUrl.startsWith('/') && !isUrlAllowed(asset.storageUrl)) {
            errors.push(`Invalid storage URL`);
            continue;
          }
          imageUrl = asset.storageUrl.startsWith('/') ? `${baseUrl}${asset.storageUrl}` : asset.storageUrl;
        } else if (asset.filePath) {
          // Local file path - construct safe URL
          const urlPath = asset.filePath.replace(/^public\//, '/');
          if (urlPath.includes('..') || !urlPath.startsWith('/')) {
            errors.push(`Invalid file path`);
            continue;
          }
          imageUrl = `${baseUrl}${urlPath}`;
        } else {
          errors.push(`No image URL available`);
          continue;
        }

        // Fetch image with timeout
        const imageResponse = await fetch(imageUrl, {
          signal: AbortSignal.timeout(30000),
        });

        if (!imageResponse.ok) {
          errors.push(`Failed to fetch image`);
          continue;
        }

        // Validate content type
        const contentType = imageResponse.headers.get('content-type') || '';
        if (!contentType.startsWith('image/')) {
          errors.push(`Invalid content type`);
          continue;
        }

        // Check content length before downloading
        const contentLength = imageResponse.headers.get('content-length');
        if (contentLength && parseInt(contentLength) > MAX_IMAGE_SIZE) {
          errors.push(`Image too large`);
          continue;
        }

        const imageBuffer = await imageResponse.arrayBuffer();

        // Validate actual size
        if (imageBuffer.byteLength > MAX_IMAGE_SIZE) {
          errors.push(`Image too large`);
          continue;
        }

        const imageBase64 = Buffer.from(imageBuffer).toString('base64');

        // Build prompts
        const prompts = [];

        if (body.textPrompt) {
          const sanitizedPrompt = body.textPrompt.trim().substring(0, 100).replace(/[^\w\s-]/g, '');
          prompts.push({ type: 'text', data: sanitizedPrompt });
        }

        for (const box of body.exemplars.slice(0, 10)) {
          prompts.push({
            type: 'box',
            data: {
              x: Math.max(0, Math.round(box.x1)),
              y: Math.max(0, Math.round(box.y1)),
              width: Math.max(1, Math.round(box.x2 - box.x1)),
              height: Math.max(1, Math.round(box.y2 - box.y1)),
            }
          });
        }

        // Call SAM3 API
        const sam3Response = await fetch(SAM3_API_URL, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${ROBOFLOW_API_KEY}`,
          },
          body: JSON.stringify({
            image: { type: 'base64', value: imageBase64 },
            prompts,
          }),
          signal: AbortSignal.timeout(120000),
        });

        if (!sam3Response.ok) {
          errors.push(`SAM3 API error: ${sam3Response.status}`);
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
                    batchJobId: batchJob.id,
                    assetId: asset.id,
                    weedType: body.weedType,
                    confidence: pred.confidence ?? 0.9,
                    polygon: polygon,
                    bbox: bbox,
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
          where: { id: batchJob.id },
          data: {
            processedImages: processedCount,
            detectionsFound: totalDetections,
          },
        });

      } catch (err) {
        errors.push(`Processing error: ${err instanceof Error ? err.message : 'Unknown'}`);
      }
    }

    // Mark job complete
    const finalStatus = errors.length > 0 && processedCount === 0 ? 'FAILED' : 'COMPLETED';
    await prisma.batchJob.update({
      where: { id: batchJob.id },
      data: {
        status: finalStatus,
        processedImages: processedCount,
        detectionsFound: totalDetections,
        completedAt: new Date(),
        errorMessage: errors.length > 0 ? errors.slice(0, 5).join('; ') : null,
      },
    });

    return NextResponse.json({
      success: true,
      batchJobId: batchJob.id,
      totalImages: assets.length,
      processedImages: processedCount,
      detectionsFound: totalDetections,
      limitNote: assets.length >= MAX_IMAGES_SYNC
        ? `Processing limited to ${MAX_IMAGES_SYNC} images. For larger batches, use background job queue.`
        : undefined,
      errors: errors.length > 0 ? errors.slice(0, 5) : undefined,
    });

  } catch (error) {
    console.error('Batch processing error:', error instanceof Error ? error.message : 'Unknown');
    return NextResponse.json(
      { error: 'Batch processing failed', success: false },
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

  try {
    const batchJobs = await prisma.batchJob.findMany({
      where: { projectId },
      orderBy: { createdAt: 'desc' },
      include: {
        _count: {
          select: { pendingAnnotations: true }
        }
      },
      take: 50, // Limit results
    });

    return NextResponse.json({
      success: true,
      batchJobs,
    });
  } catch (error) {
    console.error('Failed to list batch jobs:', error);
    return NextResponse.json(
      { error: 'Failed to list batch jobs', success: false },
      { status: 500 }
    );
  }
}
