/**
 * SAM3 Batch Job Status API
 *
 * Get details of a specific batch job and its pending annotations.
 *
 * Security:
 * - Authentication required
 * - Project membership validated through batch job's project
 */
import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/db';
import { checkProjectAccess } from '@/lib/auth/api-auth';

interface RouteParams {
  params: Promise<{ id: string }>;
}

export async function GET(
  request: NextRequest,
  { params }: RouteParams
): Promise<NextResponse> {
  const { id } = await params;
  const { searchParams } = new URL(request.url);
  const includeAnnotations = searchParams.get('includeAnnotations') === 'true';
  const requestedAnnotationLimit = Number.parseInt(
    searchParams.get('annotationLimit') || '250',
    10
  );
  const annotationLimit = Number.isFinite(requestedAnnotationLimit)
    ? Math.min(Math.max(requestedAnnotationLimit, 1), 1000)
    : 250;

  // Validate ID format
  if (!/^c[a-z0-9]{24,}$/i.test(id)) {
    return NextResponse.json(
      { error: 'Invalid batch job ID format', success: false },
      { status: 400 }
    );
  }

  try {
    // First get the batch job to find its project
    const batchJobBasic = await prisma.batchJob.findUnique({
      where: { id },
      select: { projectId: true },
    });

    if (!batchJobBasic) {
      return NextResponse.json(
        { error: 'Batch job not found', success: false },
        { status: 404 }
      );
    }

    // Check authentication and project access
    const projectAccess = await checkProjectAccess(batchJobBasic.projectId);
    if (!projectAccess.authenticated) {
      return NextResponse.json(
        { error: 'Authentication required', success: false },
        { status: 401 }
      );
    }
    if (!projectAccess.hasAccess) {
      return NextResponse.json(
        { error: projectAccess.error || 'Access denied', success: false },
        { status: 403 }
      );
    }

    const [batchJob, groupedStatusCounts, annotations] = await Promise.all([
      prisma.batchJob.findUnique({
        where: { id },
        include: {
          project: {
            select: {
              id: true,
              name: true,
            }
          }
        }
      }),
      prisma.pendingAnnotation.groupBy({
        by: ['status'],
        where: { batchJobId: id },
        _count: { _all: true },
      }),
      includeAnnotations
        ? prisma.pendingAnnotation.findMany({
            where: { batchJobId: id },
            include: {
              asset: {
                select: {
                  id: true,
                  fileName: true,
                  storageUrl: true,
                  thumbnailUrl: true,
                }
              }
            },
            orderBy: { confidence: 'desc' },
            take: annotationLimit,
          })
        : Promise.resolve([]),
    ]);

    if (!batchJob) {
      return NextResponse.json(
        { error: 'Batch job not found', success: false },
        { status: 404 }
      );
    }

    const statusCounts = groupedStatusCounts.reduce(
      (acc, row) => {
        acc[row.status] = row._count._all;
        return acc;
      },
      { PENDING: 0, ACCEPTED: 0, REJECTED: 0 } as Record<string, number>
    );
    const totalAnnotations = groupedStatusCounts.reduce(
      (sum, row) => sum + row._count._all,
      0
    );

    return NextResponse.json({
      success: true,
      batchJob: {
        id: batchJob.id,
        projectId: batchJob.projectId,
        projectName: batchJob.project.name,
        weedType: batchJob.weedType,
        status: batchJob.status,
        totalImages: batchJob.totalImages,
        processedImages: batchJob.processedImages,
        detectionsFound: batchJob.detectionsFound,
        errorMessage: batchJob.errorMessage,
        createdAt: batchJob.createdAt,
        startedAt: batchJob.startedAt,
        completedAt: batchJob.completedAt,
      },
      summary: {
        total: totalAnnotations,
        pending: statusCounts.PENDING || 0,
        accepted: statusCounts.ACCEPTED || 0,
        rejected: statusCounts.REJECTED || 0,
      },
      annotations,
    });
  } catch (error) {
    console.error('Failed to get batch job:', error);
    return NextResponse.json(
      { error: 'Failed to get batch job', success: false },
      { status: 500 }
    );
  }
}

// DELETE: Cancel/delete a batch job
export async function DELETE(
  request: NextRequest,
  { params }: RouteParams
): Promise<NextResponse> {
  const { id } = await params;

  // Validate ID format
  if (!/^c[a-z0-9]{24,}$/i.test(id)) {
    return NextResponse.json(
      { error: 'Invalid batch job ID format', success: false },
      { status: 400 }
    );
  }

  try {
    // Get the batch job to find its project
    const batchJob = await prisma.batchJob.findUnique({
      where: { id },
      select: { id: true, projectId: true },
    });

    if (!batchJob) {
      return NextResponse.json(
        { error: 'Batch job not found', success: false },
        { status: 404 }
      );
    }

    // Check authentication and project access
    const projectAccess = await checkProjectAccess(batchJob.projectId);
    if (!projectAccess.authenticated) {
      return NextResponse.json(
        { error: 'Authentication required', success: false },
        { status: 401 }
      );
    }
    if (!projectAccess.hasAccess) {
      return NextResponse.json(
        { error: projectAccess.error || 'Access denied', success: false },
        { status: 403 }
      );
    }

    // Delete the batch job (cascades to pending annotations)
    await prisma.batchJob.delete({
      where: { id },
    });

    return NextResponse.json({
      success: true,
      message: 'Batch job deleted',
    });
  } catch (error) {
    console.error('Failed to delete batch job:', error);
    return NextResponse.json(
      { error: 'Failed to delete batch job', success: false },
      { status: 500 }
    );
  }
}
