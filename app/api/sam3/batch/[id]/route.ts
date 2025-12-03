/**
 * SAM3 Batch Job Status API
 *
 * Get details of a specific batch job and its pending annotations.
 */
import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';

interface RouteParams {
  params: Promise<{ id: string }>;
}

export async function GET(
  request: NextRequest,
  { params }: RouteParams
): Promise<NextResponse> {
  const { id } = await params;

  try {
    const batchJob = await prisma.batchJob.findUnique({
      where: { id },
      include: {
        pendingAnnotations: {
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
          orderBy: { confidence: 'desc' }
        },
        project: {
          select: {
            id: true,
            name: true,
          }
        }
      }
    });

    if (!batchJob) {
      return NextResponse.json(
        { error: 'Batch job not found', success: false },
        { status: 404 }
      );
    }

    // Group annotations by status
    const pending = batchJob.pendingAnnotations.filter(a => a.status === 'PENDING');
    const accepted = batchJob.pendingAnnotations.filter(a => a.status === 'ACCEPTED');
    const rejected = batchJob.pendingAnnotations.filter(a => a.status === 'REJECTED');

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
        total: batchJob.pendingAnnotations.length,
        pending: pending.length,
        accepted: accepted.length,
        rejected: rejected.length,
      },
      annotations: batchJob.pendingAnnotations,
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

  try {
    const batchJob = await prisma.batchJob.findUnique({
      where: { id },
    });

    if (!batchJob) {
      return NextResponse.json(
        { error: 'Batch job not found', success: false },
        { status: 404 }
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
