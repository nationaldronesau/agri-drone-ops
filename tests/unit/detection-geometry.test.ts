import { describe, expect, it } from 'vitest';
import {
  calculateBoxIoU,
  calculatePolygonBoxIoU,
  getPolygonBoundingRect,
  getValidPolygon,
} from '@/lib/utils/detection-geometry';

describe('detection geometry', () => {
  it('returns the bounding rect for a valid polygon', () => {
    expect(
      getPolygonBoundingRect([
        [3, 4],
        [9, 2],
        [7, 12],
      ])
    ).toEqual([3, 2, 9, 12]);
  });

  it('rejects missing, malformed, and degenerate polygons', () => {
    expect(getValidPolygon(undefined)).toBeNull();
    expect(getValidPolygon([[1, 2], [3, 4]])).toBeNull();
    expect(getValidPolygon([[1, 2], [3, Number.NaN], [5, 6]])).toBeNull();
    expect(getValidPolygon([[1, 1], [1, 2], [1, 3]])).toBeNull();
    expect(getPolygonBoundingRect([[1, 1], [1, 2], [1, 3]])).toBeNull();
  });

  it('computes box IoU and returns null for invalid boxes', () => {
    expect(calculateBoxIoU([0, 0, 10, 10], [0, 0, 10, 10])).toBe(1);
    expect(calculateBoxIoU([0, 0, 10, 10], [5, 0, 15, 10])).toBeCloseTo(1 / 3);
    expect(calculateBoxIoU([0, 0, 10, 10], [20, 20, 30, 30])).toBe(0);
    expect(calculateBoxIoU([0, 0, 0, 10], [0, 0, 10, 10])).toBeNull();
  });

  it('compares a stored box with the polygon bounding rect', () => {
    expect(
      calculatePolygonBoxIoU(
        [0, 0, 10, 10],
        [
          [0, 0],
          [8, 0],
          [8, 10],
          [0, 10],
        ]
      )
    ).toBeCloseTo(0.8);
  });
});
