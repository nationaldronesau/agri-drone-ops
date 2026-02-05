import prisma from '@/lib/db';
import { datasetPreparation, sanitizeClassName } from '@/lib/services/dataset-preparation';
import { S3Service } from '@/lib/services/s3';
import { createHash, randomUUID } from 'crypto';
import type { TrainingDataset } from '@prisma/client';

export interface PreprocessingConfig {
  resize?: string;
  tile?: string;
  autoOrient?: boolean;
  [key: string]: unknown;
}

export interface AugmentationConfig {
  preset?: string;
  [key: string]: unknown;
}

export interface SnapshotFilters {
  weedTypes?: string[];
  minConfidence?: number;
  verifiedOnly?: boolean;
  includeAIDetections?: boolean;
  includeSAM3?: boolean;
  includeManual?: boolean;
}

export interface CreateVersionConfig {
  projectId: string;
  teamId: string;
  createdById?: string | null;
  name?: string;
  displayName?: string;
  idempotencyKey?: string;
  classes?: string[];
  preprocessing?: PreprocessingConfig;
  augmentation?: AugmentationConfig;
  splits?: { train: number; val: number; test: number };
  filters?: SnapshotFilters;
}

interface AnnotationManifestEntry {
  id: string;
  type: 'manual' | 'detection' | 'sam3';
  assetId: string;
  className: string;
  confidence?: number | string | null;
  coordinates?: unknown;
  bbox?: unknown;
  geoCoordinates?: unknown;
  preprocessingMeta?: unknown;
  sourceType?: string | null;
}

interface AnnotationManifest {
  snapshotAt: string;
  projectId: string;
  filters: SnapshotFilters | undefined;
  annotationCount: number;
  annotations: AnnotationManifestEntry[];
}

function normalizeSplitRatio(splits?: { train: number; val: number; test: number }) {
  const defaults = { train: 0.8, val: 0.15, test: 0.05 };
  if (!splits) return defaults;
  const total = (splits.train ?? 0) + (splits.val ?? 0) + (splits.test ?? 0);
  if (total <= 0) return defaults;
  return {
    train: (splits.train ?? 0) / total,
    val: (splits.val ?? 0) / total,
    test: (splits.test ?? 0) / total,
  };
}

function resolveFilters(filters?: SnapshotFilters) {
  return {
    includeAIDetections: filters?.includeAIDetections ?? true,
    includeManualAnnotations: filters?.includeManual ?? true,
    includeSAM3: filters?.includeSAM3 ?? false,
    minConfidence: filters?.minConfidence ?? 0.5,
    verifiedOnly: filters?.verifiedOnly ?? false,
  };
}

class TrainingDatasetVersionService {
  async createVersion(config: CreateVersionConfig): Promise<{ dataset: TrainingDataset; preview: Awaited<ReturnType<typeof datasetPreparation.previewDataset>> }> {
    const filterConfig = resolveFilters(config.filters);
    const selectedClasses = config.classes?.length
      ? config.classes
      : config.filters?.weedTypes?.length
        ? config.filters.weedTypes
        : undefined;

    if (config.idempotencyKey) {
      const existing = await prisma.trainingDataset.findUnique({
        where: { idempotencyKey: config.idempotencyKey },
      });
      if (existing) {
        const storedFilters = (existing.creationFilters || config.filters || null) as SnapshotFilters | null;
        const storedFilterConfig = resolveFilters(storedFilters || undefined);
        const existingClasses = (() => {
          try {
            return JSON.parse(existing.classes || '[]') as string[];
          } catch {
            return [];
          }
        })();
        const imageCount = existing.imageCount || 0;
        const splitRatio = imageCount
          ? {
              train: existing.trainCount / imageCount,
              val: existing.valCount / imageCount,
              test: existing.testCount / imageCount,
            }
          : normalizeSplitRatio(config.splits);
        const preview = await datasetPreparation.previewDataset({
          projectId: existing.projectId || config.projectId,
          classes: existingClasses.length > 0 ? existingClasses : selectedClasses,
          splitRatio,
          includeAIDetections: storedFilterConfig.includeAIDetections,
          includeManualAnnotations: storedFilterConfig.includeManualAnnotations,
          includeSAM3: storedFilterConfig.includeSAM3,
          minConfidence: storedFilterConfig.minConfidence,
          verifiedOnly: storedFilterConfig.verifiedOnly,
          createdBefore: existing.snapshotAt || new Date(),
        });
        return { dataset: existing, preview };
      }
    }

    const snapshotAt = new Date();
    const preview = await datasetPreparation.previewDataset({
      projectId: config.projectId,
      classes: selectedClasses,
      splitRatio: config.splits,
      includeAIDetections: filterConfig.includeAIDetections,
      includeManualAnnotations: filterConfig.includeManualAnnotations,
      includeSAM3: filterConfig.includeSAM3,
      minConfidence: filterConfig.minConfidence,
      verifiedOnly: filterConfig.verifiedOnly,
      createdBefore: snapshotAt,
    });

    if (preview.imageCount === 0) {
      throw new Error('No annotated images found matching criteria');
    }

    const datasetId = randomUUID();
    const preparedAssets = await datasetPreparation.listPreparedAssets({
      projectId: config.projectId,
      assetIds: undefined,
      classes: preview.classes,
      includeAIDetections: filterConfig.includeAIDetections,
      includeManualAnnotations: filterConfig.includeManualAnnotations,
      includeSAM3: filterConfig.includeSAM3,
      minConfidence: filterConfig.minConfidence,
      verifiedOnly: filterConfig.verifiedOnly,
      createdBefore: snapshotAt,
    });

    if (preparedAssets.length === 0) {
      throw new Error('No annotated images found matching criteria');
    }

    const assetIds = preparedAssets.map((asset) => asset.id);
    const { manifestKey, checksum, annotationCount } = await this.createAnnotationManifest({
      projectId: config.projectId,
      snapshotAt,
      filters: config.filters,
      assetIds,
      classes: preview.classes,
      verifiedOnly: filterConfig.verifiedOnly,
      includeAIDetections: filterConfig.includeAIDetections,
      includeManualAnnotations: filterConfig.includeManualAnnotations,
      includeSAM3: filterConfig.includeSAM3,
      minConfidence: filterConfig.minConfidence,
    });

    const splitRatio = normalizeSplitRatio(config.splits);

    let dataset: TrainingDataset;
    try {
      dataset = await prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM Project WHERE id = ${config.projectId} FOR UPDATE`;

        if (config.idempotencyKey) {
          const existing = await tx.trainingDataset.findUnique({
            where: { idempotencyKey: config.idempotencyKey },
          });
          if (existing) return existing;
        }

        const maxVersion = await tx.trainingDataset.aggregate({
          where: { projectId: config.projectId, version: { not: null } },
          _max: { version: true },
        });
        const nextVersion = (maxVersion._max.version || 0) + 1;
        const s3BasePath = `datasets/${config.projectId}/v${nextVersion}`;
        const s3FullPath = `s3://${S3Service.bucketName}/${s3BasePath}/`;

        const created = await tx.trainingDataset.create({
          data: {
            id: datasetId,
            name: config.name || `${config.projectId}-v${nextVersion}`,
            displayName: config.displayName,
            version: nextVersion,
            snapshotAt,
            status: 'CREATING',
            projectId: config.projectId,
            teamId: config.teamId,
            imageCount: preview.imageCount,
            labelCount: preview.labelCount,
            classes: JSON.stringify(preview.classes),
            trainCount: Math.floor(preview.imageCount * splitRatio.train),
            valCount: Math.floor(preview.imageCount * splitRatio.val),
            testCount: Math.max(0, preview.imageCount - Math.floor(preview.imageCount * splitRatio.train) - Math.floor(preview.imageCount * splitRatio.val)),
            preprocessingConfig: config.preprocessing,
            augmentationPreset: config.augmentation?.preset,
            augmentationConfig: config.augmentation ? JSON.stringify(config.augmentation) : null,
            annotationManifestS3Key: manifestKey,
            annotationManifestChecksum: checksum,
            annotationCount,
            idempotencyKey: config.idempotencyKey,
            creationFilters: config.filters || undefined,
            s3Bucket: S3Service.bucketName,
            s3Path: s3FullPath,
            createdById: config.createdById ?? undefined,
          },
        });

        if (preparedAssets.length > 0) {
          const chunkSize = 1000;
          for (let i = 0; i < preparedAssets.length; i += chunkSize) {
            const chunk = preparedAssets.slice(i, i + chunkSize).map((asset) => ({
              datasetId: created.id,
              assetId: asset.id,
              s3Key: asset.s3Key || null,
              gpsLatitude: asset.gpsLatitude ?? null,
              gpsLongitude: asset.gpsLongitude ?? null,
            }));
            await tx.trainingDatasetAsset.createMany({
              data: chunk,
              skipDuplicates: true,
            });
          }
        }

        return created;
      });
    } catch (error) {
      if (
        config.idempotencyKey &&
        error &&
        typeof error === 'object' &&
        'code' in error &&
        (error as { code?: string }).code === 'P2002'
      ) {
        const existing = await prisma.trainingDataset.findUnique({
          where: { idempotencyKey: config.idempotencyKey },
        });
        if (existing) return { dataset: existing, preview };
      }
      throw error;
    }

    const parsedS3Path = dataset.s3Path.replace(/^s3:\/\//, '');
    const [, ...keyParts] = parsedS3Path.split('/');
    const s3BasePath = keyParts.join('/').replace(/\/+$/, '');

    let prepared;
    try {
      prepared = await datasetPreparation.prepareDataset(
        config.teamId,
        dataset.name,
        {
          projectId: config.projectId,
          assetIds,
          classes: preview.classes,
          splitRatio: splitRatio,
          includeAIDetections: filterConfig.includeAIDetections,
          includeManualAnnotations: filterConfig.includeManualAnnotations,
          includeSAM3: filterConfig.includeSAM3,
          minConfidence: filterConfig.minConfidence,
          verifiedOnly: filterConfig.verifiedOnly,
          createdBefore: snapshotAt,
          datasetId,
          s3BasePath,
          skipCreateRecord: true,
          createdById: config.createdById ?? undefined,
        }
      );
    } catch (error) {
      await prisma.trainingDataset.update({
        where: { id: datasetId },
        data: { status: 'FAILED' },
      });
      throw error;
    }

    const updated = await prisma.trainingDataset.update({
      where: { id: datasetId },
      data: {
        imageCount: prepared.imageCount,
        labelCount: prepared.labelCount,
        trainCount: prepared.trainCount,
        valCount: prepared.valCount,
        testCount: prepared.testCount,
        status: 'READY',
      },
    });

    return { dataset: updated, preview };
  }

  async getNextVersionNumber(projectId: string): Promise<number> {
    const max = await prisma.trainingDataset.aggregate({
      where: { projectId, version: { not: null } },
      _max: { version: true },
    });
    return (max._max.version || 0) + 1;
  }

  async listVersions(projectId: string) {
    return prisma.trainingDataset.findMany({
      where: { projectId, version: { not: null } },
      orderBy: { version: 'desc' },
      include: {
        trainingJobs: {
          include: { trainedModel: true },
          orderBy: { createdAt: 'desc' },
          take: 1,
        },
      },
    });
  }

  async getVersionWithStats(versionId: string) {
    return prisma.trainingDataset.findUnique({
      where: { id: versionId },
      include: {
        trainingJobs: {
          include: { trainedModel: true },
          orderBy: { createdAt: 'desc' },
        },
        assets: true,
      },
    });
  }

  async compareVersions(v1Id: string, v2Id: string) {
    const [v1, v2] = await Promise.all([
      prisma.trainingDataset.findUnique({ where: { id: v1Id } }),
      prisma.trainingDataset.findUnique({ where: { id: v2Id } }),
    ]);

    if (!v1 || !v2) {
      throw new Error('One or both versions not found');
    }

    const [v1Assets, v2Assets] = await Promise.all([
      prisma.trainingDatasetAsset.findMany({
        where: { datasetId: v1Id },
        select: { assetId: true },
      }),
      prisma.trainingDatasetAsset.findMany({
        where: { datasetId: v2Id },
        select: { assetId: true },
      }),
    ]);

    const v1Set = new Set(v1Assets.map((a) => a.assetId));
    const v2Set = new Set(v2Assets.map((a) => a.assetId));
    let overlap = 0;
    for (const id of v1Set) {
      if (v2Set.has(id)) overlap += 1;
    }

    const v1Classes = new Set<string>(JSON.parse(v1.classes || '[]'));
    const v2Classes = new Set<string>(JSON.parse(v2.classes || '[]'));
    const addedClasses = Array.from(v2Classes).filter((cls) => !v1Classes.has(cls));
    const removedClasses = Array.from(v1Classes).filter((cls) => !v2Classes.has(cls));

    return {
      v1: { id: v1.id, version: v1.version, imageCount: v1.imageCount, labelCount: v1.labelCount },
      v2: { id: v2.id, version: v2.version, imageCount: v2.imageCount, labelCount: v2.labelCount },
      overlapAssets: overlap,
      addedClasses,
      removedClasses,
    };
  }

  async reconcileStuckVersions(): Promise<number> {
    const stuckThreshold = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const result = await prisma.trainingDataset.updateMany({
      where: {
        status: 'TRAINING',
        updatedAt: { lt: stuckThreshold },
      },
      data: { status: 'READY' },
    });
    return result.count;
  }

  private async createAnnotationManifest(options: {
    projectId: string;
    snapshotAt: Date;
    filters?: SnapshotFilters;
    assetIds?: string[];
    classes: string[];
    verifiedOnly: boolean;
    includeAIDetections: boolean;
    includeManualAnnotations: boolean;
    includeSAM3: boolean;
    minConfidence: number;
  }): Promise<{ manifestKey: string; checksum: string; annotationCount: number }> {
    const {
      projectId,
      snapshotAt,
      filters,
      assetIds,
      classes,
      verifiedOnly,
      includeAIDetections,
      includeManualAnnotations,
      includeSAM3,
      minConfidence,
    } = options;

    const classSet = new Set(classes);

    const annotations: AnnotationManifestEntry[] = [];

    if (includeManualAnnotations) {
      const manual = await prisma.manualAnnotation.findMany({
        where: {
          session: {
            asset: {
              projectId,
              ...(assetIds && assetIds.length > 0 ? { id: { in: assetIds } } : {}),
            },
          },
          verified: true,
          createdAt: { lte: snapshotAt },
          ...(filters?.weedTypes && filters.weedTypes.length > 0
            ? { weedType: { in: filters.weedTypes } }
            : {}),
        },
        select: {
          id: true,
          weedType: true,
          roboflowClassName: true,
          coordinates: true,
          geoCoordinates: true,
          confidence: true,
          session: { select: { assetId: true } },
        },
      });

      for (const annotation of manual) {
        const className = (annotation.roboflowClassName || annotation.weedType || '').toString();
        if (classSet.size > 0 && !classSet.has(sanitizeClassName(className))) {
          continue;
        }
        annotations.push({
          id: annotation.id,
          type: 'manual',
          assetId: annotation.session.assetId,
          className,
          confidence: annotation.confidence,
          coordinates: annotation.coordinates,
          geoCoordinates: annotation.geoCoordinates,
        });
      }
    }

    if (includeAIDetections) {
      const detections = await prisma.detection.findMany({
        where: {
          asset: {
            projectId,
            ...(assetIds && assetIds.length > 0 ? { id: { in: assetIds } } : {}),
          },
          type: { in: ['AI', 'YOLO_LOCAL'] },
          rejected: false,
          ...(verifiedOnly
            ? { verified: true }
            : { OR: [{ verified: true }, { userCorrected: true }] }),
          createdAt: { lte: snapshotAt },
          ...(filters?.weedTypes && filters.weedTypes.length > 0
            ? { className: { in: filters.weedTypes } }
            : {}),
        },
        select: {
          id: true,
          assetId: true,
          className: true,
          confidence: true,
          boundingBox: true,
          preprocessingMeta: true,
          type: true,
        },
      });

      for (const detection of detections) {
        if (typeof detection.confidence === 'number' && detection.confidence < minConfidence) {
          continue;
        }
        const className = detection.className || '';
        if (classSet.size > 0 && !classSet.has(sanitizeClassName(className))) {
          continue;
        }
        annotations.push({
          id: detection.id,
          type: 'detection',
          assetId: detection.assetId,
          className,
          confidence: detection.confidence,
          bbox: detection.boundingBox,
          preprocessingMeta: detection.preprocessingMeta,
          sourceType: detection.type,
        });
      }
    }

    if (includeSAM3) {
      const pending = await prisma.pendingAnnotation.findMany({
        where: {
          asset: {
            projectId,
            ...(assetIds && assetIds.length > 0 ? { id: { in: assetIds } } : {}),
          },
          status: 'ACCEPTED',
          createdAt: { lte: snapshotAt },
          ...(filters?.weedTypes && filters.weedTypes.length > 0
            ? { weedType: { in: filters.weedTypes } }
            : {}),
        },
        select: {
          id: true,
          assetId: true,
          weedType: true,
          confidence: true,
          polygon: true,
          bbox: true,
        },
      });

      for (const annotation of pending) {
        if (typeof annotation.confidence === 'number' && annotation.confidence < minConfidence) {
          continue;
        }
        const className = annotation.weedType || '';
        if (classSet.size > 0 && !classSet.has(sanitizeClassName(className))) {
          continue;
        }
        annotations.push({
          id: annotation.id,
          type: 'sam3',
          assetId: annotation.assetId,
          className,
          confidence: annotation.confidence,
          coordinates: annotation.polygon,
          bbox: annotation.bbox,
        });
      }
    }

    const manifest: AnnotationManifest = {
      snapshotAt: snapshotAt.toISOString(),
      projectId,
      filters,
      annotationCount: annotations.length,
      annotations,
    };

    const manifestJson = JSON.stringify(manifest, null, 2);
    const checksum = createHash('sha256').update(manifestJson).digest('hex');
    const safeTimestamp = snapshotAt.toISOString().replace(/:/g, '-');
    const manifestKey = `datasets/${projectId}/manifests/${safeTimestamp}.json`;

    await S3Service.uploadBuffer(Buffer.from(manifestJson), manifestKey, 'application/json');

    return { manifestKey, checksum, annotationCount: annotations.length };
  }
}

export const trainingDatasetVersionService = new TrainingDatasetVersionService();
