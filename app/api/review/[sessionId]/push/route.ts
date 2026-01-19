import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/db';
import { getAuthenticatedUser } from '@/lib/auth/api-auth';
import { datasetPreparation, sanitizeClassName } from '@/lib/services/dataset-preparation';
import { roboflowTrainingService } from '@/lib/services/roboflow-training';
import { yoloService, estimateTrainingTime, formatModelId } from '@/lib/services/yolo';
import { S3Service } from '@/lib/services/s3';
import { fetchImageSafely, isUrlAllowed } from '@/lib/utils/security';
import { rescaleToOriginalWithMeta } from '@/lib/utils/georeferencing';
import type { CenterBox, YOLOPreprocessingMeta } from '@/lib/types/detection';
import type { AnnotationBox } from '@/types/roboflow';

type PushTarget = 'roboflow' | 'yolo' | 'both';

function parseCenterBox(value: unknown): CenterBox | null {
  if (!value) return null;
  let parsed: unknown = value;
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value);
    } catch {
      return null;
    }
  }

  if (
    parsed &&
    typeof parsed === 'object' &&
    'x' in parsed &&
    'y' in parsed &&
    'width' in parsed &&
    'height' in parsed
  ) {
    return parsed as CenterBox;
  }

  if (Array.isArray(parsed) && parsed.length >= 4) {
    const [x1, y1, x2, y2] = parsed as number[];
    const width = x2 - x1;
    const height = y2 - y1;
    if (width <= 0 || height <= 0) return null;
    return {
      x: x1 + width / 2,
      y: y1 + height / 2,
      width,
      height,
    };
  }

  return null;
}

async function getImageBuffer(asset: {
  id: string;
  fileName: string;
  storageUrl: string;
  storageType: string;
  s3Key: string | null;
  s3Bucket: string | null;
}): Promise<Buffer> {
  if (asset.storageType === 's3' && asset.s3Key) {
    return S3Service.downloadFile(asset.s3Key, asset.s3Bucket || S3Service.bucketName);
  }

  if (!asset.storageUrl) {
    throw new Error('Asset storage URL missing');
  }

  if (!isUrlAllowed(asset.storageUrl)) {
    throw new Error('Asset URL is not from an allowed domain');
  }

  return fetchImageSafely(asset.storageUrl, `Asset ${asset.id}`);
}

export async function POST(
  request: NextRequest,
  { params }: { params: { sessionId: string } }
) {
  try {
    const auth = await getAuthenticatedUser();
    if (!auth.authenticated || !auth.userId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = await request.json();
    const target = body.target as PushTarget | undefined;
    const roboflowProjectId = body.roboflowProjectId as string | undefined;
    const yoloConfig = body.yoloConfig as {
      datasetName: string;
      classes: string[];
      classMapping?: Record<string, string>;
      splitRatio?: { train: number; val: number; test: number };
      confidenceThreshold?: number;
      baseModel?: 'yolo11n' | 'yolo11s' | 'yolo11m' | 'yolo11l' | 'yolo11x';
      epochs?: number;
      batchSize?: number;
      imageSize?: number;
      learningRate?: number;
    } | undefined;

    if (!target || !['roboflow', 'yolo', 'both'].includes(target)) {
      return NextResponse.json({ error: 'Invalid target' }, { status: 400 });
    }

    const session = await prisma.reviewSession.findUnique({
      where: { id: params.sessionId },
    });

    if (!session) {
      return NextResponse.json({ error: 'Review session not found' }, { status: 404 });
    }

    const membership = await prisma.teamMember.findFirst({
      where: { teamId: session.teamId, userId: auth.userId },
      select: { id: true },
    });

    if (!membership) {
      return NextResponse.json({ error: 'Access denied' }, { status: 403 });
    }

    const assetIds = Array.isArray(session.assetIds)
      ? (session.assetIds as string[]).filter((id) => typeof id === 'string')
      : [];

    if (assetIds.length === 0) {
      return NextResponse.json({ error: 'No assets available for this session' }, { status: 400 });
    }

    const results: Record<string, unknown> = {};

    if (target === 'roboflow' || target === 'both') {
      const projectId = roboflowProjectId || session.roboflowProjectId || undefined;
      if (!projectId) {
        return NextResponse.json(
          { error: 'roboflowProjectId is required for Roboflow push' },
          { status: 400 }
        );
      }

      const manualAnnotations = await prisma.manualAnnotation.findMany({
        where: {
          verified: true,
          session: {
            assetId: { in: assetIds },
          },
        },
        select: { id: true },
      });

      const manualResult = manualAnnotations.length > 0
        ? await roboflowTrainingService.uploadBatch(
            manualAnnotations.map((ann) => ann.id),
            'train',
            projectId
          )
        : { success: 0, failed: 0, errors: [] };

      const detections = await prisma.detection.findMany({
        where: {
          assetId: { in: assetIds },
          rejected: false,
          OR: [{ verified: true }, { userCorrected: true }],
        },
        include: {
          asset: {
            select: {
              id: true,
              fileName: true,
              storageUrl: true,
              storageType: true,
              s3Key: true,
              s3Bucket: true,
            },
          },
        },
      });

      const assetGroups = new Map<
        string,
        { asset: (typeof detections)[0]['asset']; detections: typeof detections }
      >();

      for (const detection of detections) {
        const group = assetGroups.get(detection.assetId) || {
          asset: detection.asset,
          detections: [],
        };
        group.detections.push(detection);
        assetGroups.set(detection.assetId, group);
      }

      let detectionSuccess = 0;
      const detectionErrors: { assetId: string; error: string }[] = [];

      for (const [assetId, group] of assetGroups) {
        try {
          const boxes: AnnotationBox[] = [];
          for (const det of group.detections) {
            let centerBox = parseCenterBox(det.boundingBox);
            let meta = det.preprocessingMeta as YOLOPreprocessingMeta | null;
            if (meta && typeof meta === 'string') {
              try {
                meta = JSON.parse(meta) as YOLOPreprocessingMeta;
              } catch {
                meta = null;
              }
            }
            if (centerBox && det.type === 'YOLO_LOCAL' && meta) {
              centerBox = rescaleToOriginalWithMeta(centerBox, meta);
            }
            if (!centerBox) continue;
            boxes.push({
              x: centerBox.x,
              y: centerBox.y,
              width: centerBox.width,
              height: centerBox.height,
              class: det.className,
            });
          }

          if (boxes.length === 0) continue;

          const imageBuffer = await getImageBuffer(group.asset);
          const imageBase64 = imageBuffer.toString('base64');

          const upload = await roboflowTrainingService.uploadTrainingData(
            imageBase64,
            group.asset.fileName,
            boxes,
            'train',
            projectId
          );

          if (upload?.success) {
            detectionSuccess += boxes.length;
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Unknown error';
          detectionErrors.push({ assetId, error: message });
        }
      }

      results.roboflow = {
        manual: manualResult,
        detections: {
          success: detectionSuccess,
          failed: detectionErrors.length,
          errors: detectionErrors,
        },
      };
    }

    if (target === 'yolo' || target === 'both') {
      if (!yoloConfig?.datasetName || !Array.isArray(yoloConfig.classes) || yoloConfig.classes.length === 0) {
        return NextResponse.json(
          { error: 'yoloConfig.datasetName and yoloConfig.classes are required' },
          { status: 400 }
        );
      }

      const sanitizedClasses = yoloConfig.classes
        .map((cls) => sanitizeClassName(cls))
        .filter(Boolean);
      const dedupedClasses = Array.from(new Set(sanitizedClasses));
      if (dedupedClasses.length !== sanitizedClasses.length) {
        return NextResponse.json(
          { error: 'Duplicate class names detected after sanitization' },
          { status: 400 }
        );
      }

      const dataset = await datasetPreparation.prepareDataset(session.teamId, yoloConfig.datasetName, {
        projectId: session.projectId,
        assetIds,
        classes: dedupedClasses,
        classMapping: yoloConfig.classMapping,
        splitRatio: yoloConfig.splitRatio || { train: 0.7, val: 0.2, test: 0.1 },
        includeAIDetections: true,
        includeManualAnnotations: true,
        minConfidence: yoloConfig.confidenceThreshold ?? 0.5,
        createdAfter: session.createdAt,
        createdById: auth.userId,
      });

      const modelBaseName = yoloConfig.datasetName
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '');

      const existing = await prisma.trainedModel.findFirst({
        where: {
          teamId: session.teamId,
          name: modelBaseName,
        },
        select: { version: true },
        orderBy: { version: 'desc' },
      });

      const nextVersion = existing ? existing.version + 1 : 1;
      const modelName = formatModelId(modelBaseName, nextVersion);
      const estimate = estimateTrainingTime(dataset.imageCount, yoloConfig.epochs || 100, yoloConfig.batchSize || 16);

      const trainingJob = await prisma.trainingJob.create({
        data: {
          datasetId: dataset.datasetId,
          baseModel: yoloConfig.baseModel || 'yolo11m',
          epochs: yoloConfig.epochs || 100,
          batchSize: yoloConfig.batchSize || 16,
          imageSize: yoloConfig.imageSize || 640,
          learningRate: yoloConfig.learningRate || 0.01,
          status: 'QUEUED',
          estimatedMinutes: estimate.minutes,
          teamId: session.teamId,
          createdById: auth.userId,
          trainingConfig: JSON.stringify({ modelName }),
        },
      });

      const ec2Response = await yoloService.startTraining({
        dataset_s3_path: dataset.s3Path,
        model_name: modelName,
        base_model: yoloConfig.baseModel || 'yolo11m',
        epochs: yoloConfig.epochs || 100,
        batch_size: yoloConfig.batchSize || 16,
        image_size: yoloConfig.imageSize || 640,
        learning_rate: yoloConfig.learningRate || 0.01,
      });

      await prisma.trainingJob.update({
        where: { id: trainingJob.id },
        data: {
          ec2JobId: ec2Response.job_id,
          status: 'PREPARING',
        },
      });

      results.yolo = {
        datasetId: dataset.datasetId,
        trainingJobId: trainingJob.id,
        modelName,
        estimatedMinutes: estimate.minutes,
      };
    }

    return NextResponse.json({ success: true, results });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to push review session';
    console.error('Error pushing review session:', error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
