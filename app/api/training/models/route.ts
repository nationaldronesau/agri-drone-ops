/**
 * Training Models API Routes
 *
 * GET /api/training/models - List trained models
 */
import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/db';
import { getAuthenticatedUser, getUserTeamIds } from '@/lib/auth/api-auth';

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
      return NextResponse.json({ error: 'No team access' }, { status: 403 });
    }

    const { searchParams } = new URL(request.url);
    const teamId = searchParams.get('teamId');
    const status = searchParams.get('status');
    const limit = parseInt(searchParams.get('limit') || '20', 10);
    const offset = parseInt(searchParams.get('offset') || '0', 10);

    const teamIds = teamId ? [teamId] : membership.teamIds;
    if (teamId && !membership.teamIds.includes(teamId)) {
      return NextResponse.json({ error: 'Access denied' }, { status: 403 });
    }

    const where: Record<string, unknown> = { teamId: { in: teamIds } };
    if (status) {
      where.status = status.toUpperCase();
    }

    const [models, total] = await Promise.all([
      prisma.trainedModel.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: limit,
        skip: offset,
      }),
      prisma.trainedModel.count({ where }),
    ]);

    const formatted = models.map((model) => ({
      ...model,
      classes: JSON.parse(model.classes),
      classMetrics: model.classMetrics ? JSON.parse(model.classMetrics) : null,
    }));

    return NextResponse.json({
      models: formatted,
      total,
      limit,
      offset,
    });
  } catch (error) {
    console.error('Error listing trained models:', error);
    return NextResponse.json(
      { error: 'Failed to list trained models' },
      { status: 500 }
    );
  }
}
