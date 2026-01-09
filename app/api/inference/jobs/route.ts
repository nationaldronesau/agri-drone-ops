/**
 * Inference Jobs API Route
 *
 * GET /api/inference/jobs - List inference jobs
 */
import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/db';
import { getAuthenticatedUser, getUserTeamIds } from '@/lib/auth/api-auth';

function parseConfig(config: unknown) {
  if (!config || typeof config !== 'object') return {};
  return config as Record<string, unknown>;
}

export async function GET(request: NextRequest) {
  try {
    const auth = await getAuthenticatedUser();
    if (!auth.authenticated || !auth.userId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const membership = await getUserTeamIds();
    if (!membership.authenticated || !membership.userId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    if (membership.teamIds.length === 0) {
      return NextResponse.json({ jobs: [] });
    }

    const { searchParams } = new URL(request.url);
    const projectId = searchParams.get('projectId');
    const limit = parseInt(searchParams.get('limit') || '20', 10);
    const offset = parseInt(searchParams.get('offset') || '0', 10);

    const where: Record<string, unknown> = {
      type: 'AI_DETECTION',
      project: {
        teamId: { in: membership.teamIds },
      },
    };
    if (projectId) {
      where.projectId = projectId;
    }

    const jobs = await prisma.processingJob.findMany({
      where,
      include: {
        project: { select: { id: true, name: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: limit,
      skip: offset,
    });

    const formatted = jobs.map((job) => ({
      ...job,
      config: parseConfig(job.config),
    }));

    return NextResponse.json({ jobs: formatted });
  } catch (error) {
    console.error('Error listing inference jobs:', error);
    return NextResponse.json(
      { error: 'Failed to list inference jobs' },
      { status: 500 }
    );
  }
}
