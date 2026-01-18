import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/db';
import { getAuthenticatedUser, checkProjectAccess } from '@/lib/auth/api-auth';
import { enqueueYoloInferenceJob } from '@/lib/queue/yolo-inference-queue';

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
      reviewSessionId,
      assetIds,
      modelName,
      confidence = 0.5,
    } = body;

    if (!modelName || typeof modelName !== 'string') {
      return NextResponse.json({ error: 'modelName is required' }, { status: 400 });
    }

    let resolvedProjectId = projectId as string | undefined;
    let resolvedAssetIds: string[] = [];
    let teamId: string | undefined;

    if (reviewSessionId) {
      const session = await prisma.reviewSession.findUnique({
        where: { id: reviewSessionId },
        select: { id: true, projectId: true, assetIds: true, teamId: true },
      });

      if (!session) {
        return NextResponse.json({ error: 'Review session not found' }, { status: 404 });
      }

      const membership = await prisma.teamMember.findFirst({
        where: { teamId: session.teamId, userId: auth.userId },
        select: { id: true },
      });

      if (!membership) {
        return NextResponse.json({ error: 'Access denied' }, { status: 403 });
      }

      resolvedProjectId = session.projectId;
      teamId = session.teamId;
      resolvedAssetIds = toStringArray(session.assetIds);
    } else {
      if (!resolvedProjectId) {
        return NextResponse.json({ error: 'projectId is required' }, { status: 400 });
      }

      const access = await checkProjectAccess(resolvedProjectId);
      if (!access.hasAccess || !access.teamId) {
        return NextResponse.json(
          { error: access.error || 'Access denied' },
          { status: 403 }
        );
      }
      teamId = access.teamId;

      const requestedAssetIds = toStringArray(assetIds);
      if (requestedAssetIds.length > 0) {
        const assets = await prisma.asset.findMany({
          where: {
            id: { in: requestedAssetIds },
            projectId: resolvedProjectId,
          },
          select: { id: true },
        });
        if (assets.length !== requestedAssetIds.length) {
          return NextResponse.json(
            { error: 'One or more assetIds do not belong to this project' },
            { status: 400 }
          );
        }
        resolvedAssetIds = assets.map((asset) => asset.id);
      } else {
        const assets = await prisma.asset.findMany({
          where: { projectId: resolvedProjectId },
          select: { id: true },
        });
        resolvedAssetIds = assets.map((asset) => asset.id);
      }
    }

    if (!resolvedProjectId || !teamId) {
      return NextResponse.json({ error: 'Unable to resolve project' }, { status: 400 });
    }

    if (resolvedAssetIds.length === 0) {
      return NextResponse.json({ error: 'No assets available for inference' }, { status: 400 });
    }

    const job = await prisma.yOLOInferenceJob.create({
      data: {
        teamId,
        createdById: auth.userId,
        projectId: resolvedProjectId,
        reviewSessionId: reviewSessionId || null,
        assetIds: reviewSessionId ? null : resolvedAssetIds,
        modelName,
        confidence: typeof confidence === 'number' ? confidence : 0.5,
        totalImages: resolvedAssetIds.length,
        status: 'QUEUED',
      },
    });

    await enqueueYoloInferenceJob(job.id);

    return NextResponse.json({
      jobId: job.id,
      status: job.status.toLowerCase(),
      totalImages: job.totalImages,
    });
  } catch (error) {
    console.error('Error starting YOLO inference:', error);
    return NextResponse.json(
      { error: 'Failed to start YOLO inference' },
      { status: 500 }
    );
  }
}
