import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth/config';
import prisma from '@/lib/db';
import { roboflowTrainingService } from '@/lib/services/roboflow-training';
import { isAuthBypassed } from '@/lib/utils/auth-bypass';

// Increase function timeout for long-running uploads (AWS/Vercel)
export const maxDuration = 300; // 5 minutes

// Maximum annotations to process in one request to avoid timeouts
const MAX_BATCH_SIZE = 10;

export async function POST(request: NextRequest) {
  try {
    // Auth check with explicit bypass for development
    let userId: string | null = null;

    if (!isAuthBypassed()) {
      const session = await getServerSession(authOptions);
      if (!session?.user?.id) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
      }
      userId = session.user.id;
    }

    const body = await request.json();
    const { sessionId } = body;

    if (!sessionId) {
      return NextResponse.json(
        { error: 'sessionId is required' },
        { status: 400 }
      );
    }

    // Fetch session with project/team info for authorization
    const annotationSession = await prisma.annotationSession.findUnique({
      where: { id: sessionId },
      include: {
        asset: {
          include: {
            project: {
              include: {
                team: {
                  include: {
                    members: true,
                  },
                },
              },
            },
          },
        },
      },
    });

    if (!annotationSession) {
      return NextResponse.json(
        { error: 'Session not found' },
        { status: 404 }
      );
    }

    // Authorization check - verify user has access to this project's team
    if (!isAuthBypassed() && userId) {
      const team = annotationSession.asset.project?.team;
      if (team) {
        const isMember = team.members.some((member) => member.userId === userId);
        if (!isMember) {
          return NextResponse.json(
            { error: 'You do not have access to this session' },
            { status: 403 }
          );
        }
      }
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

    // Process in batches to avoid timeout
    const annotationIds = annotations.map((a) => a.id);
    const batchSize = Math.min(annotationIds.length, MAX_BATCH_SIZE);
    const batchToProcess = annotationIds.slice(0, batchSize);
    const remaining = annotationIds.length - batchSize;

    console.log(`[Push-Session] Processing ${batchToProcess.length} of ${annotationIds.length} annotations`);

    // Push batch to Roboflow
    const result = await roboflowTrainingService.uploadBatch(batchToProcess);

    // If all uploads failed, return an error with details
    if (result.success === 0 && result.failed > 0) {
      const firstError = result.errors[0]?.error || 'Unknown error';
      console.error('All training uploads failed:', result.errors);
      return NextResponse.json(
        {
          error: `Failed to upload annotations: ${firstError}`,
          details: result.errors.slice(0, 3), // First 3 errors for debugging
        },
        { status: 500 }
      );
    }

    return NextResponse.json({
      success: true,
      pushed: result.success,
      failed: result.failed,
      remaining: remaining,
      message: remaining > 0
        ? `Uploaded ${result.success} annotations. ${remaining} more remaining - click again to continue.`
        : `Successfully uploaded ${result.success} annotations.`,
      errors: result.errors.length > 0 ? result.errors : undefined,
    });
  } catch (error) {
    console.error('Error pushing to training service:', error);
    // Provide more helpful error messages
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json(
      { error: `Failed to upload for training: ${errorMessage}` },
      { status: 500 }
    );
  }
}
