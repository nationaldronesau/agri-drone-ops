import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CopyObjectCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  ListPartsCommand,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
  type CompletedPart,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

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

/**
 * SECURITY: Validates S3 keys to prevent path traversal attacks.
 * User-controlled S3 keys must be validated before use.
 *
 * Allows: alphanumeric, forward slash, underscore, hyphen, dot, space, plus,
 * parentheses, and other URL-safe characters commonly found in filenames.
 *
 * @param key - The S3 key to validate
 * @returns true if the key is safe, false otherwise
 */
export function validateS3Key(key: string): boolean {
  // Reject empty keys
  if (!key || key.length === 0) {
    return false;
  }

  // Reject keys that are too long (S3 max is 1024 bytes)
  if (key.length > 1024) {
    return false;
  }

  // CRITICAL: Reject path traversal attempts
  // Check for ".." anywhere in the key (handles URL-encoded variants too)
  let decodedKey: string;
  try {
    decodedKey = decodeURIComponent(key);
  } catch {
    // Malformed percent encoding - reject the key
    return false;
  }

  if (decodedKey.includes('..')) {
    return false;
  }

  // Reject double slashes (could indicate path manipulation)
  if (decodedKey.includes('//')) {
    return false;
  }

  // Reject keys starting with slash (S3 keys should be relative)
  if (decodedKey.startsWith('/')) {
    return false;
  }

  // Allow common filename characters including literal spaces, parentheses, etc.
  // S3 allows most characters, but we restrict to safe printable ASCII + common symbols
  // Uses literal space (not \s which includes tabs/newlines)
  // Allows: a-z A-Z 0-9 / _ - . space ( ) + @ = , ! ' # $ & ~
  if (!/^[\w \/\-\.\(\)\+@=,!'#$&~]+$/i.test(decodedKey)) {
    return false;
  }

  // Reject keys that could be interpreted as special files
  const dangerousPatterns = [
    /^\.\.$/,           // literal ".."
    /\/\.\.$/,          // ends with "/.."
    /^\.\.?\//,         // starts with "./" or "../"
    /\/\.\.?\//,        // contains "/./" or "/../"
  ];

  for (const pattern of dangerousPatterns) {
    if (pattern.test(decodedKey)) {
      return false;
    }
  }

  return true;
}

/**
 * SECURITY: Validates an S3 key, throwing if invalid.
 *
 * @param key - The S3 key to validate
 * @param context - Context for error messages (e.g., "uploaded file")
 * @throws Error if the key is invalid
 */
export function assertValidS3Key(key: string, context: string = 'S3 key'): void {
  if (!validateS3Key(key)) {
    throw new Error(
      `[SECURITY] Invalid ${context}: "${key.substring(0, 100)}${key.length > 100 ? '...' : ''}". ` +
      `Keys must not contain path traversal sequences (..) and must be relative paths.`
    );
  }
}

/**
 * SECURITY: Sanitizes a filename for use in S3 keys.
 * Removes/replaces potentially dangerous characters while preserving readability.
 *
 * @param fileName - The original filename
 * @returns Sanitized filename safe for S3 keys
 */
export function sanitizeFileName(fileName: string): string {
  // Decode any URL encoding first
  let sanitized = fileName;
  try {
    sanitized = decodeURIComponent(fileName);
  } catch {
    // If decoding fails, use as-is
  }

  // Remove path traversal sequences
  sanitized = sanitized.replace(/\.\./g, '');

  // Remove leading/trailing slashes and dots
  sanitized = sanitized.replace(/^[\/\.]+|[\/\.]+$/g, '');

  // Replace problematic characters with underscores
  // Keep: alphanumeric, underscore, hyphen, dot, space, parentheses
  sanitized = sanitized.replace(/[^\w\s\-\.\(\)]/g, '_');

  // Collapse multiple underscores/spaces
  sanitized = sanitized.replace(/[_\s]+/g, '_');

  // Ensure non-empty
  if (!sanitized || sanitized.length === 0) {
    sanitized = 'unnamed_file';
  }

  return sanitized;
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
  orthomosaicId?: string;
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

  static parseS3Url(url: string): { bucket: string; key: string } {
    const parsed = new URL(url);
    const hostSegments = parsed.hostname.split(".");

    let bucket: string;
    let encodedKey: string;

    // Virtual-hosted style: <bucket>.s3.<region>.amazonaws.com
    if (hostSegments.length >= 3 && hostSegments[1] === "s3") {
      bucket = hostSegments[0];
      encodedKey = parsed.pathname.replace(/^\//, "");
    }
    // Path-style: s3.<region>.amazonaws.com/<bucket>/<key>
    else if (hostSegments[0] === "s3" && parsed.pathname.split("/").filter(Boolean).length >= 1) {
      const pathSegments = parsed.pathname.split("/").filter(Boolean);
      bucket = pathSegments[0];
      encodedKey = pathSegments.slice(1).join("/");
    } else {
      throw new Error(`Unsupported S3 URL format: ${url}`);
    }

    // Decode the key since URL.pathname returns percent-encoded values
    // This ensures round-trip consistency: parseS3Url returns decoded key,
    // buildPublicUrl encodes it when constructing the URL
    let key: string;
    try {
      key = decodeURIComponent(encodedKey);
    } catch {
      // If decoding fails (malformed %), use the encoded key as-is
      // validateS3Key will catch any invalid characters
      key = encodedKey;
    }

    // SECURITY: Validate the parsed key to prevent path traversal
    assertValidS3Key(key, 'parsed S3 URL key');

    return { bucket, key };
  }

  static buildPublicUrl(key: string, bucket: string = this.bucketName): string {
    const region = process.env.AWS_REGION || "ap-southeast-2";
    // URL-encode each path segment to handle spaces, #, etc.
    const encodedKey = key.split('/').map(segment => encodeURIComponent(segment)).join('/');
    return `https://${bucket}.s3.${region}.amazonaws.com/${encodedKey}`;
  }

    /**
   * Generate an S3 key (path) for uploads based on project structure and file context.
   *
   * The key pattern dynamically adapts depending on whether the upload
   * belongs to a flight session, orthomosaic, or miscellaneous category.
   *
   * Examples:
   *  - Drone image:      development/{projectId}/raw-images/{flightSession}/{filename}
   *  - Orthomosaic:      development/{projectId}/orthomosaics/{orthomosaicId}/{filename}
   *  - Miscellaneous:    development/{projectId}/misc/{filename}
   *
   * @param {CreateMultipartUploadOptions} options - The upload configuration.
   * @param {string} options.projectId - The associated project ID.
   * @param {string} [options.flightSession] - The drone flight session identifier.
   * @param {string} [options.orthomosaicId] - The orthomosaic ID (if applicable).
   * @param {string} options.filename - The name of the file being uploaded.
   * @param {string} options.contentType - The MIME type of the file.
   * @param {Record<string, string>} [options.metadata] - Optional metadata to store in S3.
   *
   * @returns {string} The generated S3 key (relative path inside the bucket).
   */
  static generateKey(options: CreateMultipartUploadOptions): string {
    const { projectId, flightSession, orthomosaicId, fileName } = options;

    // SECURITY: Sanitize filename to prevent path traversal
    const safeFileName = sanitizeFileName(fileName);

    if (orthomosaicId) {
      // Orthomosaic structure
      return `${NODE_ENV}/${projectId}/orthomosaics/${orthomosaicId}/${safeFileName}`;
    } else if (flightSession) {
      // Drone image structure
      return `${NODE_ENV}/${projectId}/raw-images/${flightSession}/${safeFileName}`;
    } else {
      // Fallback (misc)
      return `${NODE_ENV}/${projectId}/misc/${safeFileName}`;
    }
  }


  /**
   * Initiate a multipart upload session
   */
  static async createMultipartUpload(
    options: CreateMultipartUploadOptions,
  ): Promise<MultipartUploadResult> {
    const key = this.generateKey(options);
    console.log("Multipart upload key:", key);

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
   * List parts that have been uploaded for a multipart upload session.
   * Required by Uppy for resumable uploads.
   */
  static async listParts(options: {
    key: string;
    uploadId: string;
  }): Promise<Array<{ PartNumber: number; Size: number; ETag: string }>> {
    const command = new ListPartsCommand({
      Bucket: this.bucketName,
      Key: options.key,
      UploadId: options.uploadId,
    });

    const response = await s3Client.send(command);

    return (response.Parts || []).map((part) => ({
      PartNumber: part.PartNumber || 0,
      Size: part.Size || 0,
      ETag: part.ETag || "",
    }));
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
    const key = this.generateKey({
      userId: options.userId,
      projectId: options.projectId,
      flightSession: options.flightSession,
      fileName: options.fileName,
      contentType: options.contentType,
      metadata: options.metadata,
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
   * Generate a presigned URL for secure file access
   */
  static async getSignedUrl(
    key: string,
    expiresIn: number = SIGNED_URL_EXPIRY,
    bucket: string = BUCKET_NAME
  ): Promise<string> {
    try {
      const command = new GetObjectCommand({
        Bucket: bucket,
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
   * Upload a buffer directly to S3
   */
  static async uploadBuffer(
    buffer: Buffer,
    key: string,
    contentType: string,
    bucket: string = this.bucketName
  ): Promise<void> {
    assertValidS3Key(key, 'S3 upload key');
    try {
      const command = new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: buffer,
        ContentType: contentType,
      });

      await s3Client.send(command);
    } catch (error) {
      console.error("S3 upload error:", error);
      throw new Error(`Failed to upload file to S3: ${error instanceof Error ? error.message : "Unknown error"}`);
    }
  }

  /**
   * Copy an object within S3
   */
  static async copyObject(sourceKey: string, destinationKey: string): Promise<void> {
    try {
      const command = new CopyObjectCommand({
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
