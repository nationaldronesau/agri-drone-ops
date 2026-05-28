import { describe, expect, it } from 'vitest';
import {
  clusterPineSaplingDetections,
  distanceMeters,
} from '@/lib/services/pine-sapling-count';

describe('pine sapling count clustering', () => {
  it('counts each georeferenced detection separately when clustering is disabled', () => {
    const clusters = clusterPineSaplingDetections(
      [
        {
          id: 'det-1',
          assetId: 'asset-1',
          centerLat: -27.1,
          centerLon: 153.1,
          confidence: 0.91,
        },
        {
          id: 'det-2',
          assetId: 'asset-2',
          centerLat: -27.10001,
          centerLon: 153.10001,
          confidence: 0.87,
        },
      ],
      0
    );

    expect(clusters).toHaveLength(2);
    expect(clusters.map((cluster) => cluster.count)).toEqual([1, 1]);
  });

  it('clusters nearby detections and keeps distant detections separate', () => {
    const first = { lat: -27.1, lon: 153.1 };
    const nearby = { lat: -27.100002, lon: 153.100002 };
    const distant = { lat: -27.1002, lon: 153.1002 };

    expect(distanceMeters(first, nearby)).toBeLessThan(1);
    expect(distanceMeters(first, distant)).toBeGreaterThan(10);

    const clusters = clusterPineSaplingDetections(
      [
        {
          id: 'det-1',
          assetId: 'asset-1',
          centerLat: first.lat,
          centerLon: first.lon,
          confidence: 0.82,
        },
        {
          id: 'det-2',
          assetId: 'asset-2',
          centerLat: nearby.lat,
          centerLon: nearby.lon,
          confidence: 0.94,
        },
        {
          id: 'det-3',
          assetId: 'asset-3',
          centerLat: distant.lat,
          centerLon: distant.lon,
          confidence: 0.71,
        },
      ],
      1
    );

    expect(clusters).toHaveLength(2);
    expect(clusters[0]).toMatchObject({
      count: 2,
      maxConfidence: 0.94,
      detectionIds: ['det-1', 'det-2'],
      assetIds: ['asset-1', 'asset-2'],
    });
    expect(clusters[1]).toMatchObject({
      count: 1,
      detectionIds: ['det-3'],
    });
  });

  it('ignores detections without finite georeferenced centres', () => {
    const clusters = clusterPineSaplingDetections(
      [
        {
          id: 'det-1',
          assetId: 'asset-1',
          centerLat: null,
          centerLon: 153.1,
          confidence: 0.91,
        },
        {
          id: 'det-2',
          assetId: 'asset-2',
          centerLat: -27.1,
          centerLon: Number.NaN,
          confidence: 0.87,
        },
      ],
      0
    );

    expect(clusters).toEqual([]);
  });
});
