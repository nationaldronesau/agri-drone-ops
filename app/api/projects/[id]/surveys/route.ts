import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/db';
import { checkProjectAccess, getAuthenticatedUser } from '@/lib/auth/api-auth';
import {
  getProjectSurveyBackfillStatus,
  listProjectSurveys,
  scheduleProjectSurveyBackfill,
} from '@/lib/services/survey';
import { isTemporalInsightsEnabled } from '@/lib/utils/feature-flags';

export async function GET(
  _request: NextRequest,
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
        name: true,
        teamId: true,
        features: true,
      },
    });
    if (!project) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 });
    }

    if (!isTemporalInsightsEnabled(project.features)) {
      return NextResponse.json({ error: 'Feature not enabled' }, { status: 403 });
    }

    const backfillStatus = await getProjectSurveyBackfillStatus(projectId);
    if (
      backfillStatus.stale &&
      backfillStatus.status !== 'running'
    ) {
      scheduleProjectSurveyBackfill(projectId);
    }

    const surveys = await listProjectSurveys(projectId);
    const defaultComparison = surveys[0] || null;
    const defaultBaseline = surveys[1] || null;

    return NextResponse.json({
      project: {
        id: project.id,
        name: project.name,
      },
      surveys,
      defaults: {
        baselineSurveyId: defaultBaseline?.id || null,
        comparisonSurveyId: defaultComparison?.id || null,
      },
      backfillStatus,
    });
  } catch (error) {
    console.error('Failed to fetch project surveys:', error);
    return NextResponse.json({ error: 'Failed to fetch surveys' }, { status: 500 });
  }
}

