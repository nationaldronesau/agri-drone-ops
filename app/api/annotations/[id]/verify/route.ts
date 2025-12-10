import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/db';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;

    const annotation = await prisma.manualAnnotation.findUnique({
      where: { id },
    });

    if (!annotation) {
      return NextResponse.json(
        { error: 'Annotation not found' },
        { status: 404 }
      );
    }

    const updated = await prisma.manualAnnotation.update({
      where: { id },
      data: {
        verified: true,
        verifiedAt: new Date(),
      },
    });

    return NextResponse.json({
      id: updated.id,
      verified: updated.verified,
      verifiedAt: updated.verifiedAt,
    });
  } catch (error) {
    console.error('Error verifying annotation:', error);
    return NextResponse.json(
      { error: 'Failed to verify annotation' },
      { status: 500 }
    );
  }
}
