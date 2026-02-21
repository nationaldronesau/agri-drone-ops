import { NextRequest, NextResponse } from 'next/server';
import { Prisma, TemporalRunStatus } from '@prisma/client';
import { z } from 'zod';
import prisma from '@/lib/db';
import { checkProjectAccess, getAuthenticatedUser } from '@/lib/auth/api-auth';
import { enqueueTemporalJob } from '@/lib/queue/temporal-queue';
import { isTemporalInsightsEnabled } from '@/lib/utils/feature-flags';

const createRunSchema = z.object({
  baselineSurveyId: z.string().min(1),
  comparisonSurveyId: z.string().min(1),
  species: z.array(z.string().min(1)).optional().default([]),
  minConfidence: z.number().min(0).max(1).optional().default(0.45),
});

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const auth = await getAuthenticatedUser();
    if (!auth.authenticated || !auth.userId) {
      return NextResponse.json({ error: auth.error || 'Unauthorized' }, { status: 401 });
    }

    const { id: projectId } = await params;
    const access = await checkProjectAccess(projectId);
    if (!access.hasAccess || !access.teamId) {
      return NextResponse.json({ error: access.error || 'Access denied' }, { status: 403 });
    }

    const project = await prisma.project.findUnique({
      where: { id: projectId },
      select: { features: true },
    });
    if (!project) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 });
    }
    if (!isTemporalInsightsEnabled(project.features)) {
      return NextResponse.json({ error: 'Feature not enabled' }, { status: 403 });
    }

    const searchParams = request.nextUrl.searchParams;
    const status = searchParams.get('status');
    const limit = Math.max(1, Math.min(100, Number(searchParams.get('limit') || '20')));
    const offset = Math.max(0, Number(searchParams.get('offset') || '0'));

    const where: Prisma.TemporalComparisonRunWhereInput = {
      teamId: access.teamId,
      projectId,
    };
    if (status && status in TemporalRunStatus) {
      where.status = status as TemporalRunStatus;
    }

    const [runs, total] = await Promise.all([
      prisma.temporalComparisonRun.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: limit,
        skip: offset,
        include: {
          baselineSurvey: {
            select: { id: true, name: true, startedAt: true, endedAt: true },
          },
          comparisonSurvey: {
            select: { id: true, name: true, startedAt: true, endedAt: true },
          },
        },
      }),
      prisma.temporalComparisonRun.count({ where }),
    ]);

    return NextResponse.json({
      runs,
      total,
      limit,
      offset,
    });
  } catch (error) {
    console.error('Failed to list temporal runs:', error);
    return NextResponse.json({ error: 'Failed to list temporal runs' }, { status: 500 });
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const auth = await getAuthenticatedUser();
    if (!auth.authenticated || !auth.userId) {
      return NextResponse.json({ error: auth.error || 'Unauthorized' }, { status: 401 });
    }

    const { id: projectId } = await params;
    const access = await checkProjectAccess(projectId);
    if (!access.hasAccess || !access.teamId) {
      return NextResponse.json({ error: access.error || 'Access denied' }, { status: 403 });
    }

    const project = await prisma.project.findUnique({
      where: { id: projectId },
      select: { features: true },
    });
    if (!project) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 });
    }
    if (!isTemporalInsightsEnabled(project.features)) {
      return NextResponse.json({ error: 'Feature not enabled' }, { status: 403 });
    }

    const payload = createRunSchema.safeParse(await request.json());
    if (!payload.success) {
      return NextResponse.json(
        { error: 'Invalid request body', details: payload.error.flatten() },
        { status: 400 }
      );
    }

    const body = payload.data;
    if (body.baselineSurveyId === body.comparisonSurveyId) {
      return NextResponse.json(
        { error: 'baselineSurveyId and comparisonSurveyId must be different' },
        { status: 400 }
      );
    }

    const [baselineSurvey, comparisonSurvey] = await Promise.all([
      prisma.survey.findFirst({
        where: {
          id: body.baselineSurveyId,
          projectId,
          teamId: access.teamId,
        },
        select: { id: true },
      }),
      prisma.survey.findFirst({
        where: {
          id: body.comparisonSurveyId,
          projectId,
          teamId: access.teamId,
        },
        select: { id: true },
      }),
    ]);

    if (!baselineSurvey || !comparisonSurvey) {
      return NextResponse.json(
        { error: 'One or both surveys do not belong to the selected project' },
        { status: 400 }
      );
    }

    const run = await prisma.temporalComparisonRun.create({
      data: {
        teamId: access.teamId,
        projectId,
        baselineSurveyId: body.baselineSurveyId,
        comparisonSurveyId: body.comparisonSurveyId,
        createdById: auth.userId,
        status: TemporalRunStatus.QUEUED,
        progress: 0,
        config: {
          species: body.species,
          minConfidence: body.minConfidence,
        } as Prisma.InputJsonValue,
      },
      select: { id: true, status: true },
    });

    await prisma.auditLog.create({
      data: {
        action: 'CREATE',
        entityType: 'TemporalComparisonRun',
        entityId: run.id,
        userId: auth.userId,
        beforeState: null,
        afterState: {
          status: run.status,
          baselineSurveyId: body.baselineSurveyId,
          comparisonSurveyId: body.comparisonSurveyId,
        } as Prisma.InputJsonValue,
      },
    });

    try {
      await enqueueTemporalJob({
        runId: run.id,
        projectId,
        teamId: access.teamId,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to enqueue temporal job';
      await prisma.temporalComparisonRun.update({
        where: { id: run.id },
        data: {
          status: TemporalRunStatus.FAILED,
          progress: 100,
          completedAt: new Date(),
          errorMessage: message,
        },
      });
      return NextResponse.json({ error: message }, { status: 500 });
    }

    return NextResponse.json(
      {
        success: true,
        runId: run.id,
        status: run.status,
        message: 'Temporal comparison queued',
      },
      { status: 202 }
    );
  } catch (error) {
    console.error('Failed to create temporal run:', error);
    return NextResponse.json({ error: 'Failed to create temporal run' }, { status: 500 });
  }
}

