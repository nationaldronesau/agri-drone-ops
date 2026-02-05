/**
 * Individual Training Job API Routes
 *
 * GET /api/training/jobs/[id] - Get job status and metrics
 * DELETE /api/training/jobs/[id] - Cancel job
 */
import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/db';
import { TrainingStatus } from '@prisma/client';
import { getAuthenticatedUser } from '@/lib/auth/api-auth';
import { syncJobWithEC2 } from '@/lib/services/training-sync';
import { yoloService } from '@/lib/services/yolo';
import { releaseGpuLock } from '@/lib/services/gpu-lock';

export async function GET(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const auth = await getAuthenticatedUser();
    if (!auth.authenticated || !auth.userId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const jobId = params.id;

    const job = await prisma.trainingJob.findFirst({
      where: {
        id: jobId,
        team: {
          members: {
            some: { userId: auth.userId },
          },
        },
      },
      include: {
        dataset: {
          select: {
            name: true,
            imageCount: true,
            classes: true,
            s3Path: true,
          },
        },
        trainedModel: {
          select: {
            id: true,
            name: true,
            version: true,
            mAP50: true,
            mAP5095: true,
            s3Path: true,
          },
        },
      },
    });

    if (!job) {
      return NextResponse.json({ error: 'Training job not found' }, { status: 404 });
    }

    let updatedJob = job;
    let syncStatus: 'ok' | 'failed' | null = null;
    let syncError: string | null = null;
    let syncUpdatedAt: string | null = null;

    if (job.ec2JobId) {
      const syncResult = await syncJobWithEC2(job);
      if (syncResult.syncStatus !== 'skipped') {
        syncStatus = syncResult.syncStatus === 'ok' ? 'ok' : 'failed';
        syncUpdatedAt = new Date().toISOString();
        syncError = syncResult.syncError || null;
      }

      if (syncResult.job.id !== updatedJob.id || syncResult.syncStatus !== 'skipped') {
        updatedJob = await prisma.trainingJob.findUniqueOrThrow({
          where: { id: jobId },
          include: {
            dataset: {
              select: {
                name: true,
                imageCount: true,
                classes: true,
                s3Path: true,
              },
            },
            trainedModel: {
              select: {
                id: true,
                name: true,
                version: true,
                mAP50: true,
                mAP5095: true,
                s3Path: true,
              },
            },
          },
        });
      }
    }

    const response = {
      ...updatedJob,
      syncStatus,
      syncError,
      syncUpdatedAt,
      dataset: updatedJob.dataset
        ? {
            ...updatedJob.dataset,
            classes: JSON.parse(updatedJob.dataset.classes),
          }
        : updatedJob.dataset,
      currentMetrics: updatedJob.currentMetrics
        ? JSON.parse(updatedJob.currentMetrics)
        : null,
      metricsHistory: updatedJob.metricsHistory
        ? JSON.parse(updatedJob.metricsHistory)
        : null,
      trainingConfig: updatedJob.trainingConfig
        ? JSON.parse(updatedJob.trainingConfig)
        : null,
    };

    return NextResponse.json(response);
  } catch (error) {
    console.error('Error fetching training job:', error);
    return NextResponse.json(
      { error: 'Failed to fetch training job' },
      { status: 500 }
    );
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const auth = await getAuthenticatedUser();
    if (!auth.authenticated || !auth.userId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const jobId = params.id;
    const job = await prisma.trainingJob.findFirst({
      where: {
        id: jobId,
        team: {
          members: {
            some: { userId: auth.userId },
          },
        },
      },
    });

    if (!job) {
      return NextResponse.json({ error: 'Training job not found' }, { status: 404 });
    }

    const cancellableStatuses = [
      TrainingStatus.QUEUED,
      TrainingStatus.PREPARING,
      TrainingStatus.RUNNING,
    ];

    if (!cancellableStatuses.includes(job.status)) {
      return NextResponse.json(
        { error: `Cannot cancel job with status: ${job.status}` },
        { status: 400 }
      );
    }

    let cancelError: string | null = null;
    if (job.ec2JobId) {
      try {
        await yoloService.cancelTraining(job.ec2JobId);
      } catch (ec2Error) {
        console.error('Failed to cancel on EC2:', ec2Error);
        cancelError = ec2Error instanceof Error ? ec2Error.message : 'Failed to cancel on EC2';
      }
    }

    if (cancelError) {
      return NextResponse.json(
        { error: 'Failed to cancel training job on EC2', details: cancelError },
        { status: 502 }
      );
    }

    const updatedJob = await prisma.trainingJob.update({
      where: { id: jobId },
      data: {
        status: TrainingStatus.CANCELLED,
        completedAt: new Date(),
        errorMessage: 'Cancelled by user',
      },
    });

    if (job.trainingConfig) {
      try {
        const parsed = JSON.parse(job.trainingConfig);
        if (typeof parsed?.gpuLockToken === 'string') {
          await releaseGpuLock(parsed.gpuLockToken);
        }
      } catch {
        // ignore config parsing errors
      }
    }

    if (job.datasetId) {
      const dataset = await prisma.trainingDataset.findUnique({
        where: { id: job.datasetId },
        select: { id: true, version: true, status: true },
      });
      if (dataset?.version != null && dataset.status !== 'ARCHIVED') {
        const activeCount = await prisma.trainingJob.count({
          where: {
            datasetId: dataset.id,
            status: { in: ['QUEUED', 'PREPARING', 'RUNNING', 'UPLOADING'] },
          },
        });
        if (activeCount === 0 && dataset.status !== 'READY') {
          await prisma.trainingDataset.update({
            where: { id: dataset.id },
            data: { status: 'READY' },
          });
        }
      }
    }

    return NextResponse.json({ success: true, job: updatedJob });
  } catch (error) {
    console.error('Error cancelling training job:', error);
    return NextResponse.json(
      { error: 'Failed to cancel training job' },
      { status: 500 }
    );
  }
}
