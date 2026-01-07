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

    // Get user's teams to filter accessible sessions
    const userTeams = await getUserTeamIds();
    if (userTeams.dbError) {
      return NextResponse.json(
        { error: 'Database error while fetching team access' },
        { status: 500 }
      );
    }
    if (userTeams.teamIds.length === 0) {
      return NextResponse.json([]);
    }

    const searchParams = request.nextUrl.searchParams;
    const assetId = searchParams.get('assetId');
    const status = searchParams.get('status');

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const where: any = {
      // Filter by user's teams through asset -> project -> team
      asset: {
        project: {
          teamId: { in: userTeams.teamIds }
        }
      }
    };
    if (assetId) {
      where.assetId = assetId;
    }
    if (status) {
      where.status = status;
    }

    const sessions = await prisma.annotationSession.findMany({
      where,
      include: {
        asset: {
          select: {
            id: true,
            fileName: true,
            storageUrl: true,
            imageWidth: true,
            imageHeight: true,
            gpsLatitude: true,
            gpsLongitude: true,
            project: {
              select: {
                id: true,
                name: true,
                location: true,
              }
            }
          }
        },
        annotations: {
          select: {
            id: true,
            weedType: true,
            confidence: true,
            coordinates: true,
            notes: true,
            verified: true,
            pushedToTraining: true,
            pushedAt: true,
            roboflowImageId: true,
          }
        },
        _count: {
          select: {
            annotations: true,
          }
        }
      },
      orderBy: {
        updatedAt: 'desc'
      }
    });
    
    return NextResponse.json(sessions);
  } catch (error) {
    console.error('Error fetching annotation sessions:', error);
    return NextResponse.json(
      { error: 'Failed to fetch annotation sessions' },
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
    const { assetId } = body;

    if (!assetId) {
      return NextResponse.json(
        { error: 'Asset ID is required' },
        { status: 400 }
      );
    }

    // Check if asset exists and verify user has access through team membership
    const asset = await prisma.asset.findUnique({
      where: { id: assetId },
      select: {
        id: true,
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
    });

    if (!asset) {
      return NextResponse.json(
        { error: 'Asset not found' },
        { status: 404 }
      );
    }

    // Verify user is a member of the asset's project team
    if (!asset.project?.team?.members || asset.project.team.members.length === 0) {
      return NextResponse.json(
        { error: 'Access denied - not a member of this project\'s team' },
        { status: 403 }
      );
    }
    
    // Use a transaction to prevent race conditions
    // This ensures that only one session can be created for an asset at a time
    // Note: SQLite doesn't support Serializable isolation, so we use default isolation
    // and rely on the transaction's atomicity. For PostgreSQL, we use Serializable.
    const isPostgres = process.env.DATABASE_URL?.includes('postgresql');

    const transactionOptions = isPostgres
      ? { isolationLevel: 'Serializable' as const }
      : {}; // SQLite uses default DEFERRED transactions

    try {
      const session = await prisma.$transaction(async (tx) => {
        // Check if there's already an active session for this asset
        const existingSession = await tx.annotationSession.findFirst({
          where: {
            assetId,
            status: 'IN_PROGRESS'
          },
          include: {
            asset: {
              select: {
                id: true,
                fileName: true,
                storageUrl: true,
                imageWidth: true,
                imageHeight: true,
                gpsLatitude: true,
                gpsLongitude: true,
                altitude: true,
                gimbalPitch: true,
                gimbalRoll: true,
                gimbalYaw: true,
                project: {
                  select: {
                    id: true,
                    name: true,
                    location: true,
                  }
                }
              }
            },
            annotations: true,
          }
        });

        if (existingSession) {
          // Return existing session - no need to create a new one
          return existingSession;
        }

        // Create new annotation session within the transaction
        return await tx.annotationSession.create({
          data: {
            assetId,
            userId: auth.userId,
            status: 'IN_PROGRESS',
          },
          include: {
            asset: {
              select: {
                id: true,
                fileName: true,
                storageUrl: true,
                imageWidth: true,
                imageHeight: true,
                gpsLatitude: true,
                gpsLongitude: true,
                altitude: true,
                gimbalPitch: true,
                gimbalRoll: true,
                gimbalYaw: true,
                project: {
                  select: {
                    id: true,
                    name: true,
                    location: true,
                  }
                }
              }
            },
            annotations: true,
          }
        });
      }, transactionOptions);

      return NextResponse.json(session);
    } catch (error: any) {
      // Handle serialization failures (P2034) - suggest retry
      if (error?.code === 'P2034') {
        return NextResponse.json(
          { error: 'Session creation conflict - please try again', retryable: true },
          { status: 409 }
        );
      }
      throw error; // Re-throw other errors to be caught by outer catch
    }
  } catch (error) {
    console.error('Error creating annotation session:', error);
    return NextResponse.json(
      { error: 'Failed to create annotation session' },
      { status: 500 }
    );
  }
}
