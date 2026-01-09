/**
 * Inference Job Status API Route
 *
 * GET /api/inference/[jobId] - Get job status
 * DELETE /api/inference/[jobId] - Cancel job
 */
import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/db';
import { getAuthenticatedUser, getUserTeamIds } from '@/lib/auth/api-auth';
import { removeInferenceJob } from '@/lib/queue/inference-queue';

function parseConfig(config: unknown) {
  if (!config || typeof config !== 'object') return {};
  return config as Record<string, unknown>;
}

export async function GET(
  _request: NextRequest,
  { params }: { params: { jobId: string } }
) {
  try {
    const auth = await getAuthenticatedUser();
    if (!auth.authenticated || !auth.userId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const membership = await getUserTeamIds();
    if (!membership.authenticated || !membership.userId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const job = await prisma.processingJob.findFirst({
      where: { id: params.jobId },
      include: {
        project: { select: { id: true, name: true, teamId: true } },
      },
    });

    if (!job) {
      return NextResponse.json({ error: 'Inference job not found' }, { status: 404 });
    }

    if (!membership.teamIds.includes(job.project.teamId)) {
      return NextResponse.json({ error: 'Access denied' }, { status: 403 });
    }

    const config = parseConfig(job.config);

    return NextResponse.json({
      id: job.id,
      status: job.status.toLowerCase(),
      progress: job.progress,
      processedImages: Number(config.processedImages || 0),
      totalImages: Number(config.totalImages || 0),
      detectionsFound: Number(config.detectionsFound || 0),
      skippedImages: Number(config.skippedImages || 0),
      duplicateImages: Number(config.duplicateImages || 0),
      errorMessage: job.errorMessage,
      project: job.project,
    });
  } catch (error) {
    console.error('Error fetching inference job:', error);
    return NextResponse.json(
      { error: 'Failed to fetch inference job' },
      { status: 500 }
    );
  }
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: { jobId: string } }
) {
  try {
    const auth = await getAuthenticatedUser();
    if (!auth.authenticated || !auth.userId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const membership = await getUserTeamIds();
    if (!membership.authenticated || !membership.userId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const job = await prisma.processingJob.findFirst({
      where: { id: params.jobId },
      include: {
        project: { select: { teamId: true } },
      },
    });

    if (!job) {
      return NextResponse.json({ error: 'Inference job not found' }, { status: 404 });
    }

    if (!membership.teamIds.includes(job.project.teamId)) {
      return NextResponse.json({ error: 'Access denied' }, { status: 403 });
    }

    if (['COMPLETED', 'FAILED', 'CANCELLED'].includes(job.status)) {
      return NextResponse.json(
        { error: `Cannot cancel job with status ${job.status}` },
        { status: 400 }
      );
    }

    await prisma.processingJob.update({
      where: { id: job.id },
      data: {
        status: 'CANCELLED',
        completedAt: new Date(),
        errorMessage: 'Cancelled by user',
      },
    });

    try {
      await removeInferenceJob(job.id);
    } catch (error) {
      console.warn('Failed to remove inference job from queue:', error);
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Error cancelling inference job:', error);
    return NextResponse.json(
      { error: 'Failed to cancel inference job' },
      { status: 500 }
    );
  }
}
