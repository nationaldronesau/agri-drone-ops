/**
 * SAM3 Batch Processing API Route
 *
 * Processes multiple images using box exemplars for few-shot detection.
 * Creates PendingAnnotation records for review before acceptance.
 */
import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';

const ROBOFLOW_API_KEY = process.env.ROBOFLOW_API_KEY;
const SAM3_API_URL = 'https://serverless.roboflow.com/sam3/concept_segment';

interface BoxExemplar {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

interface BatchRequest {
  projectId: string;
  weedType: string;
  exemplars: BoxExemplar[];
  assetIds?: string[]; // Optional: specific assets, or all in project
  textPrompt?: string;
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    if (!ROBOFLOW_API_KEY) {
      return NextResponse.json(
        { error: 'SAM3 service not configured', success: false },
        { status: 503 }
      );
    }

    const body: BatchRequest = await request.json();

    // Validate request
    if (!body.projectId || !body.weedType || !body.exemplars?.length) {
      return NextResponse.json(
        { error: 'Missing required fields: projectId, weedType, exemplars', success: false },
        { status: 400 }
      );
    }

    // Validate exemplars
    for (const exemplar of body.exemplars) {
      if (typeof exemplar.x1 !== 'number' || typeof exemplar.y1 !== 'number' ||
          typeof exemplar.x2 !== 'number' || typeof exemplar.y2 !== 'number') {
        return NextResponse.json(
          { error: 'Invalid exemplar format', success: false },
          { status: 400 }
        );
      }
    }

    // Get target assets
    let assets;
    if (body.assetIds?.length) {
      assets = await prisma.asset.findMany({
        where: {
          id: { in: body.assetIds },
          projectId: body.projectId,
        },
        select: {
          id: true,
          storageUrl: true,
          filePath: true,
          s3Key: true,
          s3Bucket: true,
          storageType: true,
          imageWidth: true,
          imageHeight: true,
        },
      });
    } else {
      // Get all assets in project
      assets = await prisma.asset.findMany({
        where: { projectId: body.projectId },
        select: {
          id: true,
          storageUrl: true,
          filePath: true,
          s3Key: true,
          s3Bucket: true,
          storageType: true,
          imageWidth: true,
          imageHeight: true,
        },
        take: 100, // Limit to 100 images per batch
      });
    }

    if (assets.length === 0) {
      return NextResponse.json(
        { error: 'No assets found', success: false },
        { status: 404 }
      );
    }

    // Create batch job
    const batchJob = await prisma.batchJob.create({
      data: {
        projectId: body.projectId,
        weedType: body.weedType,
        exemplars: body.exemplars,
        textPrompt: body.textPrompt || body.weedType.replace('Suspected ', ''),
        totalImages: assets.length,
        status: 'PROCESSING',
        startedAt: new Date(),
      },
    });

    // Process in background (simplified synchronous for now)
    // In production, this should be a background job with BullMQ
    const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
    let processedCount = 0;
    let totalDetections = 0;
    const errors: string[] = [];

    for (const asset of assets) {
      try {
        // Build image URL
        let imageUrl: string;
        if (asset.storageType === 'S3' && asset.s3Key && asset.s3Bucket) {
          const signedUrlResponse = await fetch(`${baseUrl}/api/assets/${asset.id}/signed-url`, {
            headers: { 'X-Internal-Request': 'true' }
          });
          if (!signedUrlResponse.ok) {
            errors.push(`Failed to get signed URL for ${asset.id}`);
            continue;
          }
          const signedUrlData = await signedUrlResponse.json();
          imageUrl = signedUrlData.url;
        } else if (asset.storageUrl) {
          imageUrl = asset.storageUrl.startsWith('/') ? `${baseUrl}${asset.storageUrl}` : asset.storageUrl;
        } else if (asset.filePath) {
          const urlPath = asset.filePath.replace(/^public\//, '/');
          imageUrl = `${baseUrl}${urlPath}`;
        } else {
          errors.push(`No image URL for ${asset.id}`);
          continue;
        }

        // Fetch and encode image
        const imageResponse = await fetch(imageUrl, {
          signal: AbortSignal.timeout(30000),
        });

        if (!imageResponse.ok) {
          errors.push(`Failed to fetch image ${asset.id}`);
          continue;
        }

        const imageBuffer = await imageResponse.arrayBuffer();
        const imageBase64 = Buffer.from(imageBuffer).toString('base64');

        // Build prompts
        const prompts = [];

        // Add text prompt
        if (body.textPrompt) {
          prompts.push({ type: 'text', data: body.textPrompt.substring(0, 100) });
        }

        // Add box exemplars
        for (const box of body.exemplars.slice(0, 10)) {
          prompts.push({
            type: 'box',
            data: {
              x: Math.max(0, Math.round(box.x1)),
              y: Math.max(0, Math.round(box.y1)),
              width: Math.max(1, Math.round(box.x2 - box.x1)),
              height: Math.max(1, Math.round(box.y2 - box.y1)),
            }
          });
        }

        // Call SAM3 API
        const sam3Response = await fetch(SAM3_API_URL, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${ROBOFLOW_API_KEY}`,
          },
          body: JSON.stringify({
            image: { type: 'base64', value: imageBase64 },
            prompts,
          }),
          signal: AbortSignal.timeout(120000),
        });

        if (!sam3Response.ok) {
          errors.push(`SAM3 failed for ${asset.id}: ${sam3Response.status}`);
          continue;
        }

        const result = await sam3Response.json();

        // Parse detections
        if (result.prompt_results) {
          for (const promptResult of result.prompt_results) {
            const predictions = promptResult.predictions || [];
            for (const pred of predictions) {
              const masks = pred.masks || [];
              if (masks.length > 0 && masks[0].length >= 3) {
                const maskPoints = masks[0];
                const polygon: [number, number][] = maskPoints.map((p: number[]) => [p[0], p[1]]);
                const xs = maskPoints.map((p: number[]) => p[0]);
                const ys = maskPoints.map((p: number[]) => p[1]);
                const bbox = [
                  Math.min(...xs),
                  Math.min(...ys),
                  Math.max(...xs),
                  Math.max(...ys),
                ];

                // Create pending annotation
                await prisma.pendingAnnotation.create({
                  data: {
                    batchJobId: batchJob.id,
                    assetId: asset.id,
                    weedType: body.weedType,
                    confidence: pred.confidence ?? 0.9,
                    polygon: polygon,
                    bbox: bbox,
                    status: 'PENDING',
                  },
                });

                totalDetections++;
              }
            }
          }
        }

        processedCount++;

        // Update progress
        await prisma.batchJob.update({
          where: { id: batchJob.id },
          data: {
            processedImages: processedCount,
            detectionsFound: totalDetections,
          },
        });

      } catch (err) {
        errors.push(`Error processing ${asset.id}: ${err instanceof Error ? err.message : 'Unknown'}`);
      }
    }

    // Mark job complete
    const finalStatus = errors.length > 0 && processedCount === 0 ? 'FAILED' : 'COMPLETED';
    await prisma.batchJob.update({
      where: { id: batchJob.id },
      data: {
        status: finalStatus,
        processedImages: processedCount,
        detectionsFound: totalDetections,
        completedAt: new Date(),
        errorMessage: errors.length > 0 ? errors.slice(0, 5).join('; ') : null,
      },
    });

    return NextResponse.json({
      success: true,
      batchJobId: batchJob.id,
      totalImages: assets.length,
      processedImages: processedCount,
      detectionsFound: totalDetections,
      errors: errors.length > 0 ? errors.slice(0, 5) : undefined,
    });

  } catch (error) {
    console.error('Batch processing error:', error instanceof Error ? error.message : 'Unknown');
    return NextResponse.json(
      { error: 'Batch processing failed', success: false },
      { status: 500 }
    );
  }
}

// GET: List batch jobs for a project
export async function GET(request: NextRequest): Promise<NextResponse> {
  const { searchParams } = new URL(request.url);
  const projectId = searchParams.get('projectId');

  if (!projectId) {
    return NextResponse.json(
      { error: 'projectId required', success: false },
      { status: 400 }
    );
  }

  try {
    const batchJobs = await prisma.batchJob.findMany({
      where: { projectId },
      orderBy: { createdAt: 'desc' },
      include: {
        _count: {
          select: { pendingAnnotations: true }
        }
      }
    });

    return NextResponse.json({
      success: true,
      batchJobs,
    });
  } catch (error) {
    console.error('Failed to list batch jobs:', error);
    return NextResponse.json(
      { error: 'Failed to list batch jobs', success: false },
      { status: 500 }
    );
  }
}
