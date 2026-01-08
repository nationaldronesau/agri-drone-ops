/**
 * Dataset Preparation Service
 * 
 * Converts SAM3/manual annotations from the database to YOLO format
 * and uploads to S3 for training.
 * 
 * Location: lib/services/dataset-preparation.ts
 */

import { prisma } from '@/lib/db';
import { S3Service } from '@/lib/services/s3';
import { randomUUID } from 'crypto';

// ===========================================
// TYPES
// ===========================================

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

interface DatasetConfig {
  projectId?: string;
  sessionIds?: string[];  // Specific annotation sessions
  classes: string[];      // Class names in order, e.g., ["wattle", "lantana"]
  splitRatio?: {
    train: number;  // e.g., 0.7
    val: number;    // e.g., 0.2
    test: number;   // e.g., 0.1
  };
  includeAIDetections?: boolean;  // Include Roboflow detections
  includeManualAnnotations?: boolean;  // Include manual annotations
  minConfidence?: number;  // Min confidence for AI detections
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

// ===========================================
// DATASET PREPARATION SERVICE
// ===========================================

export class DatasetPreparationService {
  private s3: S3Service;
  private bucket: string;

  constructor() {
    this.s3 = new S3Service();
    this.bucket = process.env.AWS_S3_BUCKET || 'nd-agridrone';
  }

  /**
   * Prepare a dataset from project annotations
   */
  async prepareDataset(
    teamId: string,
    name: string,
    config: DatasetConfig
  ): Promise<PreparedDataset> {
    const datasetId = randomUUID();
    const s3BasePath = `datasets/${datasetId}`;

    console.log(`Preparing dataset: ${name} (${datasetId})`);

    // 1. Fetch all relevant assets with annotations
    const assets = await this.fetchAnnotatedAssets(config);
    
    if (assets.length === 0) {
      throw new Error('No annotated images found matching criteria');
    }

    console.log(`Found ${assets.length} annotated images`);

    // 2. Build class mapping
    const classMap = new Map<string, number>();
    config.classes.forEach((cls, idx) => {
      classMap.set(cls.toLowerCase(), idx);
    });

    // 3. Shuffle and split dataset
    const shuffled = this.shuffleArray([...assets]);
    const splits = this.splitDataset(shuffled, config.splitRatio);

    console.log(`Split: train=${splits.train.length}, val=${splits.val.length}, test=${splits.test.length}`);

    // 4. Process each split
    let totalLabels = 0;

    for (const [splitName, splitAssets] of Object.entries(splits)) {
      if (splitAssets.length === 0) continue;

      for (const asset of splitAssets) {
        // Convert annotations to YOLO format
        const yoloAnnotations = this.convertToYOLO(
          asset,
          classMap,
          config.includeAIDetections ?? true,
          config.includeManualAnnotations ?? true,
          config.minConfidence ?? 0.5
        );

        if (yoloAnnotations.length === 0) continue;

        totalLabels += yoloAnnotations.length;

        // Generate label file content
        const labelContent = yoloAnnotations
          .map(ann => `${ann.classId} ${ann.bbox.x.toFixed(6)} ${ann.bbox.y.toFixed(6)} ${ann.bbox.width.toFixed(6)} ${ann.bbox.height.toFixed(6)}`)
          .join('\n');

        // Upload label file
        const labelKey = `${s3BasePath}/${splitName}/labels/${asset.id}.txt`;
        await this.s3.uploadBuffer(
          Buffer.from(labelContent),
          labelKey,
          'text/plain'
        );

        // Copy image to dataset (or create symlink reference)
        // If image is already in S3, we can reference it in data.yaml
        // For simplicity, we'll copy it
        if (asset.s3Key) {
          const imageExt = asset.filename?.split('.').pop() || 'jpg';
          const imageKey = `${s3BasePath}/${splitName}/images/${asset.id}.${imageExt}`;
          await this.s3.copyObject(asset.s3Key, imageKey);
        }
      }
    }

    // 5. Create data.yaml
    const dataYaml = this.generateDataYaml(
      s3BasePath,
      config.classes,
      splits
    );

    await this.s3.uploadBuffer(
      Buffer.from(dataYaml),
      `${s3BasePath}/data.yaml`,
      'text/yaml'
    );

    // 6. Create dataset record in database
    const s3FullPath = `s3://${this.bucket}/${s3BasePath}/`;
    
    await prisma.trainingDataset.create({
      data: {
        id: datasetId,
        name,
        projectId: config.projectId,
        s3Path: s3FullPath,
        s3Bucket: this.bucket,
        imageCount: assets.length,
        labelCount: totalLabels,
        classes: JSON.stringify(config.classes),
        trainCount: splits.train.length,
        valCount: splits.val.length,
        testCount: splits.test.length,
        teamId,
      },
    });

    console.log(`Dataset prepared: ${s3FullPath}`);

    return {
      datasetId,
      s3Path: s3FullPath,
      imageCount: assets.length,
      labelCount: totalLabels,
      trainCount: splits.train.length,
      valCount: splits.val.length,
      testCount: splits.test.length,
      classes: config.classes,
    };
  }

  /**
   * Fetch assets with their annotations
   */
  private async fetchAnnotatedAssets(config: DatasetConfig) {
    const where: any = {};

    if (config.projectId) {
      where.projectId = config.projectId;
    }

    // Fetch assets with AI detections and/or manual annotations
    const assets = await prisma.asset.findMany({
      where,
      include: {
        detections: config.includeAIDetections ? true : false,
        manualAnnotations: config.includeManualAnnotations ? {
          include: {
            session: true,
          },
          where: config.sessionIds ? {
            sessionId: { in: config.sessionIds },
          } : undefined,
        } : false,
      },
    });

    // Filter to only assets that have at least one annotation
    return assets.filter(asset => {
      const hasAIDetections = config.includeAIDetections && 
        asset.detections && 
        asset.detections.length > 0;
      
      const hasManualAnnotations = config.includeManualAnnotations && 
        asset.manualAnnotations && 
        asset.manualAnnotations.length > 0;

      return hasAIDetections || hasManualAnnotations;
    });
  }

  /**
   * Convert asset annotations to YOLO format
   */
  private convertToYOLO(
    asset: any,
    classMap: Map<string, number>,
    includeAI: boolean,
    includeManual: boolean,
    minConfidence: number
  ): YOLOAnnotation[] {
    const annotations: YOLOAnnotation[] = [];
    
    const imageWidth = asset.width || 4000;  // Default DJI image width
    const imageHeight = asset.height || 3000;

    // Process AI detections
    if (includeAI && asset.detections) {
      for (const detection of asset.detections) {
        if (detection.confidence < minConfidence) continue;

        const className = detection.class?.toLowerCase();
        const classId = classMap.get(className);
        
        if (classId === undefined) continue;

        // Detection bbox is typically [x1, y1, x2, y2] in pixels
        const bbox = typeof detection.bbox === 'string' 
          ? JSON.parse(detection.bbox) 
          : detection.bbox;

        if (bbox && bbox.length >= 4) {
          const [x1, y1, x2, y2] = bbox;
          annotations.push({
            classId,
            bbox: this.pixelToYOLO(x1, y1, x2, y2, imageWidth, imageHeight),
          });
        }
      }
    }

    // Process manual annotations
    if (includeManual && asset.manualAnnotations) {
      for (const annotation of asset.manualAnnotations) {
        const className = annotation.label?.toLowerCase();
        const classId = classMap.get(className);
        
        if (classId === undefined) continue;

        // Manual annotations have polygon points
        const points = typeof annotation.points === 'string'
          ? JSON.parse(annotation.points)
          : annotation.points;

        if (points && points.length >= 3) {
          // Convert polygon to bounding box
          const bbox = this.polygonToBBox(points, imageWidth, imageHeight);
          annotations.push({ classId, bbox });
        }
      }
    }

    return annotations;
  }

  /**
   * Convert pixel coordinates to YOLO format (center x, center y, width, height - all normalized 0-1)
   */
  private pixelToYOLO(
    x1: number, y1: number, x2: number, y2: number,
    imgWidth: number, imgHeight: number
  ): BoundingBox {
    const width = (x2 - x1) / imgWidth;
    const height = (y2 - y1) / imgHeight;
    const x = (x1 + x2) / 2 / imgWidth;
    const y = (y1 + y2) / 2 / imgHeight;

    return {
      x: Math.max(0, Math.min(1, x)),
      y: Math.max(0, Math.min(1, y)),
      width: Math.max(0, Math.min(1, width)),
      height: Math.max(0, Math.min(1, height)),
    };
  }

  /**
   * Convert polygon points to YOLO bounding box
   */
  private polygonToBBox(
    points: [number, number][],
    imgWidth: number,
    imgHeight: number
  ): BoundingBox {
    const xs = points.map(p => p[0]);
    const ys = points.map(p => p[1]);
    
    const x1 = Math.min(...xs);
    const x2 = Math.max(...xs);
    const y1 = Math.min(...ys);
    const y2 = Math.max(...ys);

    return this.pixelToYOLO(x1, y1, x2, y2, imgWidth, imgHeight);
  }

  /**
   * Generate data.yaml for YOLO training
   */
  private generateDataYaml(
    s3BasePath: string,
    classes: string[],
    splits: { train: any[]; val: any[]; test: any[] }
  ): string {
    const s3Uri = `s3://${this.bucket}/${s3BasePath}`;
    
    return `# AgriDrone Ops Dataset
# Generated: ${new Date().toISOString()}

# Paths (relative to this file or absolute S3 URIs)
path: ${s3Uri}
train: train/images
val: val/images
test: ${splits.test.length > 0 ? 'test/images' : ''}

# Classes
nc: ${classes.length}
names: ${JSON.stringify(classes)}

# Dataset info
# Train images: ${splits.train.length}
# Val images: ${splits.val.length}
# Test images: ${splits.test.length}
`;
  }

  /**
   * Split dataset into train/val/test
   */
  private splitDataset(
    assets: any[],
    ratio = { train: 0.7, val: 0.2, test: 0.1 }
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

  /**
   * Fisher-Yates shuffle
   */
  private shuffleArray<T>(array: T[]): T[] {
    for (let i = array.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [array[i], array[j]] = [array[j], array[i]];
    }
    return array;
  }
}

// Export singleton
export const datasetPreparation = new DatasetPreparationService();
