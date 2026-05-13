import { describe, expect, it } from 'vitest';
import { datasetPreparation } from '@/lib/services/dataset-preparation';
import { buildTrainingAugmentationFromDataset } from '@/lib/services/training-augmentation';
import { normalizeTrainingDatasetSourceFlags } from '@/lib/utils/training-dataset-sources';

describe('training dataset sources', () => {
  const classMap = new Map([['lantana', 0]]);
  const datasetPreparationInternals = datasetPreparation as unknown as {
    convertToYOLO: (
      asset: Record<string, unknown>,
      classMap: Map<string, number>,
      includeAI: boolean,
      includeManual: boolean,
      minConfidence: number,
      includeSAM3: boolean
    ) => Array<{
      classId: number;
      bbox: { x: number; y: number; width: number; height: number };
    }>;
  };

  function convertToYOLO(asset: Record<string, unknown>) {
    return datasetPreparationInternals.convertToYOLO(
      {
        id: 'asset-1',
        fileName: 'asset-1.jpg',
        imageWidth: 100,
        imageHeight: 100,
        ...asset,
      },
      classMap,
      true,
      true,
      0.5,
      true
    );
  }

  it('includes accepted SAM3 labels by default when building training datasets', () => {
    expect(normalizeTrainingDatasetSourceFlags({})).toEqual({
      includeAIDetections: true,
      includeManualAnnotations: true,
      includeSAM3: true,
    });
  });

  it('allows callers to explicitly disable SAM3 labels', () => {
    expect(normalizeTrainingDatasetSourceFlags({ includeSAM3: false })).toMatchObject({
      includeSAM3: false,
    });
  });

  it('converts accepted SAM3 pending annotations into YOLO labels', () => {
    const labels = convertToYOLO({
      pendingAnnotations: [
        {
          weedType: 'Lantana',
          confidence: 0.92,
          status: 'ACCEPTED',
          bbox: [10, 20, 50, 80],
          polygon: [],
        },
      ],
    });

    expect(labels).toEqual([
      {
        classId: 0,
        bbox: {
          x: 0.3,
          y: 0.5,
          width: 0.4,
          height: 0.6,
        },
      },
    ]);
  });

  it('excludes pending and rejected SAM3 labels from YOLO datasets', () => {
    const labels = convertToYOLO({
      pendingAnnotations: [
        {
          weedType: 'Lantana',
          confidence: 0.92,
          status: 'PENDING',
          bbox: [10, 20, 50, 80],
          polygon: [],
        },
        {
          weedType: 'Lantana',
          confidence: 0.92,
          status: 'REJECTED',
          bbox: [10, 20, 50, 80],
          polygon: [],
        },
      ],
    });

    expect(labels).toEqual([]);
  });

  it('includes reviewed Roboflow fallback detections through the same review gate', () => {
    const labels = convertToYOLO({
      detections: [
        {
          type: 'AI',
          className: 'Lantana',
          confidence: 0.88,
          verified: true,
          rejected: false,
          userCorrected: false,
          boundingBox: { x: 20, y: 30, width: 10, height: 12 },
          metadata: { source: 'roboflow_batch_detection' },
        },
      ],
    });

    expect(labels).toHaveLength(1);
    expect(labels[0].classId).toBe(0);
  });

  it('excludes unreviewed Roboflow fallback detections from YOLO datasets', () => {
    const labels = convertToYOLO({
      detections: [
        {
          type: 'AI',
          className: 'Lantana',
          confidence: 0.88,
          verified: false,
          rejected: false,
          userCorrected: false,
          boundingBox: { x: 20, y: 30, width: 10, height: 12 },
          metadata: { source: 'roboflow_batch_detection' },
        },
      ],
    });

    expect(labels).toEqual([]);
  });

  it('carries dataset augmentation presets into YOLO training config', () => {
    expect(
      buildTrainingAugmentationFromDataset({
        augmentationPreset: 'agricultural',
        augmentationConfig: JSON.stringify({
          horizontalFlip: true,
          rotation: 12,
          brightness: 20,
          copiesPerImage: 3,
        }),
      })
    ).toMatchObject({
      preset: 'agricultural',
      horizontal_flip: true,
      fliplr: 0.5,
      rotation_degrees: 12,
      degrees: 12,
      brightness_pct: 20,
      hsv_v: 0.2,
      copies_per_image: 3,
    });
  });
});
