/**
 * AWS SAM3 Service Module
 *
 * Manages EC2 instance lifecycle and SAM3 API interactions.
 * Key responsibilities:
 * - EC2 instance start/stop via AWS SDK
 * - IP address discovery from running instances
 * - Health check and warmup handling
 * - Image resizing for T4 GPU memory limits (max 2048px)
 * - Coordinate scaling for resized images
 * - Activity tracking for auto-shutdown
 */
import {
  EC2Client,
  DescribeInstancesCommand,
  StartInstancesCommand,
  StopInstancesCommand,
} from '@aws-sdk/client-ec2';
import sharp from 'sharp';

// Configuration - Support both naming conventions for backward compatibility
const AWS_REGION = process.env.SAM3_EC2_REGION || process.env.AWS_REGION || 'ap-southeast-2';
const SAM3_INSTANCE_ID = process.env.SAM3_EC2_INSTANCE_ID || process.env.SAM3_INSTANCE_ID;
const SAM3_PORT = process.env.SAM3_EC2_PORT || process.env.SAM3_PORT || '8000';
const IDLE_TIMEOUT_MS = parseInt(process.env.SAM3_IDLE_TIMEOUT_MS || '3600000'); // 1 hour default
const MAX_IMAGE_SIZE = 2048;
const STARTUP_TIMEOUT_MS = 180000; // 3 minutes to start and warm up
const HEALTH_CHECK_INTERVAL_MS = 5000; // Check every 5 seconds during startup

// Fun loading messages for the UI
export const FUN_LOADING_MESSAGES = [
  'Waking up the squirrels...',
  'Teaching hamsters to run faster...',
  'Warming up the GPU neurons...',
  'Convincing the AI to help...',
  'Dusting off the neural networks...',
  'Brewing digital coffee...',
  'Stretching the tensors...',
  'Polishing the pixels...',
  'Summoning the machine spirits...',
  'Loading weed detection spells...',
  'Calibrating the pixel wizards...',
  'Herding digital cats...',
  'Spinning up the flux capacitor...',
  'Consulting the oracle of vegetation...',
];

export type SAM3InstanceState =
  | 'stopped'
  | 'starting'
  | 'running'
  | 'warming'
  | 'ready'
  | 'stopping'
  | 'error';

export interface SAM3Status {
  instanceState: SAM3InstanceState;
  ipAddress: string | null;
  modelLoaded: boolean;
  gpuAvailable: boolean;
  lastActivity: number;
  backend: 'aws' | 'roboflow' | null;
  funMessage: string;
}

export interface ScalingInfo {
  originalWidth: number;
  originalHeight: number;
  scaledWidth: number;
  scaledHeight: number;
  scaleFactor: number;
}

export interface SAM3SegmentRequest {
  image: string; // base64 encoded JPEG
  boxes: Array<{ x1: number; y1: number; x2: number; y2: number }>;
  className: string;
  minSize?: number;
  maxSize?: number | null;
}

export interface SAM3Detection {
  bbox: [number, number, number, number];
  area: number;
  class_name: string;
  confidence: number;
}

export interface SAM3SegmentResponse {
  detections: SAM3Detection[];
  count: number;
  image_size: [number, number];
}

export interface SAM3SegmentResult {
  success: boolean;
  response: SAM3SegmentResponse | null;
  error?: string;
  errorCode?: 'NOT_CONFIGURED' | 'NOT_READY' | 'API_ERROR' | 'TIMEOUT' | 'NETWORK_ERROR';
}

// Point-based prediction interfaces (for click-to-segment)
export interface SAM3PointPredictRequest {
  imageUrl: string;
  assetId: string;
  points: Array<{ x: number; y: number; label: 0 | 1 }>;
  simplifyTolerance?: number;
}

export interface SAM3PointPredictResponse {
  success: boolean;
  score: number;
  polygon: [number, number][] | null;
  bbox: [number, number, number, number] | null;
  processingTimeMs: number;
  device: string;
  message?: string;
}

export interface SAM3PointPredictResult {
  success: boolean;
  response: SAM3PointPredictResponse | null;
  error?: string;
  errorCode?: 'NOT_CONFIGURED' | 'NOT_READY' | 'API_ERROR' | 'TIMEOUT' | 'NETWORK_ERROR';
}

/**
 * Singleton service for AWS EC2 SAM3 instance management
 */
class AWSSAM3Service {
  private ec2Client: EC2Client | null = null;
  private instanceIp: string | null = null;
  private instanceState: SAM3InstanceState = 'stopped';
  private lastActivityTime: number = 0;
  private modelLoaded: boolean = false;
  private gpuAvailable: boolean = false;
  private startupPromise: Promise<boolean> | null = null;
  private configError: string | null = null;
  private configured: boolean = false;

  constructor() {
    this.validateAndInitialize();
  }

  /**
   * Validate configuration and initialize EC2 client
   * Called once at startup to detect missing config early
   */
  private validateAndInitialize(): void {
    // Check for instance ID first
    if (!SAM3_INSTANCE_ID) {
      this.configError = 'SAM3_INSTANCE_ID environment variable not set';
      console.log('[AWS-SAM3] AWS SAM3 not configured: missing SAM3_INSTANCE_ID');
      return;
    }

    // Check for AWS credentials
    const hasExplicitCreds = process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY;

    if (hasExplicitCreds) {
      try {
        this.ec2Client = new EC2Client({
          region: AWS_REGION,
          credentials: {
            accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
            secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
          },
        });
        this.configured = true;
        console.log(`[AWS-SAM3] Initialized with explicit credentials, instance: ${SAM3_INSTANCE_ID}, region: ${AWS_REGION}`);
      } catch (error) {
        this.configError = `Failed to initialize EC2 client: ${error instanceof Error ? error.message : 'Unknown error'}`;
        console.error('[AWS-SAM3] Failed to initialize:', this.configError);
      }
    } else {
      // Try default credentials (IAM role, instance profile, etc.)
      try {
        this.ec2Client = new EC2Client({ region: AWS_REGION });
        this.configured = true;
        console.log(`[AWS-SAM3] Initialized with default credentials, instance: ${SAM3_INSTANCE_ID}, region: ${AWS_REGION}`);
      } catch (error) {
        this.configError = `No AWS credentials available: ${error instanceof Error ? error.message : 'Unknown error'}`;
        console.error('[AWS-SAM3] Failed to initialize:', this.configError);
      }
    }
  }

  /**
   * Get any configuration error message
   */
  getConfigError(): string | null {
    return this.configError;
  }

  /**
   * Get a random fun loading message for the UI
   */
  getRandomFunMessage(): string {
    return FUN_LOADING_MESSAGES[Math.floor(Math.random() * FUN_LOADING_MESSAGES.length)];
  }

  /**
   * Update the last activity timestamp
   */
  updateActivity(): void {
    this.lastActivityTime = Date.now();
  }

  /**
   * Check if the instance has been idle past the timeout
   */
  isIdle(): boolean {
    if (this.lastActivityTime === 0) return false;
    if (this.instanceState !== 'ready') return false;
    return Date.now() - this.lastActivityTime > IDLE_TIMEOUT_MS;
  }

  /**
   * Query EC2 API to discover the current public IP of the instance
   */
  async discoverInstanceIp(): Promise<string | null> {
    if (!SAM3_INSTANCE_ID || !this.ec2Client) return null;

    try {
      const command = new DescribeInstancesCommand({
        InstanceIds: [SAM3_INSTANCE_ID],
      });
      const response = await this.ec2Client.send(command);
      const instance = response.Reservations?.[0]?.Instances?.[0];

      if (instance) {
        this.instanceIp = instance.PublicIpAddress || null;
        this.updateEC2State(instance.State?.Name);
        console.log(`[AWS-SAM3] Instance IP: ${this.instanceIp}, State: ${instance.State?.Name}`);
      }

      return this.instanceIp;
    } catch (error) {
      console.error('[AWS-SAM3] Failed to discover instance IP:', error);
      return null;
    }
  }

  /**
   * Start the EC2 instance
   */
  async startInstance(): Promise<boolean> {
    if (!SAM3_INSTANCE_ID || !this.ec2Client) {
      console.error('[AWS-SAM3] Cannot start instance: not configured');
      return false;
    }

    // If already starting, return the existing promise
    if (this.startupPromise) {
      console.log('[AWS-SAM3] Instance already starting, waiting...');
      return this.startupPromise;
    }

    // If already ready, just return
    if (this.instanceState === 'ready') {
      console.log('[AWS-SAM3] Instance already ready');
      return true;
    }

    this.startupPromise = this._doStartInstance();
    try {
      return await this.startupPromise;
    } finally {
      this.startupPromise = null;
    }
  }

  private async _doStartInstance(): Promise<boolean> {
    try {
      console.log('[AWS-SAM3] Starting EC2 instance...');
      this.instanceState = 'starting';

      const command = new StartInstancesCommand({
        InstanceIds: [SAM3_INSTANCE_ID!],
      });
      await this.ec2Client!.send(command);

      // Wait for instance to be ready
      return await this.waitForReady();
    } catch (error) {
      console.error('[AWS-SAM3] Failed to start instance:', error);
      this.instanceState = 'error';
      return false;
    }
  }

  /**
   * Wait for the instance to be running and the model to be ready
   */
  private async waitForReady(): Promise<boolean> {
    const startTime = Date.now();

    while (Date.now() - startTime < STARTUP_TIMEOUT_MS) {
      await new Promise((resolve) => setTimeout(resolve, HEALTH_CHECK_INTERVAL_MS));

      // Discover IP
      const ip = await this.discoverInstanceIp();
      if (!ip) {
        console.log('[AWS-SAM3] Waiting for IP address...');
        continue;
      }

      // Check health
      const health = await this.checkHealth();
      if (!health) {
        console.log('[AWS-SAM3] Waiting for health check...');
        continue;
      }

      // If model not loaded, warm it up
      if (!health.modelLoaded) {
        console.log('[AWS-SAM3] Model not loaded, warming up...');
        this.instanceState = 'warming';
        const warmed = await this.warmup();
        if (warmed) {
          console.log('[AWS-SAM3] Instance ready!');
          this.instanceState = 'ready';
          this.updateActivity();
          return true;
        }
      } else {
        console.log('[AWS-SAM3] Instance ready!');
        this.instanceState = 'ready';
        this.updateActivity();
        return true;
      }
    }

    console.error('[AWS-SAM3] Timeout waiting for instance to be ready');
    this.instanceState = 'error';
    return false;
  }

  /**
   * Stop the EC2 instance
   */
  async stopInstance(): Promise<void> {
    if (!SAM3_INSTANCE_ID || !this.ec2Client) return;

    try {
      console.log('[AWS-SAM3] Stopping EC2 instance...');
      this.instanceState = 'stopping';

      const command = new StopInstancesCommand({
        InstanceIds: [SAM3_INSTANCE_ID],
      });
      await this.ec2Client.send(command);

      this.instanceState = 'stopped';
      this.instanceIp = null;
      this.modelLoaded = false;
      console.log('[AWS-SAM3] Instance stopped');
    } catch (error) {
      console.error('[AWS-SAM3] Failed to stop instance:', error);
    }
  }

  /**
   * Check the health of the SAM3 API
   */
  async checkHealth(): Promise<{ modelLoaded: boolean; gpuAvailable: boolean } | null> {
    if (!this.instanceIp) return null;

    try {
      const response = await fetch(`http://${this.instanceIp}:${SAM3_PORT}/health`, {
        signal: AbortSignal.timeout(5000),
      });

      if (!response.ok) return null;

      const data = await response.json();
      // SAM3 service returns: { status, model_loaded, gpu_available, device }
      this.modelLoaded = data.model_loaded === true;
      this.gpuAvailable = data.gpu_available === true;

      return {
        modelLoaded: this.modelLoaded,
        gpuAvailable: this.gpuAvailable,
      };
    } catch {
      return null;
    }
  }

  /**
   * Warm up the SAM3 model (required after instance start)
   */
  async warmup(): Promise<boolean> {
    if (!this.instanceIp) return false;

    try {
      console.log('[AWS-SAM3] Warming up model...');
      const response = await fetch(`http://${this.instanceIp}:${SAM3_PORT}/api/v1/warmup`, {
        method: 'POST',
        signal: AbortSignal.timeout(120000), // 2 minutes for warmup
      });

      if (!response.ok) {
        console.error('[AWS-SAM3] Warmup failed:', response.status);
        return false;
      }

      const data = await response.json();
      console.log('[AWS-SAM3] Warmup complete:', data);
      this.modelLoaded = data.success === true;
      return this.modelLoaded;
    } catch (error) {
      console.error('[AWS-SAM3] Warmup error:', error);
      return false;
    }
  }

  /**
   * Resize an image to fit within the T4 GPU memory limits
   */
  async resizeImage(imageBuffer: Buffer): Promise<{ buffer: Buffer; scaling: ScalingInfo }> {
    const image = sharp(imageBuffer);
    const metadata = await image.metadata();

    const originalWidth = metadata.width || 0;
    const originalHeight = metadata.height || 0;
    const maxDimension = Math.max(originalWidth, originalHeight);

    // If already small enough, just convert to JPEG
    if (maxDimension <= MAX_IMAGE_SIZE) {
      return {
        buffer: await image.jpeg({ quality: 90 }).toBuffer(),
        scaling: {
          originalWidth,
          originalHeight,
          scaledWidth: originalWidth,
          scaledHeight: originalHeight,
          scaleFactor: 1.0,
        },
      };
    }

    // Calculate scale factor
    const scaleFactor = MAX_IMAGE_SIZE / maxDimension;
    const scaledWidth = Math.round(originalWidth * scaleFactor);
    const scaledHeight = Math.round(originalHeight * scaleFactor);

    console.log(
      `[AWS-SAM3] Resizing image from ${originalWidth}x${originalHeight} to ${scaledWidth}x${scaledHeight}`
    );

    return {
      buffer: await image.resize(scaledWidth, scaledHeight).jpeg({ quality: 90 }).toBuffer(),
      scaling: {
        originalWidth,
        originalHeight,
        scaledWidth,
        scaledHeight,
        scaleFactor,
      },
    };
  }

  /**
   * Scale coordinates from scaled image back to original coordinates
   */
  scaleCoordinatesToOriginal(
    coords: { x1: number; y1: number; x2: number; y2: number },
    scaling: ScalingInfo
  ): { x1: number; y1: number; x2: number; y2: number } {
    const inverseScale = 1 / scaling.scaleFactor;
    return {
      x1: Math.round(coords.x1 * inverseScale),
      y1: Math.round(coords.y1 * inverseScale),
      x2: Math.round(coords.x2 * inverseScale),
      y2: Math.round(coords.y2 * inverseScale),
    };
  }

  /**
   * Scale coordinates from original to scaled image
   */
  scaleCoordinatesToScaled(
    coords: { x1: number; y1: number; x2: number; y2: number },
    scaling: ScalingInfo
  ): { x1: number; y1: number; x2: number; y2: number } {
    return {
      x1: Math.round(coords.x1 * scaling.scaleFactor),
      y1: Math.round(coords.y1 * scaling.scaleFactor),
      x2: Math.round(coords.x2 * scaling.scaleFactor),
      y2: Math.round(coords.y2 * scaling.scaleFactor),
    };
  }

  /**
   * Call the SAM3 /segment endpoint
   * Returns structured result with error information for better observability
   */
  async segment(request: SAM3SegmentRequest): Promise<SAM3SegmentResult> {
    if (!this.configured) {
      return {
        success: false,
        response: null,
        error: this.configError || 'AWS SAM3 not configured',
        errorCode: 'NOT_CONFIGURED',
      };
    }

    if (!this.instanceIp || this.instanceState !== 'ready') {
      return {
        success: false,
        response: null,
        error: `Instance not ready (state: ${this.instanceState})`,
        errorCode: 'NOT_READY',
      };
    }

    this.updateActivity();

    try {
      console.log(
        `[AWS-SAM3] Calling /segment with ${request.boxes.length} boxes, class: ${request.className}`
      );

      const response = await fetch(`http://${this.instanceIp}:${SAM3_PORT}/segment`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          image: request.image,
          boxes: request.boxes,
          class_name: request.className,
          min_size: request.minSize ?? 100,
          max_size: request.maxSize ?? null,
        }),
        signal: AbortSignal.timeout(120000), // 2 minutes timeout
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => 'Unknown error');
        console.error(`[AWS-SAM3] Segment failed: ${response.status} - ${errorText}`);
        return {
          success: false,
          response: null,
          error: `SAM3 API error: ${response.status} - ${errorText.substring(0, 200)}`,
          errorCode: 'API_ERROR',
        };
      }

      const result = await response.json();
      console.log(`[AWS-SAM3] Segment returned ${result.count} detections`);
      return {
        success: true,
        response: result,
      };
    } catch (error) {
      const isTimeout = error instanceof Error && error.name === 'TimeoutError';
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      console.error('[AWS-SAM3] Segment error:', errorMessage);

      return {
        success: false,
        response: null,
        error: errorMessage,
        errorCode: isTimeout ? 'TIMEOUT' : 'NETWORK_ERROR',
      };
    }
  }

  /**
   * Call the SAM3 /api/v1/predict endpoint for point-based segmentation
   * This endpoint accepts click points and returns a polygon mask
   */
  async predictWithPoints(request: SAM3PointPredictRequest): Promise<SAM3PointPredictResult> {
    if (!this.configured) {
      return {
        success: false,
        response: null,
        error: this.configError || 'AWS SAM3 not configured',
        errorCode: 'NOT_CONFIGURED',
      };
    }

    if (!this.instanceIp || this.instanceState !== 'ready') {
      return {
        success: false,
        response: null,
        error: `Instance not ready (state: ${this.instanceState})`,
        errorCode: 'NOT_READY',
      };
    }

    this.updateActivity();

    try {
      console.log(
        `[AWS-SAM3] Calling /api/v1/predict with ${request.points.length} points for asset: ${request.assetId}`
      );

      const response = await fetch(`http://${this.instanceIp}:${SAM3_PORT}/api/v1/predict`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          imageUrl: request.imageUrl,
          assetId: request.assetId,
          points: request.points,
          simplifyTolerance: request.simplifyTolerance ?? 0.02,
        }),
        signal: AbortSignal.timeout(120000), // 2 minutes timeout
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => 'Unknown error');
        console.error(`[AWS-SAM3] Predict failed: ${response.status} - ${errorText}`);
        return {
          success: false,
          response: null,
          error: `SAM3 API error: ${response.status} - ${errorText.substring(0, 200)}`,
          errorCode: 'API_ERROR',
        };
      }

      const result = await response.json();
      console.log(`[AWS-SAM3] Predict returned score: ${result.score}`);
      return {
        success: true,
        response: result,
      };
    } catch (error) {
      const isTimeout = error instanceof Error && error.name === 'TimeoutError';
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      console.error('[AWS-SAM3] Predict error:', errorMessage);

      return {
        success: false,
        response: null,
        error: errorMessage,
        errorCode: isTimeout ? 'TIMEOUT' : 'NETWORK_ERROR',
      };
    }
  }

  /**
   * Check if the service is configured
   */
  isConfigured(): boolean {
    return this.configured && Boolean(this.ec2Client);
  }

  /**
   * Check if the instance is ready for requests
   */
  isReady(): boolean {
    return this.instanceState === 'ready' && Boolean(this.instanceIp);
  }

  /**
   * Get the current status of the service (cached)
   */
  getStatus(): SAM3Status {
    return {
      instanceState: this.instanceState,
      ipAddress: this.instanceIp,
      modelLoaded: this.modelLoaded,
      gpuAvailable: this.gpuAvailable,
      lastActivity: this.lastActivityTime,
      backend: this.instanceState === 'ready' ? 'aws' : null,
      funMessage: this.getRandomFunMessage(),
    };
  }

  /**
   * Refresh status by actually querying EC2 and health endpoint
   * Call this when you need fresh state (e.g., from status API)
   */
  async refreshStatus(): Promise<SAM3Status> {
    if (!this.configured) {
      return this.getStatus();
    }

    try {
      // Query EC2 to get current IP and state
      await this.discoverInstanceIp();

      // If we have an IP and instance is running, check health
      if (this.instanceIp && this.instanceState === 'running') {
        const health = await this.checkHealth();
        if (health?.modelLoaded) {
          this.instanceState = 'ready';
          console.log('[AWS-SAM3] Instance already ready (discovered on refresh)');
        }
      }
    } catch (error) {
      console.error('[AWS-SAM3] Error refreshing status:', error);
    }

    return this.getStatus();
  }

  /**
   * Get the instance ID for logging
   */
  getInstanceId(): string | undefined {
    return SAM3_INSTANCE_ID;
  }

  /**
   * Update internal state based on EC2 state
   */
  private updateEC2State(ec2State?: string): void {
    if (ec2State === 'running') {
      if (this.instanceState !== 'warming' && this.instanceState !== 'ready') {
        this.instanceState = 'running';
      }
    } else if (ec2State === 'stopped') {
      this.instanceState = 'stopped';
      this.instanceIp = null;
      this.modelLoaded = false;
    } else if (ec2State === 'pending') {
      this.instanceState = 'starting';
    } else if (ec2State === 'stopping') {
      this.instanceState = 'stopping';
    }
  }
}

// Export singleton instance
export const awsSam3Service = new AWSSAM3Service();
