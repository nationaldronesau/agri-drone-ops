import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/db';
import { precisionPixelToGeo, extractPrecisionParams } from '@/lib/utils/precision-georeferencing';
import { pixelToGeo } from '@/lib/utils/georeferencing';
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
      let centerLat: number | null = annotation.centerLat ?? null;
      let centerLon: number | null = annotation.centerLon ?? null;
      let polygonCoordinates: Array<[number, number]> = [];

      const coords = Array.isArray(annotation.coordinates)
        ? (annotation.coordinates as [number, number][])
        : [];

      if (coords.length > 0 && asset.gpsLatitude != null && asset.gpsLongitude != null && asset.altitude != null && asset.metadata) {
        try {
          // Extract precision parameters from full metadata
          const precisionParams = extractPrecisionParams(asset.metadata);

          // Convert each polygon vertex to geographic coordinates (with DSM)
          const geoPolygonCoords: Array<[number, number]> = [];
          let totalLat = 0;
          let totalLon = 0;

          for (const [x, y] of coords) {
            const pixel = { x, y };
            try {
              const geoCoords = await precisionPixelToGeo(pixel, precisionParams);

              if (geoCoords && typeof geoCoords.latitude === 'number' && typeof geoCoords.longitude === 'number') {
                geoPolygonCoords.push([geoCoords.longitude, geoCoords.latitude]); // KML uses lon,lat
                totalLat += geoCoords.latitude;
                totalLon += geoCoords.longitude;
              }
            } catch (coordError) {
              console.warn(`Failed to convert vertex ${x},${y}:`, coordError);
            }
          }

          if (geoPolygonCoords.length > 0) {
            polygonCoordinates = geoPolygonCoords;
            // Calculate centroid from converted coordinates
            centerLat = totalLat / geoPolygonCoords.length;
            centerLon = totalLon / geoPolygonCoords.length;
          }
        } catch (error) {
          console.warn('Failed to convert coordinates for annotation:', annotation.id, error);

          // Fallback to basic method if precision fails
          try {
            const centerX = coords.reduce((sum, [x]) => sum + x, 0) / coords.length;
            const centerY = coords.reduce((sum, [, y]) => sum + y, 0) / coords.length;

            const precisionParams = extractPrecisionParams(asset.metadata);
            const pixel = { x: centerX, y: centerY };
            const geoCoords = await precisionPixelToGeo(pixel, precisionParams);

            if (geoCoords && typeof geoCoords.latitude === 'number' && typeof geoCoords.longitude === 'number') {
              centerLat = geoCoords.latitude;
              centerLon = geoCoords.longitude;
            }
          } catch (fallbackError) {
            console.warn('Fallback coordinate conversion also failed:', fallbackError);
          }
        }
      } else if (coords.length > 0 && asset.gpsLatitude != null && asset.gpsLongitude != null) {
        // Basic pixel->geo fallback when precision metadata is missing
        try {
          const centerX = coords.reduce((sum, [x]) => sum + x, 0) / coords.length;
          const centerY = coords.reduce((sum, [, y]) => sum + y, 0) / coords.length;
          const geoCoords = pixelToGeo(
            {
              gpsLatitude: asset.gpsLatitude,
              gpsLongitude: asset.gpsLongitude,
              altitude: asset.altitude || 100,
              gimbalPitch: asset.gimbalPitch || 0,
              gimbalRoll: asset.gimbalRoll || 0,
              gimbalYaw: asset.gimbalYaw || 0,
              imageWidth: asset.imageWidth || 4000,
              imageHeight: asset.imageHeight || 3000,
              cameraFov: asset.cameraFov || 84,
              lrfDistance: asset.lrfDistance || undefined,
            },
            { x: centerX, y: centerY }
          );

          if (!(geoCoords instanceof Promise)) {
            centerLat = centerLat ?? geoCoords.lat;
            centerLon = centerLon ?? geoCoords.lon;
          }
        } catch (fallbackError) {
          console.warn('Basic coordinate conversion failed:', fallbackError);
        }
      }

      // Fallback to stored polygon coordinates if precision conversion didn't succeed
      if (polygonCoordinates.length === 0 && annotation.geoCoordinates && typeof annotation.geoCoordinates === 'object') {
        const geo = annotation.geoCoordinates as { type?: string; coordinates?: Array<Array<[number, number]>> };
        if (geo.type === 'Polygon' && Array.isArray(geo.coordinates?.[0])) {
          polygonCoordinates = geo.coordinates[0];
        }
      }

      if ((centerLat == null || centerLon == null) && polygonCoordinates.length > 0) {
        const totalLat = polygonCoordinates.reduce((sum, [, lat]) => sum + lat, 0);
        const totalLon = polygonCoordinates.reduce((sum, [lon]) => sum + lon, 0);
        centerLat = centerLat ?? totalLat / polygonCoordinates.length;
        centerLon = centerLon ?? totalLon / polygonCoordinates.length;
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

      let centerLat: number | null = pending.centerLat ?? null;
      let centerLon: number | null = pending.centerLon ?? null;
      let polygonCoordinates: Array<[number, number]> = [];

      const coords = Array.isArray(pending.polygon)
        ? (pending.polygon as [number, number][])
        : [];

      if (coords.length > 0 && asset.gpsLatitude != null && asset.gpsLongitude != null && asset.altitude != null && asset.metadata) {
        try {
          const precisionParams = extractPrecisionParams(asset.metadata);
          const geoPolygonCoords: Array<[number, number]> = [];
          let totalLat = 0;
          let totalLon = 0;

          for (const [x, y] of coords) {
            const pixel = { x, y };
            try {
              const geoCoords = await precisionPixelToGeo(pixel, precisionParams);
              if (geoCoords && typeof geoCoords.latitude === 'number' && typeof geoCoords.longitude === 'number') {
                geoPolygonCoords.push([geoCoords.longitude, geoCoords.latitude]);
                totalLat += geoCoords.latitude;
                totalLon += geoCoords.longitude;
              }
            } catch (coordError) {
              console.warn(`Failed to convert SAM3 vertex ${x},${y}:`, coordError);
            }
          }

          if (geoPolygonCoords.length > 0) {
            polygonCoordinates = geoPolygonCoords;
            centerLat = totalLat / geoPolygonCoords.length;
            centerLon = totalLon / geoPolygonCoords.length;
          }
        } catch (error) {
          console.warn('Failed to convert SAM3 coordinates:', pending.id, error);
        }
      } else if (coords.length > 0 && asset.gpsLatitude != null && asset.gpsLongitude != null) {
        try {
          const centerX = coords.reduce((sum, [x]) => sum + x, 0) / coords.length;
          const centerY = coords.reduce((sum, [, y]) => sum + y, 0) / coords.length;
          const geoCoords = pixelToGeo(
            {
              gpsLatitude: asset.gpsLatitude,
              gpsLongitude: asset.gpsLongitude,
              altitude: asset.altitude || 100,
              gimbalPitch: asset.gimbalPitch || 0,
              gimbalRoll: asset.gimbalRoll || 0,
              gimbalYaw: asset.gimbalYaw || 0,
              imageWidth: asset.imageWidth || 4000,
              imageHeight: asset.imageHeight || 3000,
              cameraFov: asset.cameraFov || 84,
              lrfDistance: asset.lrfDistance || undefined,
            },
            { x: centerX, y: centerY }
          );

          if (!(geoCoords instanceof Promise)) {
            centerLat = centerLat ?? geoCoords.lat;
            centerLon = centerLon ?? geoCoords.lon;
          }
        } catch (fallbackError) {
          console.warn('Basic SAM3 coordinate conversion failed:', fallbackError);
        }
      }

      if ((centerLat == null || centerLon == null) && polygonCoordinates.length > 0) {
        const totalLat = polygonCoordinates.reduce((sum, [, lat]) => sum + lat, 0);
        const totalLon = polygonCoordinates.reduce((sum, [lon]) => sum + lon, 0);
        centerLat = centerLat ?? totalLat / polygonCoordinates.length;
        centerLon = centerLon ?? totalLon / polygonCoordinates.length;
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
