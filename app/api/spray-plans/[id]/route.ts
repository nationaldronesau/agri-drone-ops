import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/db';
import { getAuthenticatedUser, getUserTeamIds } from '@/lib/auth/api-auth';

export async function GET(_request: NextRequest, { params }: { params: { id: string } }) {
  try {
    const auth = await getAuthenticatedUser();
    if (!auth.authenticated || !auth.userId) {
      return NextResponse.json({ error: auth.error || 'Unauthorized' }, { status: 401 });
    }

    const memberships = await getUserTeamIds();
    if (memberships.dbError) {
      return NextResponse.json({ error: 'Failed to load team memberships' }, { status: 500 });
    }

    const plan = await prisma.sprayPlan.findFirst({
      where: {
        id: params.id,
        teamId: { in: memberships.teamIds },
      },
      include: {
        project: {
          select: {
            id: true,
            name: true,
            location: true,
          },
        },
        createdBy: {
          select: {
            id: true,
            name: true,
            email: true,
          },
        },
        missions: {
          orderBy: { sequence: 'asc' },
          include: {
            zones: {
              orderBy: { priorityScore: 'desc' },
              select: {
                id: true,
                species: true,
                detectionCount: true,
                averageConfidence: true,
                priorityScore: true,
                centroidLat: true,
                centroidLon: true,
                areaHa: true,
                recommendedDosePerHa: true,
                recommendedLiters: true,
                recommendationSource: true,
                polygon: true,
                metadata: true,
              },
            },
          },
        },
        zones: {
          orderBy: [{ missionId: 'asc' }, { priorityScore: 'desc' }],
          select: {
            id: true,
            missionId: true,
            species: true,
            detectionCount: true,
            averageConfidence: true,
            priorityScore: true,
            centroidLat: true,
            centroidLon: true,
            areaHa: true,
            recommendedDosePerHa: true,
            recommendedLiters: true,
            recommendationSource: true,
            polygon: true,
            metadata: true,
          },
        },
      },
    });

    if (!plan) {
      return NextResponse.json({ error: 'Spray plan not found' }, { status: 404 });
    }

    return NextResponse.json(plan);
  } catch (error) {
    console.error('[spray-plan] detail failed', error);
    return NextResponse.json({ error: 'Failed to load spray plan' }, { status: 500 });
  }
}

export async function DELETE(_request: NextRequest, { params }: { params: { id: string } }) {
  try {
    const auth = await getAuthenticatedUser();
    if (!auth.authenticated || !auth.userId) {
      return NextResponse.json({ error: auth.error || 'Unauthorized' }, { status: 401 });
    }

    const memberships = await getUserTeamIds();
    if (memberships.dbError) {
      return NextResponse.json({ error: 'Failed to load team memberships' }, { status: 500 });
    }

    const existing = await prisma.sprayPlan.findFirst({
      where: {
        id: params.id,
        teamId: { in: memberships.teamIds },
      },
      select: { id: true },
    });

    if (!existing) {
      return NextResponse.json({ error: 'Spray plan not found' }, { status: 404 });
    }

    await prisma.sprayPlan.delete({ where: { id: params.id } });
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('[spray-plan] delete failed', error);
    return NextResponse.json({ error: 'Failed to delete spray plan' }, { status: 500 });
  }
}
