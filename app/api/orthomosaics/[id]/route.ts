import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/db';

export async function GET(request: NextRequest, { params }: { params: { id: string } }) {
  try {
    const orthomosaic = await prisma.orthomosaic.findUnique({
      where: { id: params.id },
      include: {
        project: {
          select: {
            id: true,
            name: true,
            location: true,
          }
        }
      }
    });

    if (!orthomosaic) {
      return NextResponse.json(
        { error: 'Orthomosaic not found' },
        { status: 404 }
      );
    }

    return NextResponse.json(orthomosaic);
  } catch (error) {
    console.error('Error fetching orthomosaic:', error);
    return NextResponse.json(
      { error: 'Failed to fetch orthomosaic' },
      { status: 500 }
    );
  }
}