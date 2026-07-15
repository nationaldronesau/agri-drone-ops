import { describe, expect, it } from 'vitest';
import { filterSam3ReviewDetections } from '@/lib/utils/sam3-review-quality';

const polygonFor = (bbox: [number, number, number, number]): [number, number][] => [
  [bbox[0], bbox[1]],
  [bbox[2], bbox[1]],
  [bbox[2], bbox[3]],
  [bbox[0], bbox[3]],
];

describe('SAM3 review quality guardrails', () => {
  it('keeps the highest-scoring box and suppresses overlapping or contained duplicates', () => {
    const boxes: Array<[number, number, number, number]> = [
      [100, 100, 140, 140],
      [102, 102, 139, 139],
      [98, 98, 143, 143],
      [180, 100, 220, 140],
    ];
    const result = filterSam3ReviewDetections({
      detections: boxes.map((bbox, index) => ({
        bbox,
        polygon: polygonFor(bbox),
        confidence: [0.91, 0.87, 0.84, 0.88][index],
      })),
      exemplars: [{ x1: 10, y1: 10, x2: 50, y2: 50 }],
    });

    expect(result.detections.map((detection) => detection.bbox)).toEqual([
      [100, 100, 140, 140],
      [180, 100, 220, 140],
    ]);
    expect(result.stats).toEqual({
      inputCount: 4,
      duplicateSuppressedCount: 2,
      geometryFilteredCount: 0,
      outputCount: 2,
    });
  });

  it('keeps nearby same-sized objects when overlap is below the final NMS threshold', () => {
    const first: [number, number, number, number] = [100, 100, 140, 140];
    const nearby: [number, number, number, number] = [117, 100, 157, 140];
    const result = filterSam3ReviewDetections({
      detections: [first, nearby].map((bbox, index) => ({
        bbox,
        polygon: polygonFor(bbox),
        confidence: [0.91, 0.89][index],
      })),
      exemplars: [{ x1: 10, y1: 10, x2: 50, y2: 50 }],
    });

    expect(result.detections.map((detection) => detection.bbox)).toEqual([first, nearby]);
    expect(result.stats.duplicateSuppressedCount).toBe(0);
  });

  it('drops implausibly large boxes while preserving similarly scaled saplings', () => {
    const valid: [number, number, number, number] = [500, 400, 545, 445];
    const adjacent: [number, number, number, number] = [580, 405, 620, 448];
    const oversized: [number, number, number, number] = [700, 350, 880, 500];
    const result = filterSam3ReviewDetections({
      detections: [valid, adjacent, oversized].map((bbox, index) => ({
        bbox,
        polygon: polygonFor(bbox),
        confidence: [0.86, 0.84, 0.93][index],
      })),
      exemplars: [
        { x1: 100, y1: 100, x2: 140, y2: 140 },
        { x1: 180, y1: 100, x2: 225, y2: 145 },
        { x1: 260, y1: 100, x2: 302, y2: 142 },
      ],
      sourceWidth: 4000,
      sourceHeight: 3000,
      targetWidth: 4000,
      targetHeight: 3000,
    });

    expect(result.detections.map((detection) => detection.bbox)).toEqual([valid, adjacent]);
    expect(result.stats.geometryFilteredCount).toBe(1);
    expect(result.stats.duplicateSuppressedCount).toBe(0);
  });
});
