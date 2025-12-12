import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth/config';
import prisma from '@/lib/db';
import { roboflowTrainingService } from '@/lib/services/roboflow-training';

export async function POST(request: NextRequest) {
  try {
    // Auth check - skip in development mode (auth is disabled)
    const isDev = process.env.NODE_ENV === 'development';
    let userId: string | null = null;

    if (!isDev) {
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
    if (!isDev && userId) {
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
    console.error('Error pushing to training service:', error);
    return NextResponse.json(
      { error: 'Failed to upload for training. Please try again.' },
      { status: 500 }
    );
  }
}
