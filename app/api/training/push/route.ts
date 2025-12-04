/**
 * Training Push API
 *
 * POST - Push manual annotations to Roboflow for training
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth/config';
import { prisma } from '@/lib/db';
import { roboflowTrainingService } from '@/lib/services/roboflow-training';
import { checkRateLimit } from '@/lib/utils/security';

export async function POST(request: NextRequest) {
  try {
    // Check authentication
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // Rate limit training push (10 per minute per user)
    const rateLimitKey = `training-push:${session.user.id}`;
    const rateLimit = checkRateLimit(rateLimitKey, { maxRequests: 10, windowMs: 60000 });
    if (!rateLimit.allowed) {
      return NextResponse.json(
        { error: 'Rate limit exceeded. Please try again later.' },
        {
          status: 429,
          headers: {
            'X-RateLimit-Remaining': '0',
            'X-RateLimit-Reset': rateLimit.resetTime.toString(),
          },
        }
      );
    }

    const body = await request.json();
    const { projectId, roboflowProjectId, trainValidSplit = 0.8 } = body;

    if (!projectId) {
      return NextResponse.json({ error: 'projectId is required' }, { status: 400 });
    }

    // Verify user has access to the project (through team membership)
    const project = await prisma.project.findFirst({
      where: {
        id: projectId,
        team: {
          members: {
            some: {
              userId: session.user.id,
            },
          },
        },
      },
    });

    if (!project) {
      return NextResponse.json(
        { error: 'Project not found or access denied' },
        { status: 403 }
      );
    }

    // Get all unpushed, verified annotations for the project
    const annotations = await prisma.manualAnnotation.findMany({
      where: {
        session: {
          asset: {
            projectId,
          },
        },
        verified: true,
        pushedToTraining: false,
      },
      select: {
        id: true,
      },
    });

    if (annotations.length === 0) {
      return NextResponse.json({
        success: true,
        pushed: 0,
        message: 'No unpushed annotations found',
      });
    }

    const annotationIds = annotations.map((a) => a.id);

    // Determine train/valid split
    const trainCount = Math.floor(annotationIds.length * trainValidSplit);
    const trainIds = annotationIds.slice(0, trainCount);
    const validIds = annotationIds.slice(trainCount);

    let successCount = 0;
    const errors: { id: string; error: string }[] = [];

    // Push training set
    if (trainIds.length > 0) {
      const trainResult = await roboflowTrainingService.uploadBatch(
        trainIds,
        'train',
        roboflowProjectId
      );
      successCount += trainResult.success;
      errors.push(...trainResult.errors);
    }

    // Push validation set
    if (validIds.length > 0) {
      const validResult = await roboflowTrainingService.uploadBatch(
        validIds,
        'valid',
        roboflowProjectId
      );
      successCount += validResult.success;
      errors.push(...validResult.errors);
    }

    return NextResponse.json({
      success: true,
      pushed: successCount,
      failed: errors.length,
      trainCount: trainIds.length,
      validCount: validIds.length,
      errors: errors.slice(0, 10), // Limit error details
    });
  } catch (error) {
    console.error('Error pushing annotations:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to push annotations' },
      { status: 500 }
    );
  }
}
