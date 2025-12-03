/**
 * SAM3 Batch Processing API Route
 *
 * Enqueues batch detection jobs for background processing.
 * Jobs are processed by the BullMQ worker (workers/batch-worker.ts).
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
import { prisma } from '@/lib/db';
import { checkProjectAccess } from '@/lib/auth/api-auth';
import { enqueueBatchJob, getQueueStats } from '@/lib/queue/batch-queue';
import { checkRedisConnection } from '@/lib/queue/redis';

// Rate limiting (per-instance; use Redis for production multi-instance)
const rateLimitMap = new Map<string, { count: number; resetTime: number }>();
const RATE_LIMIT_WINDOW_MS = 60000; // 1 minute
const RATE_LIMIT_MAX_REQUESTS = 10; // 10 batch jobs per minute

// Maximum images per batch (reasonable limit for queue)
const MAX_IMAGES_PER_BATCH = 500;

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
    // Check if Redis is available
    const redisAvailable = await checkRedisConnection();
    if (!redisAvailable) {
      return NextResponse.json(
        { error: 'Queue service unavailable. Please ensure Redis is running.', success: false },
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

    // Authentication and project access check
    const projectAccess = await checkProjectAccess(body.projectId);
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

    // Get target asset IDs
    let assetIds: string[];
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

    if (assetIds.length === 0) {
      return NextResponse.json(
        { error: 'No assets found', success: false },
        { status: 404 }
      );
    }

    // Create batch job record
    const batchJob = await prisma.batchJob.create({
      data: {
        projectId: body.projectId,
        weedType: body.weedType,
        exemplars: body.exemplars,
        textPrompt: body.textPrompt?.substring(0, 100) || body.weedType.replace('Suspected ', ''),
        totalImages: assetIds.length,
        status: 'QUEUED',
      },
    });

    // Enqueue job for background processing
    // If enqueue fails, mark the job as FAILED to avoid stuck jobs
    try {
      await enqueueBatchJob({
        batchJobId: batchJob.id,
        projectId: body.projectId,
        weedType: body.weedType,
        exemplars: body.exemplars,
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
    });

  } catch (error) {
    console.error('Batch enqueue error:', error instanceof Error ? error.message : 'Unknown');
    return NextResponse.json(
      { error: 'Failed to create batch job', success: false },
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
