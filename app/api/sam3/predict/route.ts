/**
 * SAM3 Prediction API Route - Roboflow concept_segment Integration
 *
 * Uses Roboflow's serverless SAM3 API for few-shot object detection.
 * Supports both point prompts (click-to-segment) and box exemplars (find-all-similar).
 *
 * Security:
 * - Uses Authorization header (not query param) for API key
 * - Basic rate limiting per IP
 * - SSRF protection for image URL fetching
 * - Sanitized error responses
 */
import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';

// Roboflow SAM3 API endpoint
const SAM3_API_URL = 'https://serverless.roboflow.com/sam3/concept_segment';
const ROBOFLOW_API_KEY = process.env.ROBOFLOW_API_KEY;

// Rate limiting (simple in-memory, resets on server restart)
const rateLimitMap = new Map<string, { count: number; resetTime: number }>();
const RATE_LIMIT_WINDOW_MS = 60000; // 1 minute
const RATE_LIMIT_MAX_REQUESTS = 30; // 30 requests per minute

// Allowed URL patterns for SSRF protection
const ALLOWED_URL_PATTERNS = [
  /^https:\/\/[^/]+\.amazonaws\.com\//,  // S3
  /^https:\/\/storage\.googleapis\.com\//,  // GCS
  /^https:\/\/[^/]+\.blob\.core\.windows\.net\//,  // Azure Blob
  /^http:\/\/localhost(:\d+)?\//,  // Local development
  /^http:\/\/127\.0\.0\.1(:\d+)?\//,  // Local development
];

function isUrlAllowed(url: string): boolean {
  // Allow relative URLs (will be prefixed with app URL)
  if (url.startsWith('/')) return true;

  // Check against allowed patterns
  return ALLOWED_URL_PATTERNS.some(pattern => pattern.test(url));
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

function getClientIp(request: NextRequest): string {
  return request.headers.get('x-forwarded-for')?.split(',')[0].trim()
    || request.headers.get('x-real-ip')
    || 'unknown';
}

interface ClickPoint {
  x: number;
  y: number;
  label: 0 | 1;
}

interface BoxExemplar {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

interface PredictRequest {
  assetId: string;
  points?: ClickPoint[];
  boxes?: BoxExemplar[];
  textPrompt?: string;
}

interface RoboflowPrompt {
  type: 'text' | 'box' | 'point';
  data: string | { x: number; y: number; width: number; height: number } | { x: number; y: number; positive: boolean };
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  // Rate limiting
  const clientIp = getClientIp(request);
  const rateLimit = checkRateLimit(clientIp);

  if (!rateLimit.allowed) {
    return NextResponse.json(
      { error: 'Too many requests', success: false },
      {
        status: 429,
        headers: { 'Retry-After': String(rateLimit.retryAfter) }
      }
    );
  }

  try {
    // Validate configuration
    if (!ROBOFLOW_API_KEY) {
      return NextResponse.json(
        { error: 'SAM3 service not configured', success: false },
        { status: 503 }
      );
    }

    const body: PredictRequest = await request.json();

    // Validate request
    if (!body.assetId || typeof body.assetId !== 'string') {
      return NextResponse.json(
        { error: 'Invalid request', success: false },
        { status: 400 }
      );
    }

    // Validate assetId format (should be cuid)
    if (!/^c[a-z0-9]{24,}$/i.test(body.assetId)) {
      return NextResponse.json(
        { error: 'Invalid asset ID format', success: false },
        { status: 400 }
      );
    }

    const hasPoints = body.points && Array.isArray(body.points) && body.points.length > 0;
    const hasBoxes = body.boxes && Array.isArray(body.boxes) && body.boxes.length > 0;
    const hasTextPrompt = body.textPrompt && typeof body.textPrompt === 'string' && body.textPrompt.trim().length > 0;

    if (!hasPoints && !hasBoxes && !hasTextPrompt) {
      return NextResponse.json(
        { error: 'At least one prompt required', success: false },
        { status: 400 }
      );
    }

    // Validate point values
    if (hasPoints) {
      for (const point of body.points!) {
        if (typeof point.x !== 'number' || typeof point.y !== 'number' ||
            point.x < 0 || point.y < 0 || point.x > 10000 || point.y > 10000) {
          return NextResponse.json(
            { error: 'Invalid point coordinates', success: false },
            { status: 400 }
          );
        }
      }
    }

    // Get asset from database
    const asset = await prisma.asset.findUnique({
      where: { id: body.assetId },
      select: {
        id: true,
        s3Key: true,
        s3Bucket: true,
        filePath: true,
        storageType: true,
        storageUrl: true,
        imageWidth: true,
        imageHeight: true,
      },
    });

    if (!asset) {
      return NextResponse.json(
        { error: 'Asset not found', success: false },
        { status: 404 }
      );
    }

    // Build image URL with SSRF protection
    let imageUrl: string;
    const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';

    if (asset.storageType === 'S3' && asset.s3Key && asset.s3Bucket) {
      // Use internal API to get signed URL (trusted path)
      const signedUrlResponse = await fetch(`${baseUrl}/api/assets/${asset.id}/signed-url`, {
        headers: { 'X-Internal-Request': 'true' }
      });

      if (!signedUrlResponse.ok) {
        return NextResponse.json(
          { error: 'Failed to access image', success: false },
          { status: 500 }
        );
      }

      const signedUrlData = await signedUrlResponse.json();
      imageUrl = signedUrlData.url;

      // Validate signed URL is from allowed S3 domain
      if (!isUrlAllowed(imageUrl)) {
        console.error('Signed URL not from allowed domain:', imageUrl.substring(0, 50));
        return NextResponse.json(
          { error: 'Invalid image source', success: false },
          { status: 400 }
        );
      }
    } else if (asset.storageUrl) {
      // Validate storage URL
      if (!isUrlAllowed(asset.storageUrl)) {
        console.error('Storage URL not allowed:', asset.storageUrl.substring(0, 50));
        return NextResponse.json(
          { error: 'Invalid image source', success: false },
          { status: 400 }
        );
      }

      imageUrl = asset.storageUrl;
      if (imageUrl.startsWith('/')) {
        imageUrl = `${baseUrl}${imageUrl}`;
      }
    } else if (asset.filePath) {
      // Local file path - construct safe URL
      const urlPath = asset.filePath.replace(/^public\//, '/');
      if (urlPath.includes('..') || !urlPath.startsWith('/')) {
        return NextResponse.json(
          { error: 'Invalid image path', success: false },
          { status: 400 }
        );
      }
      imageUrl = `${baseUrl}${urlPath}`;
    } else {
      return NextResponse.json(
        { error: 'Image not available', success: false },
        { status: 400 }
      );
    }

    // Fetch image and convert to base64
    const imageResponse = await fetch(imageUrl, {
      signal: AbortSignal.timeout(30000), // 30 second timeout
    });

    if (!imageResponse.ok) {
      return NextResponse.json(
        { error: 'Failed to load image', success: false },
        { status: 500 }
      );
    }

    // Validate content type
    const contentType = imageResponse.headers.get('content-type') || '';
    if (!contentType.startsWith('image/')) {
      return NextResponse.json(
        { error: 'Invalid image format', success: false },
        { status: 400 }
      );
    }

    const imageBuffer = await imageResponse.arrayBuffer();

    // Limit image size (10MB max)
    if (imageBuffer.byteLength > 10 * 1024 * 1024) {
      return NextResponse.json(
        { error: 'Image too large', success: false },
        { status: 400 }
      );
    }

    const imageBase64 = Buffer.from(imageBuffer).toString('base64');

    // Build prompts array
    const prompts: RoboflowPrompt[] = [];

    if (hasTextPrompt) {
      // Sanitize text prompt (max 100 chars, alphanumeric + spaces)
      const sanitizedPrompt = body.textPrompt!.trim().substring(0, 100).replace(/[^\w\s-]/g, '');
      prompts.push({ type: 'text', data: sanitizedPrompt });
    }

    if (hasBoxes) {
      for (const box of body.boxes!.slice(0, 10)) { // Max 10 boxes
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
    }

    if (hasPoints) {
      for (const point of body.points!.slice(0, 20)) { // Max 20 points
        prompts.push({
          type: 'point',
          data: {
            x: Math.round(point.x),
            y: Math.round(point.y),
            positive: point.label === 1,
          }
        });
      }
    }

    const startTime = Date.now();

    // Call Roboflow SAM3 API with Authorization header
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
      signal: AbortSignal.timeout(120000), // 2 minute timeout for large images
    });

    const processingTimeMs = Date.now() - startTime;

    if (!sam3Response.ok) {
      // Don't expose detailed error to client
      console.error('SAM3 API error:', sam3Response.status);
      return NextResponse.json(
        { error: 'Segmentation failed', success: false },
        { status: 502 }
      );
    }

    const result = await sam3Response.json();

    // Parse results
    const detections: Array<{
      polygon: [number, number][];
      bbox: [number, number, number, number];
      score: number;
    }> = [];

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
            const bbox: [number, number, number, number] = [
              Math.min(...xs),
              Math.min(...ys),
              Math.max(...xs),
              Math.max(...ys),
            ];

            detections.push({
              polygon,
              bbox,
              score: pred.confidence ?? 0.9,
            });
          }
        }
      }
    }

    // Return response
    if (hasPoints && !hasBoxes && !hasTextPrompt && detections.length > 0) {
      const best = detections[0];
      return NextResponse.json({
        success: true,
        score: best.score,
        polygon: best.polygon,
        bbox: best.bbox,
        processingTimeMs,
      });
    }

    return NextResponse.json({
      success: detections.length > 0,
      detections,
      count: detections.length,
      processingTimeMs,
      polygon: detections[0]?.polygon || null,
      bbox: detections[0]?.bbox || null,
      score: detections[0]?.score || 0,
    });

  } catch (error) {
    // Log but don't expose error details
    console.error('SAM3 predict error:', error instanceof Error ? error.message : 'Unknown');

    return NextResponse.json(
      { error: 'Processing failed', success: false },
      { status: 500 }
    );
  }
}
