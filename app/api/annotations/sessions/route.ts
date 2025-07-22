import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/db';

export async function GET(request: NextRequest) {
  try {
    const searchParams = request.nextUrl.searchParams;
    const assetId = searchParams.get('assetId');
    const status = searchParams.get('status');
    
    const where: any = {};
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
            project: {
              select: {
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
            verified: true,
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
    const body = await request.json();
    const { assetId, userId } = body;
    
    if (!assetId) {
      return NextResponse.json(
        { error: 'Asset ID is required' },
        { status: 400 }
      );
    }
    
    // Check if asset exists
    const asset = await prisma.asset.findUnique({
      where: { id: assetId }
    });
    
    if (!asset) {
      return NextResponse.json(
        { error: 'Asset not found' },
        { status: 404 }
      );
    }
    
    // Check if there's already an active session for this asset
    const existingSession = await prisma.annotationSession.findFirst({
      where: {
        assetId,
        status: 'IN_PROGRESS'
      }
    });
    
    if (existingSession) {
      // Return existing session instead of creating new one
      return NextResponse.json(existingSession);
    }
    
    // Create new annotation session
    const session = await prisma.annotationSession.create({
      data: {
        assetId,
        userId,
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
                name: true,
                location: true,
              }
            }
          }
        },
        annotations: true,
      }
    });
    
    return NextResponse.json(session);
  } catch (error) {
    console.error('Error creating annotation session:', error);
    return NextResponse.json(
      { error: 'Failed to create annotation session' },
      { status: 500 }
    );
  }
}