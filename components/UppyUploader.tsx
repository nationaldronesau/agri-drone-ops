"use client";

import { useEffect, useRef } from "react";
import Uppy from "@uppy/core";
import Dashboard from "@uppy/dashboard";
import AwsS3 from "@uppy/aws-s3";

import "@uppy/core/dist/style.css";
import "@uppy/dashboard/dist/style.css";

export interface ProcessedUploadFile {
  id?: string;
  name: string;
  size: number;
  url: string;
  path?: string;
  mimeType?: string;
  metadata?: Record<string, unknown> | null;
  gpsLatitude?: number | null;
  gpsLongitude?: number | null;
  altitude?: number | null;
  detections?: Array<Record<string, unknown>>;
  success?: boolean;
  warning?: string | null;
  warnings?: string[];
  error?: string;
}

export interface QueuedDetectionSummary {
  started: boolean;
  status?: string;
  jobId?: string;
  totalImages?: number;
  skippedImages?: number;
  error?: string;
  source?: string;
}

export interface UploadApiResponse {
  message: string;
  files: ProcessedUploadFile[];
  summary?: {
    successful: number;
    failed: number;
    withWarnings: number;
    warningTypes: string[];
  };
  autoInference?: Record<string, unknown>;
  roboflowDetection?: QueuedDetectionSummary;
}

type CreateMultipartResponse = {
  uploadId: string;
  key: string;
  bucket?: string;
  url?: string;
  partSize?: number;
};

interface DynamicModel {
  id: string;
  projectId: string;
  projectName: string;
  version: number;
  endpoint: string;
  classes: string[];
}

interface UploadFinalizeFile {
  url: string;
  name: string;
  size: number;
  mimeType: string;
  key?: string;
  bucket?: string;
}

const FINALIZATION_CHUNK_SIZE = 50;
const BULK_DETECTION_FILE_COUNT_THRESHOLD = 75;
const BULK_DETECTION_TOTAL_BYTES_THRESHOLD = 1 * 1024 * 1024 * 1024;
const MAX_TOTAL_UPLOAD_SIZE = 250 * 1024 * 1024 * 1024;

function chunkArray<T>(items: T[], chunkSize: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += chunkSize) {
    chunks.push(items.slice(index, index + chunkSize));
  }
  return chunks;
}

function buildUploadSummary(files: ProcessedUploadFile[]) {
  const successful = files.filter((file) => file.success !== false).length;
  const failed = files.filter((file) => file.success === false).length;
  const withWarnings = files.filter(
    (file) =>
      file.success !== false &&
      ((file.warnings && file.warnings.length > 0) || file.warning)
  ).length;
  const warningTypes = [
    ...new Set(
      files.flatMap((file) => {
        const warnings = [...(file.warnings || [])];
        if (file.warning) warnings.push(file.warning);
        return warnings;
      })
    ),
  ];

  return {
    successful,
    failed,
    withWarnings,
    warningTypes,
  };
}

interface UppyUploaderProps {
  projectId: string | null;
  runDetection: boolean;
  detectionModels?: string[]; // Legacy: hardcoded model keys
  dynamicModels?: DynamicModel[]; // New: dynamic models from workspace
  flightSession?: string;
  cameraFov?: number;
  cameraProfileId?: string;
  disabled?: boolean;
  onProcessingStart?: () => void;
  onProcessingComplete?: (response: UploadApiResponse) => void;
  onProcessingError?: (error: Error) => void;
}

/**
 * Uppy dashboard uploader configured for direct-to-S3 uploads with multipart presigning.
 */
export function UppyUploader({
  projectId,
  runDetection,
  detectionModels = [],
  dynamicModels = [],
  flightSession,
  cameraFov,
  cameraProfileId,
  disabled = false,
  onProcessingStart,
  onProcessingComplete,
  onProcessingError,
}: UppyUploaderProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const uppyRef = useRef<Uppy | null>(null);
  const latestSettingsRef = useRef({
    projectId,
    runDetection,
    detectionModels,
    dynamicModels,
    flightSession,
    cameraFov,
    cameraProfileId,
    disabled,
  });
  const processingRef = useRef<boolean>(false);
  const callbacksRef = useRef({
    onProcessingStart,
    onProcessingComplete,
    onProcessingError,
  });

  useEffect(() => {
    latestSettingsRef.current = {
      projectId,
      runDetection,
      detectionModels,
      dynamicModels,
      flightSession,
      cameraFov,
      cameraProfileId,
      disabled,
    };
  }, [projectId, runDetection, detectionModels, dynamicModels, flightSession, cameraFov, cameraProfileId, disabled]);

  useEffect(() => {
    callbacksRef.current = {
      onProcessingStart,
      onProcessingComplete,
      onProcessingError,
    };
  }, [onProcessingStart, onProcessingComplete, onProcessingError]);

  useEffect(() => {
    if (!containerRef.current || uppyRef.current) {
      return;
    }

    const uppy = new Uppy({
      autoProceed: false,
      allowMultipleUploadBatches: true,
      restrictions: {
        allowedFileTypes: ["image/*"],
        maxTotalFileSize: MAX_TOTAL_UPLOAD_SIZE,
      },
      locale: {
        strings: {
          dropPasteFiles: "Drop images here or %{browse}",
          browse: "browse",
        },
      },
    });

    uppy.use(Dashboard, {
      target: containerRef.current,
      inline: true,
      showProgressDetails: true,
      proudlyDisplayPoweredByUppy: false,
      hideProgressAfterFinish: true,
      note: "Large upload batches are supported. Background detection is used automatically for big runs.",
    });

    uppy.use(AwsS3, {
      limit: 4,
      shouldUseMultipart: () => true,
      retryDelays: [0, 1000, 3000, 5000],
      createMultipartUpload: async (file) => {
        const settings = latestSettingsRef.current;
        if (settings.disabled || !settings.projectId) {
          const message = "Select a project before uploading files.";
          uppy.info(message, "error", 5000);
          throw new Error(message);
        }

        const response = await fetch("/api/s3/multipart/create", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            filename: file.name,
            contentType: file.type || "application/octet-stream",
            projectId: settings.projectId,
            flightSession: settings.flightSession || undefined,
          }),
        });

        if (!response.ok) {
          const errorBody = await response.json().catch(() => ({}));
          const message =
            errorBody?.error || "Failed to start multipart upload.";
          uppy.info(message, "error", 5000);
          throw new Error(message);
        }

        return (await response.json()) as CreateMultipartResponse;
      },
      listParts: async (_file, { uploadId, key, signal }) => {
        const response = await fetch("/api/s3/multipart/list-parts", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal,
          body: JSON.stringify({ uploadId, key }),
        });

        if (!response.ok) {
          // If the upload was already completed or aborted, S3 returns NoSuchUpload.
          // Return empty array to let Uppy proceed (it will start fresh if needed).
          const errorBody = await response.json().catch(() => ({}));
          if (errorBody?.details?.includes?.("NoSuchUpload") ||
              errorBody?.error?.includes?.("NoSuchUpload")) {
            console.debug("[Uppy] listParts: upload already completed/aborted, returning empty");
            return [];
          }
          const message =
            errorBody?.error || "Failed to list multipart upload parts.";
          throw new Error(message);
        }

        const data = await response.json();
        return data.parts || [];
      },
      signPart: async (_file, { uploadId, key, partNumber, body, signal }) => {
        const response = await fetch("/api/s3/multipart/sign", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal,
          body: JSON.stringify({
            uploadId,
            key,
            partNumber,
            contentLength: body?.size,
          }),
        });

        if (!response.ok) {
          const errorBody = await response.json().catch(() => ({}));
          const message =
            errorBody?.error || "Failed to sign multipart upload part.";
          throw new Error(message);
        }

        return response.json();
      },
      abortMultipartUpload: async (_file, { uploadId, key, signal }) => {
        const response = await fetch("/api/s3/multipart/abort", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal,
          body: JSON.stringify({ uploadId, key }),
        });

        if (!response.ok) {
          const errorBody = await response.json().catch(() => ({}));
          const message =
            errorBody?.error || "Failed to abort multipart upload.";
          throw new Error(message);
        }
      },
      completeMultipartUpload: async (_file, { uploadId, key, parts, signal }) => {
        const response = await fetch("/api/s3/multipart/complete", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal,
          body: JSON.stringify({
            uploadId,
            key,
            parts,
          }),
        });

        if (!response.ok) {
          const errorBody = await response.json().catch(() => ({}));
          const message =
            errorBody?.error || "Failed to complete multipart upload.";
          throw new Error(message);
        }

        return response.json();
      },
    });

    uppy.on("upload-progress", (file, progress) => {
      if (!file) {
        return;
      }
      console.debug(
        `[Uppy] upload-progress ${file.name}: ${progress.bytesUploaded}/${progress.bytesTotal}`,
      );
    });

    uppy.on("upload-error", (_file, error, response) => {
      console.error("Upload error:", error, response);
      const message =
        (error as Error)?.message || "Failed to upload file to S3.";
      uppy.info(message, "error", 5000);
    });

    uppy.on("complete", async (result) => {
      if (processingRef.current) {
        return;
      }

      const successfulFiles = result.successful ?? [];
      if (successfulFiles.length === 0) {
        return;
      }

      const settings = latestSettingsRef.current;

      if (!settings.projectId) {
        uppy.info("Select a project before processing uploads.", "error", 5000);
        return;
      }

      const filesPayload = successfulFiles
        .map((file) => {
          const awsMeta = (file.meta?.awsMultipart || {}) as {
            key?: string;
            bucket?: string;
          };
          const responseBody = file.response?.body as
            | { key?: string; bucket?: string; url?: string; location?: string }
            | undefined;
          const uploadUrl = file.uploadURL || responseBody?.location || responseBody?.url;
          if (!uploadUrl) {
            console.warn(`[Uppy] Skipping file ${file.name} - no upload URL`);
            return null;
          }
          const resolvedKey =
            responseBody?.key ||
            awsMeta.key ||
            (() => {
              try {
                return new URL(uploadUrl).pathname.replace(/^\//, "");
              } catch {
                return undefined;
              }
            })();

          return {
            url: uploadUrl,
            name: file.name,
            size: typeof file.size === "number" ? file.size : 0,
            mimeType:
              file.type ||
              (file.data instanceof File ? file.data.type : undefined) ||
              "application/octet-stream",
            key: resolvedKey,
            bucket: responseBody?.bucket || awsMeta.bucket,
          };
        })
        .filter((file): file is NonNullable<typeof file> => Boolean(file)) as UploadFinalizeFile[];

      if (filesPayload.length === 0) {
        uppy.info("No files with valid upload URLs to process.", "error", 5000);
        return;
      }

      processingRef.current = true;
      callbacksRef.current.onProcessingStart?.();

      try {
        const totalBytes = filesPayload.reduce(
          (sum, file) => sum + (file.size || 0),
          0
        );
        const useQueuedRoboflowDetection =
          settings.runDetection &&
          (filesPayload.length >= BULK_DETECTION_FILE_COUNT_THRESHOLD ||
            totalBytes >= BULK_DETECTION_TOTAL_BYTES_THRESHOLD);

        const chunkedFiles = chunkArray(filesPayload, FINALIZATION_CHUNK_SIZE);
        const chunkResponses: UploadApiResponse[] = [];

        for (const [index, chunk] of chunkedFiles.entries()) {
          uppy.info(
            `Processing upload batch ${index + 1} of ${chunkedFiles.length}...`,
            "info",
            2000
          );

          const response = await fetch("/api/upload", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              files: chunk,
              projectId: settings.projectId,
              runDetection: useQueuedRoboflowDetection ? false : settings.runDetection,
              detectionModels: settings.detectionModels?.join(",") || "",
              dynamicModels: settings.dynamicModels || [],
              flightSession: settings.flightSession || undefined,
              cameraFov: settings.cameraFov,
              cameraProfileId: settings.cameraProfileId,
              disableAutoInference: useQueuedRoboflowDetection,
            }),
          });

          if (!response.ok) {
            const errorBody = await response.json().catch(() => ({}));
            const message =
              errorBody?.error ||
              errorBody?.details ||
              "Failed to process uploaded files.";
            throw new Error(message);
          }

          chunkResponses.push((await response.json()) as UploadApiResponse);
        }

        const aggregatedFiles = chunkResponses.flatMap(
          (chunkResponse) => chunkResponse.files || []
        );
        const payload: UploadApiResponse = {
          message: `Processed ${aggregatedFiles.filter((file) => file.success !== false).length} of ${aggregatedFiles.length} files`,
          files: aggregatedFiles,
          summary: buildUploadSummary(aggregatedFiles),
          autoInference:
            chunkResponses.find((chunkResponse) => chunkResponse.autoInference)
              ?.autoInference || undefined,
        };

        if (useQueuedRoboflowDetection) {
          const successfulAssetIds = [
            ...new Set(
              aggregatedFiles
                .filter(
                  (file): file is ProcessedUploadFile & { id: string } =>
                    file.success !== false && Boolean(file.id)
                )
                .map((file) => file.id)
            ),
          ];

          if (successfulAssetIds.length > 0) {
            const detectionResponse = await fetch("/api/roboflow/detection/run", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                projectId: settings.projectId,
                assetIds: successfulAssetIds,
                detectionModels: settings.detectionModels || [],
                dynamicModels: settings.dynamicModels || [],
              }),
            });

            if (!detectionResponse.ok) {
              const errorBody = await detectionResponse.json().catch(() => ({}));
              payload.roboflowDetection = {
                started: false,
                error:
                  errorBody?.error ||
                  "Uploads completed, but background Roboflow detection could not be started.",
                totalImages: successfulAssetIds.length,
                source: "roboflow_batch_detection",
              };
            } else {
              const detectionPayload = (await detectionResponse.json()) as {
                jobId: string;
                totalImages: number;
                skippedImages: number;
                status: string;
                source: string;
              };

              payload.roboflowDetection = {
                started: true,
                status: detectionPayload.status,
                jobId: detectionPayload.jobId,
                totalImages: detectionPayload.totalImages,
                skippedImages: detectionPayload.skippedImages,
                source: detectionPayload.source,
              };
            }
          }
        }

        callbacksRef.current.onProcessingComplete?.(payload);
        uppy.clear();
      } catch (error) {
        console.error("Post-upload processing failed:", error);
        if (error instanceof Error) {
          uppy.info(error.message, "error", 6000);
          callbacksRef.current.onProcessingError?.(error);
        } else {
          const fallback = new Error("Unknown processing error.");
          uppy.info(fallback.message, "error", 6000);
          callbacksRef.current.onProcessingError?.(fallback);
        }
      } finally {
        processingRef.current = false;
      }
    });

    uppyRef.current = uppy;

    return () => {
      const cleanupTarget = uppyRef.current ?? uppy;
      const destroy = (cleanupTarget as unknown as { destroy?: () => void }).destroy;
      const close = (cleanupTarget as unknown as { close?: () => void }).close;

      if (typeof destroy === "function") {
        destroy.call(cleanupTarget);
      } else if (typeof close === "function") {
        close.call(cleanupTarget);
      }
      uppyRef.current = null;
    };
  }, []);

  return <div ref={containerRef} data-testid="uppy-dashboard" />;
}
