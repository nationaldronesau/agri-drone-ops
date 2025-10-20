"use client";

import { useEffect, useRef } from "react";
import Uppy from "@uppy/core";
import Dashboard from "@uppy/dashboard";
import AwsS3 from "@uppy/aws-s3";

import "@uppy/core/dist/style.css";
import "@uppy/dashboard/dist/style.css";

interface OrthomosaicUploaderProps {
  projectId: string | null;
  name: string;
  description?: string;
  disabled?: boolean;
  onProcessingStart?: () => void;
  onProcessingComplete?: (orthomosaic: Record<string, unknown>) => void;
  onProcessingError?: (error: Error) => void;
}

export function OrthomosaicUploader({
  projectId,
  name,
  description,
  disabled = false,
  onProcessingStart,
  onProcessingComplete,
  onProcessingError,
}: OrthomosaicUploaderProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const uppyRef = useRef<Uppy | null>(null);
  const settingsRef = useRef({
    projectId,
    name,
    description,
    disabled,
  });
  const processingRef = useRef(false);
  const callbacksRef = useRef({
    onProcessingStart,
    onProcessingComplete,
    onProcessingError,
  });

  useEffect(() => {
    settingsRef.current = {
      projectId,
      name,
      description,
      disabled,
    };
  }, [projectId, name, description, disabled]);

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
      restrictions: {
        maxNumberOfFiles: 1,
        allowedFileTypes: [".tif", ".tiff", ".geotiff", "image/tiff"],
        maxFileSize: 8 * 1024 * 1024 * 1024, // 8GB
      },
      locale: {
        strings: {
          dropPasteFiles: "Drop a GeoTIFF here or %{browse}",
          browse: "browse",
        },
      },
    });

    uppy.use(Dashboard, {
      target: containerRef.current,
      inline: true,
      showProgressDetails: true,
      proudlyDisplayPoweredByUppy: false,
      note: "Single GeoTIFF up to 8GB. Metadata is extracted server-side.",
    });

    uppy.use(AwsS3, {
      limit: 3,
      retryDelays: [0, 1000, 3000, 5000],
      createMultipartUpload: async (file) => {
        const settings = settingsRef.current;
        if (settings.disabled || !settings.projectId) {
          const message = "Select a project before uploading.";
          uppy.info(message, "error", 5000);
          throw new Error(message);
        }

        const response = await fetch("/api/s3/multipart/create", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            filename: file.name,
            contentType: file.type || "image/tiff",
            projectId: settings.projectId,
            flightSession: "orthomosaics",
          }),
        });

        if (!response.ok) {
          const errorBody = await response.json().catch(() => ({}));
          const message =
            errorBody?.error || "Failed to initiate multipart upload.";
          uppy.info(message, "error", 5000);
          throw new Error(message);
        }

        return response.json();
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
          body: JSON.stringify({ uploadId, key, parts }),
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

    uppy.on("upload-error", (_file, error, response) => {
      console.error("Orthomosaic S3 upload error:", error, response);
      const message =
        (error as Error)?.message || "Failed to upload orthomosaic to S3.";
      uppy.info(message, "error", 5000);
    });

    uppy.on("complete", async (result) => {
      if (processingRef.current) return;
      if (result.successful.length === 0) return;

      const settings = settingsRef.current;
      if (!settings.projectId) {
        uppy.info("Select a project before processing.", "error", 5000);
        return;
      }

      const uploadedFile = result.successful[0];
      const awsMeta = (uploadedFile.meta?.awsMultipart || {}) as {
        key?: string;
        bucket?: string;
      };

      const mosaicName =
        settings.name?.trim() ||
        uploadedFile.name.replace(/\.[^/.]+$/, "") ||
        "Untitled Orthomosaic";

      processingRef.current = true;
      callbacksRef.current.onProcessingStart?.();

      try {
        const response = await fetch("/api/orthomosaics/upload", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            file: {
              url: uploadedFile.uploadURL,
              name: uploadedFile.name,
              size: uploadedFile.size,
              mimeType:
                uploadedFile.type ||
                (uploadedFile.data instanceof File
                  ? uploadedFile.data.type
                  : "image/tiff"),
              key: awsMeta.key,
              bucket: awsMeta.bucket,
            },
            projectId: settings.projectId,
            name: mosaicName,
            description: settings.description?.trim() || null,
          }),
        });

        if (!response.ok) {
          const errorBody = await response.json().catch(() => ({}));
          const message =
            errorBody?.error ||
            errorBody?.details ||
            "Failed to register orthomosaic.";
          throw new Error(message);
        }

        const orthomosaic = await response.json();
        callbacksRef.current.onProcessingComplete?.(orthomosaic);
        uppy.reset();
      } catch (error) {
        console.error("Orthomosaic post-processing failed:", error);
        if (error instanceof Error) {
          uppy.info(error.message, "error", 6000);
          callbacksRef.current.onProcessingError?.(error);
        } else {
          const fallback = new Error("Unknown orthomosaic processing error.");
          uppy.info(fallback.message, "error", 6000);
          callbacksRef.current.onProcessingError?.(fallback);
        }
      } finally {
        processingRef.current = false;
      }
    });

    uppyRef.current = uppy;
    return () => {
      uppy.close();
      uppyRef.current = null;
    };
  // We initialize Uppy once and manage updates via refs.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return <div ref={containerRef} />;
}
