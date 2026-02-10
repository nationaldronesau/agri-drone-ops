import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/db';
import { getAuthenticatedUser, checkProjectAccess } from '@/lib/auth/api-auth';
import { Prisma } from '@prisma/client';

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry) => typeof entry === 'string') as string[];
}

export async function POST(request: NextRequest) {
  try {
    const auth = await getAuthenticatedUser();
    if (!auth.authenticated || !auth.userId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = await request.json();
    const {
      projectId,
      workflowType = 'custom',
      targetType = 'both',
      roboflowProjectId,
      yoloModelName,
      confidenceThreshold,
      weedTypeFilter,
      assetIds,
      inferenceJobIds,
      batchJobIds,
    } = body;

    if (!projectId || typeof projectId !== 'string') {
      return NextResponse.json({ error: 'projectId is required' }, { status: 400 });
    }

    if (typeof workflowType !== 'string' || !workflowType) {
      return NextResponse.json({ error: 'workflowType must be a non-empty string' }, { status: 400 });
    }

    if (typeof targetType !== 'string' || !targetType) {
      return NextResponse.json({ error: 'targetType must be a non-empty string' }, { status: 400 });
    }

    if (roboflowProjectId != null && typeof roboflowProjectId !== 'string') {
      return NextResponse.json({ error: 'roboflowProjectId must be a string' }, { status: 400 });
    }

    if (yoloModelName != null && typeof yoloModelName !== 'string') {
      return NextResponse.json({ error: 'yoloModelName must be a string' }, { status: 400 });
    }

    if (weedTypeFilter != null && typeof weedTypeFilter !== 'string') {
      return NextResponse.json({ error: 'weedTypeFilter must be a string' }, { status: 400 });
    }

    const projectAccess = await checkProjectAccess(projectId);
    if (!projectAccess.hasAccess || !projectAccess.teamId) {
      return NextResponse.json(
        { error: projectAccess.error || 'Access denied' },
        { status: 403 }
      );
    }

    const requestedAssetIds = toStringArray(assetIds);
    const requestedInferenceJobIds = toStringArray(inferenceJobIds);
    const requestedBatchJobIds = toStringArray(batchJobIds);
    let snapshotAssetIds: string[] = [];

    if (requestedAssetIds.length > 0) {
      const assets = await prisma.asset.findMany({
        where: {
          id: { in: requestedAssetIds },
          projectId,
        },
        select: { id: true },
      });
      const validIds = assets.map((asset) => asset.id);
      if (validIds.length !== requestedAssetIds.length) {
        return NextResponse.json(
          { error: 'One or more assetIds do not belong to this project' },
          { status: 400 }
        );
      }
      snapshotAssetIds = validIds;
    } else {
      const assetIdSet = new Set<string>();
      const hasJobFilters =
        requestedBatchJobIds.length > 0 || requestedInferenceJobIds.length > 0;

      if (requestedBatchJobIds.length > 0) {
        const batchJobs = await prisma.batchJob.findMany({
          where: { id: { in: requestedBatchJobIds }, projectId },
          select: { id: true },
        });
        if (batchJobs.length !== requestedBatchJobIds.length) {
          return NextResponse.json(
            { error: 'One or more batchJobIds do not belong to this project' },
            { status: 400 }
          );
        }

        const pendingAssets = await prisma.pendingAnnotation.findMany({
          where: { batchJobId: { in: requestedBatchJobIds } },
          select: { assetId: true },
          distinct: ['assetId'],
        });
        pendingAssets.forEach((entry) => assetIdSet.add(entry.assetId));
      }

      if (requestedInferenceJobIds.length > 0) {
        const [yoloInferenceJobs, processingJobs] = await Promise.all([
          prisma.yOLOInferenceJob.findMany({
            where: { id: { in: requestedInferenceJobIds }, projectId },
            select: {
              id: true,
              assetIds: true,
              reviewSession: { select: { assetIds: true } },
            },
          }),
          prisma.processingJob.findMany({
            where: {
              id: { in: requestedInferenceJobIds },
              projectId,
              type: 'AI_DETECTION',
            },
            select: { id: true },
          }),
        ]);

        const yoloInferenceJobIds = yoloInferenceJobs.map((job) => job.id);
        const processingJobIds = processingJobs.map((job) => job.id);
        const foundIds = new Set([...yoloInferenceJobIds, ...processingJobIds]);
        const missingIds = requestedInferenceJobIds.filter((id) => !foundIds.has(id));

        if (missingIds.length > 0) {
          return NextResponse.json(
            { error: 'One or more inferenceJobIds do not belong to this project' },
            { status: 400 }
          );
        }

        for (const job of yoloInferenceJobs) {
          const directIds = toStringArray(job.assetIds);
          const sessionIds = toStringArray(job.reviewSession?.assetIds);
          const ids = directIds.length > 0 ? directIds : sessionIds;
          ids.forEach((id) => assetIdSet.add(id));
        }

        if (assetIdSet.size === 0 && yoloInferenceJobIds.length > 0) {
          const detectionAssets = await prisma.detection.findMany({
            where: { inferenceJobId: { in: yoloInferenceJobIds } },
            select: { assetId: true },
            distinct: ['assetId'],
          });
          detectionAssets.forEach((entry) => assetIdSet.add(entry.assetId));
        }

        if (processingJobIds.length > 0) {
          const detectionAssets = await prisma.detection.findMany({
            where: { jobId: { in: processingJobIds } },
            select: { assetId: true },
            distinct: ['assetId'],
          });
          detectionAssets.forEach((entry) => assetIdSet.add(entry.assetId));
        }
      }

      if (assetIdSet.size === 0) {
        if (hasJobFilters) {
          snapshotAssetIds = [];
        } else {
          const assets = await prisma.asset.findMany({
            where: { projectId },
            select: { id: true },
          });
          snapshotAssetIds = assets.map((asset) => asset.id);
        }
      } else {
        snapshotAssetIds = Array.from(assetIdSet);
      }
    }

    const session = await prisma.reviewSession.create({
      data: {
        teamId: projectAccess.teamId,
        createdById: auth.userId,
        projectId,
        workflowType,
        targetType,
        roboflowProjectId,
        yoloModelName,
        confidenceThreshold: typeof confidenceThreshold === 'number' ? confidenceThreshold : null,
        weedTypeFilter,
        assetIds: snapshotAssetIds,
        assetCount: snapshotAssetIds.length,
        inferenceJobIds: requestedInferenceJobIds,
        batchJobIds: requestedBatchJobIds,
      },
    });

    return NextResponse.json({ session });
  } catch (error) {
    console.error('Error creating review session:', error);
    const fallbackMessage = 'Failed to create review session';

    if (error instanceof Prisma.PrismaClientKnownRequestError) {
      // Common production footgun: DB migration not applied.
      if (error.code === 'P2021') {
        const table = (error.meta as { table?: string } | undefined)?.table;
        return NextResponse.json(
          {
            error: 'Review sessions are not available. Database schema is out of date.',
            details: table
              ? `Missing table: ${table}. Run npx prisma migrate deploy.`
              : 'Missing table. Run npx prisma migrate deploy.',
            code: error.code,
          },
          { status: 503 }
        );
      }

      if (error.code === 'P2022') {
        const column = (error.meta as { column?: string } | undefined)?.column;
        return NextResponse.json(
          {
            error: fallbackMessage,
            details: column
              ? `Database column missing: ${column}. Run npx prisma migrate deploy.`
              : 'Database column missing. Run npx prisma migrate deploy.',
            code: error.code,
          },
          { status: 500 }
        );
      }

      return NextResponse.json(
        { error: fallbackMessage, details: error.message, code: error.code },
        { status: 500 }
      );
    }

    if (error instanceof Prisma.PrismaClientInitializationError) {
      return NextResponse.json(
        { error: fallbackMessage, details: error.message, code: 'PRISMA_INIT' },
        { status: 503 }
      );
    }

    if (error instanceof Error) {
      return NextResponse.json(
        { error: fallbackMessage, details: error.message },
        { status: 500 }
      );
    }

    return NextResponse.json({ error: fallbackMessage }, { status: 500 });
  }
}
