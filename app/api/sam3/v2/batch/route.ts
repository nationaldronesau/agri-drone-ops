import { NextRequest, NextResponse } from 'next/server';
import type { Prisma } from '@prisma/client';
import prisma from '@/lib/db';
import { checkProjectAccess } from '@/lib/auth/api-auth';
import {
  enqueueBatchJobV2,
  getQueueStatsV2,
  type Sam3BatchV2Mode,
} from '@/lib/queue/batch-queue-v2';
import { checkRedisConnection } from '@/lib/queue/redis';
import {
  SAM3_BATCH_V2_MAX_EXEMPLARS,
  SAM3_BATCH_V2_MAX_IMAGES,
} from '@/lib/services/sam3-batch-v2';
import { checkRateLimit, getRateLimitKey } from '@/lib/utils/security';

interface BoxExemplar {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

interface BatchV2Request {
  projectId: string;
  weedType: string;
  mode: Sam3BatchV2Mode;
  exemplars: BoxExemplar[];
  exemplarSourceWidth?: number;
  exemplarSourceHeight?: number;
  exemplarCrops?: string[];
  sourceAssetId?: string;
  assetIds?: string[];
  textPrompt?: string;
}

const PROJECT_ID_REGEX = /^c[a-z0-9]{24,}$/i;
const MODE_SET = new Set<Sam3BatchV2Mode>(['visual_crop_match', 'concept_propagation']);

function isValidBox(value: BoxExemplar) {
  const entries = [value.x1, value.y1, value.x2, value.y2];
  return entries.every((entry) => typeof entry === 'number' && Number.isFinite(entry) && entry >= 0);
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const rateLimit = checkRateLimit(getRateLimitKey(request, 'sam3-batch-v2'), {
    maxRequests: 10,
    windowMs: 60000,
  });

  if (!rateLimit.allowed) {
    return NextResponse.json(
      {
        success: false,
        error: 'Too many batch requests',
      },
      {
        status: 429,
        headers: {
          'Retry-After': String(Math.ceil((rateLimit.resetTime - Date.now()) / 1000)),
        },
      }
    );
  }

  let body: BatchV2Request;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { success: false, error: 'Invalid request body - could not parse JSON' },
      { status: 400 }
    );
  }

  if (!body.projectId || !body.weedType || !Array.isArray(body.exemplars) || body.exemplars.length === 0) {
    return NextResponse.json(
      { success: false, error: 'projectId, weedType, and exemplars are required' },
      { status: 400 }
    );
  }

  if (!PROJECT_ID_REGEX.test(body.projectId)) {
    return NextResponse.json(
      { success: false, error: 'Invalid project ID format' },
      { status: 400 }
    );
  }

  if (!MODE_SET.has(body.mode)) {
    return NextResponse.json(
      { success: false, error: 'mode must be visual_crop_match or concept_propagation' },
      { status: 400 }
    );
  }

  if (body.exemplars.length > SAM3_BATCH_V2_MAX_EXEMPLARS) {
    return NextResponse.json(
      { success: false, error: `Maximum ${SAM3_BATCH_V2_MAX_EXEMPLARS} exemplars allowed` },
      { status: 400 }
    );
  }

  if (!body.exemplars.every(isValidBox)) {
    return NextResponse.json(
      { success: false, error: 'Invalid exemplar coordinates' },
      { status: 400 }
    );
  }

  if ((body.exemplarSourceWidth ?? body.exemplarSourceHeight) != null) {
    if (
      !Number.isFinite(body.exemplarSourceWidth) ||
      !Number.isFinite(body.exemplarSourceHeight) ||
      (body.exemplarSourceWidth ?? 0) <= 0 ||
      (body.exemplarSourceHeight ?? 0) <= 0
    ) {
      return NextResponse.json(
        { success: false, error: 'exemplarSourceWidth and exemplarSourceHeight must be positive numbers' },
        { status: 400 }
      );
    }
  }

  if (body.sourceAssetId && !PROJECT_ID_REGEX.test(body.sourceAssetId)) {
    return NextResponse.json(
      { success: false, error: 'Invalid source asset ID format' },
      { status: 400 }
    );
  }

  if (Array.isArray(body.assetIds) && body.assetIds.length > SAM3_BATCH_V2_MAX_IMAGES) {
    return NextResponse.json(
      { success: false, error: `Batch limit is ${SAM3_BATCH_V2_MAX_IMAGES} assets` },
      { status: 400 }
    );
  }

  if (Array.isArray(body.assetIds) && body.assetIds.some((assetId) => !PROJECT_ID_REGEX.test(assetId))) {
    return NextResponse.json(
      { success: false, error: 'Invalid asset ID format' },
      { status: 400 }
    );
  }

  const projectAccess = await checkProjectAccess(body.projectId);
  if (!projectAccess.authenticated) {
    return NextResponse.json(
      { success: false, error: 'Authentication required' },
      { status: 401 }
    );
  }
  if (!projectAccess.hasAccess) {
    return NextResponse.json(
      { success: false, error: projectAccess.error || 'Access denied' },
      { status: 403 }
    );
  }

  const redisAvailable = await checkRedisConnection();
  if (!redisAvailable) {
    return NextResponse.json(
      {
        success: false,
        error: 'Queue unavailable, retry later',
      },
      { status: 503 }
    );
  }

  if (Array.isArray(body.assetIds) && body.assetIds.length === 0) {
    return NextResponse.json(
      { success: false, error: 'Batch requires at least one asset' },
      { status: 400 }
    );
  }

  const requestedAssets = body.assetIds?.length
    ? await prisma.asset.findMany({
        where: {
          id: { in: body.assetIds },
          projectId: body.projectId,
        },
        select: { id: true },
      })
    : await prisma.asset.findMany({
        where: { projectId: body.projectId },
        select: { id: true },
        take: SAM3_BATCH_V2_MAX_IMAGES + 1,
      });

  if (body.assetIds?.length && requestedAssets.length !== body.assetIds.length) {
    return NextResponse.json(
      { success: false, error: 'One or more assetIds do not belong to this project' },
      { status: 400 }
    );
  }

  if (requestedAssets.length === 0) {
    return NextResponse.json(
      { success: false, error: 'Batch requires at least one asset' },
      { status: 400 }
    );
  }

  if (!body.assetIds?.length && requestedAssets.length > SAM3_BATCH_V2_MAX_IMAGES) {
    return NextResponse.json(
      {
        success: false,
        error: `Batch limit is ${SAM3_BATCH_V2_MAX_IMAGES} assets`,
      },
      { status: 400 }
    );
  }

  const assetIds = requestedAssets.map((asset) => asset.id);
  const exemplarsJson = body.exemplars as unknown as Prisma.InputJsonValue;
  const emptyStageLogJson = [] as unknown as Prisma.InputJsonValue;
  const batchJob = await prisma.batchJob.create({
    data: {
      projectId: body.projectId,
      weedType: body.weedType,
      exemplars: exemplarsJson,
      textPrompt: body.textPrompt?.trim().substring(0, 100) || body.weedType,
      exemplarSourceWidth: body.exemplarSourceWidth,
      exemplarSourceHeight: body.exemplarSourceHeight,
      sourceAssetId: body.sourceAssetId,
      version: 2,
      mode: body.mode,
      stageLog: emptyStageLogJson,
      totalImages: assetIds.length,
      status: 'QUEUED',
    },
  });

  try {
    await enqueueBatchJobV2({
      batchJobId: batchJob.id,
      projectId: body.projectId,
      weedType: body.weedType,
      mode: body.mode,
      exemplars: body.exemplars,
      exemplarSourceWidth: body.exemplarSourceWidth,
      exemplarSourceHeight: body.exemplarSourceHeight,
      exemplarCrops: body.exemplarCrops,
      sourceAssetId: body.sourceAssetId,
      textPrompt: body.textPrompt,
      assetIds,
    });
  } catch (error) {
    await prisma.batchJob.update({
      where: { id: batchJob.id },
      data: {
        status: 'FAILED',
        completedAt: new Date(),
        errorMessage: error instanceof Error ? error.message : 'Failed to enqueue v2 batch job.',
      },
    });

    return NextResponse.json(
      { success: false, error: 'Failed to enqueue v2 batch job. Please retry.' },
      { status: 503 }
    );
  }

  const queueStats = await getQueueStatsV2();

  return NextResponse.json({
    success: true,
    batchJobId: batchJob.id,
    version: 2,
    mode: body.mode,
    totalImages: assetIds.length,
    status: 'QUEUED',
    queuePosition: queueStats.waiting + 1,
    pollUrl: `/api/sam3/v2/batch/${batchJob.id}`,
  });
}
