import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/db';
import { getAuthenticatedUser, getUserTeamIds } from '@/lib/auth/api-auth';

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
    if (userTeams.teamIds.length === 0) {
      // User has no teams, return empty list
      return NextResponse.json({ projects: [] });
    }

    // Fetch only projects belonging to user's teams
    const projects = await prisma.project.findMany({
      where: {
        teamId: { in: userTeams.teamIds }
      },
      include: {
        _count: {
          select: { assets: true }
        }
      },
      orderBy: {
        createdAt: 'desc'
      }
    });

    return NextResponse.json({ projects });
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

    // Get user's teams
    const userTeams = await getUserTeamIds();

    // If teamId is specified, verify user is a member
    let targetTeamId = teamId;
    if (targetTeamId) {
      if (!userTeams.teamIds.includes(targetTeamId)) {
        return NextResponse.json(
          { error: 'Access denied - not a member of specified team' },
          { status: 403 }
        );
      }
    } else {
      // Use user's first team or create a personal team
      if (userTeams.teamIds.length > 0) {
        targetTeamId = userTeams.teamIds[0];
      } else {
        // Create a personal team for the user
        const personalTeam = await prisma.team.create({
          data: {
            name: `Personal Team`,
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