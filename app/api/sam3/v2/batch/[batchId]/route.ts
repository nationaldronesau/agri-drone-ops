import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/db';
import { checkProjectAccess } from '@/lib/auth/api-auth';
import { parseStageLog, summarizeStageLog } from '@/lib/services/sam3-batch-v2';
import {
  SAM3_BATCH_JOB_KINDS,
  summarizeChildBatchJobs,
} from '@/lib/utils/sam3-batch-jobs';
import { summarizeSam3BatchExecution } from '@/lib/utils/sam3-batch-execution';

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

  const batchJob = await prisma.batchJob.findUnique({
    where: { id: batchId },
    include: {
      project: {
        select: {
          id: true,
          name: true,
        },
      },
    },
  });

  if (!batchJob) {
    return NextResponse.json(
      { success: false, error: 'Batch job not found' },
      { status: 404 }
    );
  }

  if (batchJob.kind === SAM3_BATCH_JOB_KINDS.AGGREGATE) {
    const childJobs = await prisma.batchJob.findMany({
      where: { parentBatchJobId: batchJob.id },
      orderBy: [
        { shardIndex: 'asc' },
        { createdAt: 'asc' },
      ],
      select: {
        id: true,
        status: true,
        processedImages: true,
        totalImages: true,
        detectionsFound: true,
        errorMessage: true,
        shardIndex: true,
        shardCount: true,
        stageLog: true,
      },
    });
    const childBatchJobIds = childJobs.map((childJob) => childJob.id);

    const [groupedStatusCounts, annotations] = await Promise.all([
      prisma.pendingAnnotation.groupBy({
        by: ['status'],
        where: {
          batchJobId: { in: childBatchJobIds.length > 0 ? childBatchJobIds : ['__none__'] },
        },
        _count: { _all: true },
      }),
      includeAnnotations
        ? prisma.pendingAnnotation.findMany({
            where: {
              batchJobId: { in: childBatchJobIds.length > 0 ? childBatchJobIds : ['__none__'] },
            },
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

    const childStageSummaries = childJobs.map((childJob) => {
      const stageLog = parseStageLog(childJob.stageLog);
      const stageSummary = summarizeStageLog(stageLog);
      const latestStageEntry = [...stageLog]
        .reverse()
        .find((entry) => entry.stage !== 'terminal');

      return {
        id: childJob.id,
        status: childJob.status,
        processedImages: childJob.processedImages,
        totalImages: childJob.totalImages,
        detectionsFound: childJob.detectionsFound,
        errorMessage: childJob.errorMessage,
        shardIndex: childJob.shardIndex,
        shardCount: childJob.shardCount,
        latestStage: stageSummary.latestStage,
        latestStageTimestamp: latestStageEntry?.timestamp || null,
        terminalState: stageSummary.terminalState,
        assetSummary: stageSummary.assetOutcomes,
      };
    });

    const aggregateStageInfo = summarizeChildBatchJobs(childStageSummaries);
    const execution = summarizeSam3BatchExecution(
      childJobs.map((childJob) => parseStageLog(childJob.stageLog)),
      batchJob.mode
    );
    const assetSummary = childStageSummaries.reduce(
      (summary, child) => {
        summary.success += child.assetSummary.success;
        summary.zero_detections += child.assetSummary.zero_detections;
        summary.oom += child.assetSummary.oom;
        summary.inference_error += child.assetSummary.inference_error;
        summary.prepare_error += child.assetSummary.prepare_error;
        return summary;
      },
      {
        success: 0,
        zero_detections: 0,
        oom: 0,
        inference_error: 0,
        prepare_error: 0,
      }
    );

    const statusCounts = groupedStatusCounts.reduce(
      (accumulator, row) => {
        accumulator[row.status] = row._count._all;
        return accumulator;
      },
      { PENDING: 0, ACCEPTED: 0, REJECTED: 0 } as Record<string, number>
    );
    const totalAnnotations = groupedStatusCounts.reduce((sum, row) => sum + row._count._all, 0);

    return NextResponse.json({
      success: true,
      batchJob: {
        id: batchJob.id,
        projectId: batchJob.projectId,
        projectName: batchJob.project.name,
        weedType: batchJob.weedType,
        version: batchJob.version,
        kind: batchJob.kind,
        mode: batchJob.mode,
        status: aggregateStageInfo.status,
        totalImages: batchJob.totalImages,
        processedImages: aggregateStageInfo.processedImages,
        detectionsFound: aggregateStageInfo.detectionsFound,
        errorMessage: aggregateStageInfo.errorMessage,
        createdAt: batchJob.createdAt,
        startedAt: batchJob.startedAt,
        completedAt: batchJob.completedAt,
        stageLog: [],
        latestStage: aggregateStageInfo.latestStage,
        terminalState: aggregateStageInfo.terminalState,
        assetSummary,
        shardCount: batchJob.shardCount ?? childJobs.length,
        completedShards: aggregateStageInfo.completedShards,
        failedShards: aggregateStageInfo.failedShards,
        childStatuses: aggregateStageInfo.childStatuses,
        completedWithWarnings: aggregateStageInfo.completedWithWarnings,
      },
      summary: {
        total: totalAnnotations,
        pending: statusCounts.PENDING || 0,
        accepted: statusCounts.ACCEPTED || 0,
        rejected: statusCounts.REJECTED || 0,
      },
      execution,
      annotations,
    });
  }

  const [groupedStatusCounts, annotations] = await Promise.all([
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
  const execution = summarizeSam3BatchExecution([stageLog], batchJob.mode);

  return NextResponse.json({
    success: true,
    batchJob: {
      id: batchJob.id,
      projectId: batchJob.projectId,
      projectName: batchJob.project.name,
      weedType: batchJob.weedType,
      version: batchJob.version,
      kind: batchJob.kind || SAM3_BATCH_JOB_KINDS.SINGLE,
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
      shardCount: batchJob.shardCount ?? null,
      completedShards: batchJob.kind === SAM3_BATCH_JOB_KINDS.SHARD ? null : 0,
      failedShards: batchJob.kind === SAM3_BATCH_JOB_KINDS.SHARD ? null : 0,
      childStatuses: [],
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
    execution,
    annotations,
  });
}
