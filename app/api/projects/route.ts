import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/db';
import { getAuthenticatedUser, getUserTeamIds, getUserTeamMemberships, canManageTeam } from '@/lib/auth/api-auth';
import { parsePaginationParams, paginatedResponse } from '@/lib/utils/pagination';

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

    // Get user's teams
    const userTeams = await getUserTeamIds();
    if (userTeams.dbError) {
      return NextResponse.json(
        { error: 'Database error while fetching team access' },
        { status: 500 }
      );
    }
    if (userTeams.teamIds.length === 0) {
      // User has no teams, return empty list with pagination
      return NextResponse.json({
        projects: [],
        pagination: { page: 1, pageSize: 50, total: 0, totalPages: 0, hasMore: false }
      });
    }

    // Parse pagination params
    const paginationParams = parsePaginationParams(request.nextUrl.searchParams);

    // Build where clause
    const where = { teamId: { in: userTeams.teamIds } };

    // Get total count and paginated results in parallel
    const [total, projects] = await Promise.all([
      prisma.project.count({ where }),
      prisma.project.findMany({
        where,
        include: {
          _count: {
            select: { assets: true }
          },
          cameraProfile: {
            select: { id: true, name: true },
          },
        },
        orderBy: {
          createdAt: 'desc'
        },
        skip: paginationParams.skip,
        take: paginationParams.take,
      })
    ]);

    return NextResponse.json(paginatedResponse(projects, total, paginationParams, 'projects'));
  } catch (error) {
    console.error('Failed to fetch projects:', error);
    return NextResponse.json(
      { error: 'Failed to fetch projects' },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    // Authenticate user
    const auth = await getAuthenticatedUser();
    if (!auth.authenticated || !auth.userId) {
      return NextResponse.json(
        { error: auth.error || 'Unauthorized' },
        { status: 401 }
      );
    }

    const { name, description, location, purpose, season, teamId } = await request.json();

    if (!name) {
      return NextResponse.json(
        { error: 'Project name is required' },
        { status: 400 }
      );
    }

    // Get user's teams with roles
    const userMemberships = await getUserTeamMemberships();
    if (userMemberships.dbError) {
      return NextResponse.json(
        { error: 'Database error while fetching team access' },
        { status: 500 }
      );
    }

    // If teamId is specified, verify user is OWNER or ADMIN
    let targetTeamId = teamId;
    if (targetTeamId) {
      if (!canManageTeam(userMemberships.memberships, targetTeamId)) {
        return NextResponse.json(
          { error: 'Access denied - requires OWNER or ADMIN role to create projects' },
          { status: 403 }
        );
      }
    } else {
      // Use user's first team where they are OWNER/ADMIN, or create a personal team
      const managedTeam = userMemberships.memberships.find(
        m => m.role === 'OWNER' || m.role === 'ADMIN'
      );
      if (managedTeam) {
        targetTeamId = managedTeam.teamId;
      } else {
        // Create a personal team for the user with unique name
        const personalTeam = await prisma.team.create({
          data: {
            name: `Personal Team - ${auth.userId.slice(-8)}`,
            description: 'Auto-created personal team',
            members: {
              create: {
                userId: auth.userId,
                role: 'OWNER'
              }
            }
          }
        });
        targetTeamId = personalTeam.id;
      }
    }

    const project = await prisma.project.create({
      data: {
        name,
        description,
        location,
        purpose: purpose || 'WEED_DETECTION',
        season,
        teamId: targetTeamId
      },
      include: {
        _count: {
          select: { assets: true }
        }
      }
    });

    return NextResponse.json(project);
  } catch (error) {
    console.error('Failed to create project:', error);
    return NextResponse.json(
      { error: 'Failed to create project' },
      { status: 500 }
    );
  }
}
