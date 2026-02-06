/**
 * Start Training Job API Route
 *
 * POST /api/training/jobs/[id]/start - Manually start a queued training job
 *
 * Use this to retry jobs that were created before YOLO_SERVICE_URL was configured.
 */
import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/db';
import { yoloService, formatModelId } from '@/lib/services/yolo';
import { sam3Orchestrator } from '@/lib/services/sam3-orchestrator';
import { acquireGpuLock, releaseGpuLock } from '@/lib/services/gpu-lock';
import { TrainingStatus } from '@prisma/client';
import { getAuthenticatedUser } from '@/lib/auth/api-auth';
import { buildTrainingAugmentationFromDataset } from '@/lib/services/training-augmentation';

const TRAINING_LOCK_TTL_MS = 15 * 60 * 1000;

export async function POST(
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
            s3Path: true,
            imageCount: true,
            classes: true,
            version: true,
            augmentationPreset: true,
            augmentationConfig: true,
          },
        },
        checkpointModel: {
          select: {
            id: true,
            s3Path: true,
            weightsFile: true,
          },
        },
      },
    });

    if (!job) {
      return NextResponse.json({ error: 'Training job not found' }, { status: 404 });
    }

    // Only allow starting QUEUED jobs that don't have an ec2JobId
    if (job.status !== TrainingStatus.QUEUED) {
      return NextResponse.json(
        { error: `Job is not queued (current status: ${job.status})` },
        { status: 400 }
      );
    }

    if (job.ec2JobId) {
      return NextResponse.json(
        { error: 'Job already has an EC2 job ID. It may already be running.' },
        { status: 400 }
      );
    }

    if (!job.dataset) {
      return NextResponse.json(
        { error: 'Job has no associated dataset' },
        { status: 400 }
      );
    }

    // Get model name from config or generate one
    const config = job.trainingConfig ? JSON.parse(job.trainingConfig) : {};
    const storedAugmentation =
      config && typeof config === 'object' && config.augmentation && typeof config.augmentation === 'object'
        ? (config.augmentation as Record<string, unknown>)
        : null;
    const datasetAugmentation = buildTrainingAugmentationFromDataset(job.dataset);
    const augmentation = storedAugmentation || datasetAugmentation;
    let modelName = config.modelName;

    if (!modelName) {
      const modelBaseName = job.dataset.name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '');

      const existing = await prisma.trainedModel.findFirst({
        where: {
          teamId: job.teamId,
          name: modelBaseName,
        },
        select: { version: true },
        orderBy: { version: 'desc' },
      });

      const nextVersion = existing ? existing.version + 1 : 1;
      modelName = formatModelId(modelBaseName, nextVersion);
    }

    console.log(`[Training Start] Starting job ${jobId} with model name: ${modelName}`);
    console.log(`[Training Start] Dataset S3 path: ${job.dataset.s3Path}`);
    console.log(`[Training Start] Config: epochs=${job.epochs}, batch=${job.batchSize}, imageSize=${job.imageSize}`);

    let gpuLockToken: string | null = null;
    try {
      // Ensure GPU is available by unloading SAM3 if needed
      // SAM3 holds ~14GB GPU memory, leaving no room for YOLO training on the 16GB T4
      const gpuResult = await sam3Orchestrator.ensureGPUAvailable();
      if (!gpuResult.success) {
        await prisma.trainingJob.update({
          where: { id: jobId },
          data: {
            status: TrainingStatus.FAILED,
            errorMessage: `GPU not available: ${gpuResult.message}`,
          },
        });
        return NextResponse.json(
          { error: `Cannot start YOLO training: ${gpuResult.message}` },
          { status: 503 }
        );
      }

      const gpuLock = await acquireGpuLock('yolo-training', TRAINING_LOCK_TTL_MS);
      if (!gpuLock.acquired) {
        await prisma.trainingJob.update({
          where: { id: jobId },
          data: {
            status: TrainingStatus.FAILED,
            errorMessage: 'GPU lock unavailable for training',
          },
        });
        return NextResponse.json(
          { error: 'Cannot start YOLO training: GPU lock unavailable' },
          { status: 503 }
        );
      }
      gpuLockToken = gpuLock.token;

      const ec2Response = await yoloService.startTraining({
        dataset_s3_path: job.dataset.s3Path,
        model_name: modelName,
        base_model: job.baseModel as 'yolo11n' | 'yolo11s' | 'yolo11m' | 'yolo11l' | 'yolo11x',
        epochs: job.epochs,
        batch_size: job.batchSize,
        image_size: job.imageSize,
        learning_rate: job.learningRate,
        ...(augmentation ? { augmentation } : {}),
        ...(
          job.checkpointModel
            ? {
                checkpoint_s3_path: `${job.checkpointModel.s3Path.replace(/\/+$/, '')}/${job.checkpointModel.weightsFile}`,
              }
            : {}
        ),
      });

      console.log(`[Training Start] EC2 response:`, ec2Response);

      const updatedJob = await prisma.trainingJob.update({
        where: { id: jobId },
        data: {
          ec2JobId: ec2Response.job_id,
          status: TrainingStatus.PREPARING,
          trainingConfig: JSON.stringify({
            ...config,
            modelName,
            ...(augmentation ? { augmentation } : {}),
            gpuLockToken,
          }),
        },
        include: {
          dataset: {
            select: {
              name: true,
              imageCount: true,
              classes: true,
            },
          },
        },
      });

      if (job.dataset?.version != null) {
        await prisma.trainingDataset.update({
          where: { id: job.datasetId },
          data: { status: 'TRAINING' },
        });
      }

      return NextResponse.json({
        success: true,
        message: 'Training job started successfully',
        job: {
          id: updatedJob.id,
          ec2JobId: ec2Response.job_id,
          status: 'preparing',
          modelName,
          dataset: updatedJob.dataset
            ? {
                ...updatedJob.dataset,
                classes: JSON.parse(updatedJob.dataset.classes),
              }
            : null,
        },
      });
    } catch (ec2Error) {
      if (gpuLockToken) {
        await releaseGpuLock(gpuLockToken);
      }
      console.error('[Training Start] Failed to start training on EC2:', ec2Error);

      await prisma.trainingJob.update({
        where: { id: jobId },
        data: {
          status: TrainingStatus.FAILED,
          errorMessage: ec2Error instanceof Error
            ? ec2Error.message
            : 'Failed to start training on EC2',
        },
      });

      if (job.dataset?.version != null) {
        const activeCount = await prisma.trainingJob.count({
          where: {
            datasetId: job.datasetId,
            status: { in: ['QUEUED', 'PREPARING', 'RUNNING', 'UPLOADING'] },
          },
        });
        if (activeCount === 0) {
          await prisma.trainingDataset.update({
            where: { id: job.datasetId },
            data: { status: 'READY' },
          });
        }
      }

      return NextResponse.json(
        {
          error: 'Failed to start training on EC2',
          details: ec2Error instanceof Error ? ec2Error.message : undefined,
        },
        { status: 502 }
      );
    }
  } catch (error) {
    console.error('[Training Start] Error:', error);
    return NextResponse.json(
      { error: 'Failed to start training job' },
      { status: 500 }
    );
  }
}
