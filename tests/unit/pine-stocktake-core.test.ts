import { describe, expect, it } from 'vitest';
import fixture from '../fixtures/pine-stocktake/hqp-sealed-small.json';
import {
  PINE_STOCKTAKE_CONFIG,
  SAM3_IDENTITY,
  acceptCrown,
  applyRestartableStage,
  assertPinnedModel,
  assertThreeExternalExemplars,
  axisStarts,
  boundedNeighbourhoodRecovery,
  buildAgreementGroups,
  centreCropForSlot,
  createReviewRevision,
  deduplicateObservations,
  exportStockCsv,
  exportStockGeoJson,
  fusePerExemplar,
  mapNativePointToQuery,
  mapQueryPointToNative,
  matchPose,
  nativeMaskIou,
  nativeTiles,
  oneShotLayout,
  parseClc,
  parseCli,
  pixelToWorld,
  selectCrownCluster,
  selectProjectedCrs,
  strictCrossViewRecovery,
  transformBoxToCanvas,
  validateCameraSerials,
  validateNativePolygon,
  worldToPixel,
  type BinaryMask,
  type FusedCandidate,
  type LidarPoint,
  type ModelCandidate,
  type NativeTile,
  type StockObservation,
} from '@/lib/pine-stocktake/core';

const tile = (tileId: string, x1 = 0, y1 = 0, width = 4, height = 4): NativeTile => ({ tileId, x1, y1, x2: x1 + width, y2: y1 + height, width, height, partial: width < 1024 || height < 1024 });
const mask = (active: number[]): BinaryMask => ({ width: 4, height: 4, active });
const candidate = (id: string, exemplarId: string, nativeTile: NativeTile, active: number[], score = 0.8): ModelCandidate => ({ candidateId: id, exemplarId, targetImageId: 'target', targetImageSha256: 'a'.repeat(64), tile: nativeTile, score, mask: mask(active), polygon: [[2, 1], [4, 1], [4, 3], [2, 3]], modelResultSha256: id.padEnd(64, '0').slice(0, 64) });

describe('pine-stocktake-v1 shared canvas and native tiling', () => {
  it('places support and query in the validated one-shot canvas', () => {
    const layout = oneShotLayout();
    expect(layout.support).toEqual({ x: 0, y: 0, width: 1008, height: 252 });
    expect(layout.query).toEqual({ x: 0, y: 252, width: 1008, height: 756 });
    const crop = centreCropForSlot([4458, 2943, 4737, 3148], layout.support, { width: 6144, height: 4096 });
    const box = transformBoxToCanvas([4458, 2943, 4737, 3148], crop, layout.support);
    expect(box[0]).toBeGreaterThanOrEqual(0);
    expect(box[2]).toBeLessThanOrEqual(1008);
  });

  it('prohibits target-label prompt leakage and requires three independent exemplars', () => {
    const exemplars = [1, 2, 3].map((value) => ({ id: `E${value}`, sourceImageId: `source-${value}`, sourceImageSha256: String(value).repeat(64), polygon: [[0, 0], [5, 0], [5, 5]] as const, approved: true }));
    expect(() => assertThreeExternalExemplars(exemplars, 'target')).not.toThrow();
    expect(() => assertThreeExternalExemplars([{ ...exemplars[0], sourceImageId: 'target' }, exemplars[1], exemplars[2]], 'target')).toThrow(/forbidden/);
  });

  it('covers every native pixel and handles a partial image without stretching', () => {
    expect(axisStarts(6144)).toEqual([0, 768, 1536, 2304, 3072, 3840, 4608, 5120]);
    expect(axisStarts(4096)).toEqual([0, 768, 1536, 2304, 3072]);
    const full = nativeTiles(6144, 4096);
    expect(full).toHaveLength(40);
    for (let y = 0; y < 4096; y += 97) for (let x = 0; x < 6144; x += 97) expect(full.some((item) => x >= item.x1 && x < item.x2 && y >= item.y1 && y < item.y2)).toBe(true);
    const partial = nativeTiles(800, 600);
    expect(partial).toEqual([{ tileId: 'T0000', x1: 0, y1: 0, x2: 800, y2: 600, width: 800, height: 600, partial: true }]);
  });

  it('round trips tile coordinates to exact native coordinates', () => {
    const query = oneShotLayout().query;
    const nativeTile = tile('T', 3072, 2560, 1024, 1024);
    const native: [number, number] = [3891.2, 3001.4];
    const canvas = mapNativePointToQuery(native, query, nativeTile);
    const roundTrip = mapQueryPointToNative(canvas, query, nativeTile);
    expect(roundTrip[0]).toBeCloseTo(native[0], 8);
    expect(roundTrip[1]).toBeCloseTo(native[1], 8);
    expect(() => validateNativePolygon([[0, 0], [6143, 0], [6143, 4095]], 6144, 4096)).not.toThrow();
  });
});

describe('per-exemplar masks, duplicate fusion and agreement', () => {
  it('uses exact native-mask IoU across overlapping tiles', () => {
    const left = candidate('left', 'E1', tile('T1', 0), [6, 7, 10, 11, 14, 15]);
    const right = candidate('right', 'E1', tile('T2', 2), [4, 5, 8, 9, 12, 13]);
    expect(nativeMaskIou(left, right)).toBe(1);
  });

  it('keeps exemplar runs separate and retains duplicate lineage', () => {
    const left = candidate('left', 'E1', tile('T1', 0), [6, 7, 10, 11, 14, 15], 0.9);
    const right = candidate('right', 'E1', tile('T2', 2), [4, 5, 8, 9, 12, 13], 0.8);
    const fused = fusePerExemplar([right, left]);
    expect(fused.kept).toHaveLength(1);
    expect(fused.kept[0].duplicateLineage).toEqual(['right']);
    expect(() => fusePerExemplar([left, { ...right, exemplarId: 'E2' }])).toThrow(/cannot combine/);
  });

  it('calculates union, two-of-three and three-of-three agreement', () => {
    const common = [6, 7, 10, 11, 14, 15];
    const isolated = [0];
    const make = (id: string, exemplarId: string, active = common) => ({ ...candidate(id, exemplarId, tile('same'), active), duplicateLineage: [] } as FusedCandidate);
    const groups = buildAgreementGroups({ E1: [make('a', 'E1'), make('solo', 'E1', isolated)], E2: [make('b', 'E2')], E3: [make('c', 'E3')] });
    expect(groups.map((group) => group.agreementLevel).sort()).toEqual([1, 3]);
    expect(groups.flatMap((group) => group.candidateIds)).toHaveLength(4);
  });
});

describe('calibration, pose and projection gates', () => {
  const clcText = `Camera serial number: LV-SERIAL\nQ(4)\n1 0 0 0\nT(3)\n1000 0 0\nCamera serial number: RV-SERIAL\nQ(4)\n1 0 0 0\nT(3)\n-1000 0 0\n`;
  const cliText = `Q(4)\n1 0 0 0\nT(3)\n0 2000 0\n`;

  it('parses CLC and CLI transforms and validates camera serials', () => {
    const clc = parseClc(clcText);
    expect(clc).toHaveLength(2);
    expect(clc[0].translationM).toEqual([1, 0, 0]);
    expect(parseCli(cliText).translationM).toEqual([0, 2, 0]);
    expect(() => validateCameraSerials(['LV-SERIAL', 'RV-SERIAL'], clc)).not.toThrow();
    expect(() => validateCameraSerials(['OTHER'], clc)).toThrow(/serial mismatch/);
  });

  it('matches pose time and rejects ambiguous timebases', () => {
    const poses = [{ timestamp: 10, position: [0, 0, 0] as const, quaternion: [1, 0, 0, 0] as const, timebase: 'GPS' }, { timestamp: 20, position: [10, 20, 30] as const, quaternion: [1, 0, 0, 0] as const, timebase: 'GPS' }];
    expect(matchPose(15, poses, 'GPS').position).toEqual([5, 10, 15]);
    expect(() => matchPose(15, poses, '')).toThrow(/ambiguous/);
    expect(() => matchPose(25, poses, 'GPS')).toThrow(/outside/);
  });

  it('round trips camera pixel to world and back', () => {
    const frame = { camera: { focalPx: 1000, cx: 500, cy: 500, width: 1000, height: 1000 }, cameraOrigin: [500000, 7000000, 100] as const, cameraToWorld: [[1, 0, 0], [0, 1, 0], [0, 0, 1]] as const };
    const world = pixelToWorld(frame, [550, 475], 20);
    const pixel = worldToPixel(frame, world);
    expect(pixel[0]).toBeCloseTo(550, 7);
    expect(pixel[1]).toBeCloseTo(475, 7);
  });

  it('selects a location-appropriate projected CRS', () => {
    expect(selectProjectedCrs(-27.47, 153.03)).toBe('EPSG:32756');
    expect(selectProjectedCrs(-33.87, 151.21)).toBe('EPSG:32756');
    expect(selectProjectedCrs(-31.95, 115.86)).toBe('EPSG:32750');
  });
});

describe('LiDAR association, recovery and explicit missing reasons', () => {
  const crownPoints = Array.from({ length: 30 }, (_, index): LidarPoint => ({ id: `c${index}`, x: 100 + (index % 5) * 0.01, y: 200 + Math.floor(index / 5) * 0.01, z: 70.8 + index * 0.001, hag: 0.8 + index * 0.001, classification: 4 }));
  const remoteNoise: LidarPoint[] = [0, 1, 2].map((index) => ({ id: `n${index}`, x: 101 + index * 0.01, y: 201, z: 72 + index * 0.1, hag: 2 + index * 0.1, classification: 5 }));

  it('selects a coherent upper crown cluster and rejects isolated high noise', () => {
    const result = selectCrownCluster([...crownPoints, ...remoteNoise]);
    expect(result.status).toBe('matched');
    if (result.status === 'matched') {
      expect(result.pointCount).toBe(30);
      expect(result.heightP99M).toBeLessThan(0.84);
      expect(result.x).toBeCloseTo(100.02, 1);
    }
  });

  it('replays only one strict cross-view duplicate', () => {
    const polygon = [[0, 0], [10, 0], [10, 10], [0, 10]] as const;
    expect(strictCrossViewRecovery(polygon, [{ crownId: 'stock-1', projectedCentre: [5, 5], projectedApex: [6, 6] }])).toEqual({ status: 'matched', crownId: 'stock-1' });
    expect(strictCrossViewRecovery(polygon, [{ crownId: 'a', projectedCentre: [5, 5], projectedApex: [6, 6] }, { crownId: 'b', projectedCentre: [4, 4], projectedApex: [7, 7] }])).toEqual({ status: 'missing', reason: 'ambiguous_cross_view_match' });
  });

  it('uses the bounded ray neighbourhood and never invents a coordinate', () => {
    const recovered = boundedNeighbourhoodRecovery(crownPoints, [99.8, 200], [100.4, 200], [{ crownId: 'existing', x: 100.02, y: 200.03 }]);
    expect(recovered.recovery).toBe('merge_existing');
    expect(recovered.existingCrownId).toBe('existing');
    const missing = boundedNeighbourhoodRecovery([], [0, 0], [1, 0], []);
    expect(missing).toEqual({ association: { status: 'missing', reason: 'no_bounded_neighbourhood_cluster', detail: 'Only 0 valid vegetation points' }, recovery: 'missing' });
  });
});

describe('review immutability, restart idempotence, deduplication and exports', () => {
  it('keeps prediction geometry immutable and stores resumable review lineage', () => {
    const source = candidate('candidate', 'E1', tile('T'), [0], 0.9);
    const before = JSON.stringify(source);
    const working = createReviewRevision({ revisionId: 'r1', candidateId: source.candidateId, parentRevisionId: null, polygon: [[1, 1], [4, 1], [4, 4]], action: 'adjust', reviewState: 'working', edgeClipped: false, reviewerId: 'reviewer', reviewedAt: '2026-08-17T00:00:00.000Z' });
    const accepted = createReviewRevision({ revisionId: 'r2', candidateId: source.candidateId, parentRevisionId: 'r1', polygon: [[1, 1], [5, 1], [5, 5]], action: 'accept', reviewState: 'accepted', edgeClipped: true, reviewerId: 'reviewer', reviewedAt: '2026-08-17T00:01:00.000Z' });
    const crown = acceptCrown({ crownId: 'pine-001', sourceImageId: 'target', sourceImageSha256: 'a'.repeat(64), group: null, revisions: [working, accepted] });
    expect(crown.revisionLineage).toEqual(['r1', 'r2']);
    expect(crown.edgeClipped).toBe(true);
    expect(JSON.stringify(source)).toBe(before);
  });

  it('does not duplicate a completed restart stage or lose review counters', () => {
    const initial = { completed: [], attempts: {}, reviewRevisionCount: 17 };
    const once = applyRestartableStage(initial, 'detect', 'manifest-1');
    const twice = applyRestartableStage(once, 'detect', 'manifest-1');
    expect(twice).toBe(once);
    expect(twice.attempts.detect).toBe(1);
    expect(twice.reviewRevisionCount).toBe(17);
  });

  it('retains LV/RV duplicate lineage and reproduces stored results in CSV and GeoJSON', () => {
    const records = deduplicateObservations(fixture.observations as StockObservation[]);
    expect(records).toHaveLength(2);
    expect(records[0].observations).toHaveLength(2);
    expect(records[0].lineage).toEqual(expect.arrayContaining(['LV-C001', 'RV-C004', 'E1', 'E2', 'E3']));
    const csv = exportStockCsv(records);
    const geojson = exportStockGeoJson(records, 'EPSG:32756');
    expect(csv).toContain(records[0].stockId);
    expect(geojson.features[0].properties.heightP99M).toBe(records[0].heightP99M);
    expect(geojson.features[1].properties.missingReason).toBe('no_bounded_neighbourhood_cluster');
  });

  it('pins the validated model and treats HQP recovery counts as regression evidence only', () => {
    expect(() => assertPinnedModel(SAM3_IDENTITY)).not.toThrow();
    expect(() => assertPinnedModel({ ...SAM3_IDENTITY, revision: 'changed' })).toThrow(/drift/);
    expect(fixture.regression_counts).toEqual({ merge_existing_lidar: 8, new_lidar_cluster_review: 20, ambiguous: 4, no_coverage: 130 });
    expect(PINE_STOCKTAKE_CONFIG).toMatchObject({ scoreThreshold: 0.5, maskThreshold: 0.5, agreementIou: 0.7, rayNeighbourhoodRadiusM: 0.75, duplicateRadiusM: 0.5 });
  });
});
