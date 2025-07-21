import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/db';

export async function GET(request: NextRequest) {
  try {
    // Get all assets
    const allAssets = await prisma.asset.findMany({
      where: {
        projectId: 'default-project'
      },
      select: {
        id: true,
        fileName: true,
        gpsLatitude: true,
        gpsLongitude: true,
        altitude: true,
        metadata: true
      }
    });

    // Categorize assets
    const withGPS = allAssets.filter(a => a.gpsLatitude !== null && a.gpsLongitude !== null);
    const withoutGPS = allAssets.filter(a => a.gpsLatitude === null || a.gpsLongitude === null);

    return NextResponse.json({
      total: allAssets.length,
      withGPS: {
        count: withGPS.length,
        assets: withGPS
      },
      withoutGPS: {
        count: withoutGPS.length,
        assets: withoutGPS.map(a => ({
          id: a.id,
          fileName: a.fileName,
          hasMetadata: a.metadata !== null
        }))
      }
    });
  } catch (error) {
    console.error('Failed to check GPS:', error);
    return NextResponse.json(
      { error: 'Failed to check GPS data' },
      { status: 500 }
    );
  }
}