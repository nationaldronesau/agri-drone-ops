/**
 * Training Push Detections API
 *
 * POST - Push verified/corrected AI detections to Roboflow for retraining
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth/config';
import prisma from '@/lib/db';
import { roboflowTrainingService } from '@/lib/services/roboflow-training';
import { S3Service } from '@/lib/services/s3';
import {
  checkRateLimit,
  fetchImageSafely,
  isUrlAllowed,
  MAX_IMAGE_SIZE,
} from '@/lib/utils/security';
import { isAuthBypassed } from '@/lib/utils/auth-bypass';

export async function POST(request: NextRequest) {
  try {
    // Auth check with explicit bypass for development
    let userId = 'dev-user';

    if (!isAuthBypassed()) {
      const session = await getServerSession(authOptions);
      if (!session?.user?.id) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
      }
      userId = session.user.id;
    }

    // Rate limit training push (10 per minute per user)
    const rateLimitKey = `training-push-detections:${userId}`;
    const rateLimit = checkRateLimit(rateLimitKey, { maxRequests: 10, windowMs: 60000 });
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
      projectId,
      roboflowProjectId,
      includeVerified = true,
      includeCorrected = true,
      trainValidSplit = 0.8,
    } = body;

    if (!projectId) {
      return NextResponse.json({ error: 'projectId is required' }, { status: 400 });
    }

    if (!roboflowProjectId) {
      return NextResponse.json({ error: 'roboflowProjectId is required' }, { status: 400 });
    }

    // Verify project exists (skip team membership check if auth bypassed)
    const projectWhere = isAuthBypassed()
      ? { id: projectId }
      : {
          id: projectId,
          team: {
            members: {
              some: {
                userId,
              },
            },
          },
        };

    const project = await prisma.project.findFirst({
      where: projectWhere,
    });

    if (!project) {
      return NextResponse.json(
        { error: 'Project not found or access denied' },
        { status: 403 }
      );
    }

    // Build filter conditions
    const conditions = [];
    if (includeVerified) {
      conditions.push({ verified: true, userCorrected: false });
    }
    if (includeCorrected) {
      conditions.push({ userCorrected: true });
    }

    if (conditions.length === 0) {
      return NextResponse.json({
        success: true,
        pushed: 0,
        message: 'No filter conditions specified',
      });
    }

    // Get all verified/corrected detections for the project
    const detections = await prisma.detection.findMany({
      where: {
        asset: {
          projectId,
        },
        OR: conditions,
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

    if (detections.length === 0) {
      return NextResponse.json({
        success: true,
        pushed: 0,
        message: 'No reviewed detections found',
      });
    }

    // Group detections by asset for batch upload
    const assetGroups = new Map<
      string,
      {
        asset: (typeof detections)[0]['asset'];
        detections: typeof detections;
      }
    >();

    for (const detection of detections) {
      const group = assetGroups.get(detection.assetId) || {
        asset: detection.asset,
        detections: [],
      };
      group.detections.push(detection);
      assetGroups.set(detection.assetId, group);
    }

    const assetIds = Array.from(assetGroups.keys());
    const trainCount = Math.floor(assetIds.length * trainValidSplit);
    const trainAssetIds = assetIds.slice(0, trainCount);

    let successCount = 0;
    const errors: { assetId: string; error: string }[] = [];

    // Process each asset
    for (const [assetId, group] of assetGroups) {
      try {
        const split = trainAssetIds.includes(assetId) ? 'train' : 'valid';

        // Get image buffer with security checks
        let imageBuffer: Buffer;
        if (group.asset.storageType === 's3' && group.asset.s3Key) {
          // S3 storage is trusted
          imageBuffer = await S3Service.downloadFile(
            group.asset.s3Key,
            group.asset.s3Bucket || S3Service.bucketName
          );
        } else if (group.asset.storageUrl) {
          // Validate URL for SSRF protection
          if (!isUrlAllowed(group.asset.storageUrl)) {
            errors.push({
              assetId,
              error: 'Storage URL is not from an allowed domain',
            });
            continue;
          }

          // Fetch with size and content-type validation
          imageBuffer = await fetchImageSafely(group.asset.storageUrl, `Asset ${assetId}`);
        } else {
          errors.push({
            assetId,
            error: 'No valid storage location for asset',
          });
          continue;
        }

        // Verify buffer size
        if (imageBuffer.length > MAX_IMAGE_SIZE) {
          errors.push({
            assetId,
            error: `Image exceeds maximum size of ${MAX_IMAGE_SIZE / 1024 / 1024}MB`,
          });
          continue;
        }

        const imageBase64 = imageBuffer.toString('base64');

        // Convert detections to annotation boxes
        const boxes = group.detections.map((detection) => {
          const bbox = detection.boundingBox as {
            x: number;
            y: number;
            width: number;
            height: number;
          };
          return {
            x: bbox.x + bbox.width / 2,
            y: bbox.y + bbox.height / 2,
            width: bbox.width,
            height: bbox.height,
            class: detection.className,
          };
        });

        // Upload to Roboflow
        await roboflowTrainingService.uploadTrainingData(
          imageBase64,
          group.asset.fileName,
          boxes,
          split as 'train' | 'valid',
          roboflowProjectId
        );

        successCount++;
      } catch (error) {
        console.error(`Error pushing detection for asset ${assetId}:`, error);
        errors.push({
          assetId,
          error: 'Failed to process this image',
        });
      }
    }

    return NextResponse.json({
      success: true,
      pushed: successCount,
      failed: errors.length,
      trainCount: trainAssetIds.length,
      validCount: assetIds.length - trainAssetIds.length,
      errors: errors.slice(0, 10),
    });
  } catch (error) {
    console.error('Error pushing detections:', error);
    return NextResponse.json(
      { error: 'Failed to upload detections for training. Please try again.' },
      { status: 500 }
    );
  }
}
