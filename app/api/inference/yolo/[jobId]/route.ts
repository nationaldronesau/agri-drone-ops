import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/db';
import { getAuthenticatedUser } from '@/lib/auth/api-auth';

export async function GET(
  _request: NextRequest,
  { params }: { params: { jobId: string } }
) {
  try {
    const auth = await getAuthenticatedUser();
    if (!auth.authenticated || !auth.userId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const job = await prisma.yOLOInferenceJob.findUnique({
      where: { id: params.jobId },
      include: { project: { select: { teamId: true } } },
    });

    if (!job) {
      return NextResponse.json({ error: 'Inference job not found' }, { status: 404 });
    }

    const membership = await prisma.teamMember.findFirst({
      where: { teamId: job.project.teamId, userId: auth.userId },
      select: { id: true },
    });

    if (!membership) {
      return NextResponse.json({ error: 'Access denied' }, { status: 403 });
    }

    return NextResponse.json({
      jobId: job.id,
      status: job.status.toLowerCase(),
      processedImages: job.processedImages,
      totalImages: job.totalImages,
      detectionsFound: job.detectionsFound,
      errorMessage: job.errorMessage,
      completedAt: job.completedAt,
    });
  } catch (error) {
    console.error('Error fetching YOLO inference job:', error);
    return NextResponse.json(
      { error: 'Failed to fetch inference job' },
      { status: 500 }
    );
  }
}
