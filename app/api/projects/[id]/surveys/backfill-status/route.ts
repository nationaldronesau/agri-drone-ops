import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/db';
import { checkProjectAccess, getAuthenticatedUser } from '@/lib/auth/api-auth';
import {
  getProjectSurveyBackfillStatus,
  scheduleProjectSurveyBackfill,
} from '@/lib/services/survey';
import { isTemporalInsightsEnabled } from '@/lib/utils/feature-flags';

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
      select: {
        id: true,
        features: true,
      },
    });
    if (!project) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 });
    }
    if (!isTemporalInsightsEnabled(project.features)) {
      return NextResponse.json({ error: 'Feature not enabled' }, { status: 403 });
    }

    const trigger = request.nextUrl.searchParams.get('trigger') === 'true';
    const status = await getProjectSurveyBackfillStatus(projectId);
    if (trigger && status.stale && status.status !== 'running') {
      scheduleProjectSurveyBackfill(projectId);
    }

    return NextResponse.json({
      projectId,
      ...status,
    });
  } catch (error) {
    console.error('Failed to fetch survey backfill status:', error);
    return NextResponse.json({ error: 'Failed to fetch backfill status' }, { status: 500 });
  }
}

