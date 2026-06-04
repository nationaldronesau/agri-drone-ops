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
import {
  isPineSaplingYoloModelId,
  resolveYoloServiceModelName,
} from '@/lib/services/yolo';
import { S3Service } from '@/lib/services/s3';

const MAX_SYNC_IMAGES = 50;
const STANDARD_INFERENCE_CONFIDENCE = 0.25;
const HIGH_RECALL_INFERENCE_CONFIDENCE = 0.1;

type InferenceMode = 'standard' | 'high_recall' | 'custom';

function clampConfidence(value: unknown, fallback = STANDARD_INFERENCE_CONFIDENCE): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(0, Math.min(1, parsed));
}

function resolveInferenceMode(input: {
  inferenceMode?: unknown;
  confidence?: unknown;
}): { mode: InferenceMode; label: string; confidence: number } {
  const requestedMode = typeof input.inferenceMode === 'string'
    ? input.inferenceMode
    : null;
  const hasExplicitConfidence = typeof input.confidence !== 'undefined';

  if (requestedMode === 'high_recall') {
    return {
      mode: 'high_recall',
      label: 'High recall assisted labelling',
      confidence: HIGH_RECALL_INFERENCE_CONFIDENCE,
    };
  }

  if (requestedMode === 'standard') {
    return {
      mode: 'standard',
      label: 'Standard QA',
      confidence: STANDARD_INFERENCE_CONFIDENCE,
    };
  }

  if (requestedMode && requestedMode !== 'custom') {
    throw new Error('Invalid inferenceMode. Use standard, high_recall, or custom.');
  }

  const confidence = clampConfidence(input.confidence);
  if (requestedMode === 'custom' || hasExplicitConfidence) {
    return {
      mode: 'custom',
      label: 'Custom confidence',
      confidence,
    };
  }

  return {
    mode: 'standard',
    label: 'Standard QA',
    confidence: STANDARD_INFERENCE_CONFIDENCE,
  };
}

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
      saveDetections = true,
      preview = false,
    } = body;
    const replaceDraftDetections = body.replaceDraftDetections === true;
    let inferenceSelection: ReturnType<typeof resolveInferenceMode>;
    try {
      inferenceSelection = resolveInferenceMode({
        inferenceMode: body.inferenceMode,
        confidence: body.confidence,
      });
    } catch (error) {
      return NextResponse.json(
        { error: error instanceof Error ? error.message : 'Invalid inference mode' },
        { status: 400 }
      );
    }
    const confidence = inferenceSelection.confidence;
    const inferenceMode = inferenceSelection.mode;
    const inferenceModeLabel = inferenceSelection.label;

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

    const backendPreference = isPineSaplingYoloModelId(effectiveModelId)
      ? 'local'
      : (project?.inferenceBackend || 'AUTO').toLowerCase();

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

    const anyModelDetectionFilter = { customModelId: effectiveModelId };
    const reviewedModelDetectionFilter = {
      customModelId: effectiveModelId,
      OR: [
        { verified: true },
        { rejected: true },
        { userCorrected: true },
        { reviewedAt: { not: null } },
      ],
    };

    const duplicateImages = await prisma.asset.count({
      where: {
        ...baseWhere,
        detections: {
          some: anyModelDetectionFilter,
        },
      },
    });

    const reviewedDuplicateImages = await prisma.asset.count({
      where: {
        ...baseWhere,
        detections: {
          some: reviewedModelDetectionFilter,
        },
      },
    });

    const replaceableDuplicateImages = Math.max(0, duplicateImages - reviewedDuplicateImages);

    const candidateWhere: Record<string, unknown> = {
      ...baseWhere,
      ...(replaceDraftDetections
        ? {
            NOT: {
              detections: {
                some: reviewedModelDetectionFilter,
              },
            },
          }
        : {
            detections: {
              none: anyModelDetectionFilter,
            },
          }),
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
        replaceDraftDetections,
        replaceableDuplicateImages,
        reviewedDuplicateImages,
        confidence,
        inferenceMode,
        inferenceModeLabel,
      });
    }

    if (totalImages === 0) {
      const rerunBlockedByDrafts =
        duplicateImages > 0 && replaceableDuplicateImages > 0 && !replaceDraftDetections;
      return NextResponse.json(
        {
          error: rerunBlockedByDrafts
            ? 'No eligible images to process. This project already has draft detections for this model; enable replaceDraftDetections to rerun unreviewed images.'
            : 'No eligible images to process',
          totalImages,
          skippedImages,
          skippedReason: 'missing_gps_or_dimensions',
          duplicateImages,
          replaceDraftDetections,
          replaceableDuplicateImages,
          reviewedDuplicateImages,
        },
        { status: 400 }
      );
    }

    if (!preview && !isPineSaplingYoloModelId(effectiveModelId)) {
      const weightsReady = await ensureCanonicalWeights(model);
      if (!weightsReady.ok) {
        console.error('Failed to prepare model weights:', weightsReady.error);
        return NextResponse.json(
          { error: 'Failed to prepare model weights' },
          { status: 502 }
        );
      }
    }

    const modelName = resolveYoloServiceModelName(model);

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
          inferenceMode,
          inferenceModeLabel,
          saveDetections,
          replaceDraftDetections,
          totalImages,
          processedImages: 0,
          detectionsFound: 0,
          skippedImages,
          skippedReason: 'missing_gps_or_dimensions',
          duplicateImages,
          replaceableDuplicateImages,
          reviewedDuplicateImages,
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
        inferenceMode,
        inferenceModeLabel,
        saveDetections,
        replaceDraftDetections,
        skippedImages,
        duplicateImages,
        replaceableDuplicateImages,
        reviewedDuplicateImages,
        skippedReason: 'missing_gps_or_dimensions',
        backend: backendPreference as 'local' | 'roboflow' | 'auto',
      });

      if (result.processedImages === 0 && result.errors.length > 0) {
        return NextResponse.json(
          {
            error: 'Inference failed for all selected images',
            details: result.errors.slice(0, 5),
            jobId: processingJob.id,
            totalImages,
            skippedImages,
            skippedReason: 'missing_gps_or_dimensions',
            duplicateImages,
            replaceDraftDetections,
            replaceableDuplicateImages,
            reviewedDuplicateImages,
            detectionsFound: result.detectionsFound,
            draftDetectionsReplaced: result.draftDetectionsReplaced,
            confidence,
            inferenceMode,
            inferenceModeLabel,
            tiling: result.tiling,
          },
          { status: 502 }
        );
      }

      return NextResponse.json({
        jobId: processingJob.id,
        totalImages,
        status: 'completed',
        processedImages: result.processedImages,
        skippedImages,
        skippedReason: 'missing_gps_or_dimensions',
        duplicateImages,
        replaceDraftDetections,
        replaceableDuplicateImages,
        reviewedDuplicateImages,
        detectionsFound: result.detectionsFound,
        draftDetectionsReplaced: result.draftDetectionsReplaced,
        confidence,
        inferenceMode,
        inferenceModeLabel,
        errors: result.errors.slice(0, 10),
        tiling: result.tiling,
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
      inferenceMode,
      inferenceModeLabel,
      saveDetections,
      replaceDraftDetections,
      backend: backendPreference as 'local' | 'roboflow' | 'auto',
    });

    return NextResponse.json({
      jobId: processingJob.id,
      totalImages,
      status: 'queued',
      confidence,
      inferenceMode,
      inferenceModeLabel,
      skippedImages,
      skippedReason: 'missing_gps_or_dimensions',
      duplicateImages,
      replaceDraftDetections,
      replaceableDuplicateImages,
      reviewedDuplicateImages,
    });
  } catch (error) {
    console.error('Error starting inference:', error);
    return NextResponse.json(
      { error: 'Failed to start inference' },
      { status: 500 }
    );
  }
}
