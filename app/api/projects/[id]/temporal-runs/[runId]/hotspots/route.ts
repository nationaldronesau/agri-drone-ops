import { NextRequest, NextResponse } from 'next/server';
import { Prisma } from '@prisma/client';
import prisma from '@/lib/db';
import { checkProjectAccess, getAuthenticatedUser } from '@/lib/auth/api-auth';
import { isTemporalInsightsEnabled } from '@/lib/utils/feature-flags';

export async function GET(
  request: NextRequest,
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
      where: { id: runId, projectId, teamId: access.teamId },
      select: { id: true },
    });
    if (!run) {
      return NextResponse.json({ error: 'Temporal run not found' }, { status: 404 });
    }

    const searchParams = request.nextUrl.searchParams;
    const species = searchParams.get('species');
    const minPriority = Number(searchParams.get('minPriority') || '0');
    const limit = Math.max(1, Math.min(200, Number(searchParams.get('limit') || '200')));

    const where: Prisma.TemporalHotspotWhereInput = {
      runId,
    };
    if (species) {
      where.species = species;
    }
    if (Number.isFinite(minPriority) && minPriority > 0) {
      where.priorityScore = { gte: minPriority };
    }

    const hotspots = await prisma.temporalHotspot.findMany({
      where,
      orderBy: [{ priorityScore: 'desc' }, { createdAt: 'desc' }],
      take: limit,
    });

    return NextResponse.json({
      hotspots,
    });
  } catch (error) {
    console.error('Failed to fetch temporal hotspots:', error);
    return NextResponse.json({ error: 'Failed to fetch temporal hotspots' }, { status: 500 });
  }
}

