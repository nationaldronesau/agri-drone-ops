import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/db';
import { pixelToGeoWithDSM, polygonToCenterBox, validateGeoParams } from '@/lib/utils/georeferencing';
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
    const returnAll = searchParams.get('all') === 'true';
    const includeManual = searchParams.get('includeManual') !== 'false';
    const includePending = searchParams.get('includePending') === 'true';

    // If specific project requested, verify access
    if (projectId && projectId !== 'all') {
      const projectAuth = await checkProjectAccess(projectId);
      if (!projectAuth.hasAccess) {
        return NextResponse.json(
          { error: projectAuth.error || 'Access denied' },
          { status: 403 }
        );
      }
    }

    // Get user's teams to filter accessible annotations
    const userTeams = await getUserTeamIds();
    if (userTeams.dbError) {
      return NextResponse.json(
        { error: 'Database error while fetching team access' },
        { status: 500 }
      );
    }
    if (userTeams.teamIds.length === 0) {
      if (returnAll) {
        return NextResponse.json([]);
      }
      return NextResponse.json({ data: [], pagination: { page: 1, limit: DEFAULT_PAGE_SIZE, totalCount: 0, totalPages: 0, hasMore: false } });
    }

    // Pagination parameters (set all=true to return all results without pagination)
    const pageParam = searchParams.get('page');
    const limitParam = searchParams.get('limit');
    const page = Math.max(1, parseInt(pageParam || '1', 10) || 1);
    const limit = returnAll ? undefined : Math.min(MAX_PAGE_SIZE, Math.max(1, parseInt(limitParam || String(DEFAULT_PAGE_SIZE), 10) || DEFAULT_PAGE_SIZE));
    const skip = returnAll ? undefined : (page - 1) * (limit || DEFAULT_PAGE_SIZE);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const where: any = {
      // Filter by user's teams through session -> asset -> project -> team
      session: {
        asset: {
          project: {
            teamId: { in: userTeams.teamIds }
          }
        }
      }
    };
    if (projectId && projectId !== 'all') {
      where.session.asset.projectId = projectId;
    }

    const pendingWhere = includePending ? {
      status: 'PENDING',
      asset: {
        project: {
          teamId: { in: userTeams.teamIds }
        },
        ...(projectId && projectId !== 'all' ? { projectId } : {}),
      },
    } : null;

    // Get total count for pagination metadata
    const [manualCount, pendingCount] = await Promise.all([
      includeManual ? prisma.manualAnnotation.count({ where }) : Promise.resolve(0),
      includePending && pendingWhere ? prisma.pendingAnnotation.count({ where: pendingWhere }) : Promise.resolve(0),
    ]);
    const totalCount = manualCount + pendingCount;

    const annotations = includeManual ? await prisma.manualAnnotation.findMany({
      where,
      include: {
        session: {
          include: {
            asset: {
              select: {
                id: true,
                fileName: true,
                gpsLatitude: true,
                gpsLongitude: true,
                altitude: true,
                imageWidth: true,
                imageHeight: true,
                gimbalPitch: true,
                gimbalRoll: true,
                gimbalYaw: true,
                cameraFov: true,
                lrfDistance: true,
                lrfTargetLat: true,
                lrfTargetLon: true,
                metadata: true, // Include full metadata for precision georeferencing
                project: {
                  select: {
                    id: true,
                    name: true,
                    location: true,
                  }
                }
              }
            }
          }
        }
      },
      orderBy: {
        createdAt: 'desc'
      },
      skip,
      take: limit,
    }) : [];

    const pendingAnnotations = includePending && pendingWhere ? await prisma.pendingAnnotation.findMany({
      where: pendingWhere,
      include: {
        asset: {
          select: {
            id: true,
            fileName: true,
            gpsLatitude: true,
            gpsLongitude: true,
            altitude: true,
            imageWidth: true,
            imageHeight: true,
            gimbalPitch: true,
            gimbalRoll: true,
            gimbalYaw: true,
            cameraFov: true,
            lrfDistance: true,
            lrfTargetLat: true,
            lrfTargetLon: true,
            metadata: true,
            project: {
              select: {
                id: true,
                name: true,
                location: true,
              }
            }
          }
        }
      },
      orderBy: {
        createdAt: 'desc'
      },
      skip,
      take: limit,
    }) : [];
    
    // Convert to format compatible with export page
    const exportAnnotations = await Promise.all(annotations.map(async annotation => {
      const asset = annotation.session.asset;

      // Calculate geographic coordinates for the annotation center and full polygon
      let centerLat: number | null = null;
      let centerLon: number | null = null;
      let polygonCoordinates: Array<[number, number]> = [];

      const coords = Array.isArray(annotation.coordinates)
        ? (annotation.coordinates as [number, number][])
        : [];

      const validation = validateGeoParams(asset);
      if (coords.length > 0 && validation.valid) {
        const centerBox = polygonToCenterBox(coords);
        if (centerBox) {
          try {
            const centerGeo = await pixelToGeoWithDSM(asset, { x: centerBox.x, y: centerBox.y });
            if (centerGeo) {
              centerLat = centerGeo.lat;
              centerLon = centerGeo.lon;
            }
          } catch (error) {
            console.warn('Failed to convert annotation center:', annotation.id, error);
          }
        }

        const geoPolygonCoords: Array<[number, number]> = [];
        let totalLat = 0;
        let totalLon = 0;

        for (const [x, y] of coords) {
          try {
            const geoCoords = await pixelToGeoWithDSM(asset, { x, y });
            if (geoCoords) {
              geoPolygonCoords.push([geoCoords.lon, geoCoords.lat]);
              totalLat += geoCoords.lat;
              totalLon += geoCoords.lon;
            }
          } catch (coordError) {
            console.warn(`Failed to convert vertex ${x},${y}:`, coordError);
          }
        }

        if (geoPolygonCoords.length > 0) {
          polygonCoordinates = geoPolygonCoords;
          if (centerLat == null || centerLon == null) {
            centerLat = totalLat / geoPolygonCoords.length;
            centerLon = totalLon / geoPolygonCoords.length;
          }
        }
      }

      return {
        id: annotation.id,
        className: annotation.weedType,
        confidence: annotation.confidence === 'CERTAIN' ? 0.95 :
                   annotation.confidence === 'LIKELY' ? 0.75 : 0.5,
        centerLat,
        centerLon,
        type: 'manual',
        metadata: {
          color: '#00FF00', // Green for manual annotations
          source: 'manual',
          notes: annotation.notes,
          verified: annotation.verified,
          coordinateCount: Array.isArray(annotation.coordinates) ? annotation.coordinates.length : 0,
          polygonCoordinates: polygonCoordinates // Full polygon geometry for KML export
        },
        createdAt: annotation.createdAt.toISOString(),
        asset: {
          id: asset.id,
          fileName: asset.fileName,
          altitude: asset.altitude,
          project: {
            name: asset.project.name,
            location: asset.project.location,
          }
        }
      };
    }));

    const exportPendingAnnotations = await Promise.all(pendingAnnotations.map(async pending => {
      const asset = pending.asset;

      let centerLat: number | null = null;
      let centerLon: number | null = null;
      let polygonCoordinates: Array<[number, number]> = [];

      const coords = Array.isArray(pending.polygon)
        ? (pending.polygon as [number, number][])
        : [];

      const validation = validateGeoParams(asset);
      if (coords.length > 0 && validation.valid) {
        const centerBox = polygonToCenterBox(coords);
        if (centerBox) {
          try {
            const centerGeo = await pixelToGeoWithDSM(asset, { x: centerBox.x, y: centerBox.y });
            if (centerGeo) {
              centerLat = centerGeo.lat;
              centerLon = centerGeo.lon;
            }
          } catch (error) {
            console.warn('Failed to convert pending annotation center:', pending.id, error);
          }
        }

        const geoPolygonCoords: Array<[number, number]> = [];
        let totalLat = 0;
        let totalLon = 0;

        for (const [x, y] of coords) {
          try {
            const geoCoords = await pixelToGeoWithDSM(asset, { x, y });
            if (geoCoords) {
              geoPolygonCoords.push([geoCoords.lon, geoCoords.lat]);
              totalLat += geoCoords.lat;
              totalLon += geoCoords.lon;
            }
          } catch (coordError) {
            console.warn(`Failed to convert SAM3 vertex ${x},${y}:`, coordError);
          }
        }

        if (geoPolygonCoords.length > 0) {
          polygonCoordinates = geoPolygonCoords;
          if (centerLat == null || centerLon == null) {
            centerLat = totalLat / geoPolygonCoords.length;
            centerLon = totalLon / geoPolygonCoords.length;
          }
        }
      }

      return {
        id: pending.id,
        className: pending.weedType,
        confidence: pending.confidence,
        centerLat,
        centerLon,
        type: 'sam3',
        metadata: {
          color: '#8B5CF6', // Purple for SAM3
          source: 'sam3',
          notes: 'SAM3 pending annotation',
          verified: false,
          coordinateCount: coords.length,
          polygonCoordinates: polygonCoordinates,
        },
        createdAt: pending.createdAt.toISOString(),
        asset: {
          id: asset.id,
          fileName: asset.fileName,
          altitude: asset.altitude,
          project: {
            name: asset.project.name,
            location: asset.project.location,
          }
        }
      };
    }));

    const combinedExportAnnotations = includePending
      ? [...exportAnnotations, ...exportPendingAnnotations]
      : exportAnnotations;
    
    // Return all results without pagination wrapper if all=true
    if (returnAll) {
      return NextResponse.json(combinedExportAnnotations);
    }

    const effectiveLimit = limit || DEFAULT_PAGE_SIZE;
    const totalPages = Math.ceil(totalCount / effectiveLimit);
    const hasMore = page < totalPages;

    return NextResponse.json({
      data: combinedExportAnnotations,
      pagination: {
        page,
        limit: effectiveLimit,
        totalCount,
        totalPages,
        hasMore,
      },
    });
  } catch (error) {
    console.error('Error fetching manual annotations for export:', error);
    return NextResponse.json(
      { error: 'Failed to fetch manual annotations' },
      { status: 500 }
    );
  }
}
