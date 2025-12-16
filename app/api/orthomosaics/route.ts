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

    // Get user's teams to filter accessible orthomosaics
    const userTeams = await getUserTeamIds();
    if (userTeams.dbError) {
      return NextResponse.json(
        { error: 'Database error while fetching team access' },
        { status: 500 }
      );
    }
    if (userTeams.teamIds.length === 0) {
      return NextResponse.json({ orthomosaics: [] });
    }

    const orthomosaics = await prisma.orthomosaic.findMany({
      where: {
        project: {
          teamId: { in: userTeams.teamIds }
        }
      },
      include: {
        project: {
          select: {
            id: true,
            name: true,
            location: true,
          }
        }
      },
      orderBy: {
        createdAt: 'desc'
      }
    });

    return NextResponse.json({ orthomosaics });
  } catch (error) {
    console.error('Error fetching orthomosaics:', error);
    return NextResponse.json(
      { error: 'Failed to fetch orthomosaics' },
      { status: 500 }
    );
  }
}