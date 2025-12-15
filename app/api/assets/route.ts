import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/db';
import { getAuthenticatedUser, getUserTeamIds, checkProjectAccess } from '@/lib/auth/api-auth';

export async function GET(request: NextRequest) {
  try {
    // Authenticate user
    const auth = await getAuthenticatedUser();
    if (!auth.authenticated) {
      return NextResponse.json(
        { error: auth.error || 'Unauthorized' },
        { status: 401 }
      );
    }

    const { searchParams } = new URL(request.url);
    const projectId = searchParams.get('projectId');

    // If projectId specified, verify user has access
    if (projectId) {
      const projectAuth = await checkProjectAccess(projectId);
      if (!projectAuth.hasAccess) {
        return NextResponse.json(
          { error: projectAuth.error || 'Access denied' },
          { status: 403 }
        );
      }
    }

    // Get user's teams to filter accessible projects
    const userTeams = await getUserTeamIds();
    if (userTeams.dbError) {
      return NextResponse.json(
        { error: 'Database error while fetching team access' },
        { status: 500 }
      );
    }
    if (userTeams.teamIds.length === 0) {
      return NextResponse.json({ assets: [] });
    }

    // Build where clause - filter by user's teams
    const whereClause: Record<string, unknown> = {
      project: {
        teamId: { in: userTeams.teamIds }
      }
    };

    // Add project filter if specified
    if (projectId) {
      whereClause.projectId = projectId;
    }

    // Fetch assets with optional project filter, restricted to user's teams
    const assets = await prisma.asset.findMany({
      where: whereClause,
      include: {
        project: {
          select: {
            id: true,
            name: true,
            location: true,
            purpose: true,
            season: true
          }
        }
      },
      orderBy: {
        createdAt: 'desc'
      }
    });

    return NextResponse.json({ assets });
  } catch (error) {
    console.error('Failed to fetch assets:', error);
    return NextResponse.json(
      { error: 'Failed to fetch assets' },
      { status: 500 }
    );
  }
}