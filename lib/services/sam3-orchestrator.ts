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
  imageUrl?: string; // For AWS point-based predictions (more efficient - avoids double fetch)
  assetId?: string; // For AWS image caching
  boxes?: Array<{ x1: number; y1: number; x2: number; y2: number }>;
  points?: Array<{ x: number; y: number; label: 0 | 1 }>;
  textPrompt?: string;
  className?: string;
}

// Request for prediction with visual exemplar crops (cross-image detection)
export interface ExemplarPredictionRequest {
  imageBuffer: Buffer;
  exemplarCrops: string[]; // Base64 encoded crop images from source
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
   * Refreshes AWS status by actually querying EC2 and health endpoint
   */
  async getStatus(): Promise<SAM3OrchestratorStatus> {
    // Refresh AWS status to get actual EC2 state (not just cached)
    const awsStatus = await awsSam3Service.refreshStatus();

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
          // If starting, wait for AWS to be ready instead of falling back to Roboflow
          if (starting) {
            console.log('[Orchestrator] AWS starting, waiting for it to be ready...');
            const awsReady = await this.waitForAWSReady(180000); // Wait up to 3 minutes
            if (!awsReady) {
              console.log('[Orchestrator] AWS failed to start, falling back to Roboflow');
              return this.fallbackToRoboflow(request, startTime, message);
            }
            console.log('[Orchestrator] AWS is now ready, proceeding with prediction');
            // Continue to prediction below
          } else {
            // Not starting, not ready - fall back
            return this.fallbackToRoboflow(request, startTime);
          }
        }
      }

      // AWS is ready, try to predict
      console.log(`[Orchestrator] Attempting AWS prediction. Has imageUrl: ${!!request.imageUrl}, Has assetId: ${!!request.assetId}, Has points: ${request.points?.length || 0}`);
      const awsResult = await this.predictWithAWS(request);

      if (awsResult === null) {
        console.log('[Orchestrator] AWS returned null (likely missing imageUrl/assetId for point prediction), falling back to Roboflow');
      } else if (!awsResult.success) {
        console.log(`[Orchestrator] AWS prediction failed: ${awsResult.error}, falling back to Roboflow`);
      } else {
        console.log(`[Orchestrator] AWS prediction succeeded with ${awsResult.detections.length} detections`);
        return {
          ...awsResult,
          backend: 'aws',
          processingTimeMs: Date.now() - startTime,
        };
      }
    }

    return this.fallbackToRoboflow(request, startTime);
  }

  /**
   * Predict using AWS SAM3 instance
   *
   * Supports two modes:
   * - Point-based prediction (click-to-segment): Uses /api/v1/predict endpoint
   * - Box-based prediction (few-shot): Uses /segment endpoint
   */
  private async predictWithAWS(
    request: PredictionRequest
  ): Promise<Omit<PredictionResult, 'backend' | 'processingTimeMs'> | null> {
    try {
      const hasPoints = request.points && request.points.length > 0;
      const hasBoxes = request.boxes && request.boxes.length > 0;

      // Point-based prediction (click-to-segment)
      if (hasPoints && request.imageUrl && request.assetId) {
        console.log('[Orchestrator] Using AWS point-based prediction');

        // The SAM3 Python service handles image resizing internally (max 2048px)
        // and scales coordinates automatically, so we pass original coordinates
        const predictResult = await awsSam3Service.predictWithPoints({
          imageUrl: request.imageUrl,
          assetId: request.assetId,
          points: request.points!,
        });

        if (!predictResult.success || !predictResult.response) {
          console.error(`[Orchestrator] AWS predict failed: ${predictResult.error} (${predictResult.errorCode})`);
          return {
            success: false,
            detections: [],
            count: 0,
            error: predictResult.error,
            errorCode: predictResult.errorCode,
          };
        }

        // Convert response to Detection format
        // Coordinates are already in original image space (Python service handles scaling)
        const response = predictResult.response;
        const detections: Detection[] = [];

        if (response.polygon && response.polygon.length >= 3) {
          detections.push({
            polygon: response.polygon,
            bbox: response.bbox || [0, 0, 0, 0],
            score: response.score,
            className: request.className,
          });
        }

        return {
          success: true,
          detections,
          count: detections.length,
        };
      }

      // Box-based prediction (few-shot detection) - requires boxes
      if (!hasBoxes) {
        // If we have points but no imageUrl/assetId, we can't use AWS for points
        // Return null to trigger Roboflow fallback
        if (hasPoints) {
          console.log('[Orchestrator] Points provided but missing imageUrl/assetId for AWS, will use fallback');
          return null;
        }
        // No points, no boxes - nothing to do
        return {
          success: false,
          detections: [],
          count: 0,
          error: 'No points or boxes provided',
        };
      }

      // Resize image for T4 GPU
      const { buffer, scaling } = await awsSam3Service.resizeImage(request.imageBuffer);

      // Scale boxes to the resized image coordinates
      const boxesForAPI = request.boxes!.map((box) => ({
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

        // Use polygon from API if available (v0.6.0+), otherwise fall back to bbox rectangle
        let polygon: [number, number][];
        if (det.polygon && Array.isArray(det.polygon) && det.polygon.length >= 3) {
          // Scale polygon coordinates back to original image space
          const inverseScale = 1 / scaling.scaleFactor;
          polygon = det.polygon.map((point: number[]) => [
            Math.round(point[0] * inverseScale),
            Math.round(point[1] * inverseScale),
          ] as [number, number]);
        } else {
          // Fallback: Create polygon from bbox (for older API versions)
          polygon = [
            [scaledBbox.x1, scaledBbox.y1],
            [scaledBbox.x2, scaledBbox.y1],
            [scaledBbox.x2, scaledBbox.y2],
            [scaledBbox.x1, scaledBbox.y2],
          ];
        }

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
      console.log('[Orchestrator] Roboflow raw response:', JSON.stringify(result).substring(0, 500));

      // Parse response and scale coordinates back to original size
      const detections = this.parseRoboflowResponse(result, scaleFactor);
      console.log(`[Orchestrator] Parsed ${detections.length} detections from Roboflow`);

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
   * Predict using visual exemplar crops for cross-image detection
   *
   * This is the key method for batch processing where exemplar boxes
   * drawn on a source image are used to find similar objects in target images.
   */
  async predictWithExemplars(request: ExemplarPredictionRequest): Promise<PredictionResult> {
    const startTime = Date.now();

    // Try AWS first if configured
    if (awsSam3Service.isConfigured()) {
      // If not ready, try to start
      if (!awsSam3Service.isReady()) {
        const { ready, message, starting } = await this.ensureAWSReady();

        if (!ready) {
          if (starting) {
            console.log('[Orchestrator] AWS starting, waiting for exemplar prediction...');
            const awsReady = await this.waitForAWSReady(180000);
            if (!awsReady) {
              console.log('[Orchestrator] AWS failed to start for exemplar prediction');
              return {
                success: false,
                backend: 'aws',
                detections: [],
                count: 0,
                processingTimeMs: Date.now() - startTime,
                startupMessage: message,
                error: 'AWS failed to start',
              };
            }
          } else {
            return {
              success: false,
              backend: 'aws',
              detections: [],
              count: 0,
              processingTimeMs: Date.now() - startTime,
              error: 'AWS not ready and not starting',
            };
          }
        }
      }

      // AWS is ready, use exemplar-based prediction
      console.log(`[Orchestrator] Using AWS exemplar prediction with ${request.exemplarCrops.length} crops`);

      // Resize image for GPU memory limits
      const { buffer, scaling } = await awsSam3Service.resizeImage(request.imageBuffer);
      const base64Image = buffer.toString('base64');

      const result = await awsSam3Service.segmentWithExemplars({
        image: base64Image,
        exemplarCrops: request.exemplarCrops,
        className: request.className,
      });

      if (!result.success || !result.response) {
        console.error(`[Orchestrator] AWS exemplar prediction failed: ${result.error}`);
        return {
          success: false,
          backend: 'aws',
          detections: [],
          count: 0,
          processingTimeMs: Date.now() - startTime,
          error: result.error,
          errorCode: result.errorCode,
        };
      }

      // Convert detections and scale back to original coordinates
      const detections: Detection[] = (result.response.detections || []).map((det) => {
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

        // Scale polygon if available
        let polygon: [number, number][];
        if (det.polygon && Array.isArray(det.polygon) && det.polygon.length >= 3) {
          const inverseScale = 1 / scaling.scaleFactor;
          polygon = det.polygon.map((point: number[]) => [
            Math.round(point[0] * inverseScale),
            Math.round(point[1] * inverseScale),
          ] as [number, number]);
        } else {
          // Fallback: Create polygon from bbox
          polygon = [
            [scaledBbox.x1, scaledBbox.y1],
            [scaledBbox.x2, scaledBbox.y1],
            [scaledBbox.x2, scaledBbox.y2],
            [scaledBbox.x1, scaledBbox.y2],
          ];
        }

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

      console.log(`[Orchestrator] AWS exemplar prediction succeeded with ${detections.length} detections`);
      return {
        success: true,
        backend: 'aws',
        detections,
        count: detections.length,
        processingTimeMs: Date.now() - startTime,
      };
    }

    // No AWS available
    return {
      success: false,
      backend: 'aws',
      detections: [],
      count: 0,
      processingTimeMs: Date.now() - startTime,
      error: 'AWS SAM3 not configured for exemplar prediction',
    };
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
