import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/db';
import { pixelToGeo } from '@/lib/utils/georeferencing';

export async function GET(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const annotation = await prisma.manualAnnotation.findUnique({
      where: { id: params.id },
      include: {
        session: {
          select: {
            id: true,
            assetId: true,
            status: true,
            asset: {
              select: {
                id: true,
                fileName: true,
                storageUrl: true,
                gpsLatitude: true,
                gpsLongitude: true,
                project: {
                  select: {
                    name: true,
                    location: true,
                  }
                }
              }
            }
          }
        }
      }
    });
    
    if (!annotation) {
      return NextResponse.json(
        { error: 'Annotation not found' },
        { status: 404 }
      );
    }
    
    return NextResponse.json(annotation);
  } catch (error) {
    console.error('Error fetching annotation:', error);
    return NextResponse.json(
      { error: 'Failed to fetch annotation' },
      { status: 500 }
    );
  }
}

export async function PUT(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const body = await request.json();
    const { 
      weedType, 
      confidence, 
      coordinates, 
      notes,
      verified,
      verifiedBy 
    } = body;
    
    // Get existing annotation to check if coordinates changed
    const existingAnnotation = await prisma.manualAnnotation.findUnique({
      where: { id: params.id },
      include: {
        session: {
          include: {
            asset: {
              select: {
                gpsLatitude: true,
                gpsLongitude: true,
                altitude: true,
                gimbalPitch: true,
                gimbalRoll: true,
                gimbalYaw: true,
                imageWidth: true,
                imageHeight: true,
                cameraFov: true,
                lrfDistance: true,
              }
            }
          }
        }
      }
    });
    
    if (!existingAnnotation) {
      return NextResponse.json(
        { error: 'Annotation not found' },
        { status: 404 }
      );
    }
    
    let updateData: any = {
      weedType,
      confidence,
      notes,
      verified,
      verifiedBy,
      verifiedAt: verified ? new Date() : null,
    };
    
    // If coordinates changed, recalculate geographic coordinates
    if (coordinates && JSON.stringify(coordinates) !== JSON.stringify(existingAnnotation.coordinates)) {
      updateData.coordinates = coordinates;
      
      if (existingAnnotation.session.asset.gpsLatitude && existingAnnotation.session.asset.gpsLongitude) {
        try {
          // Convert each point in the polygon
          const geoPoints = coordinates.map(([x, y]: [number, number]) => {
            const geoPoint = pixelToGeo(
              {
                gpsLatitude: existingAnnotation.session.asset.gpsLatitude!,
                gpsLongitude: existingAnnotation.session.asset.gpsLongitude!,
                altitude: existingAnnotation.session.asset.altitude || 100,
                gimbalPitch: existingAnnotation.session.asset.gimbalPitch || 0,
                gimbalRoll: existingAnnotation.session.asset.gimbalRoll || 0,
                gimbalYaw: existingAnnotation.session.asset.gimbalYaw || 0,
                imageWidth: existingAnnotation.session.asset.imageWidth || 4000,
                imageHeight: existingAnnotation.session.asset.imageHeight || 3000,
                cameraFov: existingAnnotation.session.asset.cameraFov || 84,
                lrfDistance: existingAnnotation.session.asset.lrfDistance || undefined,
              },
              { x, y }
            );
            
            // Handle both sync and async return types
            if (geoPoint instanceof Promise) {
              throw new Error('Async coordinate conversion not supported in this context');
            }
            
            return [geoPoint.lon, geoPoint.lat];
          });
          
          // Create GeoJSON polygon
          updateData.geoCoordinates = {
            type: 'Polygon',
            coordinates: [geoPoints.concat([geoPoints[0]])] // Close the polygon
          };
          
          // Calculate center point for map display
          const sumLat = geoPoints.reduce((sum: number, [lon, lat]: [number, number]) => sum + lat, 0);
          const sumLon = geoPoints.reduce((sum: number, [lon, lat]: [number, number]) => sum + lon, 0);
          updateData.centerLat = sumLat / geoPoints.length;
          updateData.centerLon = sumLon / geoPoints.length;
          
        } catch (error) {
          console.warn('Failed to convert pixel to geo coordinates:', error);
          // Keep existing geo coordinates
        }
      }
    }
    
    const annotation = await prisma.manualAnnotation.update({
      where: { id: params.id },
      data: updateData,
      include: {
        session: {
          select: {
            id: true,
            asset: {
              select: {
                fileName: true,
                project: {
                  select: {
                    name: true,
                  }
                }
              }
            }
          }
        }
      }
    });
    
    return NextResponse.json(annotation);
  } catch (error) {
    console.error('Error updating annotation:', error);
    return NextResponse.json(
      { error: 'Failed to update annotation' },
      { status: 500 }
    );
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const annotation = await prisma.manualAnnotation.findUnique({
      where: { id: params.id }
    });
    
    if (!annotation) {
      return NextResponse.json(
        { error: 'Annotation not found' },
        { status: 404 }
      );
    }
    
    await prisma.manualAnnotation.delete({
      where: { id: params.id }
    });
    
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Error deleting annotation:', error);
    return NextResponse.json(
      { error: 'Failed to delete annotation' },
      { status: 500 }
    );
  }
}