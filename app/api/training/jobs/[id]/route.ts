/**
 * Individual Training Job API Routes
 *
 * GET /api/training/jobs/[id] - Get job status and metrics
 * DELETE /api/training/jobs/[id] - Cancel job
 */
import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/db';
import { yoloService } from '@/lib/services/yolo';
import { TrainingStatus, ModelStatus } from '@prisma/client';
import { getAuthenticatedUser } from '@/lib/auth/api-auth';

function mapEC2Status(ec2Status: string): TrainingStatus {
  const statusMap: Record<string, TrainingStatus> = {
    queued: TrainingStatus.QUEUED,
    preparing: TrainingStatus.PREPARING,
    running: TrainingStatus.RUNNING,
    uploading: TrainingStatus.UPLOADING,
    completed: TrainingStatus.COMPLETED,
    failed: TrainingStatus.FAILED,
    cancelled: TrainingStatus.CANCELLED,
  };
  return statusMap[ec2Status] || TrainingStatus.RUNNING;
}

function parseS3Path(path: string): { bucket: string; keyPrefix: string } | null {
  if (!path.startsWith('s3://')) return null;
  const withoutScheme = path.replace('s3://', '');
  const [bucket, ...rest] = withoutScheme.split('/');
  if (!bucket) return null;
  return { bucket, keyPrefix: rest.join('/') };
}

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

    const activeStatuses = [
      TrainingStatus.QUEUED,
      TrainingStatus.PREPARING,
      TrainingStatus.RUNNING,
      TrainingStatus.UPLOADING,
    ];

    let updatedJob = job;
    let syncStatus: 'ok' | 'failed' | null = null;
    let syncError: string | null = null;
    let syncUpdatedAt: string | null = null;

    if (activeStatuses.includes(job.status) && job.ec2JobId) {
      try {
        const ec2Status = await yoloService.getTrainingStatus(job.ec2JobId);
        syncStatus = 'ok';
        syncUpdatedAt = new Date().toISOString();
        const updateData: Record<string, unknown> = {
          status: mapEC2Status(ec2Status.status),
          currentEpoch: ec2Status.current_epoch,
          progress: ec2Status.progress,
        };

        if (ec2Status.metrics) {
          updateData.currentMetrics = JSON.stringify(ec2Status.metrics);
        }

        if (ec2Status.error_message) {
          updateData.errorMessage = ec2Status.error_message;
        }

        if (ec2Status.status === 'running' && !job.startedAt) {
          updateData.startedAt = new Date();
        }

        if (ec2Status.status === 'failed' || ec2Status.status === 'cancelled') {
          updateData.completedAt = new Date();
        }

        if (ec2Status.status === 'completed') {
          updateData.completedAt = new Date();
          updateData.finalMAP50 = ec2Status.metrics?.mAP50;
          updateData.finalMAP5095 = ec2Status.metrics?.mAP5095;
          updateData.finalPrecision = ec2Status.metrics?.precision;
          updateData.finalRecall = ec2Status.metrics?.recall;

          if (ec2Status.metrics?.precision && ec2Status.metrics?.recall) {
            updateData.finalF1 =
              (2 * ec2Status.metrics.precision * ec2Status.metrics.recall) /
              (ec2Status.metrics.precision + ec2Status.metrics.recall);
          }

          if (ec2Status.s3_output_path && !job.trainedModelId) {
            const config = job.trainingConfig ? JSON.parse(job.trainingConfig) : {};
            const modelName = config.modelName || `model-${job.id}`;
            const [baseName, versionStr] = modelName.split('-v');
            const version = parseInt(versionStr, 10) || 1;
            const parsedPath = parseS3Path(ec2Status.s3_output_path);

            const trainedModel = await prisma.trainedModel.create({
              data: {
                name: baseName,
                version,
                displayName: `${job.dataset.name} (v${version})`,
                s3Path: ec2Status.s3_output_path,
                s3Bucket: parsedPath?.bucket || job.dataset.s3Path.split('/')[2] || 'agridrone-ops',
                classes: job.dataset.classes,
                classCount: JSON.parse(job.dataset.classes).length,
                mAP50: ec2Status.metrics?.mAP50,
                mAP5095: ec2Status.metrics?.mAP5095,
                precision: ec2Status.metrics?.precision,
                recall: ec2Status.metrics?.recall,
                f1Score: updateData.finalF1 as number | undefined,
                baseModel: job.baseModel,
                trainedOnImages: job.dataset.imageCount,
                trainedEpochs: job.epochs,
                status: ModelStatus.READY,
                teamId: job.teamId,
                createdById: job.createdById,
              },
            });

            updateData.trainedModelId = trainedModel.id;
          }
        }

        updatedJob = await prisma.trainingJob.update({
          where: { id: jobId },
          data: updateData,
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
      } catch (ec2Error) {
        console.error('Failed to sync with EC2:', ec2Error);
        syncStatus = 'failed';
        syncUpdatedAt = new Date().toISOString();
        syncError = ec2Error instanceof Error ? ec2Error.message : 'Failed to sync with EC2';
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

    return NextResponse.json({ success: true, job: updatedJob });
  } catch (error) {
    console.error('Error cancelling training job:', error);
    return NextResponse.json(
      { error: 'Failed to cancel training job' },
      { status: 500 }
    );
  }
}
