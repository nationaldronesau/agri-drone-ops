import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/db';

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const projectId = searchParams.get('projectId');

    // Build where clause for optional project filtering
    const whereClause = projectId ? { projectId } : {};

    // Fetch assets with optional project filter
    const assets = await prisma.asset.findMany({
      where: whereClause,
      include: {
        project: {
          select: {
            id: true,
            name: true,
            location: true,
            purpose: true,
            season: true
          }
        }
      },
      orderBy: {
        createdAt: 'desc'
      }
    });

    return NextResponse.json({ assets });
  } catch (error) {
    console.error('Failed to fetch assets:', error);
    return NextResponse.json(
      { error: 'Failed to fetch assets' },
      { status: 500 }
    );
  }
}