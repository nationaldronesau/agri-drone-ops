import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/db';
import { roboflowTrainingService } from '@/lib/services/roboflow-training';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { sessionId } = body;

    if (!sessionId) {
      return NextResponse.json(
        { error: 'sessionId is required' },
        { status: 400 }
      );
    }

    // Get all verified but not yet pushed annotations from this session
    const annotations = await prisma.manualAnnotation.findMany({
      where: {
        sessionId,
        verified: true,
        pushedToTraining: false,
      },
      select: { id: true },
    });

    if (annotations.length === 0) {
      return NextResponse.json({
        success: true,
        pushed: 0,
        message: 'No verified annotations to push',
      });
    }

    // Push to Roboflow
    const annotationIds = annotations.map((a) => a.id);
    const result = await roboflowTrainingService.uploadBatch(annotationIds);

    return NextResponse.json({
      success: true,
      pushed: result.success,
      failed: result.failed,
      errors: result.errors,
    });
  } catch (error) {
    console.error('Error pushing to Roboflow:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to push to Roboflow' },
      { status: 500 }
    );
  }
}
