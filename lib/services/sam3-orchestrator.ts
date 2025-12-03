/**
 * SAM3 Orchestrator
 *
 * Unified interface for SAM3 predictions with automatic AWS/Roboflow fallback.
 * - Uses AWS EC2 SAM3 instance as primary when configured
 * - Falls back to Roboflow API automatically when AWS is unavailable
 * - Returns fun startup messages for UI display
 * - Handles image preprocessing and coordinate scaling
 */
import { awsSam3Service, FUN_LOADING_MESSAGES } from './aws-sam3';
import sharp from 'sharp';

const ROBOFLOW_API_KEY = process.env.ROBOFLOW_API_KEY;
const ROBOFLOW_SAM3_URL = 'https://serverless.roboflow.com/sam3/concept_segment';

export interface PredictionRequest {
  imageBuffer: Buffer;
  boxes?: Array<{ x1: number; y1: number; x2: number; y2: number }>;
  points?: Array<{ x: number; y: number; label: 0 | 1 }>;
  textPrompt?: string;
  className?: string;
}

export interface Detection {
  polygon: [number, number][];
  bbox: [number, number, number, number];
  score: number;
  className?: string;
}

export interface PredictionResult {
  success: boolean;
  backend: 'aws' | 'roboflow';
  detections: Detection[];
  count: number;
  processingTimeMs: number;
  startupMessage?: string;
  error?: string;
  errorCode?: string;
}

// Max image size for Roboflow (parity with AWS)
const MAX_IMAGE_SIZE = 2048;

export interface SAM3OrchestratorStatus {
  awsAvailable: boolean;
  awsConfigured: boolean;
  awsState: string;
  awsGpuAvailable: boolean;
  awsModelLoaded: boolean;
  roboflowConfigured: boolean;
  preferredBackend: 'aws' | 'roboflow' | 'none';
  funMessage: string;
}

/**
 * Orchestrates SAM3 predictions between AWS and Roboflow backends
 */
class SAM3Orchestrator {
  /**
   * Get the current status of all SAM3 backends
   */
  async getStatus(): Promise<SAM3OrchestratorStatus> {
    const awsStatus = awsSam3Service.getStatus();

    return {
      awsAvailable: awsSam3Service.isConfigured() && awsSam3Service.isReady(),
      awsConfigured: awsSam3Service.isConfigured(),
      awsState: awsStatus.instanceState,
      awsGpuAvailable: awsStatus.gpuAvailable,
      awsModelLoaded: awsStatus.modelLoaded,
      roboflowConfigured: Boolean(ROBOFLOW_API_KEY),
      preferredBackend: awsSam3Service.isConfigured()
        ? 'aws'
        : ROBOFLOW_API_KEY
          ? 'roboflow'
          : 'none',
      funMessage: awsStatus.funMessage,
    };
  }

  /**
   * Ensure the AWS SAM3 instance is ready, starting it if needed
   * Returns immediately with a fun message if starting
   */
  async ensureAWSReady(): Promise<{ ready: boolean; message: string; starting: boolean }> {
    if (!awsSam3Service.isConfigured()) {
      return { ready: false, message: 'AWS SAM3 not configured', starting: false };
    }

    if (awsSam3Service.isReady()) {
      return { ready: true, message: 'Ready!', starting: false };
    }

    // Start the instance in the background
    const funMessage = awsSam3Service.getRandomFunMessage();
    console.log('[Orchestrator] Starting AWS SAM3 instance...');

    // Don't await - let it start in background
    awsSam3Service.startInstance().catch((error) => {
      console.error('[Orchestrator] Failed to start AWS instance:', error);
    });

    return { ready: false, message: funMessage, starting: true };
  }

  /**
   * Wait for AWS to be ready (blocking)
   */
  async waitForAWSReady(_timeoutMs: number = 180000): Promise<boolean> {
    if (!awsSam3Service.isConfigured()) return false;
    if (awsSam3Service.isReady()) return true;

    // Start instance and wait for it
    return await awsSam3Service.startInstance();
  }

  /**
   * Main prediction method - tries AWS first, falls back to Roboflow
   */
  async predict(request: PredictionRequest): Promise<PredictionResult> {
    const startTime = Date.now();

    // Try AWS first if configured
    if (awsSam3Service.isConfigured()) {
      // If not ready, try to start
      if (!awsSam3Service.isReady()) {
        const { ready, message, starting } = await this.ensureAWSReady();

        if (!ready) {
          // If starting, return a "starting" response or fall back
          if (starting) {
            // For batch processing, we might want to wait
            // For real-time, fall back to Roboflow with a message
            console.log('[Orchestrator] AWS starting, falling back to Roboflow');
            return this.fallbackToRoboflow(request, startTime, message);
          }
          // Not starting, not ready - fall back
          return this.fallbackToRoboflow(request, startTime);
        }
      }

      // AWS is ready, try to predict
      const awsResult = await this.predictWithAWS(request);
      if (awsResult && awsResult.success) {
        return {
          ...awsResult,
          backend: 'aws',
          processingTimeMs: Date.now() - startTime,
        };
      }

      // AWS failed, fall back to Roboflow with error context
      const awsError = awsResult?.error || 'Unknown AWS error';
      console.log(`[Orchestrator] AWS prediction failed (${awsError}), falling back to Roboflow`);
    }

    return this.fallbackToRoboflow(request, startTime);
  }

  /**
   * Predict using AWS SAM3 instance
   */
  private async predictWithAWS(
    request: PredictionRequest
  ): Promise<Omit<PredictionResult, 'backend' | 'processingTimeMs'> | null> {
    try {
      // Resize image for T4 GPU
      const { buffer, scaling } = await awsSam3Service.resizeImage(request.imageBuffer);

      // Scale boxes to the resized image coordinates
      const boxesForAPI = (request.boxes || []).map((box) => ({
        x1: Math.round(box.x1 * scaling.scaleFactor),
        y1: Math.round(box.y1 * scaling.scaleFactor),
        x2: Math.round(box.x2 * scaling.scaleFactor),
        y2: Math.round(box.y2 * scaling.scaleFactor),
      }));

      // Call AWS SAM3 API
      const segmentResult = await awsSam3Service.segment({
        image: buffer.toString('base64'),
        boxes: boxesForAPI,
        className: request.className || request.textPrompt || 'weed',
      });

      // Handle structured error response
      if (!segmentResult.success || !segmentResult.response) {
        console.error(`[Orchestrator] AWS segment failed: ${segmentResult.error} (${segmentResult.errorCode})`);
        return {
          success: false,
          detections: [],
          count: 0,
          error: segmentResult.error,
          errorCode: segmentResult.errorCode,
        };
      }

      // Convert detections and scale back to original coordinates
      const detections: Detection[] = (segmentResult.response.detections || []).map((det) => {
        // Scale bbox back to original coordinates
        const scaledBbox = awsSam3Service.scaleCoordinatesToOriginal(
          {
            x1: det.bbox[0],
            y1: det.bbox[1],
            x2: det.bbox[2],
            y2: det.bbox[3],
          },
          scaling
        );

        // Create polygon from bbox (AWS API returns bbox, not polygon)
        const polygon: [number, number][] = [
          [scaledBbox.x1, scaledBbox.y1],
          [scaledBbox.x2, scaledBbox.y1],
          [scaledBbox.x2, scaledBbox.y2],
          [scaledBbox.x1, scaledBbox.y2],
        ];

        return {
          polygon,
          bbox: [scaledBbox.x1, scaledBbox.y1, scaledBbox.x2, scaledBbox.y2] as [
            number,
            number,
            number,
            number,
          ],
          score: det.confidence,
          className: det.class_name,
        };
      });

      return {
        success: true,
        detections,
        count: detections.length,
      };
    } catch (error) {
      console.error('[Orchestrator] AWS prediction error:', error);
      return null;
    }
  }

  /**
   * Resize image for Roboflow API (parity with AWS path)
   * Reduces cost and improves performance for large images
   */
  private async resizeImageForRoboflow(
    imageBuffer: Buffer
  ): Promise<{ buffer: Buffer; scaleFactor: number }> {
    const image = sharp(imageBuffer);
    const metadata = await image.metadata();

    const originalWidth = metadata.width || 0;
    const originalHeight = metadata.height || 0;
    const maxDimension = Math.max(originalWidth, originalHeight);

    // If already small enough, just convert to JPEG
    if (maxDimension <= MAX_IMAGE_SIZE) {
      return {
        buffer: await image.jpeg({ quality: 90 }).toBuffer(),
        scaleFactor: 1.0,
      };
    }

    // Calculate scale factor
    const scaleFactor = MAX_IMAGE_SIZE / maxDimension;
    const scaledWidth = Math.round(originalWidth * scaleFactor);
    const scaledHeight = Math.round(originalHeight * scaleFactor);

    console.log(
      `[Orchestrator] Resizing image for Roboflow from ${originalWidth}x${originalHeight} to ${scaledWidth}x${scaledHeight}`
    );

    return {
      buffer: await image.resize(scaledWidth, scaledHeight).jpeg({ quality: 90 }).toBuffer(),
      scaleFactor,
    };
  }

  /**
   * Fallback to Roboflow API
   */
  private async fallbackToRoboflow(
    request: PredictionRequest,
    startTime: number,
    startupMessage?: string
  ): Promise<PredictionResult> {
    if (!ROBOFLOW_API_KEY) {
      return {
        success: false,
        backend: 'roboflow',
        detections: [],
        count: 0,
        processingTimeMs: Date.now() - startTime,
        startupMessage,
        error: 'No SAM3 backend available (AWS not ready, Roboflow not configured)',
      };
    }

    try {
      console.log('[Orchestrator] Using Roboflow fallback');

      // Resize image for parity with AWS path (reduces cost/improves performance)
      const { buffer: resizedBuffer, scaleFactor } = await this.resizeImageForRoboflow(
        request.imageBuffer
      );

      // Build prompts for Roboflow API, scaling coordinates if needed
      const prompts: Array<{ type: string; data: unknown }> = [];

      if (request.textPrompt) {
        prompts.push({ type: 'text', data: request.textPrompt });
      }

      for (const box of request.boxes || []) {
        prompts.push({
          type: 'box',
          data: {
            x: Math.round(box.x1 * scaleFactor),
            y: Math.round(box.y1 * scaleFactor),
            width: Math.round((box.x2 - box.x1) * scaleFactor),
            height: Math.round((box.y2 - box.y1) * scaleFactor),
          },
        });
      }

      for (const point of request.points || []) {
        prompts.push({
          type: 'point',
          data: {
            x: Math.round(point.x * scaleFactor),
            y: Math.round(point.y * scaleFactor),
            positive: point.label === 1,
          },
        });
      }

      const response = await fetch(ROBOFLOW_SAM3_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${ROBOFLOW_API_KEY}`,
        },
        body: JSON.stringify({
          image: { type: 'base64', value: resizedBuffer.toString('base64') },
          prompts,
        }),
        signal: AbortSignal.timeout(120000),
      });

      if (!response.ok) {
        throw new Error(`Roboflow API error: ${response.status}`);
      }

      const result = await response.json();
      // Parse response and scale coordinates back to original size
      const detections = this.parseRoboflowResponse(result, scaleFactor);

      return {
        success: true,
        backend: 'roboflow',
        detections,
        count: detections.length,
        processingTimeMs: Date.now() - startTime,
        startupMessage,
      };
    } catch (error) {
      console.error('[Orchestrator] Roboflow fallback error:', error);
      return {
        success: false,
        backend: 'roboflow',
        detections: [],
        count: 0,
        processingTimeMs: Date.now() - startTime,
        startupMessage,
        error: (error as Error).message,
      };
    }
  }

  /**
   * Parse Roboflow's response format into our Detection format
   * Scales coordinates back to original image size if scaleFactor != 1
   */
  private parseRoboflowResponse(
    result: {
      prompt_results?: Array<{
        predictions?: Array<{
          masks?: number[][][];
          confidence?: number;
        }>;
      }>;
    },
    scaleFactor: number = 1.0
  ): Detection[] {
    const detections: Detection[] = [];
    const inverseScale = 1 / scaleFactor;

    for (const promptResult of result.prompt_results || []) {
      for (const pred of promptResult.predictions || []) {
        const masks = pred.masks || [];
        if (masks.length > 0 && masks[0].length >= 3) {
          const maskPoints = masks[0];

          // Scale polygon back to original image coordinates
          const polygon: [number, number][] = maskPoints.map(
            (p: number[]) =>
              [Math.round(p[0] * inverseScale), Math.round(p[1] * inverseScale)] as [number, number]
          );

          // Calculate bounding box from scaled polygon
          const xs = polygon.map((p) => p[0]);
          const ys = polygon.map((p) => p[1]);

          detections.push({
            polygon,
            bbox: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)],
            score: pred.confidence ?? 0.9,
          });
        }
      }
    }

    return detections;
  }

  /**
   * Stop the AWS instance (for manual control or shutdown)
   */
  async stopAWSInstance(): Promise<void> {
    await awsSam3Service.stopInstance();
  }

  /**
   * Check if the AWS instance is idle and should be shut down
   */
  checkIdleShutdown(): boolean {
    return awsSam3Service.isIdle();
  }

  /**
   * Get a random fun loading message
   */
  getRandomFunMessage(): string {
    return FUN_LOADING_MESSAGES[Math.floor(Math.random() * FUN_LOADING_MESSAGES.length)];
  }
}

// Export singleton instance
export const sam3Orchestrator = new SAM3Orchestrator();
