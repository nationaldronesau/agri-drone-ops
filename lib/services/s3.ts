import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
  type CompletedPart,
  type PutObjectCommandInput,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { randomUUID } from "crypto";
import path from "path";

// Initialize S3 client
export const s3Client = new S3Client({
  region: process.env.AWS_REGION || "ap-southeast-2",
  credentials: process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY ? {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  } : undefined, // Use IAM role if no credentials provided
});

const BUCKET_NAME = process.env.AWS_S3_BUCKET || "agridrone-ops";
const NODE_ENV = process.env.NODE_ENV || "development";
const APP_ENV = process.env.APP_ENV || NODE_ENV;
const SIGNED_URL_EXPIRY = 3600; // 1 hour
const DEFAULT_PART_SIZE = 10 * 1024 * 1024; // 10MB chunks for multipart upload
const MULTIPART_SIGNED_URL_TTL = 900; // 15 minutes

const sanitizeSegment = (value: string): string =>
  value.replace(/[^a-zA-Z0-9_\-./]/g, "_");

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

export interface CreateMultipartUploadOptions {
  userId: string;
  projectId: string;
  fileName: string;
  contentType: string;
  flightSession?: string;
  metadata?: Record<string, string>;
}

export interface MultipartUploadPart {
  ETag: string;
  PartNumber: number;
}

export interface MultipartUploadResult {
  uploadId: string;
  key: string;
  bucket: string;
  url: string;
  partSize: number;
}

export class S3Service {
  static get bucketName(): string {
    if (!BUCKET_NAME) {
      throw new Error("AWS_S3_BUCKET is not configured");
    }
    return BUCKET_NAME;
  }

  static get environmentSegment(): string {
    return APP_ENV;
  }

  static getUserUploadPrefix(userId: string): string {
    return `uploads/${this.environmentSegment}/${sanitizeSegment(userId)}/`;
  }

  static buildUserUploadKey(options: {
    userId: string;
    projectId: string;
    flightSession?: string | null;
    originalFileName: string;
  }): string {
    const { userId, projectId, flightSession, originalFileName } = options;

    const userPrefix = this.getUserUploadPrefix(userId);
    const projectSegment = sanitizeSegment(projectId || "unassigned");
    const sessionSegment = sanitizeSegment(
      flightSession && flightSession.trim().length > 0
        ? flightSession
        : "default",
    );
    const extension = path.extname(originalFileName || "").toLowerCase();
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const uniqueId = randomUUID();

    return `${userPrefix}${projectSegment}/${sessionSegment}/${timestamp}_${uniqueId}${extension}`;
  }

  static isKeyWithinUserScope(key: string, userId: string): boolean {
    return key.startsWith(this.getUserUploadPrefix(userId));
  }

  static parseS3Url(url: string): { bucket: string; key: string } {
    const parsed = new URL(url);
    const hostSegments = parsed.hostname.split(".");

    // Virtual-hosted style: <bucket>.s3.<region>.amazonaws.com
    if (hostSegments.length >= 3 && hostSegments[1] === "s3") {
      const bucket = hostSegments[0];
      const key = parsed.pathname.replace(/^\//, "");
      return { bucket, key };
    }

    // Path-style: s3.<region>.amazonaws.com/<bucket>/<key>
    const pathSegments = parsed.pathname.split("/").filter(Boolean);
    if (hostSegments[0] === "s3" && pathSegments.length >= 1) {
      const [bucket, ...rest] = pathSegments;
      return { bucket, key: rest.join("/") };
    }

    throw new Error(`Unsupported S3 URL format: ${url}`);
  }

  static buildPublicUrl(key: string, bucket: string = this.bucketName): string {
    const region = process.env.AWS_REGION || "ap-southeast-2";
    return `https://${bucket}.s3.${region}.amazonaws.com/${key}`;
  }

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
   * Initiate a multipart upload session
   */
  static async createMultipartUpload(
    options: CreateMultipartUploadOptions,
  ): Promise<MultipartUploadResult> {
    const key = this.buildUserUploadKey({
      userId: options.userId,
      projectId: options.projectId,
      flightSession: options.flightSession,
      originalFileName: options.fileName,
    });

    const command = new CreateMultipartUploadCommand({
      Bucket: this.bucketName,
      Key: key,
      ContentType: options.contentType,
      Metadata: {
        projectId: options.projectId,
        userId: options.userId,
        environment: this.environmentSegment,
        originalFileName: options.fileName,
        flightSession: options.flightSession || "default",
        ...(options.metadata || {}),
      },
    });

    const response = await s3Client.send(command);
    if (!response.UploadId) {
      throw new Error("Failed to initiate multipart upload");
    }

    return {
      uploadId: response.UploadId,
      key,
      bucket: this.bucketName,
      url: this.buildPublicUrl(key),
      partSize: DEFAULT_PART_SIZE,
    };
  }

  /**
   * Generate presigned URL for a multipart upload part
   */
  static async signMultipartUploadPart(options: {
    key: string;
    uploadId: string;
    partNumber: number;
    contentLength?: number;
  }): Promise<{ url: string; expiresIn: number }> {
    const command = new UploadPartCommand({
      Bucket: this.bucketName,
      Key: options.key,
      UploadId: options.uploadId,
      PartNumber: options.partNumber,
      ContentLength: options.contentLength,
    });

    const url = await getSignedUrl(s3Client, command, {
      expiresIn: MULTIPART_SIGNED_URL_TTL,
    });

    return { url, expiresIn: MULTIPART_SIGNED_URL_TTL };
  }

  /**
   * Complete a multipart upload
   */
  static async completeMultipartUpload(options: {
    key: string;
    uploadId: string;
    parts: MultipartUploadPart[];
  }): Promise<{ location: string; bucket: string; key: string }> {
    const command = new CompleteMultipartUploadCommand({
      Bucket: this.bucketName,
      Key: options.key,
      UploadId: options.uploadId,
      MultipartUpload: {
        Parts: options.parts
          .sort((a, b) => a.PartNumber - b.PartNumber)
          .map<CompletedPart>((part) => ({
            ETag: part.ETag,
            PartNumber: part.PartNumber,
          })),
      },
    });

    const response = await s3Client.send(command);

    return {
      location: response.Location || this.buildPublicUrl(options.key),
      bucket: response.Bucket || this.bucketName,
      key: response.Key || options.key,
    };
  }

  /**
   * Abort a multipart upload session (best-effort)
   */
  static async abortMultipartUpload(options: {
    key: string;
    uploadId: string;
  }): Promise<void> {
    const command = new AbortMultipartUploadCommand({
      Bucket: this.bucketName,
      Key: options.key,
      UploadId: options.uploadId,
    });

    await s3Client.send(command);
  }

  /**
   * Generate a presigned PUT URL for small direct uploads
   */
  static async getPresignedPutUrl(options: {
    userId: string;
    projectId: string;
    fileName: string;
    contentType: string;
    flightSession?: string;
    metadata?: Record<string, string>;
    expiresInSeconds?: number;
  }): Promise<{
    url: string;
    key: string;
    bucket: string;
    expiresIn: number;
    uploadUrl: string;
  }> {
    const key = this.buildUserUploadKey({
      userId: options.userId,
      projectId: options.projectId,
      flightSession: options.flightSession,
      originalFileName: options.fileName,
    });

    const command = new PutObjectCommand({
      Bucket: this.bucketName,
      Key: key,
      ContentType: options.contentType,
      Metadata: {
        projectId: options.projectId,
        userId: options.userId,
        environment: this.environmentSegment,
        originalFileName: options.fileName,
        flightSession: options.flightSession || "default",
        ...(options.metadata || {}),
      },
    });

    const expiresIn = options.expiresInSeconds ?? MULTIPART_SIGNED_URL_TTL;
    const signedUrl = await getSignedUrl(s3Client, command, {
      expiresIn,
    });

    return {
      url: this.buildPublicUrl(key),
      key,
      bucket: this.bucketName,
      expiresIn,
      uploadUrl: signedUrl,
    };
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
    } catch (error) {
      const err = error as { name?: string; $metadata?: { httpStatusCode?: number } };
      if (err?.name === "NotFound" || err?.$metadata?.httpStatusCode === 404) {
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
  static async downloadFile(
    key: string,
    bucket: string = this.bucketName,
  ): Promise<Buffer> {
    try {
      const command = new GetObjectCommand({
        Bucket: bucket,
        Key: key,
      });

      const response = await s3Client.send(command);
      
      if (!response.Body) {
        throw new Error("No body in S3 response");
      }

      const bodyStream = response.Body as AsyncIterable<Uint8Array>;
      const chunks: Uint8Array[] = [];
      for await (const chunk of bodyStream) {
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
    return this.buildPublicUrl(key);
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
