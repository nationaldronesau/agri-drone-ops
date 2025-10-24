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
  error?: string;
}

export interface UploadApiResponse {
  message: string;
  files: ProcessedUploadFile[];
}

type CreateMultipartResponse = {
  uploadId: string;
  key: string;
  bucket?: string;
  url?: string;
  partSize?: number;
};

interface UppyUploaderProps {
  projectId: string | null;
  runDetection: boolean;
  detectionModels: string[];
  flightSession?: string;
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
  detectionModels,
  flightSession,
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
    flightSession,
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
      flightSession,
      disabled,
    };
  }, [projectId, runDetection, detectionModels, flightSession, disabled]);

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
        maxTotalFileSize: 5 * 1024 * 1024 * 1024, // 5GB bucketed limit
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
      note: "Images up to 500MB each. GPS metadata recommended for detections.",
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

      if (result.successful.length === 0) {
        return;
      }

      const settings = latestSettingsRef.current;

      if (!settings.projectId) {
        uppy.info("Select a project before processing uploads.", "error", 5000);
        return;
      }

      const filesPayload = result.successful.map((file) => {
        const awsMeta = (file.meta?.awsMultipart || {}) as {
          key?: string;
          bucket?: string;
        };
        const responseBody = file.response?.body as
          | { key?: string; bucket?: string; url?: string }
          | undefined;
        const resolvedKey =
          responseBody?.key ||
          awsMeta.key ||
          (() => {
            try {
              return new URL(file.uploadURL ?? "").pathname.replace(/^\//, "");
            } catch {
              return undefined;
            }
          })();

        return {
          url: file.uploadURL,
          name: file.name,
          size: file.size,
          mimeType:
            file.type ||
            (file.data instanceof File ? file.data.type : undefined) ||
            "application/octet-stream",
          key: resolvedKey,
          bucket: responseBody?.bucket || awsMeta.bucket,
        };
      });

      processingRef.current = true;
      callbacksRef.current.onProcessingStart?.();

      try {
        const response = await fetch("/api/upload", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            files: filesPayload,
            projectId: settings.projectId,
            runDetection: settings.runDetection,
            detectionModels: settings.detectionModels.join(","),
            flightSession: settings.flightSession || undefined,
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

        const payload = (await response.json()) as UploadApiResponse;
        callbacksRef.current.onProcessingComplete?.(payload);
        uppy.resetProgress()
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
      uppy.cancelAll()
      uppy.resetProgress()
      uppy.getFiles().forEach(file => uppy.removeFile(file.id))
      uppyRef.current = null;
    };
  // We intentionally initialize Uppy once and rely on refs for latest props.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return <div ref={containerRef} data-testid="uppy-dashboard" />;
}
