import prisma from "@/lib/db";
import { S3Service } from "@/lib/services/s3";
import {
  AnnotationBox,
  BatchUploadResponse,
  DatasetStats,
  TrainingJob,
  TrainingOptions,
  TrainingStatus,
  UploadResponse,
} from "@/types/roboflow";

type Split = "train" | "valid" | "test";

interface AssetData {
  id: string;
  fileName: string;
  storageUrl: string;
  storageType: string;
  s3Key: string | null;
  s3Bucket: string | null;
}

function polygonToBoundingBox(coordinates: [number, number][]): AnnotationBox {
  const xs = coordinates.map(([x]) => x);
  const ys = coordinates.map(([, y]) => y);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  const maxX = Math.max(...xs);
  const maxY = Math.max(...ys);

  return {
    x: minX + (maxX - minX) / 2,
    y: minY + (maxY - minY) / 2,
    width: maxX - minX,
    height: maxY - minY,
    class: "Unknown",
  };
}

function normalizeBase64(imageBase64: string): string {
  if (imageBase64.startsWith("data:")) {
    const [, data] = imageBase64.split("base64,");
    return data || imageBase64;
  }
  return imageBase64;
}

export class RoboflowTrainingService {
  private apiKey = process.env.ROBOFLOW_API_KEY;
  private defaultProject =
    process.env.ROBOFLOW_TRAINING_PROJECT || process.env.ROBOFLOW_PROJECT;
  private workspace = process.env.ROBOFLOW_WORKSPACE;
  private baseUrl = "https://api.roboflow.com";

  private ensureConfig(overrideProjectId?: string) {
    if (!this.apiKey) {
      throw new Error("Roboflow API key is not configured");
    }
    const project = overrideProjectId || this.defaultProject;
    if (!project) {
      throw new Error("ROBOFLOW_TRAINING_PROJECT is not configured");
    }
    return project;
  }

  private buildDatasetPath(projectId: string): string {
    // Roboflow returns project IDs like "workspace/project-name"
    // Strip the workspace prefix if present to avoid duplication
    const projectSlug = projectId.includes('/')
      ? projectId.split('/').slice(1).join('/')
      : projectId;

    return this.workspace
      ? `dataset/${this.workspace}/${projectSlug}`
      : `dataset/${projectSlug}`;
  }

  private buildUploadUrl(split: Split, projectId: string): string {
    const url = new URL(
      `${this.baseUrl}/${this.buildDatasetPath(projectId)}/upload?api_key=${this.apiKey}`,
    );
    url.searchParams.set("name", `${Date.now()}`);
    url.searchParams.set("split", split);
    return url.toString();
  }

  private async getImageBuffer(asset: AssetData): Promise<Buffer> {
    if (asset.storageType === "s3" || asset.s3Key) {
      if (!asset.s3Key) {
        throw new Error("Missing S3 key for asset");
      }
      return S3Service.downloadFile(
        asset.s3Key,
        asset.s3Bucket || S3Service.bucketName,
      );
    }

    // Fallback to fetching via URL for local storage
    const response = await fetch(asset.storageUrl);
    if (!response.ok) {
      throw new Error(`Failed to fetch image: ${response.statusText}`);
    }
    const arrayBuffer = await response.arrayBuffer();
    return Buffer.from(arrayBuffer);
  }

  async uploadTrainingData(
    imageBase64: string,
    fileName: string,
    annotations: AnnotationBox[],
    split: Split = "train",
    overrideProjectId?: string,
  ): Promise<UploadResponse> {
    const projectId = this.ensureConfig(overrideProjectId);

    const url = this.buildUploadUrl(split, projectId);
    const payload = {
      image: normalizeBase64(imageBase64),
      name: fileName,
      annotation: {
        boxes: annotations,
      },
    };

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `Roboflow upload failed: ${response.status} ${response.statusText} - ${errorText}`,
      );
    }

    const data = await response.json();
    return {
      id: data.id || data.image?.id || fileName,
      success: true,
    };
  }

  async uploadFromAnnotation(
    annotationId: string,
    split: Split = "train",
    overrideProjectId?: string,
  ): Promise<UploadResponse> {
    const projectId = this.ensureConfig(overrideProjectId);

    const annotation = await prisma.manualAnnotation.findUnique({
      where: { id: annotationId },
      include: {
        session: {
          include: {
            asset: {
              select: {
                id: true,
                fileName: true,
                storageUrl: true,
                storageType: true,
                s3Key: true,
                s3Bucket: true,
              },
            },
          },
        },
      },
    });

    if (!annotation) {
      throw new Error("Annotation not found");
    }

    if (!annotation.verified) {
      throw new Error("Annotation must be verified before pushing to training");
    }

    if (!annotation.coordinates || (annotation.coordinates as unknown[]).length < 3) {
      throw new Error("Annotation coordinates are incomplete");
    }

    const asset = annotation.session.asset;
    const buffer = await this.getImageBuffer(asset);
    const imageBase64 = buffer.toString("base64");

    const box = polygonToBoundingBox(annotation.coordinates as [number, number][]);
    box.class = annotation.weedType || "Unknown";

    const uploadResult = await this.uploadTrainingData(
      imageBase64,
      asset.fileName,
      [box],
      split,
      projectId,
    );

    await prisma.manualAnnotation.update({
      where: { id: annotationId },
      data: {
        pushedToTraining: true,
        pushedAt: new Date(),
        roboflowImageId: uploadResult.id,
      },
    });

    return uploadResult;
  }

  async uploadBatch(
    annotationIds: string[],
    split: Split = "train",
    overrideProjectId?: string,
  ): Promise<BatchUploadResponse> {
    let success = 0;
    const errors: { id: string; error: string }[] = [];

    if (annotationIds.length === 0) {
      return { success: 0, failed: 0, errors: [] };
    }

    // Fetch all annotations + assets in a single query to avoid N+1 uploads
    const annotations = await prisma.manualAnnotation.findMany({
      where: { id: { in: annotationIds } },
      include: {
        session: {
          include: {
            asset: {
              select: {
                id: true,
                fileName: true,
                storageUrl: true,
                storageType: true,
                s3Key: true,
                s3Bucket: true,
              },
            },
          },
        },
      },
    });

    const foundIds = new Set(annotations.map((annotation) => annotation.id));
    for (const id of annotationIds) {
      if (!foundIds.has(id)) {
        errors.push({ id, error: "Annotation not found" });
      }
    }

    const grouped = new Map<
      string,
      {
        asset: AssetData;
        annotations: typeof annotations;
      }
    >();

    for (const annotation of annotations) {
      if (!annotation.verified) {
        errors.push({
          id: annotation.id,
          error: "Annotation must be verified before pushing to training",
        });
        continue;
      }

      const coords = annotation.coordinates as [number, number][];
      if (!coords || coords.length < 3) {
        errors.push({
          id: annotation.id,
          error: "Annotation coordinates are incomplete",
        });
        continue;
      }

      const asset = annotation.session.asset;
      if (!asset) {
        errors.push({
          id: annotation.id,
          error: "Annotation asset not found",
        });
        continue;
      }

      const existing = grouped.get(asset.id);
      if (existing) {
        existing.annotations = [...existing.annotations, annotation];
      } else {
        grouped.set(asset.id, {
          asset,
          annotations: [annotation],
        });
      }
    }

    for (const group of grouped.values()) {
      const annotationIdsForAsset = group.annotations.map((annotation) => annotation.id);
      try {
        const buffer = await this.getImageBuffer(group.asset);
        const imageBase64 = buffer.toString("base64");

        const boxes = group.annotations.map((annotation) => {
          const box = polygonToBoundingBox(annotation.coordinates as [number, number][]);
          box.class = annotation.weedType || "Unknown";
          return box;
        });

        const uploadResult = await this.uploadTrainingData(
          imageBase64,
          group.asset.fileName,
          boxes,
          split,
          overrideProjectId,
        );

        await prisma.manualAnnotation.updateMany({
          where: { id: { in: annotationIdsForAsset } },
          data: {
            pushedToTraining: true,
            pushedAt: new Date(),
            roboflowImageId: uploadResult.id,
          },
        });

        success += group.annotations.length;
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error";
        for (const id of annotationIdsForAsset) {
          errors.push({ id, error: message });
        }
      }
    }

    return {
      success,
      failed: Math.max(annotationIds.length - success, 0),
      errors,
    };
  }

  async getDatasetStats(): Promise<DatasetStats> {
    const totalImages = await prisma.manualAnnotation.count({
      where: { verified: true },
    });

    const grouped = await prisma.manualAnnotation.groupBy({
      by: ["weedType"],
      where: { verified: true },
      _count: { weedType: true },
    });

    const byClass = grouped.reduce<Record<string, number>>((acc, group) => {
      acc[group.weedType] = group._count.weedType || 0;
      return acc;
    }, {});

    return { totalImages, byClass };
  }

  async triggerTraining(
    projectId: string,
    _options?: TrainingOptions,
  ): Promise<TrainingJob> {
    // Placeholder for future implementation
    console.warn("triggerTraining called but not implemented", { projectId });
    return { id: projectId, status: "queued" };
  }

  async getTrainingStatus(jobId: string): Promise<TrainingStatus> {
    // Placeholder for future implementation
    console.warn("getTrainingStatus called but not implemented", { jobId });
    return { id: jobId, status: "unknown" };
  }

  async testConnection(overrideProjectId?: string): Promise<{ ok: boolean; message: string }> {
    const projectId = this.ensureConfig(overrideProjectId);
    const url = `${this.baseUrl}/${this.buildDatasetPath(projectId)}?api_key=${this.apiKey}`;
    const response = await fetch(url);
    if (!response.ok) {
      // Note: Avoid logging response text that could contain sensitive information
      throw new Error(
        `Roboflow test failed: ${response.status} ${response.statusText}`,
      );
    }
    return { ok: true, message: "Roboflow API reachable" };
  }
}

export const roboflowTrainingService = new RoboflowTrainingService();
