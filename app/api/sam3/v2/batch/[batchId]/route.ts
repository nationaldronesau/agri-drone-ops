import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/db';
import { checkProjectAccess } from '@/lib/auth/api-auth';
import { parseStageLog, summarizeStageLog } from '@/lib/services/sam3-batch-v2';

interface RouteParams {
  params: Promise<{ batchId: string }>;
}

const BATCH_ID_REGEX = /^c[a-z0-9]{24,}$/i;

export async function GET(
  request: NextRequest,
  { params }: RouteParams
): Promise<NextResponse> {
  const { batchId } = await params;
  const { searchParams } = new URL(request.url);
  const includeAnnotations = searchParams.get('includeAnnotations') === 'true';
  const requestedAnnotationLimit = Number.parseInt(searchParams.get('annotationLimit') || '250', 10);
  const annotationLimit = Number.isFinite(requestedAnnotationLimit)
    ? Math.min(Math.max(requestedAnnotationLimit, 1), 1000)
    : 250;

  if (!BATCH_ID_REGEX.test(batchId)) {
    return NextResponse.json(
      { success: false, error: 'Invalid batch job ID format' },
      { status: 400 }
    );
  }

  const batchJobBasic = await prisma.batchJob.findUnique({
    where: { id: batchId },
    select: { projectId: true },
  });

  if (!batchJobBasic) {
    return NextResponse.json(
      { success: false, error: 'Batch job not found' },
      { status: 404 }
    );
  }

  const projectAccess = await checkProjectAccess(batchJobBasic.projectId);
  if (!projectAccess.authenticated) {
    return NextResponse.json(
      { success: false, error: 'Authentication required' },
      { status: 401 }
    );
  }
  if (!projectAccess.hasAccess) {
    return NextResponse.json(
      { success: false, error: projectAccess.error || 'Access denied' },
      { status: 403 }
    );
  }

  const [batchJob, groupedStatusCounts, annotations] = await Promise.all([
    prisma.batchJob.findUnique({
      where: { id: batchId },
      include: {
        project: {
          select: {
            id: true,
            name: true,
          },
        },
      },
    }),
    prisma.pendingAnnotation.groupBy({
      by: ['status'],
      where: { batchJobId: batchId },
      _count: { _all: true },
    }),
    includeAnnotations
      ? prisma.pendingAnnotation.findMany({
          where: { batchJobId: batchId },
          include: {
            asset: {
              select: {
                id: true,
                fileName: true,
                storageUrl: true,
                thumbnailUrl: true,
              },
            },
          },
          orderBy: { confidence: 'desc' },
          take: annotationLimit,
        })
      : Promise.resolve([]),
  ]);

  if (!batchJob) {
    return NextResponse.json(
      { success: false, error: 'Batch job not found' },
      { status: 404 }
    );
  }

  const statusCounts = groupedStatusCounts.reduce(
    (accumulator, row) => {
      accumulator[row.status] = row._count._all;
      return accumulator;
    },
    { PENDING: 0, ACCEPTED: 0, REJECTED: 0 } as Record<string, number>
  );
  const totalAnnotations = groupedStatusCounts.reduce((sum, row) => sum + row._count._all, 0);
  const stageLog = parseStageLog(batchJob.stageLog);
  const stageSummary = summarizeStageLog(stageLog);

  return NextResponse.json({
    success: true,
    batchJob: {
      id: batchJob.id,
      projectId: batchJob.projectId,
      projectName: batchJob.project.name,
      weedType: batchJob.weedType,
      version: batchJob.version,
      mode: batchJob.mode,
      status: batchJob.status,
      totalImages: batchJob.totalImages,
      processedImages: batchJob.processedImages,
      detectionsFound: batchJob.detectionsFound,
      errorMessage: batchJob.errorMessage,
      createdAt: batchJob.createdAt,
      startedAt: batchJob.startedAt,
      completedAt: batchJob.completedAt,
      stageLog,
      latestStage: stageSummary.latestStage,
      terminalState: stageSummary.terminalState,
      assetSummary: stageSummary.assetOutcomes,
      completedWithWarnings:
        batchJob.status === 'COMPLETED' &&
        (Boolean(batchJob.errorMessage) || stageSummary.terminalState === 'completed_partial'),
    },
    summary: {
      total: totalAnnotations,
      pending: statusCounts.PENDING || 0,
      accepted: statusCounts.ACCEPTED || 0,
      rejected: statusCounts.REJECTED || 0,
    },
    annotations,
  });
}
