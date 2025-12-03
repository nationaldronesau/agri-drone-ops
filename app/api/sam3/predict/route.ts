/**
 * SAM3 Prediction API Route - Roboflow Workflow Integration
 *
 * Uses Roboflow's hosted SAM3 workflow for segmentation.
 * Supports both click-based (point) prompts and text prompts.
 */
import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';

// Roboflow Workflow configuration
const ROBOFLOW_API_KEY = process.env.ROBOFLOW_API_KEY;
const ROBOFLOW_WORKSPACE = process.env.ROBOFLOW_WORKSPACE;
const ROBOFLOW_SAM3_WORKFLOW_ID = process.env.ROBOFLOW_SAM3_WORKFLOW_ID || 'sam3-forestry';

interface ClickPoint {
  x: number;
  y: number;
  label: 0 | 1;  // 0 = background (negative), 1 = foreground (positive)
}

interface PredictRequest {
  assetId: string;
  points: ClickPoint[];
  textPrompt?: string;  // Optional text prompt for concept-based segmentation
}

interface RoboflowPoint {
  x: number;
  y: number;
  positive: boolean;
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    // Validate configuration
    if (!ROBOFLOW_API_KEY || !ROBOFLOW_WORKSPACE) {
      return NextResponse.json(
        { error: 'Roboflow API not configured', success: false },
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

    if (!body.points || body.points.length === 0) {
      return NextResponse.json(
        { error: 'At least one point is required', success: false },
        { status: 400 }
      );
    }

    // Get asset to retrieve image URL
    const asset = await prisma.asset.findUnique({
      where: { id: body.assetId },
      select: {
        id: true,
        s3Key: true,
        s3Bucket: true,
        filePath: true,
        storageType: true,
        storageUrl: true,
      },
    });

    if (!asset) {
      return NextResponse.json(
        { error: 'Asset not found', success: false },
        { status: 404 }
      );
    }

    // Get image URL (S3 signed URL or local path)
    let imageUrl: string;

    if (asset.storageType === 'S3' && asset.s3Key && asset.s3Bucket) {
      // Generate signed URL for S3 asset
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
      // Use existing storage URL
      imageUrl = asset.storageUrl;
      // If it's a relative URL, make it absolute
      if (imageUrl.startsWith('/')) {
        const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
        imageUrl = `${baseUrl}${imageUrl}`;
      }
    } else if (asset.filePath) {
      // Construct URL from file path
      const urlPath = asset.filePath.replace(/^public\//, '/');
      const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
      imageUrl = `${baseUrl}${urlPath}`;
    } else {
      return NextResponse.json(
        { error: 'Asset has no valid file path', success: false },
        { status: 400 }
      );
    }

    // Convert points to Roboflow format
    const roboflowPoints: RoboflowPoint[] = body.points.map(p => ({
      x: p.x,
      y: p.y,
      positive: p.label === 1,  // 1 = foreground = positive
    }));

    // Build Roboflow workflow request
    const workflowUrl = `https://detect.roboflow.com/infer/workflows/${ROBOFLOW_WORKSPACE}/${ROBOFLOW_SAM3_WORKFLOW_ID}`;

    const workflowInputs: Record<string, unknown> = {
      image: {
        type: 'url',
        value: imageUrl,
      },
      points: roboflowPoints,
    };

    // Add text prompt if provided (for concept-based segmentation)
    if (body.textPrompt) {
      workflowInputs.text_prompt = body.textPrompt;
    }

    console.log('Calling Roboflow SAM3 workflow:', workflowUrl);
    console.log('Points:', roboflowPoints);

    const startTime = Date.now();

    // Call Roboflow workflow
    const roboflowResponse = await fetch(workflowUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        api_key: ROBOFLOW_API_KEY,
        inputs: workflowInputs,
      }),
    });

    const processingTimeMs = Date.now() - startTime;

    if (!roboflowResponse.ok) {
      const errorText = await roboflowResponse.text();
      console.error('Roboflow error:', errorText);
      return NextResponse.json(
        {
          error: `Roboflow API error: ${roboflowResponse.status}`,
          details: errorText,
          success: false
        },
        { status: roboflowResponse.status }
      );
    }

    const result = await roboflowResponse.json();
    console.log('Roboflow response:', JSON.stringify(result, null, 2));

    // Extract polygon from Roboflow response
    // Structure: { outputs: { sam: { predictions: [...] } } }
    let polygon: [number, number][] | null = null;
    let score = 0;
    let bbox: [number, number, number, number] | null = null;

    // Handle Roboflow workflow response structure
    const outputs = result.outputs || result;

    // Look for SAM predictions (your workflow outputs "sam" containing predictions)
    const samOutput = outputs.sam || outputs.predictions || outputs;
    const predictions = samOutput?.predictions || (Array.isArray(samOutput) ? samOutput : null);

    if (predictions && predictions.length > 0) {
      const pred = predictions[0];  // Take first/best prediction

      // Extract polygon points
      if (pred.points) {
        // Points array format: [{x, y}, {x, y}, ...]
        polygon = pred.points.map((p: { x: number; y: number }) => [p.x, p.y]);
      } else if (pred.polygon) {
        polygon = pred.polygon;
      } else if (pred.segmentation?.polygon) {
        polygon = pred.segmentation.polygon;
      }

      // Extract confidence score
      score = pred.confidence ?? pred.score ?? 0.9;

      // Extract bounding box
      if (pred.x !== undefined && pred.y !== undefined && pred.width && pred.height) {
        // Center format (x, y, width, height)
        bbox = [
          pred.x - pred.width / 2,
          pred.y - pred.height / 2,
          pred.x + pred.width / 2,
          pred.y + pred.height / 2,
        ];
      } else if (pred.bbox) {
        bbox = pred.bbox;
      }
    }

    // Fallback: check for direct polygon in outputs
    if (!polygon) {
      if (outputs.polygon) {
        polygon = outputs.polygon;
      } else if (outputs.mask_polygon) {
        polygon = outputs.mask_polygon;
      }
    }

    if (!polygon || polygon.length < 3) {
      return NextResponse.json({
        success: false,
        score: 0,
        polygon: null,
        bbox: null,
        processingTimeMs,
        message: 'No valid segmentation found',
        rawResponse: result,  // Include raw response for debugging
      });
    }

    return NextResponse.json({
      success: true,
      score,
      polygon,
      bbox,
      processingTimeMs,
      message: `Segmentation complete with ${body.points.length} points`,
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
