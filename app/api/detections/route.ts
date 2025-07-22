import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/db';

export async function GET(request: NextRequest) {
  try {
    const searchParams = request.nextUrl.searchParams;
    const projectId = searchParams.get('projectId');
    const assetId = searchParams.get('assetId');
    
    const where: any = {};
    if (projectId) {
      where.job = {
        projectId: projectId
      };
    }
    if (assetId) {
      where.assetId = assetId;
    }
    
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
        createdAt: 'desc'
      }
    });
    
    return NextResponse.json(detections);
  } catch (error) {
    console.error('Error fetching detections:', error);
    return NextResponse.json(
      { error: 'Failed to fetch detections' },
      { status: 500 }
    );
  }
}