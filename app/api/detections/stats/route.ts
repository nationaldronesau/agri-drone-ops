import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/db';
import { getAuthenticatedUser, getUserTeamIds, checkProjectAccess } from '@/lib/auth/api-auth';

export async function GET(request: NextRequest) {
  try {
    const auth = await getAuthenticatedUser();
    if (!auth.authenticated) {
      return NextResponse.json(
        { error: auth.error || 'Unauthorized' },
        { status: 401 }
      );
    }

    const searchParams = request.nextUrl.searchParams;
    const projectId = searchParams.get('projectId');

    if (projectId && projectId !== 'all') {
      const projectAuth = await checkProjectAccess(projectId);
      if (!projectAuth.hasAccess) {
        return NextResponse.json(
          { error: projectAuth.error || 'Access denied' },
          { status: 403 }
        );
      }
    }

    const userTeams = await getUserTeamIds();
    if (userTeams.dbError) {
      return NextResponse.json(
        { error: 'Database error while fetching team access' },
        { status: 500 }
      );
    }

    if (userTeams.teamIds.length === 0) {
      return NextResponse.json({
        stats: {
          total: 0,
          verified: 0,
          rejected: 0,
          pending: 0,
          byConfidence: { high: 0, medium: 0, low: 0 },
        },
      });
    }

    const where: Record<string, unknown> = {
      asset: {
        project: {
          teamId: { in: userTeams.teamIds },
        },
      },
    };

    if (projectId && projectId !== 'all') {
      (where.asset as Record<string, unknown>).projectId = projectId;
    }

    const [total, verified, rejected, pending, high, medium, low] = await Promise.all([
      prisma.detection.count({ where }),
      prisma.detection.count({ where: { ...where, verified: true } }),
      prisma.detection.count({ where: { ...where, rejected: true } }),
      prisma.detection.count({ where: { ...where, verified: false, rejected: false } }),
      prisma.detection.count({ where: { ...where, confidence: { gte: 0.8 } } }),
      prisma.detection.count({ where: { ...where, confidence: { gte: 0.5, lt: 0.8 } } }),
      prisma.detection.count({
        where: {
          ...where,
          OR: [{ confidence: { lt: 0.5 } }, { confidence: null }],
        },
      }),
    ]);

    return NextResponse.json({
      stats: {
        total,
        verified,
        rejected,
        pending,
        byConfidence: {
          high,
          medium,
          low,
        },
      },
    });
  } catch (error) {
    console.error('Error fetching detection stats:', error);
    return NextResponse.json(
      { error: 'Failed to fetch detection stats' },
      { status: 500 }
    );
  }
}
