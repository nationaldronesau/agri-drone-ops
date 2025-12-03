/**
 * SAM3 Prediction API Route - Roboflow concept_segment Integration
 *
 * Uses Roboflow's serverless SAM3 API for few-shot object detection.
 * Supports both point prompts (click-to-segment) and box exemplars (find-all-similar).
 */
import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';

// Roboflow SAM3 API endpoint
const SAM3_API_URL = 'https://serverless.roboflow.com/sam3/concept_segment';
const ROBOFLOW_API_KEY = process.env.ROBOFLOW_API_KEY;

interface ClickPoint {
  x: number;
  y: number;
  label: 0 | 1;  // 0 = background (negative), 1 = foreground (positive)
}

interface BoxExemplar {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

interface PredictRequest {
  assetId: string;
  // Point prompts for click-to-segment
  points?: ClickPoint[];
  // Box exemplars for few-shot detection
  boxes?: BoxExemplar[];
  // Text prompt for concept-based segmentation
  textPrompt?: string;
}

interface RoboflowPrompt {
  type: 'text' | 'box' | 'point';
  data: string | { x: number; y: number; width: number; height: number } | { x: number; y: number; positive: boolean };
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    // Validate configuration
    if (!ROBOFLOW_API_KEY) {
      return NextResponse.json(
        { error: 'Roboflow API key not configured', success: false },
        { status: 503 }
      );
    }

    const body: PredictRequest = await request.json();

    // Validate request
    if (!body.assetId) {
      return NextResponse.json(
        { error: 'assetId is required', success: false },
        { status: 400 }
      );
    }

    const hasPoints = body.points && body.points.length > 0;
    const hasBoxes = body.boxes && body.boxes.length > 0;
    const hasTextPrompt = body.textPrompt && body.textPrompt.trim().length > 0;

    if (!hasPoints && !hasBoxes && !hasTextPrompt) {
      return NextResponse.json(
        { error: 'At least one prompt (points, boxes, or textPrompt) is required', success: false },
        { status: 400 }
      );
    }

    // Get asset to retrieve image
    const asset = await prisma.asset.findUnique({
      where: { id: body.assetId },
      select: {
        id: true,
        s3Key: true,
        s3Bucket: true,
        filePath: true,
        storageType: true,
        storageUrl: true,
        imageWidth: true,
        imageHeight: true,
      },
    });

    if (!asset) {
      return NextResponse.json(
        { error: 'Asset not found', success: false },
        { status: 404 }
      );
    }

    // Get image URL for fetching
    let imageUrl: string;

    if (asset.storageType === 'S3' && asset.s3Key && asset.s3Bucket) {
      const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
      const signedUrlResponse = await fetch(`${baseUrl}/api/assets/${asset.id}/signed-url`);

      if (!signedUrlResponse.ok) {
        return NextResponse.json(
          { error: 'Failed to generate signed URL for asset', success: false },
          { status: 500 }
        );
      }

      const signedUrlData = await signedUrlResponse.json();
      imageUrl = signedUrlData.url;
    } else if (asset.storageUrl) {
      imageUrl = asset.storageUrl;
      if (imageUrl.startsWith('/')) {
        const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
        imageUrl = `${baseUrl}${imageUrl}`;
      }
    } else if (asset.filePath) {
      const urlPath = asset.filePath.replace(/^public\//, '/');
      const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
      imageUrl = `${baseUrl}${urlPath}`;
    } else {
      return NextResponse.json(
        { error: 'Asset has no valid file path', success: false },
        { status: 400 }
      );
    }

    // Fetch image and convert to base64
    console.log('Fetching image from:', imageUrl);
    const imageResponse = await fetch(imageUrl);
    if (!imageResponse.ok) {
      return NextResponse.json(
        { error: 'Failed to fetch image', success: false },
        { status: 500 }
      );
    }

    const imageBuffer = await imageResponse.arrayBuffer();
    const imageBase64 = Buffer.from(imageBuffer).toString('base64');

    // Build prompts array for concept_segment API
    const prompts: RoboflowPrompt[] = [];

    // Add text prompt if provided
    if (hasTextPrompt) {
      prompts.push({
        type: 'text',
        data: body.textPrompt!.trim()
      });
    }

    // Add box exemplars (few-shot detection)
    if (hasBoxes) {
      for (const box of body.boxes!) {
        prompts.push({
          type: 'box',
          data: {
            x: box.x1,
            y: box.y1,
            width: box.x2 - box.x1,
            height: box.y2 - box.y1,
          }
        });
      }
    }

    // Add point prompts (click-to-segment)
    if (hasPoints) {
      for (const point of body.points!) {
        prompts.push({
          type: 'point',
          data: {
            x: point.x,
            y: point.y,
            positive: point.label === 1,
          }
        });
      }
    }

    console.log('Calling SAM3 concept_segment API with', prompts.length, 'prompts');

    const startTime = Date.now();

    // Call Roboflow SAM3 concept_segment API
    const sam3Response = await fetch(`${SAM3_API_URL}?api_key=${ROBOFLOW_API_KEY}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        image: {
          type: 'base64',
          value: imageBase64,
        },
        prompts,
      }),
    });

    const processingTimeMs = Date.now() - startTime;

    if (!sam3Response.ok) {
      const errorText = await sam3Response.text();
      console.error('SAM3 API error:', errorText);
      return NextResponse.json(
        {
          error: `SAM3 API error: ${sam3Response.status}`,
          details: errorText,
          success: false
        },
        { status: sam3Response.status }
      );
    }

    const result = await sam3Response.json();
    console.log('SAM3 response time:', result.time, 's');

    // Parse results from concept_segment API
    // Format: { prompt_results: [{ predictions: [{ masks: [...], confidence: ... }] }] }
    const detections: Array<{
      polygon: [number, number][];
      bbox: [number, number, number, number];
      score: number;
    }> = [];

    if (result.prompt_results) {
      for (const promptResult of result.prompt_results) {
        const predictions = promptResult.predictions || [];
        for (const pred of predictions) {
          const masks = pred.masks || [];
          if (masks.length > 0 && masks[0].length >= 3) {
            const maskPoints = masks[0];

            // Convert mask to polygon format [[x, y], ...]
            const polygon: [number, number][] = maskPoints.map((p: number[]) => [p[0], p[1]]);

            // Calculate bounding box from mask
            const xs = maskPoints.map((p: number[]) => p[0]);
            const ys = maskPoints.map((p: number[]) => p[1]);
            const bbox: [number, number, number, number] = [
              Math.min(...xs),
              Math.min(...ys),
              Math.max(...xs),
              Math.max(...ys),
            ];

            detections.push({
              polygon,
              bbox,
              score: pred.confidence ?? 0.9,
            });
          }
        }
      }
    }

    // Return single detection for click-to-segment, multiple for few-shot
    if (hasPoints && !hasBoxes && !hasTextPrompt && detections.length > 0) {
      // Single click mode - return first/best detection
      const best = detections[0];
      return NextResponse.json({
        success: true,
        score: best.score,
        polygon: best.polygon,
        bbox: best.bbox,
        processingTimeMs,
        message: `Segmentation complete`,
      });
    }

    // Few-shot mode - return all detections
    return NextResponse.json({
      success: detections.length > 0,
      detections,
      count: detections.length,
      processingTimeMs,
      message: `Found ${detections.length} objects`,
      // Also include first detection as polygon/bbox for backwards compatibility
      polygon: detections[0]?.polygon || null,
      bbox: detections[0]?.bbox || null,
      score: detections[0]?.score || 0,
    });

  } catch (error) {
    console.error('SAM3 predict error:', error);

    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : 'Internal server error',
        success: false,
      },
      { status: 500 }
    );
  }
}
