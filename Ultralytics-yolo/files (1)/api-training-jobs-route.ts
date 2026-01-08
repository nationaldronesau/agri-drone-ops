/**
 * Training Jobs API Routes
 * 
 * Location: app/api/training/jobs/route.ts
 * 
 * POST /api/training/jobs - Create a new training job
 * GET /api/training/jobs - List all training jobs
 */

import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { yoloService } from '@/lib/services/yolo';
import { TrainingStatus } from '@prisma/client';

// ===========================================
// POST - Create new training job
// ===========================================

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    
    const {
      datasetId,
      baseModel = 'yolo11m',
      epochs = 100,
      batchSize = 16,
      imageSize = 640,
      learningRate = 0.01,
      teamId, // Required - from auth context in production
    } = body;

    // Validate required fields
    if (!datasetId) {
      return NextResponse.json(
        { error: 'datasetId is required' },
        { status: 400 }
      );
    }

    if (!teamId) {
      return NextResponse.json(
        { error: 'teamId is required' },
        { status: 400 }
      );
    }

    // Fetch dataset to get S3 path and validate ownership
    const dataset = await prisma.trainingDataset.findFirst({
      where: {
        id: datasetId,
        teamId: teamId,
      },
    });

    if (!dataset) {
      return NextResponse.json(
        { error: 'Dataset not found or access denied' },
        { status: 404 }
      );
    }

    // Generate model name from dataset
    const modelBaseName = dataset.name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '');

    // Find next version number for this model name
    const existingModels = await prisma.trainedModel.findMany({
      where: {
        teamId: teamId,
        name: modelBaseName,
      },
      select: { version: true },
      orderBy: { version: 'desc' },
      take: 1,
    });

    const nextVersion = existingModels.length > 0 
      ? existingModels[0].version + 1 
      : 1;

    // Estimate training time
    const batchesPerEpoch = Math.ceil(dataset.imageCount / batchSize);
    const estimatedMinutes = Math.ceil((batchesPerEpoch * 0.5 * epochs) / 60);

    // Create training job record
    const trainingJob = await prisma.trainingJob.create({
      data: {
        datasetId,
        baseModel,
        epochs,
        batchSize,
        imageSize,
        learningRate,
        status: TrainingStatus.QUEUED,
        estimatedMinutes,
        teamId,
        trainingConfig: JSON.stringify({
          modelName: `${modelBaseName}-v${nextVersion}`,
        }),
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

    // Start training on EC2
    try {
      const ec2Response = await yoloService.startTraining({
        dataset_s3_path: dataset.s3Path,
        model_name: `${modelBaseName}-v${nextVersion}`,
        base_model: baseModel as 'yolo11n' | 'yolo11m' | 'yolo11l' | 'yolo11x',
        epochs,
        batch_size: batchSize,
        image_size: imageSize,
        learning_rate: learningRate,
      });

      // Update job with EC2 job ID
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
          modelName: `${modelBaseName}-v${nextVersion}`,
          estimatedMinutes,
          dataset: trainingJob.dataset,
        },
      });

    } catch (ec2Error) {
      // Failed to start on EC2 - update status
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

// ===========================================
// GET - List training jobs
// ===========================================

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const teamId = searchParams.get('teamId');
    const status = searchParams.get('status');
    const limit = parseInt(searchParams.get('limit') || '20');
    const offset = parseInt(searchParams.get('offset') || '0');

    if (!teamId) {
      return NextResponse.json(
        { error: 'teamId is required' },
        { status: 400 }
      );
    }

    const where: any = { teamId };
    
    if (status) {
      where.status = status.toUpperCase() as TrainingStatus;
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

    // Parse JSON fields
    const formattedJobs = jobs.map(job => ({
      ...job,
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
