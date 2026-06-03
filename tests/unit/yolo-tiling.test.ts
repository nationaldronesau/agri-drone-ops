import { describe, expect, it } from 'vitest';
import {
  buildYoloTilePlan,
  calculateBBoxIoU,
  mergeYoloDetectionsWithNms,
  offsetDetectionToImage,
  shouldTileYoloImage,
} from '@/lib/utils/yolo-tiling';

describe('YOLO tiled inference utilities', () => {
  it('builds a deterministic 40-tile plan for DJI 8192x5460 images', () => {
    const tiles = buildYoloTilePlan(8192, 5460, {
      tileSize: 1536,
      overlap: 512,
    });

    expect(tiles).toHaveLength(40);
    expect(tiles[0]).toMatchObject({ index: 0, x: 0, y: 0, width: 1536, height: 1536 });
    expect(tiles[7]).toMatchObject({ index: 7, x: 6656, y: 0, width: 1536, height: 1536 });
    expect(tiles[32]).toMatchObject({ index: 32, x: 0, y: 3924, width: 1536, height: 1536 });
    expect(tiles[39]).toMatchObject({ index: 39, x: 6656, y: 3924, width: 1536, height: 1536 });
  });

  it('only tiles images larger than the configured threshold', () => {
    expect(shouldTileYoloImage(1536, 1536, {
      enabled: true,
      minDimension: 2048,
      tileSize: 1536,
    })).toBe(false);

    expect(shouldTileYoloImage(8192, 5460, {
      enabled: true,
      minDimension: 2048,
      tileSize: 1536,
    })).toBe(true);

    expect(shouldTileYoloImage(8192, 5460, {
      enabled: false,
      minDimension: 2048,
      tileSize: 1536,
    })).toBe(false);
  });

  it('offsets tile-local detections back into full-image coordinates', () => {
    const detection = offsetDetectionToImage(
      {
        class: 'Pine-Saplings',
        confidence: 0.92,
        bbox: [100, 200, 180, 280],
      },
      { index: 12, x: 2048, y: 1024, width: 1536, height: 1536 },
      8192,
      5460
    );

    expect(detection).toEqual({
      class: 'Pine-Saplings',
      confidence: 0.92,
      bbox: [2148, 1224, 2228, 1304],
    });
  });

  it('clips offset detections to the full-image boundary', () => {
    const detection = offsetDetectionToImage(
      {
        class: 'Pine-Saplings',
        confidence: 0.88,
        bbox: [1500, 1500, 1700, 1700],
      },
      { index: 39, x: 6656, y: 3924, width: 1536, height: 1536 },
      8192,
      5460
    );

    expect(detection?.bbox).toEqual([8156, 5424, 8192, 5460]);
  });

  it('merges duplicate same-class overlap boxes while preserving distinct candidates', () => {
    const merged = mergeYoloDetectionsWithNms(
      [
        { class: 'Pine-Saplings', confidence: 0.91, bbox: [100, 100, 180, 180] },
        { class: 'Pine-Saplings', confidence: 0.77, bbox: [106, 106, 186, 186] },
        { class: 'Pine-Saplings', confidence: 0.72, bbox: [350, 350, 420, 420] },
        { class: 'Wattle', confidence: 0.71, bbox: [104, 104, 184, 184] },
      ],
      0.45
    );

    expect(merged).toHaveLength(3);
    expect(merged.map((detection) => detection.confidence)).toEqual([0.91, 0.72, 0.71]);
    expect(calculateBBoxIoU([100, 100, 180, 180], [106, 106, 186, 186])).toBeGreaterThan(0.45);
  });
});
