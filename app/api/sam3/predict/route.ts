/**
 * SAM3 Prediction API Route - AWS EC2 + Roboflow Fallback
 *
 * Uses AWS EC2 SAM3 instance as primary backend, with automatic
 * fallback to Roboflow's serverless API when AWS is unavailable.
 *
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
import { sam3Orchestrator } from '@/lib/services/sam3-orchestrator';

// Rate limiting (simple in-memory, resets on server restart)
// NOTE: This is per-instance only. For horizontal scaling, use Redis-based
// rate limiting or an upstream limiter (nginx, AWS WAF, Cloudflare).
const rateLimitMap = new Map<string, { count: number; resetTime: number }>();
const RATE_LIMIT_WINDOW_MS = 60000; // 1 minute
const RATE_LIMIT_MAX_REQUESTS = 30; // 30 requests per minute

// Allowed URL patterns for SSRF protection
const ALLOWED_URL_PATTERNS = [
  /^https:\/\/[^/]+\.amazonaws\.com\//, // S3
  /^https:\/\/[^/]+\.cloudfront\.net\//, // CloudFront
  /^https:\/\/staticagridrone\.ndsmartdata\.com\//, // Custom CloudFront domain
  /^https:\/\/storage\.googleapis\.com\//, // GCS
  /^https:\/\/[^/]+\.blob\.core\.windows\.net\//, // Azure Blob
  /^http:\/\/localhost(:\d+)?\//, // Local development
  /^http:\/\/127\.0\.0\.1(:\d+)?\//, // Local development
];

function isUrlAllowed(url: string): boolean {
  // Allow relative URLs (will be prefixed with app URL)
  if (url.startsWith('/')) return true;

  // Check against allowed patterns
  return ALLOWED_URL_PATTERNS.some((pattern) => pattern.test(url));
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
  return (
    request.headers.get('x-forwarded-for')?.split(',')[0].trim() ||
    request.headers.get('x-real-ip') ||
    'unknown'
  );
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

export async function POST(request: NextRequest): Promise<NextResponse> {
  // Rate limiting
  const clientIp = getClientIp(request);
  const rateLimit = checkRateLimit(clientIp);

  if (!rateLimit.allowed) {
    return NextResponse.json(
      { error: 'Too many requests', success: false },
      {
        status: 429,
        headers: { 'Retry-After': String(rateLimit.retryAfter) },
      }
    );
  }

  try {
    // Check if any SAM3 backend is available
    const status = await sam3Orchestrator.getStatus();
    if (status.preferredBackend === 'none') {
      return NextResponse.json({ error: 'SAM3 service not configured', success: false }, { status: 503 });
    }

    const body: PredictRequest = await request.json();

    // Validate request
    if (!body.assetId || typeof body.assetId !== 'string') {
      return NextResponse.json({ error: 'Invalid request', success: false }, { status: 400 });
    }

    // Validate assetId format (should be cuid)
    if (!/^c[a-z0-9]{24,}$/i.test(body.assetId)) {
      return NextResponse.json({ error: 'Invalid asset ID format', success: false }, { status: 400 });
    }

    const hasPoints = body.points && Array.isArray(body.points) && body.points.length > 0;
    const hasBoxes = body.boxes && Array.isArray(body.boxes) && body.boxes.length > 0;
    const hasTextPrompt =
      body.textPrompt && typeof body.textPrompt === 'string' && body.textPrompt.trim().length > 0;

    if (!hasPoints && !hasBoxes && !hasTextPrompt) {
      return NextResponse.json({ error: 'At least one prompt required', success: false }, { status: 400 });
    }

    // Validate point values
    if (hasPoints) {
      for (const point of body.points!) {
        if (
          typeof point.x !== 'number' ||
          typeof point.y !== 'number' ||
          point.x < 0 ||
          point.y < 0 ||
          point.x > 10000 ||
          point.y > 10000
        ) {
          return NextResponse.json({ error: 'Invalid point coordinates', success: false }, { status: 400 });
        }
      }
    }

    // Validate box values
    if (hasBoxes) {
      for (const box of body.boxes!) {
        if (
          typeof box.x1 !== 'number' ||
          typeof box.y1 !== 'number' ||
          typeof box.x2 !== 'number' ||
          typeof box.y2 !== 'number' ||
          box.x1 < 0 ||
          box.y1 < 0 ||
          box.x2 < 0 ||
          box.y2 < 0
        ) {
          return NextResponse.json({ error: 'Invalid box coordinates', success: false }, { status: 400 });
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
      return NextResponse.json({ error: 'Asset not found', success: false }, { status: 404 });
    }

    // Build image URL with SSRF protection
    let imageUrl: string;
    const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';

    if (asset.storageType === 'S3' && asset.s3Key && asset.s3Bucket) {
      // Use internal API to get signed URL (trusted path)
      const signedUrlResponse = await fetch(`${baseUrl}/api/assets/${asset.id}/signed-url`, {
        headers: { 'X-Internal-Request': 'true' },
      });

      if (!signedUrlResponse.ok) {
        return NextResponse.json({ error: 'Failed to access image', success: false }, { status: 500 });
      }

      const signedUrlData = await signedUrlResponse.json();
      imageUrl = signedUrlData.url;

      // Validate signed URL is from allowed S3 domain
      if (!isUrlAllowed(imageUrl)) {
        console.error('Signed URL not from allowed domain:', imageUrl.substring(0, 50));
        return NextResponse.json({ error: 'Invalid image source', success: false }, { status: 400 });
      }
    } else if (asset.storageUrl) {
      // Validate storage URL
      if (!isUrlAllowed(asset.storageUrl)) {
        console.error('Storage URL not allowed:', asset.storageUrl.substring(0, 50));
        return NextResponse.json({ error: 'Invalid image source', success: false }, { status: 400 });
      }

      imageUrl = asset.storageUrl;
      if (imageUrl.startsWith('/')) {
        imageUrl = `${baseUrl}${imageUrl}`;
      }
    } else if (asset.filePath) {
      // Local file path - construct safe URL
      const urlPath = asset.filePath.replace(/^public\//, '/');
      if (urlPath.includes('..') || !urlPath.startsWith('/')) {
        return NextResponse.json({ error: 'Invalid image path', success: false }, { status: 400 });
      }
      imageUrl = `${baseUrl}${urlPath}`;
    } else {
      return NextResponse.json({ error: 'Image not available', success: false }, { status: 400 });
    }

    // Fetch image and convert to buffer
    const imageResponse = await fetch(imageUrl, {
      signal: AbortSignal.timeout(30000), // 30 second timeout
    });

    if (!imageResponse.ok) {
      return NextResponse.json({ error: 'Failed to load image', success: false }, { status: 500 });
    }

    // Validate content type
    const contentType = imageResponse.headers.get('content-type') || '';
    if (!contentType.startsWith('image/')) {
      return NextResponse.json({ error: 'Invalid image format', success: false }, { status: 400 });
    }

    const imageArrayBuffer = await imageResponse.arrayBuffer();

    // Limit image size (10MB max)
    if (imageArrayBuffer.byteLength > 10 * 1024 * 1024) {
      return NextResponse.json({ error: 'Image too large', success: false }, { status: 400 });
    }

    const imageBuffer = Buffer.from(imageArrayBuffer);

    // Sanitize text prompt if provided
    const sanitizedPrompt = hasTextPrompt
      ? body.textPrompt!.trim().substring(0, 100).replace(/[^\w\s-]/g, '')
      : undefined;

    // Call orchestrator for prediction (handles AWS/Roboflow fallback)
    const result = await sam3Orchestrator.predict({
      imageBuffer,
      boxes: hasBoxes ? body.boxes!.slice(0, 10) : undefined, // Max 10 boxes
      points: hasPoints ? body.points!.slice(0, 20) : undefined, // Max 20 points
      textPrompt: sanitizedPrompt,
      className: sanitizedPrompt,
    });

    // Return response
    if (hasPoints && !hasBoxes && !hasTextPrompt && result.detections.length > 0) {
      // Single point prediction - return best result
      const best = result.detections[0];
      return NextResponse.json({
        success: true,
        score: best.score,
        polygon: best.polygon,
        bbox: best.bbox,
        processingTimeMs: result.processingTimeMs,
        backend: result.backend,
        startupMessage: result.startupMessage,
      });
    }

    return NextResponse.json({
      success: result.success,
      detections: result.detections,
      count: result.count,
      processingTimeMs: result.processingTimeMs,
      polygon: result.detections[0]?.polygon || null,
      bbox: result.detections[0]?.bbox || null,
      score: result.detections[0]?.score || 0,
      backend: result.backend,
      startupMessage: result.startupMessage,
      error: result.error,
    });
  } catch (error) {
    // Log but don't expose error details
    console.error('SAM3 predict error:', error instanceof Error ? error.message : 'Unknown');

    return NextResponse.json({ error: 'Processing failed', success: false }, { status: 500 });
  }
}
