import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/db';

export async function GET(request: NextRequest) {
  try {
    // For now, fetch all projects (in production, filter by user/team)
    const projects = await prisma.project.findMany({
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
    const { name, description, location, purpose, season } = await request.json();

    if (!name) {
      return NextResponse.json(
        { error: 'Project name is required' },
        { status: 400 }
      );
    }

    // Create default team first if it doesn't exist
    let defaultTeam = await prisma.team.findFirst({
      where: { name: 'Default Team' }
    });

    if (!defaultTeam) {
      defaultTeam = await prisma.team.create({
        data: {
          name: 'Default Team',
          description: 'Default team for development'
        }
      });
    }

    const project = await prisma.project.create({
      data: {
        name,
        description,
        location,
        purpose: purpose || 'WEED_DETECTION',
        season,
        teamId: defaultTeam.id
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