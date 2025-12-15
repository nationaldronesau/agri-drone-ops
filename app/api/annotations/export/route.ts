import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/db';
import { precisionPixelToGeo, extractPrecisionParams } from '@/lib/utils/precision-georeferencing';

// Pagination defaults
const DEFAULT_PAGE_SIZE = 100;
const MAX_PAGE_SIZE = 500;

export async function GET(request: NextRequest) {
  try {
    const searchParams = request.nextUrl.searchParams;
    const projectId = searchParams.get('projectId');

    // Pagination parameters (set all=true to return all results without pagination)
    const returnAll = searchParams.get('all') === 'true';
    const pageParam = searchParams.get('page');
    const limitParam = searchParams.get('limit');
    const page = Math.max(1, parseInt(pageParam || '1', 10) || 1);
    const limit = returnAll ? undefined : Math.min(MAX_PAGE_SIZE, Math.max(1, parseInt(limitParam || String(DEFAULT_PAGE_SIZE), 10) || DEFAULT_PAGE_SIZE));
    const skip = returnAll ? undefined : (page - 1) * (limit || DEFAULT_PAGE_SIZE);

    const where: Record<string, unknown> = {};
    if (projectId && projectId !== 'all') {
      where.session = {
        asset: {
          projectId: projectId
        }
      };
    }

    // Get total count for pagination metadata
    const totalCount = await prisma.manualAnnotation.count({ where });

    const annotations = await prisma.manualAnnotation.findMany({
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
    });
    
    // Convert to format compatible with export page
    const exportAnnotations = await Promise.all(annotations.map(async annotation => {
      const asset = annotation.session.asset;
      
      // Calculate geographic coordinates for the annotation center and full polygon
      let centerLat: number | null = null;
      let centerLon: number | null = null;
      let polygonCoordinates: Array<[number, number]> = [];
      
      if (annotation.coordinates && Array.isArray(annotation.coordinates) && annotation.coordinates.length > 0) {
        const coords = annotation.coordinates as [number, number][];
        
        // Convert pixel coordinates to geographic coordinates using precision algorithm
        if (asset.gpsLatitude && asset.gpsLongitude && asset.altitude && asset.metadata) {
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
              // Calculate pixel centroid for fallback
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
    
    // Return all results without pagination wrapper if all=true
    if (returnAll) {
      return NextResponse.json(exportAnnotations);
    }

    const effectiveLimit = limit || DEFAULT_PAGE_SIZE;
    const totalPages = Math.ceil(totalCount / effectiveLimit);
    const hasMore = page < totalPages;

    return NextResponse.json({
      data: exportAnnotations,
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