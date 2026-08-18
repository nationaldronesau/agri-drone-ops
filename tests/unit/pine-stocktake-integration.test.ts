import { describe, expect, it } from 'vitest';
import fixture from '../fixtures/pine-stocktake/hqp-sealed-small.json';
import {
  SAM3_IDENTITY,
  acceptCrown,
  assertThreeExternalExemplars,
  boundedNeighbourhoodRecovery,
  buildAgreementGroups,
  createReviewRevision,
  deduplicateObservations,
  exportStockCsv,
  exportStockGeoJson,
  fusePerExemplar,
  nativeTiles,
  type FusedCandidate,
  type LidarPoint,
  type ModelCandidate,
  type StockObservation,
} from '@/lib/pine-stocktake/core';
import { buildImmutableManifest, validateMissionFiles, type MissionFileInput } from '@/lib/services/pine-stocktake-jobs';

const hash = (character: string) => character.repeat(64);
const crs = 'EPSG:32756';

function missionFiles(): MissionFileInput[] {
  return [
    { kind: 'IMAGE_LV', assetId: 'lv-001', fileName: 'LV_001.JPG', sha256: hash('1'), cameraSerial: 'LV-SERIAL', crs },
    { kind: 'IMAGE_RV', assetId: 'rv-001', fileName: 'RV_001.JPG', sha256: hash('2'), cameraSerial: 'RV-SERIAL', crs },
    { kind: 'CLC', assetId: 'clc-001', fileName: 'flight.CLC', sha256: hash('3'), crs, metadata: { cameraSerials: ['LV-SERIAL', 'RV-SERIAL'] } },
    { kind: 'CLI', assetId: 'cli-001', fileName: 'flight.CLI', sha256: hash('4'), crs, metadata: { quaternion: [1, 0, 0, 0], translation: [0, 0, 0] } },
    { kind: 'MRK', assetId: 'mrk-001', fileName: 'flight.MRK', sha256: hash('5'), poseIdentity: 'flight-2026-08-17', timebase: 'GPS', crs },
    { kind: 'RPOS', assetId: 'rpos-001', fileName: 'flight.RPOS', sha256: hash('6'), poseIdentity: 'flight-2026-08-17', timebase: 'GPS', crs },
    { kind: 'LIDAR_LAZ', assetId: 'laz-001', fileName: 'flight.LAZ', sha256: hash('7'), crs },
  ];
}

function prediction(id: string, exemplarId: string, score: number): ModelCandidate {
  const tile = nativeTiles(6144, 4096)[0];
  return {
    candidateId: id,
    exemplarId,
    targetImageId: 'lv-001',
    targetImageSha256: fixture.images[0].sha256,
    tile,
    score,
    mask: { width: 1024, height: 1024, active: [210 * 1024 + 270, 210 * 1024 + 271, 210 * 1024 + 272, 211 * 1024 + 270, 211 * 1024 + 271, 211 * 1024 + 272, 212 * 1024 + 270, 212 * 1024 + 271, 212 * 1024 + 272] },
    polygon: [[270, 210], [360, 210], [365, 300], [265, 300]],
    modelResultSha256: hash(id === 'candidate-e1' ? '8' : id === 'candidate-e2' ? '9' : 'a'),
  };
}

describe('sealed HQP Pine Stocktake operator journey', () => {
  it('validates, detects independently, reviews, maps with LiDAR and reproduces exports', () => {
    const files = missionFiles();
    expect(validateMissionFiles(files, 'GPS')).toEqual({ imageCount: 2, targetCrs: crs });
    const manifest = buildImmutableManifest({
      projectId: 'hqp-project', teamId: 'hqp-team', createdById: 'reviewer-1', files,
      latitude: -27.47, longitude: 153.03, poseTimebase: 'GPS',
    });
    expect(manifest.manifest.model).toEqual(SAM3_IDENTITY);
    expect(manifest.sha256).toMatch(/^[a-f0-9]{64}$/);

    const exemplars = ['e1', 'e2', 'e3'].map((id, index) => ({
      id, sourceImageId: `external-${index + 1}`, sourceImageSha256: hash(String(index + 3)),
      polygon: [[100, 100], [180, 100], [180, 185], [100, 185]] as const, approved: true,
    }));
    expect(() => assertThreeExternalExemplars(exemplars, 'lv-001')).not.toThrow();

    const separated = Object.fromEntries(exemplars.map((exemplar, index) => {
      const model = prediction(`candidate-e${index + 1}`, exemplar.id, 0.91 - index * 0.03);
      return [exemplar.id, fusePerExemplar([model]).kept];
    })) as Record<string, FusedCandidate[]>;
    const groups = buildAgreementGroups(separated);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ agreementLevel: 3, exemplarIds: ['e1', 'e2', 'e3'] });

    const working = createReviewRevision({
      revisionId: 'review-1', candidateId: groups[0].representativeCandidateId, parentRevisionId: null,
      polygon: groups[0].polygon, action: 'adjust', reviewState: 'working', edgeClipped: false, reviewerId: 'reviewer-1',
    });
    const acceptedRevision = createReviewRevision({
      revisionId: 'review-2', candidateId: groups[0].representativeCandidateId, parentRevisionId: 'review-1',
      polygon: [[268, 208], [362, 208], [367, 302], [263, 302]], action: 'accept', reviewState: 'accepted',
      edgeClipped: false, reviewerId: 'reviewer-1',
    });
    const accepted = acceptCrown({ crownId: 'LV-C001', sourceImageId: 'lv-001', sourceImageSha256: fixture.images[0].sha256, group: groups[0], revisions: [working, acceptedRevision] });
    expect(accepted.revisionLineage).toEqual(['review-1', 'review-2']);
    expect(accepted.contributingExemplarIds).toEqual(['e1', 'e2', 'e3']);

    const points: LidarPoint[] = Array.from({ length: 18 }, (_, index) => ({
      id: `lidar-${index}`, x: 500000.08 + (index % 3) * 0.02, y: 7000000.08 + Math.floor(index / 3) * 0.01,
      z: 70.88 + index * 0.006, hag: 0.78 + index * 0.006, classification: 4,
    }));
    const recovered = boundedNeighbourhoodRecovery(points, [499999.8, 7000000.1], [500000.5, 7000000.1], [{ crownId: 'existing-lidar-1', x: 500000.1, y: 7000000.1 }]);
    expect(recovered.recovery).toBe('merge_existing');
    expect(recovered.association.status).toBe('matched');

    const records = deduplicateObservations(fixture.observations as StockObservation[]);
    expect(records).toHaveLength(2);
    expect(records[0].observations.map((item) => item.sourceImageId).sort()).toEqual(['lv-001', 'rv-001']);
    expect(records[1].missingReason).toBe('no_bounded_neighbourhood_cluster');
    const csv = exportStockCsv(records);
    const geojson = exportStockGeoJson(records, manifest.targetCrs);
    expect(csv.split('\n')[0]).toContain('height_p99_m');
    expect(csv).toContain('no_bounded_neighbourhood_cluster');
    expect(geojson.features.map((feature) => feature.properties.stockId)).toEqual(records.map((record) => record.stockId));
    expect(fixture.regression_counts).toEqual({ merge_existing_lidar: 8, new_lidar_cluster_review: 20, ambiguous: 4, no_coverage: 130 });
  });

  it('blocks calibration serial drift before mapping', () => {
    const files = missionFiles();
    const clc = files.find((file) => file.kind === 'CLC')!;
    clc.metadata = { cameraSerials: ['OTHER-CAMERA'] };
    expect(() => validateMissionFiles(files, 'GPS')).toThrow(/camera serial mismatch/);
  });
});
