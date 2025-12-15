import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/db';
import { getAuthenticatedUser, getUserTeamIds, checkProjectAccess } from '@/lib/auth/api-auth';

// Pagination defaults
const DEFAULT_PAGE_SIZE = 100;
const MAX_PAGE_SIZE = 500;

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

    const searchParams = request.nextUrl.searchParams;
    const projectId = searchParams.get('projectId');
    const assetId = searchParams.get('assetId');
    const needsReview = searchParams.get('needsReview');
    const maxConfidence = searchParams.get('maxConfidence');

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

    // Get user's teams to filter accessible detections
    const userTeams = await getUserTeamIds();
    if (userTeams.teamIds.length === 0) {
      return NextResponse.json(searchParams.get('all') === 'true' ? [] : { data: [], pagination: { page: 1, limit: DEFAULT_PAGE_SIZE, totalCount: 0, totalPages: 0, hasMore: false } });
    }

    // Pagination parameters (set all=true to return all results without pagination)
    const returnAll = searchParams.get('all') === 'true';
    const pageParam = searchParams.get('page');
    const limitParam = searchParams.get('limit');
    const page = Math.max(1, parseInt(pageParam || '1', 10) || 1);
    const limit = returnAll ? undefined : Math.min(MAX_PAGE_SIZE, Math.max(1, parseInt(limitParam || String(DEFAULT_PAGE_SIZE), 10) || DEFAULT_PAGE_SIZE));
    const skip = returnAll ? undefined : (page - 1) * (limit || DEFAULT_PAGE_SIZE);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const where: any = {
      // Filter by user's teams through asset -> project -> team
      asset: {
        project: {
          teamId: { in: userTeams.teamIds }
        }
      }
    };
    if (projectId) {
      where.job = {
        projectId: projectId
      };
    }
    if (assetId) {
      where.assetId = assetId;
    }
    if (needsReview === 'true') {
      where.verified = false;
      where.rejected = false;
      where.confidence = {
        lt: maxConfidence ? parseFloat(maxConfidence) : 0.7
      };
    }

    // Get total count for pagination metadata
    const totalCount = await prisma.detection.count({ where });

    const detections = await prisma.detection.findMany({
      where,
      include: {
        asset: {
          select: {
            id: true,
            fileName: true,
            storageUrl: true,
            gpsLatitude: true,
            gpsLongitude: true,
            altitude: true,
            imageWidth: true,
            imageHeight: true,
            projectId: true,
            project: {
              select: {
                name: true,
                location: true,
                purpose: true,
              }
            }
          }
        },
        job: true,
      },
      orderBy: {
        ...(needsReview === 'true'
          ? { confidence: 'asc' as const }
          : { createdAt: 'desc' as const })
      },
      skip,
      take: limit,
    });

    // Return all results without pagination wrapper if all=true
    if (returnAll) {
      return NextResponse.json(detections);
    }

    const effectiveLimit = limit || DEFAULT_PAGE_SIZE;
    const totalPages = Math.ceil(totalCount / effectiveLimit);
    const hasMore = page < totalPages;

    return NextResponse.json({
      data: detections,
      pagination: {
        page,
        limit: effectiveLimit,
        totalCount,
        totalPages,
        hasMore,
      },
    });
  } catch (error) {
    console.error('Error fetching detections:', error);
    return NextResponse.json(
      { error: 'Failed to fetch detections' },
      { status: 500 }
    );
  }
}
