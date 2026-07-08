import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/db', () => ({
  default: {
    $disconnect: vi.fn(),
  },
}));

import {
  buildPineYoloSegCandidates,
  denormalizeYoloSegRow,
  parseYoloSegLabelLine,
} from '@/scripts/pine-yolo-seg-import';

describe('pine YOLO-seg import helpers', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pine-yolo-seg-import-'));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('parses YOLO-seg rows and denormalizes polygons/bboxes against image dimensions', () => {
    const row = parseYoloSegLabelLine(
      '0 0.100000 0.200000 0.300000 0.200000 0.300000 0.500000 0.100000 0.500000',
      'PINE_001.txt:1'
    );

    expect(row).toEqual({
      sourceClassId: '0',
      points: [
        [0.1, 0.2],
        [0.3, 0.2],
        [0.3, 0.5],
        [0.1, 0.5],
      ],
    });
    expect(denormalizeYoloSegRow(row, 1000, 500)).toEqual({
      polygon: [
        [100, 100],
        [300, 100],
        [300, 250],
        [100, 250],
      ],
      bbox: [100, 100, 300, 250],
    });
  });

  it('rejects malformed YOLO-seg rows with clear source context', () => {
    expect(() => parseYoloSegLabelLine('0 0.1 0.2 0.3', 'bad.txt:4')).toThrow(
      'bad.txt:4: YOLO-seg row must contain class plus at least three points'
    );
    expect(() => parseYoloSegLabelLine('0 0.1 0.2 0.3 0.4 0.5 1.2', 'bad.txt:5')).toThrow(
      'bad.txt:5: normalized polygon coordinate is outside 0..1'
    );
  });

  it('builds DINO-compatible candidates by filename stem and collapses to one sanitized class', async () => {
    await fs.writeFile(
      path.join(tempDir, 'PINE_001.txt'),
      [
        '0 0.1 0.2 0.3 0.2 0.3 0.5 0.1 0.5',
        '7 0.4 0.4 0.6 0.4 0.6 0.7 0.4 0.7',
      ].join('\n')
    );

    const built = await buildPineYoloSegCandidates({
      labelsDir: tempDir,
      projectId: 'project-1',
      className: 'Pine Sapling',
      assets: [
        {
          id: 'asset-1',
          fileName: 'PINE_001.JPG',
          imageWidth: 1000,
          imageHeight: 500,
        },
      ],
    });

    expect(built.summary).toMatchObject({
      labelFiles: 1,
      matchedAssets: 1,
      candidates: 2,
      className: 'pine_sapling',
      stemToAssetId: { PINE_001: 'asset-1' },
    });
    expect(built.candidateFile).toMatchObject({
      schemaVersion: 'ag3-dino-candidates/v1',
      projectId: 'project-1',
      className: 'pine_sapling',
    });
    expect(built.candidateFile.candidates).toEqual([
      expect.objectContaining({
        assetId: 'asset-1',
        className: 'pine_sapling',
        confidence: 1,
        bbox: [100, 100, 300, 250],
        polygon: [
          [100, 100],
          [300, 100],
          [300, 250],
          [100, 250],
        ],
      }),
      expect.objectContaining({
        assetId: 'asset-1',
        className: 'pine_sapling',
        confidence: 1,
        bbox: [400, 200, 600, 350],
      }),
    ]);
  });

  it('aborts when the matched asset is missing image dimensions', async () => {
    await fs.writeFile(
      path.join(tempDir, 'PINE_001.txt'),
      '0 0.1 0.2 0.3 0.2 0.3 0.5 0.1 0.5\n'
    );

    await expect(
      buildPineYoloSegCandidates({
        labelsDir: tempDir,
        projectId: 'project-1',
        className: 'pine_sapling',
        assets: [
          {
            id: 'asset-1',
            fileName: 'PINE_001.JPG',
            imageWidth: null,
            imageHeight: 500,
          },
        ],
      })
    ).rejects.toThrow(
      'PINE_001.txt: asset asset-1 (PINE_001.JPG) is missing imageWidth/imageHeight'
    );
  });
});
