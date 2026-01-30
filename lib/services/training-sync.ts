import prisma from '@/lib/db';
import { yoloService } from '@/lib/services/yolo';
import { S3Service } from '@/lib/services/s3';
import { ModelStatus, TrainingJob, TrainingStatus } from '@prisma/client';

const ACTIVE_STATUSES: TrainingStatus[] = [
  TrainingStatus.QUEUED,
  TrainingStatus.PREPARING,
  TrainingStatus.RUNNING,
  TrainingStatus.UPLOADING,
];

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

function getCanonicalModelPrefix(baseName: string, version: number): string {
  return `models/${baseName}/v${version}`;
}

type SyncResult = {
  job: TrainingJob;
  syncStatus: 'ok' | 'failed' | 'skipped';
  syncError?: string;
};

export async function syncJobWithEC2(
  job: TrainingJob & { dataset?: { name: string; s3Path: string; classes: string; imageCount: number } }
): Promise<SyncResult> {
  if (!job.ec2JobId || !ACTIVE_STATUSES.includes(job.status)) {
    return { job, syncStatus: 'skipped' };
  }

  try {
    const ec2Status = await yoloService.getTrainingStatus(job.ec2JobId);
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

      if (ec2Status.s3_output_path && !job.trainedModelId && job.dataset) {
        const config = job.trainingConfig ? JSON.parse(job.trainingConfig) : {};
        const modelName = config.modelName || `model-${job.id}`;
        const [baseName, versionStr] = modelName.split('-v');
        const version = parseInt(versionStr, 10) || 1;
        const parsedPath = parseS3Path(ec2Status.s3_output_path);
        const bucket = parsedPath?.bucket || job.dataset.s3Path.split('/')[2] || 'agridrone-ops';

        let resolvedS3Path = ec2Status.s3_output_path;
        const weightsFile = 'best.pt';

        if (parsedPath?.keyPrefix) {
          const sourcePrefix = parsedPath.keyPrefix;
          const sourceKey = sourcePrefix.endsWith('.pt')
            ? sourcePrefix
            : `${sourcePrefix}/${weightsFile}`;

          const canonicalPrefix = getCanonicalModelPrefix(baseName, version);
          const canonicalKey = `${canonicalPrefix}/${weightsFile}`;
          const canonicalS3Path = `s3://${bucket}/${canonicalPrefix}`;

          if (sourceKey !== canonicalKey) {
            try {
              await S3Service.copyObject(sourceKey, canonicalKey, bucket);
              resolvedS3Path = canonicalS3Path;
            } catch (error) {
              console.warn('Failed to copy model weights to canonical path:', error);
            }
          } else {
            resolvedS3Path = canonicalS3Path;
          }
        }

        let trainedModelId: string | null = null;

        try {
          const trainedModel = await prisma.trainedModel.create({
            data: {
              name: baseName,
              version,
              displayName: `${job.dataset.name} (v${version})`,
              s3Path: resolvedS3Path,
              s3Bucket: bucket,
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
          trainedModelId = trainedModel.id;
        } catch (error) {
          if (
            error instanceof Error &&
            'code' in error &&
            (error as { code?: string }).code === 'P2002'
          ) {
            const existing = await prisma.trainedModel.findFirst({
              where: {
                name: baseName,
                version,
                teamId: job.teamId,
              },
              select: { id: true },
            });
            trainedModelId = existing?.id || null;
          } else {
            throw error;
          }
        }

        if (trainedModelId) {
          updateData.trainedModelId = trainedModelId;
        }
      }
    }

    const updatedJob = await prisma.trainingJob.update({
      where: { id: job.id },
      data: updateData,
    });

    return { job: updatedJob, syncStatus: 'ok' };
  } catch (error) {
    return {
      job,
      syncStatus: 'failed',
      syncError: error instanceof Error ? error.message : 'Failed to sync with EC2',
    };
  }
}
