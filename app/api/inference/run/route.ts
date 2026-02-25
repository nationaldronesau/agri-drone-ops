/**
 * Inference Run API Route
 *
 * POST /api/inference/run - Start or preview inference job
 */
import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/db';
import { getAuthenticatedUser, checkProjectAccess } from '@/lib/auth/api-auth';
import { checkRedisConnection } from '@/lib/queue/redis';
import { enqueueInferenceJob } from '@/lib/queue/inference-queue';
import { processInferenceJob } from '@/lib/services/inference';
import { formatModelId } from '@/lib/services/yolo';
import { S3Service } from '@/lib/services/s3';

const MAX_SYNC_IMAGES = 50;

function parseS3Path(path: string): { bucket: string; keyPrefix: string } | null {
  if (!path.startsWith('s3://')) return null;
  const withoutScheme = path.replace('s3://', '');
  const [bucket, ...rest] = withoutScheme.split('/');
  if (!bucket) return null;
  return { bucket, keyPrefix: rest.join('/') };
}

async function ensureCanonicalWeights(model: {
  name: string;
  version: number;
  s3Path: string;
  s3Bucket?: string | null;
  weightsFile?: string | null;
}): Promise<{ ok: boolean; error?: string }> {
  const parsed = parseS3Path(model.s3Path);
  if (!parsed?.keyPrefix) {
    return { ok: true };
  }

  const weightsFile = model.weightsFile || 'best.pt';
  const sourceKey = parsed.keyPrefix.endsWith('.pt')
    ? parsed.keyPrefix
    : `${parsed.keyPrefix.replace(/\/$/, '')}/${weightsFile}`;

  const canonicalPrefix = `models/${model.name}/v${model.version}`;
  const canonicalKey = `${canonicalPrefix}/${weightsFile}`;
  const bucket = model.s3Bucket || parsed.bucket || S3Service.bucketName;

  if (sourceKey === canonicalKey) {
    return { ok: true };
  }

  try {
    await S3Service.copyObject(sourceKey, canonicalKey, bucket);
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'Failed to prepare model weights',
    };
  }
}

export async function POST(request: NextRequest) {
  try {
    const auth = await getAuthenticatedUser();
    if (!auth.authenticated || !auth.userId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = await request.json();
    const {
      modelId: requestedModelId,
      projectId,
      assetIds,
      confidence = 0.25,
      saveDetections = true,
      preview = false,
    } = body;

    if (!projectId) {
      return NextResponse.json(
        { error: 'projectId is required' },
        { status: 400 }
      );
    }

    if (assetIds && (!Array.isArray(assetIds) || assetIds.length === 0)) {
      return NextResponse.json(
        { error: 'assetIds must be a non-empty array when provided' },
        { status: 400 }
      );
    }

    const projectAccess = await checkProjectAccess(projectId);
    if (!projectAccess.hasAccess || !projectAccess.teamId) {
      return NextResponse.json(
        { error: projectAccess.error || 'Access denied' },
        { status: 403 }
      );
    }

    const project = await prisma.project.findUnique({
      where: { id: projectId },
      select: { inferenceBackend: true, activeModelId: true },
    });
    const backendPreference = (project?.inferenceBackend || 'AUTO').toLowerCase();

    const effectiveModelId = requestedModelId || project?.activeModelId;
    if (!effectiveModelId) {
      return NextResponse.json(
        { error: 'No model selected. Provide modelId or set an active model for this project.' },
        { status: 400 }
      );
    }

    const model = await prisma.trainedModel.findFirst({
      where: {
        id: effectiveModelId,
        teamId: projectAccess.teamId,
      },
      select: {
        id: true,
        name: true,
        version: true,
        status: true,
        teamId: true,
        s3Path: true,
        s3Bucket: true,
        weightsFile: true,
      },
    });

    if (!model) {
      return NextResponse.json({ error: 'Model not found' }, { status: 404 });
    }

    if (['TRAINING', 'ARCHIVED', 'FAILED'].includes(model.status)) {
      return NextResponse.json(
        { error: `Model status ${model.status} is not ready for inference` },
        { status: 400 }
      );
    }

    if (assetIds) {
      const assetCount = await prisma.asset.count({
        where: {
          id: { in: assetIds },
          projectId,
        },
      });
      if (assetCount !== assetIds.length) {
        return NextResponse.json(
          { error: 'One or more assetIds do not belong to this project' },
          { status: 400 }
        );
      }
    }

    const baseWhere: Record<string, unknown> = {
      projectId,
    };
    if (assetIds) {
      baseWhere.id = { in: assetIds };
    }

    const duplicateImages = await prisma.asset.count({
      where: {
        ...baseWhere,
        detections: {
          some: { customModelId: effectiveModelId },
        },
      },
    });

    const candidateWhere: Record<string, unknown> = {
      ...baseWhere,
      detections: {
        none: { customModelId: effectiveModelId },
      },
    };

    const skippedImages = await prisma.asset.count({
      where: {
        ...candidateWhere,
        OR: [
          { gpsLatitude: null },
          { gpsLongitude: null },
          { imageWidth: null },
          { imageHeight: null },
        ],
      },
    });

    const assetsToProcess = await prisma.asset.findMany({
      where: {
        ...candidateWhere,
        gpsLatitude: { not: null },
        gpsLongitude: { not: null },
        imageWidth: { not: null },
        imageHeight: { not: null },
      },
      select: { id: true },
    });

    const assetIdList = assetsToProcess.map((asset) => asset.id);
    const totalImages = assetIdList.length;

    if (preview) {
      return NextResponse.json({
        totalImages,
        skippedImages,
        skippedReason: 'missing_gps_or_dimensions',
        duplicateImages,
      });
    }

    if (totalImages === 0) {
      return NextResponse.json(
        {
          error: 'No eligible images to process',
          totalImages,
          skippedImages,
          skippedReason: 'missing_gps_or_dimensions',
          duplicateImages,
        },
        { status: 400 }
      );
    }

    if (!preview) {
      const weightsReady = await ensureCanonicalWeights(model);
      if (!weightsReady.ok) {
        console.error('Failed to prepare model weights:', weightsReady.error);
        return NextResponse.json(
          { error: 'Failed to prepare model weights' },
          { status: 502 }
        );
      }
    }

    const modelName = formatModelId(model.name, model.version);

    const processingJob = await prisma.processingJob.create({
      data: {
        projectId,
        type: 'AI_DETECTION',
        status: 'PENDING',
        progress: 0,
        config: {
          modelId: effectiveModelId,
          modelName,
          confidence,
          saveDetections,
          totalImages,
          processedImages: 0,
          detectionsFound: 0,
          skippedImages,
          skippedReason: 'missing_gps_or_dimensions',
          duplicateImages,
          backend: backendPreference,
        },
      },
    });

    if (totalImages <= MAX_SYNC_IMAGES) {
      const result = await processInferenceJob({
        jobId: processingJob.id,
        projectId,
        modelId: effectiveModelId,
        modelName,
        assetIds: assetIdList,
        confidence,
        saveDetections,
        skippedImages,
        duplicateImages,
        skippedReason: 'missing_gps_or_dimensions',
        backend: backendPreference as 'local' | 'roboflow' | 'auto',
      });

      return NextResponse.json({
        jobId: processingJob.id,
        totalImages,
        status: 'completed',
        processedImages: result.processedImages,
        skippedImages,
        skippedReason: 'missing_gps_or_dimensions',
        duplicateImages,
        detectionsFound: result.detectionsFound,
      });
    }

    const redisAvailable = await checkRedisConnection();
    if (!redisAvailable) {
      await prisma.processingJob.update({
        where: { id: processingJob.id },
        data: {
          status: 'FAILED',
          errorMessage: 'Redis unavailable - batch too large for sync processing',
        },
      });

      return NextResponse.json(
        {
          error: 'Batch too large for synchronous processing. Please select 50 or fewer images.',
        },
        { status: 503 }
      );
    }

    await enqueueInferenceJob({
      processingJobId: processingJob.id,
      modelId: effectiveModelId,
      modelName,
      projectId,
      assetIds: assetIdList,
      confidence,
      saveDetections,
      backend: backendPreference as 'local' | 'roboflow' | 'auto',
    });

    return NextResponse.json({
      jobId: processingJob.id,
      totalImages,
      status: 'queued',
      skippedImages,
      skippedReason: 'missing_gps_or_dimensions',
      duplicateImages,
    });
  } catch (error) {
    console.error('Error starting inference:', error);
    return NextResponse.json(
      { error: 'Failed to start inference' },
      { status: 500 }
    );
  }
}
