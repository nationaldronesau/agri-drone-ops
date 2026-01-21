/**
 * Training Jobs API Routes
 *
 * POST /api/training/jobs - Create a new training job
 * GET /api/training/jobs - List training jobs
 */
import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/db';
import { yoloService, estimateTrainingTime, formatModelId } from '@/lib/services/yolo';
import { sam3Orchestrator } from '@/lib/services/sam3-orchestrator';
import { TrainingStatus } from '@prisma/client';
import { getAuthenticatedUser, getUserTeamIds } from '@/lib/auth/api-auth';
import { checkRateLimit } from '@/lib/utils/security';

const ALLOWED_BASE_MODELS = ['yolo11n', 'yolo11s', 'yolo11m', 'yolo11l', 'yolo11x'] as const;

export async function POST(request: NextRequest) {
  try {
    const auth = await getAuthenticatedUser();
    if (!auth.authenticated || !auth.userId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const rateLimitKey = `training-jobs:${auth.userId}`;
    const rateLimit = checkRateLimit(rateLimitKey, { maxRequests: 5, windowMs: 60000 });
    if (!rateLimit.allowed) {
      return NextResponse.json(
        { error: 'Rate limit exceeded. Please try again later.' },
        {
          status: 429,
          headers: {
            'X-RateLimit-Remaining': '0',
            'X-RateLimit-Reset': rateLimit.resetTime.toString(),
          },
        }
      );
    }

    const body = await request.json();
    const {
      datasetId,
      baseModel = 'yolo11m',
      epochs = 100,
      batchSize = 16,
      imageSize = 640,
      learningRate = 0.01,
    } = body;

    if (!datasetId) {
      return NextResponse.json({ error: 'datasetId is required' }, { status: 400 });
    }

    if (!ALLOWED_BASE_MODELS.includes(baseModel)) {
      return NextResponse.json({ error: 'Invalid base model' }, { status: 400 });
    }

    const dataset = await prisma.trainingDataset.findFirst({
      where: {
        id: datasetId,
        team: {
          members: {
            some: { userId: auth.userId },
          },
        },
      },
      include: {
        team: true,
      },
    });

    if (!dataset) {
      return NextResponse.json(
        { error: 'Dataset not found or access denied' },
        { status: 404 }
      );
    }

    const modelBaseName = dataset.name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '');

    const existing = await prisma.trainedModel.findFirst({
      where: {
        teamId: dataset.teamId,
        name: modelBaseName,
      },
      select: { version: true },
      orderBy: { version: 'desc' },
    });

    const nextVersion = existing ? existing.version + 1 : 1;
    const modelName = formatModelId(modelBaseName, nextVersion);
    const estimate = estimateTrainingTime(dataset.imageCount, epochs, batchSize);

    const trainingJob = await prisma.trainingJob.create({
      data: {
        datasetId,
        baseModel,
        epochs,
        batchSize,
        imageSize,
        learningRate,
        status: TrainingStatus.QUEUED,
        estimatedMinutes: estimate.minutes,
        teamId: dataset.teamId,
        createdById: auth.userId,
        trainingConfig: JSON.stringify({ modelName }),
      },
      include: {
        dataset: {
          select: {
            name: true,
            s3Path: true,
            imageCount: true,
            classes: true,
          },
        },
      },
    });

    try {
      // Ensure GPU is available by unloading SAM3 if needed
      // SAM3 holds ~14GB GPU memory, leaving no room for YOLO training on the 16GB T4
      const gpuResult = await sam3Orchestrator.ensureGPUAvailable();
      if (!gpuResult.success) {
        await prisma.trainingJob.update({
          where: { id: trainingJob.id },
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

      const ec2Response = await yoloService.startTraining({
        dataset_s3_path: dataset.s3Path,
        model_name: modelName,
        base_model: baseModel as (typeof ALLOWED_BASE_MODELS)[number],
        epochs,
        batch_size: batchSize,
        image_size: imageSize,
        learning_rate: learningRate,
      });

      await prisma.trainingJob.update({
        where: { id: trainingJob.id },
        data: {
          ec2JobId: ec2Response.job_id,
          status: TrainingStatus.PREPARING,
        },
      });

      return NextResponse.json({
        success: true,
        job: {
          id: trainingJob.id,
          ec2JobId: ec2Response.job_id,
          status: 'preparing',
          modelName,
          estimatedMinutes: estimate.minutes,
          dataset: {
            ...trainingJob.dataset,
            classes: JSON.parse(trainingJob.dataset.classes),
          },
        },
      });
    } catch (ec2Error) {
      await prisma.trainingJob.update({
        where: { id: trainingJob.id },
        data: {
          status: TrainingStatus.FAILED,
          errorMessage: ec2Error instanceof Error
            ? ec2Error.message
            : 'Failed to start training on EC2',
        },
      });

      return NextResponse.json(
        {
          error: 'Failed to start training on EC2',
          details: ec2Error instanceof Error ? ec2Error.message : undefined,
          jobId: trainingJob.id,
        },
        { status: 502 }
      );
    }
  } catch (error) {
    console.error('Error creating training job:', error);
    return NextResponse.json(
      { error: 'Failed to create training job' },
      { status: 500 }
    );
  }
}

export async function GET(request: NextRequest) {
  try {
    const auth = await getAuthenticatedUser();
    if (!auth.authenticated || !auth.userId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { searchParams } = new URL(request.url);
    const teamId = searchParams.get('teamId');
    const status = searchParams.get('status');
    const limit = parseInt(searchParams.get('limit') || '20', 10);
    const offset = parseInt(searchParams.get('offset') || '0', 10);

    const membership = await getUserTeamIds();
    if (!membership.authenticated || !membership.userId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    if (membership.teamIds.length === 0) {
      return NextResponse.json({ error: 'No team access' }, { status: 403 });
    }

    const teamIds = teamId ? [teamId] : membership.teamIds;
    if (teamId && !membership.teamIds.includes(teamId)) {
      return NextResponse.json({ error: 'Access denied' }, { status: 403 });
    }

    const where: Record<string, unknown> = { teamId: { in: teamIds } };
    if (status) {
      where.status = status.toUpperCase();
    }

    const [jobs, total] = await Promise.all([
      prisma.trainingJob.findMany({
        where,
        include: {
          dataset: {
            select: {
              name: true,
              imageCount: true,
              classes: true,
            },
          },
          trainedModel: {
            select: {
              id: true,
              name: true,
              version: true,
              mAP50: true,
            },
          },
        },
        orderBy: { createdAt: 'desc' },
        take: limit,
        skip: offset,
      }),
      prisma.trainingJob.count({ where }),
    ]);

    const formattedJobs = jobs.map((job) => ({
      ...job,
      dataset: job.dataset
        ? {
            ...job.dataset,
            classes: JSON.parse(job.dataset.classes),
          }
        : job.dataset,
      currentMetrics: job.currentMetrics ? JSON.parse(job.currentMetrics) : null,
      trainingConfig: job.trainingConfig ? JSON.parse(job.trainingConfig) : null,
    }));

    return NextResponse.json({
      jobs: formattedJobs,
      total,
      limit,
      offset,
    });
  } catch (error) {
    console.error('Error listing training jobs:', error);
    return NextResponse.json(
      { error: 'Failed to list training jobs' },
      { status: 500 }
    );
  }
}
