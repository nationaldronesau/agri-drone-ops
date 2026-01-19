/**
 * Dataset Preparation Service
 *
 * Converts AI/manual annotations from the database to YOLO format
 * and uploads to S3 for training.
 */
import path from 'path';
import { randomUUID } from 'crypto';
import prisma from '@/lib/db';
import { S3Service } from '@/lib/services/s3';
import { fetchImageSafely } from '@/lib/utils/security';
import { rescaleToOriginalWithMeta } from '@/lib/utils/georeferencing';
import type { CenterBox, YOLOPreprocessingMeta } from '@/lib/types/detection';

interface BoundingBox {
  x: number;      // Center X (0-1)
  y: number;      // Center Y (0-1)
  width: number;  // Width (0-1)
  height: number; // Height (0-1)
}

interface YOLOAnnotation {
  classId: number;
  bbox: BoundingBox;
}

export interface DatasetConfig {
  projectId?: string;
  sessionIds?: string[];
  assetIds?: string[];
  classes?: string[];
  classMapping?: Record<string, string>;
  splitRatio?: {
    train: number;
    val: number;
    test: number;
  };
  includeAIDetections?: boolean;
  includeManualAnnotations?: boolean;
  minConfidence?: number;
  createdAfter?: Date;
  createdById?: string;
}

interface PreparedDataset {
  datasetId: string;
  s3Path: string;
  imageCount: number;
  labelCount: number;
  trainCount: number;
  valCount: number;
  testCount: number;
  classes: string[];
}

export interface DatasetPreview {
  imageCount: number;
  labelCount: number;
  trainCount: number;
  valCount: number;
  testCount: number;
  classes: string[];
  classCounts: Record<string, number>;
  availableClasses: Array<{ name: string; count: number }>;
}

type AnnotationPoint = [number, number];

export function sanitizeClassName(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/\s+/g, '_')
    .replace(/[^a-z0-9_]/g, '');
}

class DatasetPreparationService {
  private bucket = S3Service.bucketName;

  async prepareDataset(
    teamId: string,
    name: string,
    config: DatasetConfig
  ): Promise<PreparedDataset> {
    if (!config.classes || config.classes.length === 0) {
      throw new Error('Classes are required to build a dataset');
    }

    const datasetId = randomUUID();
    const s3BasePath = `datasets/${datasetId}`;

    const assets = await this.fetchAnnotatedAssets(config);
    if (assets.length === 0) {
      throw new Error('No annotated images found matching criteria');
    }

    const normalizedClasses = config.classes
      .map((cls) => sanitizeClassName(cls))
      .filter(Boolean);

    const dedupedClasses = Array.from(new Set(normalizedClasses));
    if (dedupedClasses.length !== normalizedClasses.length) {
      throw new Error('Duplicate class names detected after sanitization');
    }

    const classMap = new Map<string, number>();
    dedupedClasses.forEach((cls, idx) => {
      classMap.set(cls, idx);
    });

    const splitRatio = this.normalizeSplitRatio(config.splitRatio);
    const shuffled = this.shuffleArray([...assets]);
    const splits = this.splitDataset(shuffled, splitRatio);

    let totalLabels = 0;
    let processedImages = 0;
    const splitCounts = { train: 0, val: 0, test: 0 };

    for (const [splitName, splitAssets] of Object.entries(splits)) {
      if (splitAssets.length === 0) continue;

      for (const asset of splitAssets) {
        const yoloAnnotations = this.convertToYOLO(
          asset,
          classMap,
          config.includeAIDetections ?? true,
          config.includeManualAnnotations ?? true,
          config.minConfidence ?? 0.5
        );

        if (yoloAnnotations.length === 0) {
          continue;
        }

        const labelContent = yoloAnnotations
          .map(
            (ann) =>
              `${ann.classId} ${ann.bbox.x.toFixed(6)} ${ann.bbox.y.toFixed(6)} ${ann.bbox.width.toFixed(6)} ${ann.bbox.height.toFixed(6)}`
          )
          .join('\n');

        const labelKey = `${s3BasePath}/${splitName}/labels/${asset.id}.txt`;
        await S3Service.uploadBuffer(Buffer.from(labelContent), labelKey, 'text/plain');

        await this.copyImageToDataset(asset, s3BasePath, splitName);

        totalLabels += yoloAnnotations.length;
        processedImages += 1;
        splitCounts[splitName as keyof typeof splitCounts] += 1;
      }
    }

    const dataYaml = this.generateDataYaml(s3BasePath, dedupedClasses, splitCounts);
    await S3Service.uploadBuffer(
      Buffer.from(dataYaml),
      `${s3BasePath}/data.yaml`,
      'text/yaml'
    );

    const s3FullPath = `s3://${this.bucket}/${s3BasePath}/`;
    await prisma.trainingDataset.create({
      data: {
        id: datasetId,
        name,
        projectId: config.projectId,
        s3Path: s3FullPath,
        s3Bucket: this.bucket,
        imageCount: processedImages,
        labelCount: totalLabels,
        classes: JSON.stringify(dedupedClasses),
        trainCount: splitCounts.train,
        valCount: splitCounts.val,
        testCount: splitCounts.test,
        teamId,
        createdById: config.createdById,
      },
    });

    return {
      datasetId,
      s3Path: s3FullPath,
      imageCount: processedImages,
      labelCount: totalLabels,
      trainCount: splitCounts.train,
      valCount: splitCounts.val,
      testCount: splitCounts.test,
      classes: dedupedClasses,
    };
  }

  async previewDataset(config: DatasetConfig): Promise<DatasetPreview> {
    const assets = await this.fetchAnnotatedAssets(config);
    if (assets.length === 0) {
      return {
        imageCount: 0,
        labelCount: 0,
        trainCount: 0,
        valCount: 0,
        testCount: 0,
        classes: [],
        classCounts: {},
        availableClasses: [],
      };
    }

    const includeAI = config.includeAIDetections ?? true;
    const includeManual = config.includeManualAnnotations ?? true;
    const minConfidence = config.minConfidence ?? 0.5;

    const availableCounts = new Map<string, number>();
    const incrementAvailable = (className: string) => {
      const sanitized = sanitizeClassName(className);
      if (!sanitized) return;
      const next = (availableCounts.get(sanitized) || 0) + 1;
      availableCounts.set(sanitized, next);
    };

    for (const asset of assets) {
      if (includeAI && asset.detections) {
        for (const detection of asset.detections) {
          const confidence = typeof detection.confidence === 'number' ? detection.confidence : 0;
          if (confidence < minConfidence) continue;
          incrementAvailable(detection.className);
        }
      }

      if (includeManual && asset.annotationSessions) {
        for (const session of asset.annotationSessions) {
          for (const annotation of session.annotations) {
            incrementAvailable(annotation.roboflowClassName || annotation.weedType);
          }
        }
      }
    }

    const availableClasses = Array.from(availableCounts.entries())
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));

    const selectedClasses = (config.classes && config.classes.length > 0)
      ? config.classes.map((cls) => sanitizeClassName(cls)).filter(Boolean)
      : availableClasses.map((entry) => entry.name);

    const dedupedClasses = Array.from(new Set(selectedClasses));
    const classMap = new Map<string, number>();
    dedupedClasses.forEach((cls, idx) => {
      classMap.set(cls, idx);
    });

    let labelCount = 0;
    let imageCount = 0;
    const classCounts: Record<string, number> = {};

    for (const asset of assets) {
      const yoloAnnotations = this.convertToYOLO(
        asset,
        classMap,
        includeAI,
        includeManual,
        minConfidence
      );

      if (yoloAnnotations.length === 0) continue;

      imageCount += 1;
      labelCount += yoloAnnotations.length;

      for (const annotation of yoloAnnotations) {
        const className = dedupedClasses[annotation.classId] || 'Unknown';
        classCounts[className] = (classCounts[className] || 0) + 1;
      }
    }

    const splitRatio = this.normalizeSplitRatio(config.splitRatio);
    const trainCount = Math.floor(imageCount * splitRatio.train);
    const valCount = Math.floor(imageCount * splitRatio.val);
    const testCount = Math.max(0, imageCount - trainCount - valCount);

    return {
      imageCount,
      labelCount,
      trainCount,
      valCount,
      testCount,
      classes: dedupedClasses,
      classCounts,
      availableClasses,
    };
  }

  private async fetchAnnotatedAssets(config: DatasetConfig) {
    const where: Record<string, unknown> = {};
    if (config.projectId) {
      where.projectId = config.projectId;
    }
    if (config.assetIds && config.assetIds.length > 0) {
      where.id = { in: config.assetIds };
    }

    const assets = await prisma.asset.findMany({
      where,
      include: {
        detections: config.includeAIDetections
          ? {
              where: {
                type: { in: ['AI', 'YOLO_LOCAL'] },
                rejected: false,
                OR: [{ verified: true }, { userCorrected: true }],
                ...(config.createdAfter ? { createdAt: { gte: config.createdAfter } } : {}),
              },
            }
          : false,
        annotationSessions: config.includeManualAnnotations
          ? {
              where: config.sessionIds ? { id: { in: config.sessionIds } } : undefined,
              include: {
                annotations: {
                  where: {
                    verified: true,
                    ...(config.createdAfter ? { createdAt: { gte: config.createdAfter } } : {}),
                  },
                },
              },
            }
          : false,
      },
    });

    return assets.filter((asset) => {
      const hasAIDetections =
        config.includeAIDetections && asset.detections && asset.detections.length > 0;
      const hasManualAnnotations =
        config.includeManualAnnotations &&
        asset.annotationSessions &&
        asset.annotationSessions.some((session) => session.annotations.length > 0);

      return hasAIDetections || hasManualAnnotations;
    });
  }

  private convertToYOLO(
    asset: any,
    classMap: Map<string, number>,
    includeAI: boolean,
    includeManual: boolean,
    minConfidence: number
  ): YOLOAnnotation[] {
    const annotations: YOLOAnnotation[] = [];

    const imageWidth = asset.imageWidth || 4000;
    const imageHeight = asset.imageHeight || 3000;

    if (includeAI && asset.detections) {
      for (const detection of asset.detections) {
        const confidence = typeof detection.confidence === 'number' ? detection.confidence : 0;
        if (confidence < minConfidence) continue;

        const className = sanitizeClassName(detection.className);
        const classId = classMap.get(className);
        if (classId === undefined) continue;

        const bbox = this.parseDetectionBBox(detection, imageWidth, imageHeight);
        if (!bbox) continue;

        annotations.push({ classId, bbox });
      }
    }

    if (includeManual && asset.annotationSessions) {
      for (const session of asset.annotationSessions) {
        for (const annotation of session.annotations) {
          const className = sanitizeClassName(
            annotation.roboflowClassName || annotation.weedType
          );
          const classId = classMap.get(className);
          if (classId === undefined) continue;

          const points = this.parsePolygonPoints(annotation.coordinates);
          if (!points || points.length < 3) continue;

          const bbox = this.polygonToBBox(points, imageWidth, imageHeight);
          annotations.push({ classId, bbox });
        }
      }
    }

    return annotations;
  }

  private parseDetectionBBox(
    detection: {
      boundingBox: unknown;
      type?: string | null;
      preprocessingMeta?: unknown;
    },
    imgWidth: number,
    imgHeight: number
  ): BoundingBox | null {
    if (!detection?.boundingBox) return null;

    const parsed =
      typeof detection.boundingBox === 'string'
        ? this.safeJsonParse(detection.boundingBox)
        : detection.boundingBox;

    if (Array.isArray(parsed) && parsed.length >= 4) {
      const [x1, y1, x2, y2] = parsed;
      return this.pixelToYOLO(x1, y1, x2, y2, imgWidth, imgHeight);
    }

    if (
      typeof parsed === 'object' &&
      parsed &&
      'x' in parsed &&
      'y' in parsed &&
      'width' in parsed &&
      'height' in parsed
    ) {
      let box = parsed as CenterBox;

      if (detection.type === 'YOLO_LOCAL' && detection.preprocessingMeta) {
        const meta =
          typeof detection.preprocessingMeta === 'string'
            ? this.safeJsonParse(detection.preprocessingMeta)
            : detection.preprocessingMeta;
        if (meta) {
          box = rescaleToOriginalWithMeta(box, meta as YOLOPreprocessingMeta);
        }
      }

      return this.centerBoxToYOLO(box, imgWidth, imgHeight);
    }

    return null;
  }

  private centerBoxToYOLO(
    bbox: { x: number; y: number; width: number; height: number },
    imgWidth: number,
    imgHeight: number
  ): BoundingBox {
    const width = bbox.width / imgWidth;
    const height = bbox.height / imgHeight;
    const x = bbox.x / imgWidth;
    const y = bbox.y / imgHeight;

    return this.clampBBox({ x, y, width, height });
  }

  private parsePolygonPoints(value: unknown): AnnotationPoint[] | null {
    const parsed = typeof value === 'string' ? this.safeJsonParse(value) : value;
    if (!Array.isArray(parsed)) return null;
    const points = parsed.filter((p) => Array.isArray(p) && p.length >= 2);
    return points as AnnotationPoint[];
  }

  private pixelToYOLO(
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    imgWidth: number,
    imgHeight: number
  ): BoundingBox {
    const width = (x2 - x1) / imgWidth;
    const height = (y2 - y1) / imgHeight;
    const x = (x1 + x2) / 2 / imgWidth;
    const y = (y1 + y2) / 2 / imgHeight;

    return this.clampBBox({ x, y, width, height });
  }

  private polygonToBBox(
    points: AnnotationPoint[],
    imgWidth: number,
    imgHeight: number
  ): BoundingBox {
    const xs = points.map((p) => p[0]);
    const ys = points.map((p) => p[1]);

    const x1 = Math.min(...xs);
    const x2 = Math.max(...xs);
    const y1 = Math.min(...ys);
    const y2 = Math.max(...ys);

    return this.pixelToYOLO(x1, y1, x2, y2, imgWidth, imgHeight);
  }

  private clampBBox(bbox: BoundingBox): BoundingBox {
    return {
      x: Math.max(0, Math.min(1, bbox.x)),
      y: Math.max(0, Math.min(1, bbox.y)),
      width: Math.max(0, Math.min(1, bbox.width)),
      height: Math.max(0, Math.min(1, bbox.height)),
    };
  }

  private generateDataYaml(
    s3BasePath: string,
    classes: string[],
    counts: { train: number; val: number; test: number }
  ): string {
    const s3Uri = `s3://${this.bucket}/${s3BasePath}`;

    return `# AgriDrone Ops Dataset
# Generated: ${new Date().toISOString()}

path: ${s3Uri}
train: train/images
val: val/images
test: ${counts.test > 0 ? 'test/images' : ''}

nc: ${classes.length}
names: ${JSON.stringify(classes)}

# Train images: ${counts.train}
# Val images: ${counts.val}
# Test images: ${counts.test}
`;
  }

  private splitDataset(
    assets: any[],
    ratio: { train: number; val: number; test: number }
  ): { train: any[]; val: any[]; test: any[] } {
    const total = assets.length;
    const trainEnd = Math.floor(total * ratio.train);
    const valEnd = trainEnd + Math.floor(total * ratio.val);

    return {
      train: assets.slice(0, trainEnd),
      val: assets.slice(trainEnd, valEnd),
      test: assets.slice(valEnd),
    };
  }

  private normalizeSplitRatio(
    ratio: DatasetConfig['splitRatio']
  ): { train: number; val: number; test: number } {
    const base = ratio ?? { train: 0.7, val: 0.2, test: 0.1 };
    const total = base.train + base.val + base.test;
    if (total <= 0) {
      return { train: 0.7, val: 0.2, test: 0.1 };
    }
    return {
      train: base.train / total,
      val: base.val / total,
      test: base.test / total,
    };
  }

  private shuffleArray<T>(array: T[]): T[] {
    for (let i = array.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [array[i], array[j]] = [array[j], array[i]];
    }
    return array;
  }

  private safeJsonParse(value: string): unknown | null {
    try {
      return JSON.parse(value);
    } catch {
      return null;
    }
  }

  private async copyImageToDataset(
    asset: any,
    s3BasePath: string,
    splitName: string
  ): Promise<string> {
    const extension = this.getImageExtension(asset);
    const imageKey = `${s3BasePath}/${splitName}/images/${asset.id}${extension}`;

    if (asset.s3Key) {
      const sourceBucket = asset.s3Bucket || this.bucket;
      if (sourceBucket === this.bucket) {
        await S3Service.copyObject(asset.s3Key, imageKey);
      } else {
        const buffer = await S3Service.downloadFile(asset.s3Key, sourceBucket);
        await S3Service.uploadBuffer(buffer, imageKey, asset.mimeType || 'image/jpeg');
      }
      return imageKey;
    }

    if (asset.storageUrl) {
      const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
      const storageUrl = asset.storageUrl.startsWith('/')
        ? `${baseUrl}${asset.storageUrl}`
        : asset.storageUrl;
      const buffer = await fetchImageSafely(storageUrl, `Asset ${asset.id}`);
      await S3Service.uploadBuffer(buffer, imageKey, asset.mimeType || 'image/jpeg');
      return imageKey;
    }

    throw new Error(`Asset ${asset.id} has no accessible storage location`);
  }

  private getImageExtension(asset: any): string {
    const ext = path.extname(asset.fileName || '').toLowerCase();
    if (ext) return ext;
    if (asset.mimeType === 'image/png') return '.png';
    if (asset.mimeType === 'image/webp') return '.webp';
    if (asset.mimeType === 'image/tiff') return '.tif';
    return '.jpg';
  }
}

export const datasetPreparation = new DatasetPreparationService();
