import { NextRequest, NextResponse } from 'next/server';
import { TemporalChangeType } from '@prisma/client';
import { z } from 'zod';
import prisma from '@/lib/db';
import { checkProjectAccess, getAuthenticatedUser } from '@/lib/auth/api-auth';
import { createSprayPlanFromTemporalHotspots } from '@/lib/services/spray-planner';
import { isTemporalInsightsEnabled } from '@/lib/utils/feature-flags';

const deltaPlanSchema = z.object({
  includedChangeTypes: z
    .array(z.nativeEnum(TemporalChangeType))
    .optional()
    .default([TemporalChangeType.NEW, TemporalChangeType.PERSISTENT]),
  riskThreshold: z.number().min(0).max(1).optional().default(0.55),
  name: z.string().optional(),
});

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; runId: string }> }
) {
  try {
    const auth = await getAuthenticatedUser();
    if (!auth.authenticated || !auth.userId) {
      return NextResponse.json({ error: auth.error || 'Unauthorized' }, { status: 401 });
    }

    const { id: projectId, runId } = await params;
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

    const run = await prisma.temporalComparisonRun.findFirst({
      where: {
        id: runId,
        projectId,
        teamId: access.teamId,
      },
      select: {
        id: true,
        status: true,
      },
    });
    if (!run) {
      return NextResponse.json({ error: 'Temporal run not found' }, { status: 404 });
    }
    if (run.status !== 'READY') {
      return NextResponse.json(
        { error: 'Temporal run must be READY before generating a delta spray plan' },
        { status: 400 }
      );
    }

    const payload = deltaPlanSchema.safeParse(await request.json().catch(() => ({})));
    if (!payload.success) {
      return NextResponse.json(
        { error: 'Invalid request body', details: payload.error.flatten() },
        { status: 400 }
      );
    }

    const result = await createSprayPlanFromTemporalHotspots({
      runId,
      projectId,
      teamId: access.teamId,
      userId: auth.userId,
      includedChangeTypes: payload.data.includedChangeTypes,
      riskThreshold: payload.data.riskThreshold,
      name: payload.data.name,
    });

    return NextResponse.json(
      {
        success: true,
        planId: result.planId,
        message: 'Delta spray plan queued for generation',
      },
      { status: 202 }
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to create delta spray plan';
    const status =
      message.toLowerCase().includes('no eligible hotspots') ||
      message.toLowerCase().includes('not found')
        ? 400
        : 500;
    return NextResponse.json({ error: message }, { status });
  }
}

