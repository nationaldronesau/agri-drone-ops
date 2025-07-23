import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/db';

export async function GET(request: NextRequest) {
  try {
    const orthomosaics = await prisma.orthomosaic.findMany({
      include: {
        project: {
          select: {
            id: true,
            name: true,
            location: true,
          }
        }
      },
      orderBy: {
        createdAt: 'desc'
      }
    });

    return NextResponse.json(orthomosaics);
  } catch (error) {
    console.error('Error fetching orthomosaics:', error);
    return NextResponse.json(
      { error: 'Failed to fetch orthomosaics' },
      { status: 500 }
    );
  }
}