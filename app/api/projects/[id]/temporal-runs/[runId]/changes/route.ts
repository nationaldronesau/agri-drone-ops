import { NextRequest, NextResponse } from 'next/server';
import { Prisma, TemporalChangeType } from '@prisma/client';
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
    const page = Math.max(1, Number(searchParams.get('page') || '1'));
    const limit = Math.max(1, Math.min(200, Number(searchParams.get('limit') || '100')));
    const changeType = searchParams.get('changeType');
    const species = searchParams.get('species');
    const minRisk = Number(searchParams.get('minRisk') || '0');

    const where: Prisma.TemporalChangeItemWhereInput = {
      runId,
    };
    if (changeType && changeType in TemporalChangeType) {
      where.changeType = changeType as TemporalChangeType;
    }
    if (species) {
      where.species = species;
    }
    if (Number.isFinite(minRisk) && minRisk > 0) {
      where.riskScore = { gte: minRisk };
    }

    const [items, total] = await Promise.all([
      prisma.temporalChangeItem.findMany({
        where,
        orderBy: [{ riskScore: 'desc' }, { createdAt: 'desc' }],
        take: limit,
        skip: (page - 1) * limit,
      }),
      prisma.temporalChangeItem.count({ where }),
    ]);

    const totalPages = Math.ceil(total / limit);

    return NextResponse.json({
      items,
      pagination: {
        page,
        limit,
        total,
        totalPages,
        hasMore: page < totalPages,
      },
    });
  } catch (error) {
    console.error('Failed to fetch temporal changes:', error);
    return NextResponse.json({ error: 'Failed to fetch temporal changes' }, { status: 500 });
  }
}

