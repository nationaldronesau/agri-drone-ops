import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/db';

export async function GET(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const session = await prisma.annotationSession.findUnique({
      where: { id: params.id },
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
        annotations: {
          orderBy: {
            createdAt: 'desc'
          }
        },
        _count: {
          select: {
            annotations: true,
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
    
    return NextResponse.json(session);
  } catch (error) {
    console.error('Error fetching annotation session:', error);
    return NextResponse.json(
      { error: 'Failed to fetch annotation session' },
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
    const { status, userId } = body;
    
    const updateData: any = {};
    
    if (status) {
      updateData.status = status;
      if (status === 'COMPLETED') {
        updateData.completedAt = new Date();
      }
    }
    
    if (userId !== undefined) {
      updateData.userId = userId;
    }
    
    const session = await prisma.annotationSession.update({
      where: { id: params.id },
      data: updateData,
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
      }
    });
    
    return NextResponse.json(session);
  } catch (error) {
    console.error('Error updating annotation session:', error);
    return NextResponse.json(
      { error: 'Failed to update annotation session' },
      { status: 500 }
    );
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const session = await prisma.annotationSession.findUnique({
      where: { id: params.id }
    });
    
    if (!session) {
      return NextResponse.json(
        { error: 'Annotation session not found' },
        { status: 404 }
      );
    }
    
    // Delete session (this will cascade delete all annotations)
    await prisma.annotationSession.delete({
      where: { id: params.id }
    });
    
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Error deleting annotation session:', error);
    return NextResponse.json(
      { error: 'Failed to delete annotation session' },
      { status: 500 }
    );
  }
}