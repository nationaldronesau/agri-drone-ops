/**
 * Training Dataset Preview API
 *
 * POST /api/training/datasets/preview - Preview dataset counts before export
 */
import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/db';
import { datasetPreparation } from '@/lib/services/dataset-preparation';
import { getAuthenticatedUser } from '@/lib/auth/api-auth';
import { checkRateLimit } from '@/lib/utils/security';

export async function POST(request: NextRequest) {
  try {
    const auth = await getAuthenticatedUser();
    if (!auth.authenticated || !auth.userId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const rateLimitKey = `training-datasets-preview:${auth.userId}`;
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
    const {
      projectId,
      sessionIds,
      classes,
      splitRatio,
      includeAIDetections = true,
      includeManualAnnotations = true,
      minConfidence = 0.5,
    } = body;

    if (!projectId) {
      return NextResponse.json({ error: 'projectId is required' }, { status: 400 });
    }

    if (classes && !Array.isArray(classes)) {
      return NextResponse.json({ error: 'classes must be an array if provided' }, { status: 400 });
    }

    if (splitRatio) {
      const total = (splitRatio.train ?? 0) + (splitRatio.val ?? 0) + (splitRatio.test ?? 0);
      if (total <= 0) {
        return NextResponse.json({ error: 'splitRatio must have positive values' }, { status: 400 });
      }
    }

    const project = await prisma.project.findFirst({
      where: {
        id: projectId,
        team: {
          members: {
            some: { userId: auth.userId },
          },
        },
      },
      select: {
        id: true,
        teamId: true,
      },
    });

    if (!project) {
      return NextResponse.json(
        { error: 'Project not found or access denied' },
        { status: 403 }
      );
    }

    if (sessionIds && sessionIds.length > 0) {
      const sessionCount = await prisma.annotationSession.count({
        where: {
          id: { in: sessionIds },
          asset: { projectId },
        },
      });
      if (sessionCount !== sessionIds.length) {
        return NextResponse.json(
          { error: 'One or more sessionIds do not belong to the project' },
          { status: 400 }
        );
      }
    }

    const preview = await datasetPreparation.previewDataset({
      projectId,
      sessionIds,
      classes,
      splitRatio: splitRatio || { train: 0.7, val: 0.2, test: 0.1 },
      includeAIDetections,
      includeManualAnnotations,
      minConfidence,
    });

    return NextResponse.json({ preview });
  } catch (error) {
    console.error('Error previewing dataset:', error);
    const message = error instanceof Error ? error.message : 'Failed to preview dataset';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
