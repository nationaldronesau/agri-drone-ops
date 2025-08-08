import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  type PutObjectCommandInput,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

// Initialize S3 client
const s3Client = new S3Client({
  region: process.env.AWS_REGION || "ap-southeast-2",
  credentials: process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY ? {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  } : undefined, // Use IAM role if no credentials provided
});

const BUCKET_NAME = process.env.AWS_S3_BUCKET || "agridrone-ops";
const NODE_ENV = process.env.NODE_ENV || "development";
const SIGNED_URL_EXPIRY = 3600; // 1 hour

export interface S3UploadOptions {
  projectId: string;
  flightSession?: string;
  orthomosaicId?: string;
  filename: string;
  contentType: string;
  metadata?: Record<string, string>;
}

export interface S3UploadResult {
  key: string;
  bucket: string;
  location: string;
  etag?: string;
}

export class S3Service {
  /**
   * Generate S3 key based on file type and project structure
   */
  static generateKey(options: S3UploadOptions): string {
    const { projectId, flightSession, orthomosaicId, filename } = options;

    if (orthomosaicId) {
      // Orthomosaic structure: {NODE_ENV}/{projectId}/orthomosaics/{orthomosaicId}/{filename}
      return `${NODE_ENV}/${projectId}/orthomosaics/${orthomosaicId}/${filename}`;
    } else if (flightSession) {
      // Drone image structure: {NODE_ENV}/{projectId}/raw-images/{flightSession}/{filename}
      return `${NODE_ENV}/${projectId}/raw-images/${flightSession}/${filename}`;
    } else {
      // Fallback structure: {NODE_ENV}/{projectId}/misc/{filename}
      return `${NODE_ENV}/${projectId}/misc/${filename}`;
    }
  }

  /**
   * Upload a file to S3
   */
  static async uploadFile(
    buffer: Buffer,
    options: S3UploadOptions
  ): Promise<S3UploadResult> {
    const key = this.generateKey(options);

    const uploadParams: PutObjectCommandInput = {
      Bucket: BUCKET_NAME,
      Key: key,
      Body: buffer,
      ContentType: options.contentType,
      Metadata: {
        projectId: options.projectId,
        uploadedAt: new Date().toISOString(),
        environment: NODE_ENV,
        ...options.metadata,
      },
    };

    try {
      const command = new PutObjectCommand(uploadParams);
      const response = await s3Client.send(command);

      return {
        key,
        bucket: BUCKET_NAME,
        location: `https://${BUCKET_NAME}.s3.${process.env.AWS_REGION || "ap-southeast-2"}.amazonaws.com/${key}`,
        etag: response.ETag,
      };
    } catch (error) {
      console.error("S3 upload error:", error);
      throw new Error(`Failed to upload file to S3: ${error instanceof Error ? error.message : "Unknown error"}`);
    }
  }

  /**
   * Generate a presigned URL for secure file access
   */
  static async getSignedUrl(
    key: string,
    expiresIn: number = SIGNED_URL_EXPIRY
  ): Promise<string> {
    try {
      const command = new GetObjectCommand({
        Bucket: BUCKET_NAME,
        Key: key,
      });

      const url = await getSignedUrl(s3Client, command, { expiresIn });
      return url;
    } catch (error) {
      console.error("S3 signed URL error:", error);
      throw new Error(`Failed to generate signed URL: ${error instanceof Error ? error.message : "Unknown error"}`);
    }
  }

  /**
   * Check if an object exists in S3
   */
  static async objectExists(key: string): Promise<boolean> {
    try {
      const command = new HeadObjectCommand({
        Bucket: BUCKET_NAME,
        Key: key,
      });

      await s3Client.send(command);
      return true;
    } catch (error: any) {
      if (error.name === "NotFound" || error.$metadata?.httpStatusCode === 404) {
        return false;
      }
      throw error;
    }
  }

  /**
   * Delete a file from S3
   */
  static async deleteFile(key: string): Promise<void> {
    try {
      const command = new DeleteObjectCommand({
        Bucket: BUCKET_NAME,
        Key: key,
      });

      await s3Client.send(command);
    } catch (error) {
      console.error("S3 delete error:", error);
      throw new Error(`Failed to delete file from S3: ${error instanceof Error ? error.message : "Unknown error"}`);
    }
  }

  /**
   * List objects in a specific path
   */
  static async listObjects(prefix: string, maxKeys: number = 1000): Promise<string[]> {
    try {
      const command = new ListObjectsV2Command({
        Bucket: BUCKET_NAME,
        Prefix: prefix,
        MaxKeys: maxKeys,
      });

      const response = await s3Client.send(command);
      return response.Contents?.map(obj => obj.Key || "").filter(Boolean) || [];
    } catch (error) {
      console.error("S3 list error:", error);
      throw new Error(`Failed to list objects from S3: ${error instanceof Error ? error.message : "Unknown error"}`);
    }
  }

  /**
   * Download a file from S3
   */
  static async downloadFile(key: string): Promise<Buffer> {
    try {
      const command = new GetObjectCommand({
        Bucket: BUCKET_NAME,
        Key: key,
      });

      const response = await s3Client.send(command);
      
      if (!response.Body) {
        throw new Error("No body in S3 response");
      }

      // Convert stream to buffer
      const chunks: Uint8Array[] = [];
      for await (const chunk of response.Body as any) {
        chunks.push(chunk);
      }
      
      return Buffer.concat(chunks);
    } catch (error) {
      console.error("S3 download error:", error);
      throw new Error(`Failed to download file from S3: ${error instanceof Error ? error.message : "Unknown error"}`);
    }
  }

  /**
   * Generate a public URL (only works if bucket has public access)
   */
  static getPublicUrl(key: string): string {
    return `https://${BUCKET_NAME}.s3.${process.env.AWS_REGION || "ap-southeast-2"}.amazonaws.com/${key}`;
  }

  /**
   * Copy an object within S3
   */
  static async copyObject(sourceKey: string, destinationKey: string): Promise<void> {
    try {
      const command = new PutObjectCommand({
        Bucket: BUCKET_NAME,
        Key: destinationKey,
        CopySource: `${BUCKET_NAME}/${sourceKey}`,
      });

      await s3Client.send(command);
    } catch (error) {
      console.error("S3 copy error:", error);
      throw new Error(`Failed to copy object in S3: ${error instanceof Error ? error.message : "Unknown error"}`);
    }
  }
}