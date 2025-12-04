/**
 * Training Push Detections API
 *
 * POST - Push verified/corrected AI detections to Roboflow for retraining
 */
import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { roboflowTrainingService } from '@/lib/services/roboflow-training';
import { S3Service } from '@/lib/services/s3';

export async function POST(request: NextRequest) {
  try {
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
    const validAssetIds = assetIds.slice(trainCount);

    let successCount = 0;
    const errors: { assetId: string; error: string }[] = [];

    // Process each asset
    for (const [assetId, group] of assetGroups) {
      try {
        const split = trainAssetIds.includes(assetId) ? 'train' : 'valid';

        // Get image buffer
        let imageBuffer: Buffer;
        if (group.asset.storageType === 's3' && group.asset.s3Key) {
          imageBuffer = await S3Service.downloadFile(
            group.asset.s3Key,
            group.asset.s3Bucket || S3Service.bucketName
          );
        } else {
          const response = await fetch(group.asset.storageUrl);
          if (!response.ok) {
            throw new Error(`Failed to fetch image: ${response.statusText}`);
          }
          const arrayBuffer = await response.arrayBuffer();
          imageBuffer = Buffer.from(arrayBuffer);
        }

        const imageBase64 = imageBuffer.toString('base64');

        // Convert detections to annotation boxes
        const boxes = group.detections.map((detection) => {
          const bbox = detection.boundingBox as { x: number; y: number; width: number; height: number };
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
        errors.push({
          assetId,
          error: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    }

    return NextResponse.json({
      success: true,
      pushed: successCount,
      failed: errors.length,
      trainCount: trainAssetIds.length,
      validCount: validAssetIds.length,
      errors: errors.slice(0, 10),
    });
  } catch (error) {
    console.error('Error pushing detections:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to push detections' },
      { status: 500 }
    );
  }
}
