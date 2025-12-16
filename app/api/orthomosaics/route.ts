import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/db';
import { getAuthenticatedUser, getUserTeamIds } from '@/lib/auth/api-auth';
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

    // Get user's teams to filter accessible orthomosaics
    const userTeams = await getUserTeamIds();
    if (userTeams.dbError) {
      return NextResponse.json(
        { error: 'Database error while fetching team access' },
        { status: 500 }
      );
    }
    if (userTeams.teamIds.length === 0) {
      return NextResponse.json({
        orthomosaics: [],
        pagination: { page: 1, pageSize: 50, total: 0, totalPages: 0, hasMore: false }
      });
    }

    // Parse pagination params
    const paginationParams = parsePaginationParams(request.nextUrl.searchParams);

    // Build where clause
    const where = {
      project: {
        teamId: { in: userTeams.teamIds }
      }
    };

    // Get total count and paginated results in parallel
    const [total, orthomosaics] = await Promise.all([
      prisma.orthomosaic.count({ where }),
      prisma.orthomosaic.findMany({
        where,
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
        },
        skip: paginationParams.skip,
        take: paginationParams.take,
      })
    ]);

    return NextResponse.json(paginatedResponse(orthomosaics, total, paginationParams, 'orthomosaics'));
  } catch (error) {
    console.error('Error fetching orthomosaics:', error);
    return NextResponse.json(
      { error: 'Failed to fetch orthomosaics' },
      { status: 500 }
    );
  }
}