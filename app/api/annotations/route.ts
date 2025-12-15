import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/db';
import { pixelToGeo } from '@/lib/utils/georeferencing';
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

    // Get user's teams to filter accessible annotations
    const userTeams = await getUserTeamIds();
    if (userTeams.teamIds.length === 0) {
      return NextResponse.json({ annotations: [] });
    }

    const searchParams = request.nextUrl.searchParams;
    const sessionId = searchParams.get('sessionId');
    const weedType = searchParams.get('weedType');
    const verified = searchParams.get('verified');
    const pushedToTraining = searchParams.get('pushedToTraining');

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
    if (sessionId) {
      where.sessionId = sessionId;
    }
    if (weedType) {
      where.weedType = weedType;
    }
    if (verified !== null) {
      where.verified = verified === 'true';
    }
    if (pushedToTraining !== null) {
      where.pushedToTraining = pushedToTraining === 'true';
    }

    const annotations = await prisma.manualAnnotation.findMany({
      where,
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
                altitude: true,
                imageWidth: true,
                imageHeight: true,
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
      },
      orderBy: {
        createdAt: 'desc'
      }
    });

    return NextResponse.json({ annotations });
  } catch (error) {
    console.error('Error fetching manual annotations:', error);
    return NextResponse.json(
      { error: 'Failed to fetch manual annotations' },
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

    const body = await request.json();
    const {
      sessionId,
      weedType,
      confidence,
      coordinates, // Array of [x, y] pixel coordinates
      notes
    } = body;

    if (!sessionId || !weedType || !coordinates || !Array.isArray(coordinates)) {
      return NextResponse.json(
        { error: 'Session ID, weed type, and coordinates are required' },
        { status: 400 }
      );
    }

    // Fetch session with asset data for coordinate conversion (include project for auth check)
    const session = await prisma.annotationSession.findUnique({
      where: { id: sessionId },
      include: {
        asset: {
          select: {
            id: true,
            projectId: true,
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
            project: {
              select: {
                teamId: true,
                team: {
                  select: {
                    members: {
                      where: { userId: auth.userId },
                      select: { id: true }
                    }
                  }
                }
              }
            }
          }
        }
      }
    });

    if (!session) {
      return NextResponse.json(
        { error: 'Annotation session not found' },
        { status: 404 }
      );
    }

    // Verify session has valid project and team structure
    if (!session.asset?.project?.team?.members) {
      return NextResponse.json(
        { error: 'Session has no associated project or team' },
        { status: 404 }
      );
    }

    // Verify user has access to the session's project
    const isMember = session.asset.project.team.members.length > 0;
    if (!isMember) {
      return NextResponse.json(
        { error: 'Access denied - not a member of this project\'s team' },
        { status: 403 }
      );
    }
    
    let geoCoordinates = null;
    let centerLat = null;
    let centerLon = null;
    
    // Convert pixel coordinates to geographic coordinates if asset has GPS data
    if (session.asset.gpsLatitude && session.asset.gpsLongitude) {
      try {
        // Convert each point in the polygon
        const geoPoints = coordinates.map(([x, y]: [number, number]) => {
          const geoPoint = pixelToGeo(
            {
              gpsLatitude: session.asset.gpsLatitude!,
              gpsLongitude: session.asset.gpsLongitude!,
              altitude: session.asset.altitude || 100,
              gimbalPitch: session.asset.gimbalPitch || 0,
              gimbalRoll: session.asset.gimbalRoll || 0,
              gimbalYaw: session.asset.gimbalYaw || 0,
              imageWidth: session.asset.imageWidth || 4000,
              imageHeight: session.asset.imageHeight || 3000,
              cameraFov: session.asset.cameraFov || 84,
              lrfDistance: session.asset.lrfDistance || undefined,
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
        geoCoordinates = {
          type: 'Polygon',
          coordinates: [geoPoints.concat([geoPoints[0]])] // Close the polygon
        };
        
        // Calculate center point for map display
        const sumLat = geoPoints.reduce((sum: number, [lon, lat]: [number, number]) => sum + lat, 0);
        const sumLon = geoPoints.reduce((sum: number, [lon, lat]: [number, number]) => sum + lon, 0);
        centerLat = sumLat / geoPoints.length;
        centerLon = sumLon / geoPoints.length;
        
      } catch (error) {
        console.warn('Failed to convert pixel to geo coordinates:', error);
        // Continue without geo coordinates
      }
    }
    
    const annotation = await prisma.manualAnnotation.create({
      data: {
        sessionId,
        weedType,
        confidence: confidence || 'LIKELY',
        coordinates,
        geoCoordinates: geoCoordinates as any,
        centerLat,
        centerLon,
        notes,
      },
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
    console.error('Error creating manual annotation:', error);
    return NextResponse.json(
      { error: 'Failed to create manual annotation' },
      { status: 500 }
    );
  }
}
