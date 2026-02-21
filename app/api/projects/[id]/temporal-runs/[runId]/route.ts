import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/db';
import { checkProjectAccess, getAuthenticatedUser } from '@/lib/auth/api-auth';
import { isTemporalInsightsEnabled } from '@/lib/utils/feature-flags';

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string; runId: string }> }
) {
  try {
    const auth = await getAuthenticatedUser();
    if (!auth.authenticated || !auth.userId) {
      return NextResponse.json({ error: auth.error || 'Unauthorized' }, { status: 401 });
    }

    const { id: projectId, runId } = await params;
    const access = await checkProjectAccess(projectId);
    if (!access.hasAccess || !access.teamId) {
      return NextResponse.json({ error: access.error || 'Access denied' }, { status: 403 });
    }

    const project = await prisma.project.findUnique({
      where: { id: projectId },
      select: { features: true },
    });
    if (!project) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 });
    }
    if (!isTemporalInsightsEnabled(project.features)) {
      return NextResponse.json({ error: 'Feature not enabled' }, { status: 403 });
    }

    const run = await prisma.temporalComparisonRun.findFirst({
      where: {
        id: runId,
        projectId,
        teamId: access.teamId,
      },
      include: {
        baselineSurvey: {
          select: { id: true, name: true, startedAt: true, endedAt: true, assetCount: true },
        },
        comparisonSurvey: {
          select: { id: true, name: true, startedAt: true, endedAt: true, assetCount: true },
        },
        _count: {
          select: {
            changes: true,
            hotspots: true,
          },
        },
      },
    });

    if (!run) {
      return NextResponse.json({ error: 'Temporal run not found' }, { status: 404 });
    }

    return NextResponse.json({
      id: run.id,
      status: run.status,
      progress: run.progress,
      errorMessage: run.errorMessage,
      summary: run.summary,
      baselineSurvey: run.baselineSurvey,
      comparisonSurvey: run.comparisonSurvey,
      changeCount: run._count.changes,
      hotspotCount: run._count.hotspots,
      startedAt: run.startedAt,
      completedAt: run.completedAt,
      createdAt: run.createdAt,
      updatedAt: run.updatedAt,
    });
  } catch (error) {
    console.error('Failed to fetch temporal run:', error);
    return NextResponse.json({ error: 'Failed to fetch temporal run' }, { status: 500 });
  }
}

