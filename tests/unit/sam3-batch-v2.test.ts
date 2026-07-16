import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import sharp from 'sharp';
import { configureSam3BatchV2Queue } from '@/lib/queue/batch-queue-v2';
import {
  buildBatchV2ConceptApplyOptions,
  buildBatchV2ConceptFallbackApplyOptions,
  estimatePeakGpuMemoryMb,
  filterBatchV2ConceptDetections,
  getBatchV2MaxTargetCandidates,
  getBatchV2MinTargetCandidates,
  getGpuAdmissionCropCount,
  resolveBatchV2VegetationPrior,
  resolveBatchV2ReviewProfileForMode,
  Sam3BatchV2Service,
} from '@/lib/services/sam3-batch-v2';

describe('sam3-batch-v2', () => {
  const originalFetch = global.fetch;
  const makeConceptDetection = (index: number, similarity = 0.82) => ({
    bbox: [index * 10, 10, index * 10 + 6, 18] as [number, number, number, number],
    confidence: similarity,
    similarity,
    polygon: [
      [index * 10, 10],
      [index * 10 + 6, 10],
      [index * 10 + 6, 18],
      [index * 10, 18],
    ] as [number, number][],
    class_name: 'pine sapling',
  });
  const makeVegetationImage = async (
    width: number,
    height: number,
    greenRectangles: Array<{ left: number; top: number; width: number; height: number }>
  ) => {
    const pixels = Buffer.alloc(width * height * 3);
    for (let index = 0; index < width * height; index += 1) {
      pixels[index * 3] = 140;
      pixels[index * 3 + 1] = 90;
      pixels[index * 3 + 2] = 40;
    }
    for (const rectangle of greenRectangles) {
      for (let y = rectangle.top; y < rectangle.top + rectangle.height; y += 1) {
        for (let x = rectangle.left; x < rectangle.left + rectangle.width; x += 1) {
          const offset = (y * width + x) * 3;
          pixels[offset] = 20;
          pixels[offset + 1] = 180;
          pixels[offset + 2] = 20;
        }
      }
    }
    return sharp(pixels, { raw: { width, height, channels: 3 } }).png().toBuffer();
  };

  beforeEach(() => {
    global.fetch = vi.fn().mockImplementation(async () =>
      new Response(Buffer.from('image-bytes'), {
        status: 200,
        headers: {
          'content-type': 'image/jpeg',
          'content-length': '11',
        },
      })
    ) as typeof fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('retries GPU lock acquisition and succeeds when the lock clears quickly', async () => {
    let nowMs = 0;
    const acquireGpuLock = vi
      .fn()
      .mockResolvedValueOnce({ acquired: false, token: null })
      .mockResolvedValueOnce({ acquired: false, token: null })
      .mockResolvedValueOnce({ acquired: true, token: 'gpu-token' });
    const service = new Sam3BatchV2Service({
      prisma: {} as never,
      awsSam3Service: {} as never,
      acquireGpuLock,
      refreshGpuLock: vi.fn(),
      releaseGpuLock: vi.fn(),
      sleep: async (ms) => {
        nowMs += ms;
      },
      now: () => new Date(nowMs),
    });

    const result = await (service as any).acquireGpuLockWithRetry();

    expect(result).toEqual({ acquired: true, token: 'gpu-token' });
    expect(acquireGpuLock).toHaveBeenCalledTimes(3);
  });

  it('rejects with GPU busy after 60 seconds of lock retries', async () => {
    let nowMs = 0;
    const service = new Sam3BatchV2Service({
      prisma: {} as never,
      awsSam3Service: {} as never,
      acquireGpuLock: vi.fn().mockResolvedValue({ acquired: false, token: null }),
      refreshGpuLock: vi.fn(),
      releaseGpuLock: vi.fn(),
      sleep: async (ms) => {
        nowMs += ms;
      },
      now: () => new Date(nowMs),
    });

    const result = await (service as any).acquireGpuLockWithRetry();

    expect(result).toEqual({
      acquired: false,
      token: null,
      errorCode: 'GPU_BUSY',
      errorMessage: 'GPU busy (held by another process), retry later.',
    });
    expect((service as any).acquireGpuLock).toHaveBeenCalledTimes(12);
  });

  it('filters concept candidates with the v2 similarity floor before target refinement', () => {
    const options = buildBatchV2ConceptApplyOptions();
    const detections = filterBatchV2ConceptDetections(
      [
        {
          bbox: [1, 1, 10, 10],
          confidence: 0.91,
          similarity: 0.62,
          class_name: 'pine sapling',
        },
        {
          bbox: [20, 20, 40, 40],
          confidence: 0.72,
          similarity: 0.87,
          class_name: 'pine sapling',
        },
      ] as any,
      options
    );

    expect(options).toMatchObject({
      returnPolygons: true,
      similarityThreshold: 0.65,
      topK: 120,
      minBoxSize: 16,
      maxBoxSize: 600,
      nmsThreshold: 0.5,
    });
    expect(detections).toHaveLength(1);
    expect(detections[0].bbox).toEqual([20, 20, 40, 40]);
  });

  it('does not reject concept propagation using visual-crop memory estimates', () => {
    const conceptAdmissionCropCount = getGpuAdmissionCropCount('concept_propagation', 10);
    const visualAdmissionCropCount = getGpuAdmissionCropCount('visual_crop_match', 10);

    expect(conceptAdmissionCropCount).toBe(1);
    expect(estimatePeakGpuMemoryMb(conceptAdmissionCropCount)).toMatchObject({
      estimatedMemoryMb: 4608,
      overBudget: false,
    });
    expect(estimatePeakGpuMemoryMb(visualAdmissionCropCount)).toMatchObject({
      estimatedMemoryMb: 12800,
      overBudget: true,
    });
  });

  it('uses a high-recall review profile for dataset concept propagation', () => {
    const profile = resolveBatchV2ReviewProfileForMode('concept_propagation');
    const options = buildBatchV2ConceptApplyOptions(profile);
    const fallbackOptions = buildBatchV2ConceptFallbackApplyOptions(profile);

    expect(profile).toBe('high_recall');
    expect(options).toMatchObject({
      returnPolygons: true,
      similarityThreshold: 0.75,
      topK: 180,
    });
    expect(fallbackOptions).toMatchObject({
      returnPolygons: true,
      similarityThreshold: 0.65,
      topK: 120,
    });
    expect(getBatchV2MinTargetCandidates(profile)).toBe(50);
    expect(getBatchV2MaxTargetCandidates(profile)).toBe(180);
  });

  it('defaults the vegetation prior on and honors both rollback switches', () => {
    expect(resolveBatchV2VegetationPrior(undefined, undefined)).toBe(true);
    expect(resolveBatchV2VegetationPrior(false, undefined)).toBe(false);
    expect(resolveBatchV2VegetationPrior(true, 'false')).toBe(false);
  });

  it('gates dirt candidates, recentres a green candidate, and post-gates a dirt mask', async () => {
    const image = await makeVegetationImage(120, 80, [
      { left: 16, top: 0, width: 24, height: 40 },
    ]);
    const segment = vi.fn().mockResolvedValue({
      success: true,
      response: {
        detections: [
          {
            bbox: [8, 0, 48, 40],
            confidence: 0.95,
            polygon: [[8, 0], [15, 0], [15, 40], [8, 40]],
          },
          {
            bbox: [8, 0, 48, 40],
            confidence: 0.91,
            polygon: [[16, 0], [40, 0], [40, 40], [16, 40]],
          },
        ],
        count: 2,
      },
    });
    const service = new Sam3BatchV2Service({
      prisma: {} as never,
      awsSam3Service: {
        refreshStatus: vi.fn().mockResolvedValue({
          modelLoaded: true,
          instanceState: 'ready',
          ipAddress: '127.0.0.1',
        }),
        isReady: vi.fn().mockReturnValue(true),
        resizeImage: vi.fn().mockImplementation(async (buffer: Buffer) => ({
          buffer,
          scaling: { scaleFactor: 1 },
        })),
        segment,
      } as any,
      acquireGpuLock: vi.fn(),
      refreshGpuLock: vi.fn(),
      releaseGpuLock: vi.fn(),
      sleep: vi.fn(),
      now: () => new Date('2026-07-16T00:00:00.000Z'),
    });

    const result = await (service as any).refineConceptDetectionsWithBoxPrompts(
      {
        id: 'asset-vegetation',
        imageWidth: 120,
        imageHeight: 80,
      },
      image,
      'Pine Sapling',
      [
        {
          bbox: [0, 0, 40, 40],
          confidence: 0.88,
          similarity: 0.88,
          class_name: 'pine sapling',
        },
        {
          bbox: [70, 0, 110, 40],
          confidence: 0.86,
          similarity: 0.86,
          class_name: 'pine sapling',
        },
      ],
      { enabled: true, exemplarGreenMedian: 0.8 }
    );

    expect(segment).toHaveBeenCalledWith(expect.objectContaining({
      boxes: [{ x1: 8, y1: 0, x2: 48, y2: 40 }],
      className: 'Pine Sapling',
    }));
    expect(result).toMatchObject({
      candidateCount: 2,
      refinementBoxCount: 1,
      refinementDetectionCount: 2,
      vegetationThreshold: 0.4,
      vegetationGatedCandidates: 1,
      vegetationRecenteredCandidates: 1,
      vegetationGatedMasks: 1,
      vegetationDeduplicatedMasks: 0,
      maskGreenFractionMedian: 1,
    });
    expect(result.detections).toHaveLength(1);
    expect(result.detections[0].polygon).toEqual([[16, 0], [40, 0], [40, 40], [16, 40]]);
  });

  it('deduplicates overlapping green masks and keeps the higher-confidence detection', async () => {
    const image = await makeVegetationImage(80, 80, [
      { left: 0, top: 0, width: 80, height: 80 },
    ]);
    const segment = vi.fn().mockResolvedValue({
      success: true,
      response: {
        detections: [
          {
            bbox: [10, 10, 50, 50],
            confidence: 0.95,
            polygon: [[10, 10], [50, 10], [50, 50], [10, 50]],
          },
          {
            bbox: [20, 10, 60, 50],
            confidence: 0.95,
            polygon: [[15, 10], [55, 10], [55, 50], [15, 50]],
          },
        ],
        count: 2,
      },
    });
    const service = new Sam3BatchV2Service({
      prisma: {} as never,
      awsSam3Service: {
        refreshStatus: vi.fn().mockResolvedValue({
          modelLoaded: true,
          instanceState: 'ready',
          ipAddress: '127.0.0.1',
        }),
        isReady: vi.fn().mockReturnValue(true),
        resizeImage: vi.fn().mockImplementation(async (buffer: Buffer) => ({
          buffer,
          scaling: { scaleFactor: 1 },
        })),
        segment,
      } as any,
      acquireGpuLock: vi.fn(),
      refreshGpuLock: vi.fn(),
      releaseGpuLock: vi.fn(),
      sleep: vi.fn(),
      now: () => new Date('2026-07-16T00:00:00.000Z'),
    });

    const result = await (service as any).refineConceptDetectionsWithBoxPrompts(
      { id: 'asset-dedup', imageWidth: 80, imageHeight: 80 },
      image,
      'Pine Sapling',
      [
        { bbox: [10, 10, 50, 50], confidence: 0.7, similarity: 0.7, class_name: 'pine' },
        { bbox: [20, 10, 60, 50], confidence: 0.9, similarity: 0.9, class_name: 'pine' },
      ],
      { enabled: true, exemplarGreenMedian: 1 }
    );

    expect(result.vegetationDeduplicatedMasks).toBe(1);
    expect(result.detections).toHaveLength(1);
    expect(result.detections[0]).toMatchObject({
      confidence: 0.9,
      similarity: 0.9,
      bbox: [20, 10, 60, 50],
    });
  });

  it('leaves candidates and refined masks untouched when vegetationPrior is false', async () => {
    const segment = vi.fn().mockResolvedValue({
      success: true,
      response: {
        detections: [
          { bbox: [0, 0, 40, 40], confidence: 0.9, polygon: [[0, 0], [40, 0], [40, 40], [0, 40]] },
          { bbox: [5, 0, 45, 40], confidence: 0.8, polygon: [[5, 0], [45, 0], [45, 40], [5, 40]] },
        ],
        count: 2,
      },
    });
    const service = new Sam3BatchV2Service({
      prisma: {} as never,
      awsSam3Service: {
        refreshStatus: vi.fn().mockResolvedValue({
          modelLoaded: true,
          instanceState: 'ready',
          ipAddress: '127.0.0.1',
        }),
        isReady: vi.fn().mockReturnValue(true),
        resizeImage: vi.fn().mockImplementation(async (buffer: Buffer) => ({
          buffer,
          scaling: { scaleFactor: 1 },
        })),
        segment,
      } as any,
      acquireGpuLock: vi.fn(),
      refreshGpuLock: vi.fn(),
      releaseGpuLock: vi.fn(),
      sleep: vi.fn(),
      now: () => new Date('2026-07-16T00:00:00.000Z'),
    });
    const candidates = [
      { bbox: [0, 0, 40, 40], confidence: 0.8, similarity: 0.8, class_name: 'pine' },
      { bbox: [5, 0, 45, 40], confidence: 0.7, similarity: 0.7, class_name: 'pine' },
    ];

    const result = await (service as any).refineConceptDetectionsWithBoxPrompts(
      { id: 'asset-off', imageWidth: 80, imageHeight: 80 },
      Buffer.from('not-an-image'),
      'Pine Sapling',
      candidates,
      { enabled: false, exemplarGreenMedian: 1 }
    );

    expect(segment.mock.calls[0][0].boxes).toEqual([
      { x1: 0, y1: 0, x2: 40, y2: 40 },
      { x1: 5, y1: 0, x2: 45, y2: 40 },
    ]);
    expect(result.detections).toHaveLength(2);
    expect(result.vegetationGatedCandidates).toBeUndefined();
    expect(result.vegetationGatedMasks).toBeUndefined();
    expect(result.vegetationDeduplicatedMasks).toBeUndefined();
  });

  it('persists the calibrated exemplar green median in the prepare stage log', async () => {
    const image = await makeVegetationImage(100, 100, [
      { left: 10, top: 10, width: 20, height: 20 },
    ]);
    global.fetch = vi.fn().mockResolvedValue(new Response(image, {
      status: 200,
      headers: {
        'content-type': 'image/png',
        'content-length': String(image.length),
      },
    })) as typeof fetch;
    let persistedStageLog: unknown[] = [];
    const service = new Sam3BatchV2Service({
      prisma: {
        batchJob: {
          findUnique: vi.fn().mockResolvedValue({
            parentBatchJobId: null,
            sourceAssetId: 'asset-source',
          }),
          update: vi.fn().mockImplementation(async ({ data }) => {
            if (data.stageLog) persistedStageLog = data.stageLog;
          }),
        },
        asset: {
          findMany: vi.fn().mockResolvedValue([{
            id: 'asset-source',
            storageUrl: 'http://localhost/source.png',
            s3Key: null,
            s3Bucket: null,
            storageType: 'local',
            imageWidth: 100,
            imageHeight: 100,
          }]),
          findUnique: vi.fn(),
        },
      } as any,
      awsSam3Service: {} as never,
      acquireGpuLock: vi.fn(),
      refreshGpuLock: vi.fn(),
      releaseGpuLock: vi.fn(),
      sleep: vi.fn(),
      now: () => new Date('2026-07-16T00:00:00.000Z'),
    });
    const stageLog: unknown[] = [];

    const prepared = await (service as any).prepareBatch(
      {
        batchJobId: 'batch-calibration',
        projectId: 'project-1',
        weedType: 'Pine Sapling',
        mode: 'concept_propagation',
        exemplars: [{ x1: 10, y1: 10, x2: 30, y2: 30 }],
        exemplarSourceWidth: 100,
        exemplarSourceHeight: 100,
        sourceAssetId: 'asset-source',
        assetIds: ['asset-source'],
        vegetationPrior: true,
      },
      0,
      stageLog
    );

    expect(prepared.exemplarGreenMedian).toBe(1);
    expect(persistedStageLog).toEqual(expect.arrayContaining([
      expect.objectContaining({
        stage: 'prepare',
        status: 'completed',
        vegetationPrior: true,
        exemplarGreenMedian: 1,
      }),
    ]));
  });

  it('warns when a surviving asset has a low median mask green fraction', async () => {
    const image = await makeVegetationImage(100, 100, [
      { left: 0, top: 0, width: 20, height: 100 },
    ]);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const service = new Sam3BatchV2Service({
      prisma: {} as never,
      awsSam3Service: {} as never,
      acquireGpuLock: vi.fn(),
      refreshGpuLock: vi.fn(),
      releaseGpuLock: vi.fn(),
      sleep: vi.fn(),
      now: () => new Date('2026-07-16T00:00:00.000Z'),
    });

    const result = await (service as any).applyVegetationMaskHygiene(
      'asset-low-green',
      image,
      [{
        bbox: [0, 0, 100, 100],
        polygon: [[0, 0], [100, 0], [100, 100], [0, 100]],
        confidence: 0.9,
      }],
      100,
      100,
      0.15
    );

    expect(result.median).toBeCloseTo(0.2, 2);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('[SAM3 V2] VEGETATION_ALARM asset=asset-low-green')
    );
  });

  it('falls back to lower-confidence target candidates when strict matching returns zero', async () => {
    const applyConceptExemplar = vi
      .fn()
      .mockResolvedValueOnce({
        success: true,
        data: {
          detections: [],
          processingTimeMs: 8,
        },
      })
      .mockResolvedValueOnce({
        success: true,
        data: {
          detections: [
            {
              bbox: [20, 25, 40, 45],
              confidence: 0.59,
              similarity: 0.56,
              polygon: [
                [20, 25],
                [40, 25],
                [40, 45],
                [20, 45],
              ],
              class_name: 'pine sapling',
            },
          ],
          processingTimeMs: 11,
        },
      });
    const segment = vi.fn().mockResolvedValue({
      success: true,
      response: {
        detections: [
          {
            bbox: [20, 25, 40, 45],
            confidence: 0.91,
            polygon: [
              [21, 25],
              [39, 25],
              [39, 44],
              [21, 44],
            ],
          },
        ],
        count: 1,
      },
    });
    const service = new Sam3BatchV2Service({
      prisma: {} as never,
      awsSam3Service: {
        applyConceptExemplar,
        refreshStatus: vi.fn().mockResolvedValue({
          modelLoaded: true,
          instanceState: 'ready',
          ipAddress: '127.0.0.1',
        }),
        isReady: vi.fn().mockReturnValue(true),
        resizeImage: vi.fn().mockImplementation(async (imageBuffer: Buffer) => ({
          buffer: imageBuffer,
          scaling: { scaleFactor: 1 },
        })),
        segment,
      } as any,
      acquireGpuLock: vi.fn(),
      refreshGpuLock: vi.fn(),
      releaseGpuLock: vi.fn(),
      sleep: vi.fn(),
      now: () => new Date('2026-03-31T00:00:00.000Z'),
    });

    const result = await (service as any).runVisualConceptMatch(
      {
        id: 'asset-target',
        storageUrl: 'http://localhost/asset-target.jpg',
        s3Key: null,
        s3Bucket: null,
        storageType: 'local',
        imageWidth: 4000,
        imageHeight: 3000,
      },
      Buffer.from('target-image'),
      'visual-exemplar-1',
      'Pine Sapling'
    );

    expect(applyConceptExemplar).toHaveBeenCalledTimes(2);
    expect(applyConceptExemplar).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        options: expect.objectContaining({
          similarityThreshold: 0.65,
          topK: 120,
        }),
      })
    );
    expect(applyConceptExemplar).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        options: expect.objectContaining({
          similarityThreshold: 0.5,
          topK: 40,
        }),
      })
    );
    expect(buildBatchV2ConceptFallbackApplyOptions()).toMatchObject({
      returnPolygons: true,
      similarityThreshold: 0.5,
      topK: 40,
    });
    expect(segment).toHaveBeenCalledWith(
      expect.objectContaining({
        boxes: [{ x1: 20, y1: 25, x2: 40, y2: 45 }],
        className: 'Pine Sapling',
      })
    );
    expect(result).toMatchObject({
      assetId: 'asset-target',
      outcome: 'success',
      candidateExpansionUsed: true,
      detections: [
        {
          bbox: [20, 25, 40, 45],
          confidence: 0.56,
          similarity: 0.56,
        },
      ],
    });
  });

  it('broadens target matching when strict matching returns too few candidates', async () => {
    const applyConceptExemplar = vi
      .fn()
      .mockResolvedValueOnce({
        success: true,
        data: {
          detections: [
            {
              bbox: [20, 25, 40, 45],
              confidence: 0.82,
              similarity: 0.82,
              polygon: [
                [20, 25],
                [40, 25],
                [40, 45],
                [20, 45],
              ],
              class_name: 'pine sapling',
            },
          ],
          processingTimeMs: 8,
        },
      })
      .mockResolvedValueOnce({
        success: true,
        data: {
          detections: [
            {
              bbox: [20, 25, 40, 45],
              confidence: 0.61,
              similarity: 0.61,
              polygon: [
                [20, 25],
                [40, 25],
                [40, 45],
                [20, 45],
              ],
              class_name: 'pine sapling',
            },
            {
              bbox: [80, 90, 110, 120],
              confidence: 0.55,
              similarity: 0.55,
              polygon: [
                [80, 90],
                [110, 90],
                [110, 120],
                [80, 120],
              ],
              class_name: 'pine sapling',
            },
          ],
          processingTimeMs: 11,
        },
      });
    const segment = vi.fn().mockResolvedValue({
      success: true,
      response: {
        detections: [
          {
            bbox: [20, 25, 40, 45],
            confidence: 0.92,
            polygon: [
              [20, 25],
              [40, 25],
              [40, 45],
              [20, 45],
            ],
          },
          {
            bbox: [80, 90, 110, 120],
            confidence: 0.88,
            polygon: [
              [80, 90],
              [110, 90],
              [110, 120],
              [80, 120],
            ],
          },
        ],
        count: 2,
      },
    });
    const service = new Sam3BatchV2Service({
      prisma: {} as never,
      awsSam3Service: {
        applyConceptExemplar,
        refreshStatus: vi.fn().mockResolvedValue({
          modelLoaded: true,
          instanceState: 'ready',
          ipAddress: '127.0.0.1',
        }),
        isReady: vi.fn().mockReturnValue(true),
        resizeImage: vi.fn().mockImplementation(async (imageBuffer: Buffer) => ({
          buffer: imageBuffer,
          scaling: { scaleFactor: 1 },
        })),
        segment,
      } as any,
      acquireGpuLock: vi.fn(),
      refreshGpuLock: vi.fn(),
      releaseGpuLock: vi.fn(),
      sleep: vi.fn(),
      now: () => new Date('2026-03-31T00:00:00.000Z'),
    });

    const result = await (service as any).runVisualConceptMatch(
      {
        id: 'asset-target',
        storageUrl: 'http://localhost/asset-target.jpg',
        s3Key: null,
        s3Bucket: null,
        storageType: 'local',
        imageWidth: 4000,
        imageHeight: 3000,
      },
      Buffer.from('target-image'),
      'visual-exemplar-1',
      'Pine Sapling'
    );

    expect(applyConceptExemplar).toHaveBeenCalledTimes(2);
    expect(segment).toHaveBeenCalledWith(
      expect.objectContaining({
        boxes: [
          { x1: 20, y1: 25, x2: 40, y2: 45 },
          { x1: 80, y1: 90, x2: 110, y2: 120 },
        ],
        className: 'Pine Sapling',
      })
    );
    expect(result).toMatchObject({
      assetId: 'asset-target',
      outcome: 'success',
      candidateExpansionUsed: true,
      detections: [
        {
          bbox: [20, 25, 40, 45],
          confidence: 0.82,
          similarity: 0.82,
        },
        {
          bbox: [80, 90, 110, 120],
          confidence: 0.55,
          similarity: 0.55,
        },
      ],
    });
  });

  it('broadens dataset propagation with the high-recall review profile', async () => {
    const applyConceptExemplar = vi
      .fn()
      .mockResolvedValueOnce({
        success: true,
        data: {
          detections: [
            {
              bbox: [20, 25, 40, 45],
              confidence: 0.82,
              similarity: 0.82,
              polygon: [
                [20, 25],
                [40, 25],
                [40, 45],
                [20, 45],
              ],
              class_name: 'pine sapling',
            },
          ],
          processingTimeMs: 8,
        },
      })
      .mockResolvedValueOnce({
        success: true,
        data: {
          detections: [
            {
              bbox: [80, 90, 110, 120],
              confidence: 0.68,
              similarity: 0.68,
              polygon: [
                [80, 90],
                [110, 90],
                [110, 120],
                [80, 120],
              ],
              class_name: 'pine sapling',
            },
          ],
          processingTimeMs: 11,
        },
      });
    const segment = vi.fn().mockResolvedValue({
      success: true,
      response: {
        detections: [
          {
            bbox: [20, 25, 40, 45],
            confidence: 0.92,
            polygon: [
              [20, 25],
              [40, 25],
              [40, 45],
              [20, 45],
            ],
          },
          {
            bbox: [80, 90, 110, 120],
            confidence: 0.88,
            polygon: [
              [80, 90],
              [110, 90],
              [110, 120],
              [80, 120],
            ],
          },
        ],
        count: 2,
      },
    });
    const service = new Sam3BatchV2Service({
      prisma: {} as never,
      awsSam3Service: {
        applyConceptExemplar,
        refreshStatus: vi.fn().mockResolvedValue({
          modelLoaded: true,
          instanceState: 'ready',
          ipAddress: '127.0.0.1',
        }),
        isReady: vi.fn().mockReturnValue(true),
        resizeImage: vi.fn().mockImplementation(async (imageBuffer: Buffer) => ({
          buffer: imageBuffer,
          scaling: { scaleFactor: 1 },
        })),
        segment,
      } as any,
      acquireGpuLock: vi.fn(),
      refreshGpuLock: vi.fn(),
      releaseGpuLock: vi.fn(),
      sleep: vi.fn(),
      now: () => new Date('2026-03-31T00:00:00.000Z'),
    });

    const result = await (service as any).runConceptPropagation(
      {
        id: 'asset-target',
        storageUrl: 'http://localhost/asset-target.jpg',
        s3Key: null,
        s3Bucket: null,
        storageType: 'local',
        imageWidth: 4000,
        imageHeight: 3000,
      },
      Buffer.from('target-image'),
      'concept-exemplar-1',
      'Pine Sapling'
    );

    expect(applyConceptExemplar).toHaveBeenCalledTimes(2);
    expect(applyConceptExemplar).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        options: expect.objectContaining({
          similarityThreshold: 0.75,
          topK: 180,
        }),
      })
    );
    expect(applyConceptExemplar).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        options: expect.objectContaining({
          similarityThreshold: 0.65,
          topK: 120,
        }),
      })
    );
    expect(segment).toHaveBeenCalledWith(
      expect.objectContaining({
        boxes: [
          { x1: 20, y1: 25, x2: 40, y2: 45 },
          { x1: 80, y1: 90, x2: 110, y2: 120 },
        ],
        className: 'Pine Sapling',
      })
    );
    expect(result).toMatchObject({
      assetId: 'asset-target',
      outcome: 'success',
      candidateExpansionUsed: true,
      detections: [
        {
          bbox: [20, 25, 40, 45],
          confidence: 0.82,
          similarity: 0.82,
        },
        {
          bbox: [80, 90, 110, 120],
          confidence: 0.68,
          similarity: 0.68,
        },
      ],
    });
  });

  it('merges candidates from each source-box concept exemplar before refinement', async () => {
    const firstExemplarCandidates = Array.from({ length: 30 }, (_, index) =>
      makeConceptDetection(index, 0.84)
    );
    const secondExemplarCandidates = Array.from({ length: 30 }, (_, index) =>
      makeConceptDetection(index + 30, 0.83)
    );
    const applyConceptExemplar = vi
      .fn()
      .mockResolvedValueOnce({
        success: true,
        data: {
          detections: firstExemplarCandidates,
          processingTimeMs: 8,
        },
      })
      .mockResolvedValueOnce({
        success: true,
        data: {
          detections: secondExemplarCandidates,
          processingTimeMs: 9,
        },
      });
    const segment = vi.fn().mockResolvedValue({
      success: true,
      response: {
        detections: [
          {
            bbox: [0, 10, 6, 18],
            confidence: 0.92,
            polygon: [
              [0, 10],
              [6, 10],
              [6, 18],
              [0, 18],
            ],
          },
          {
            bbox: [300, 10, 306, 18],
            confidence: 0.88,
            polygon: [
              [300, 10],
              [306, 10],
              [306, 18],
              [300, 18],
            ],
          },
        ],
        count: 2,
      },
    });
    const service = new Sam3BatchV2Service({
      prisma: {} as never,
      awsSam3Service: {
        applyConceptExemplar,
        refreshStatus: vi.fn().mockResolvedValue({
          modelLoaded: true,
          instanceState: 'ready',
          ipAddress: '127.0.0.1',
        }),
        isReady: vi.fn().mockReturnValue(true),
        resizeImage: vi.fn().mockImplementation(async (imageBuffer: Buffer) => ({
          buffer: imageBuffer,
          scaling: { scaleFactor: 1 },
        })),
        segment,
      } as any,
      acquireGpuLock: vi.fn(),
      refreshGpuLock: vi.fn(),
      releaseGpuLock: vi.fn(),
      sleep: vi.fn(),
      now: () => new Date('2026-03-31T00:00:00.000Z'),
    });

    const result = await (service as any).runConceptPropagation(
      {
        id: 'asset-target',
        storageUrl: 'http://localhost/asset-target.jpg',
        s3Key: null,
        s3Bucket: null,
        storageType: 'local',
        imageWidth: 4000,
        imageHeight: 3000,
      },
      Buffer.from('target-image'),
      [
        { exemplarId: 'concept-exemplar-source-box-1', sourceBoxIndex: 0 },
        { exemplarId: 'concept-exemplar-source-box-2', sourceBoxIndex: 1 },
      ],
      'Pine Sapling'
    );

    expect(applyConceptExemplar).toHaveBeenCalledTimes(2);
    expect(applyConceptExemplar).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        exemplarId: 'concept-exemplar-source-box-1',
      })
    );
    expect(applyConceptExemplar).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        exemplarId: 'concept-exemplar-source-box-2',
      })
    );
    expect(segment).toHaveBeenCalledWith(
      expect.objectContaining({
        boxes: expect.arrayContaining([
          { x1: 0, y1: 10, x2: 6, y2: 18 },
          { x1: 300, y1: 10, x2: 306, y2: 18 },
        ]),
        className: 'Pine Sapling',
      })
    );
    expect(segment.mock.calls[0][0].boxes).toHaveLength(60);
    expect(result).toMatchObject({
      assetId: 'asset-target',
      outcome: 'success',
      backendMode: 'concept_ensemble_refined',
      candidateExpansionUsed: false,
      candidateCount: 60,
      detections: [
        {
          bbox: [0, 10, 6, 18],
          confidence: 0.84,
          similarity: 0.84,
        },
        {
          bbox: [300, 10, 306, 18],
          confidence: 0.83,
          similarity: 0.83,
        },
      ],
    });
  });

  it('saves concept candidate polygons for review when box refinement fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const candidates = Array.from({ length: 50 }, (_, index) =>
      makeConceptDetection(index, 0.84)
    );
    const applyConceptExemplar = vi.fn().mockResolvedValue({
      success: true,
      data: {
        detections: candidates,
        processingTimeMs: 8,
      },
    });
    const segment = vi.fn().mockResolvedValue({
      success: false,
      response: null,
      error: 'SAM3 API error: 500 - Internal Server Error',
      errorCode: 'API_ERROR',
    });
    const service = new Sam3BatchV2Service({
      prisma: {} as never,
      awsSam3Service: {
        applyConceptExemplar,
        refreshStatus: vi.fn().mockResolvedValue({
          modelLoaded: true,
          instanceState: 'ready',
          ipAddress: '127.0.0.1',
        }),
        isReady: vi.fn().mockReturnValue(true),
        resizeImage: vi.fn().mockImplementation(async (imageBuffer: Buffer) => ({
          buffer: imageBuffer,
          scaling: { scaleFactor: 1 },
        })),
        segment,
      } as any,
      acquireGpuLock: vi.fn(),
      refreshGpuLock: vi.fn(),
      releaseGpuLock: vi.fn(),
      sleep: vi.fn(),
      now: () => new Date('2026-03-31T00:00:00.000Z'),
    });

    const result = await (service as any).runConceptPropagation(
      {
        id: 'asset-target',
        storageUrl: 'http://localhost/asset-target.jpg',
        s3Key: null,
        s3Bucket: null,
        storageType: 'local',
        imageWidth: 4000,
        imageHeight: 3000,
      },
      Buffer.from('target-image'),
      'concept-exemplar-1',
      'Pine Sapling'
    );

    expect(segment).toHaveBeenCalledWith(
      expect.objectContaining({
        boxes: expect.arrayContaining([{ x1: 0, y1: 10, x2: 6, y2: 18 }]),
        returnPolygons: true,
      })
    );
    expect(result).toMatchObject({
      assetId: 'asset-target',
      outcome: 'success',
      backendMode: 'concept_ensemble_candidates_unrefined',
      backendWarning: expect.stringContaining('saved 50 unrefined concept candidate(s)'),
      candidateCount: 50,
      refinementBoxCount: 50,
      refinementDetectionCount: 0,
    });
    expect(result.detections).toHaveLength(50);
    expect(result.detections[0]).toMatchObject({
      bbox: [0, 10, 6, 18],
      polygon: [
        [0, 10],
        [6, 10],
        [6, 18],
        [0, 18],
      ],
      confidence: 0.84,
      similarity: 0.84,
    });
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('saved 50 unrefined concept candidate(s)')
    );
  });

  it('fails loudly when target refinement drifts away from candidates', async () => {
    const candidate = {
      bbox: [20, 25, 40, 45],
      confidence: 0.82,
      similarity: 0.82,
      polygon: [
        [20, 25],
        [40, 25],
        [40, 45],
        [20, 45],
      ],
      class_name: 'pine sapling',
    };
    const applyConceptExemplar = vi
      .fn()
      .mockResolvedValueOnce({
        success: true,
        data: {
          detections: [candidate],
          processingTimeMs: 8,
        },
      })
      .mockResolvedValueOnce({
        success: true,
        data: {
          detections: [],
          processingTimeMs: 11,
        },
      });
    const segment = vi.fn().mockResolvedValue({
      success: true,
      response: {
        detections: [
          {
            bbox: [220, 225, 260, 265],
            confidence: 0.93,
            polygon: [
              [220, 225],
              [260, 225],
              [260, 265],
              [220, 265],
            ],
          },
        ],
        count: 1,
      },
    });
    const service = new Sam3BatchV2Service({
      prisma: {} as never,
      awsSam3Service: {
        applyConceptExemplar,
        refreshStatus: vi.fn().mockResolvedValue({
          modelLoaded: true,
          instanceState: 'ready',
          ipAddress: '127.0.0.1',
        }),
        isReady: vi.fn().mockReturnValue(true),
        resizeImage: vi.fn().mockImplementation(async (imageBuffer: Buffer) => ({
          buffer: imageBuffer,
          scaling: { scaleFactor: 1 },
        })),
        segment,
      } as any,
      acquireGpuLock: vi.fn(),
      refreshGpuLock: vi.fn(),
      releaseGpuLock: vi.fn(),
      sleep: vi.fn(),
      now: () => new Date('2026-03-31T00:00:00.000Z'),
    });

    await expect((service as any).runVisualConceptMatch(
      {
        id: 'asset-target',
        storageUrl: 'http://localhost/asset-target.jpg',
        s3Key: null,
        s3Bucket: null,
        storageType: 'local',
        imageWidth: 4000,
        imageHeight: 3000,
      },
      Buffer.from('target-image'),
      'visual-exemplar-1',
      'Pine Sapling'
    )).rejects.toMatchObject({
      name: 'InferenceFailureError',
      errorCode: 'SAM3_REFINEMENT_DRIFT',
    });

    expect(segment).toHaveBeenCalledWith(
      expect.objectContaining({
        boxes: [{ x1: 20, y1: 25, x2: 40, y2: 45 }],
        returnPolygons: true,
      })
    );
  });

  it('deletes existing annotations before recreating them on retry', async () => {
    const operations: string[] = [];
    let stageLog: unknown[] = [];
    const prismaMock = {
      batchJob: {
        findUnique: vi.fn().mockResolvedValue({ stageLog }),
        update: vi.fn().mockImplementation(async ({ data }) => {
          if (data?.stageLog) {
            stageLog = data.stageLog as unknown[];
          }
        }),
      },
      asset: {
        findMany: vi.fn(),
        findUnique: vi.fn(),
      },
      $transaction: vi.fn().mockImplementation(async <T>(callback: (tx: any) => Promise<T>) => {
        return callback({
          pendingAnnotation: {
            deleteMany: vi.fn(async () => {
              operations.push('deleteMany');
            }),
            createMany: vi.fn(async ({ data }) => {
              operations.push(`createMany:${data.length}`);
            }),
          },
          batchJob: {
            update: vi.fn(async () => {
              operations.push('batchJob.update');
            }),
          },
        });
      }),
    } as any;
    const service = new Sam3BatchV2Service({
      prisma: prismaMock,
      awsSam3Service: {} as never,
      acquireGpuLock: vi.fn(),
      refreshGpuLock: vi.fn(),
      releaseGpuLock: vi.fn(),
      sleep: vi.fn(),
      now: () => new Date('2026-03-31T00:00:00.000Z'),
    });

    await (service as any).persistAssetResult(
      'batch-1',
      null,
      {
        assetId: 'asset-1',
        detections: [
          {
            bbox: [1, 2, 3, 4],
            polygon: [
              [1, 2],
              [3, 2],
              [3, 4],
            ],
            confidence: 0.91,
          },
        ],
        outcome: 'success',
      },
      'Lantana',
      1
    );

    expect(operations).toEqual(['deleteMany', 'createMany:1', 'batchJob.update']);
    expect(stageLog).toHaveLength(1);
  });

  it('marks the batch as failed_persist when the persist transaction throws', async () => {
    let stageLog: unknown[] = [];
    const batchState = {
      status: 'QUEUED',
      errorMessage: null as string | null,
    };
    const prismaMock = {
      batchJob: {
        findUnique: vi.fn().mockImplementation(async ({ select }) => {
          if (select?.stageLog) {
            return { stageLog };
          }
          if (select?.sourceAssetId) {
            return { sourceAssetId: 'asset-1' };
          }
          return { stageLog };
        }),
        update: vi.fn().mockImplementation(async ({ data }) => {
          if (data?.stageLog) {
            stageLog = data.stageLog as unknown[];
          }
          if (data?.status) {
            batchState.status = data.status;
          }
          if ('errorMessage' in data) {
            batchState.errorMessage = data.errorMessage;
          }
        }),
      },
      asset: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: 'asset-1',
            storageUrl: 'http://localhost/asset-1.jpg',
            s3Key: null,
            s3Bucket: null,
            storageType: 'local',
            imageWidth: 4000,
            imageHeight: 3000,
          },
        ]),
        findUnique: vi.fn().mockResolvedValue({
          id: 'asset-1',
          storageUrl: 'http://localhost/asset-1.jpg',
          s3Key: null,
          s3Bucket: null,
          storageType: 'local',
          imageWidth: 4000,
          imageHeight: 3000,
        }),
      },
      $transaction: vi.fn().mockRejectedValue(new Error('tx exploded')),
    } as any;
    const service = new Sam3BatchV2Service({
      prisma: prismaMock,
      awsSam3Service: {
        isConfigured: vi.fn().mockReturnValue(true),
        isReady: vi.fn().mockReturnValue(true),
        refreshStatus: vi.fn().mockResolvedValue({
          modelLoaded: true,
          instanceState: 'ready',
          ipAddress: '127.0.0.1',
        }),
        startInstance: vi.fn().mockResolvedValue(true),
        resizeImage: vi.fn().mockImplementation(async (imageBuffer: Buffer) => ({
          buffer: imageBuffer,
          scaling: { scaleFactor: 1 },
        })),
        segment: vi.fn().mockResolvedValue({
          success: true,
          response: { detections: [], count: 0 },
        }),
        segmentWithExemplars: vi.fn().mockResolvedValue({
          success: true,
          response: {
            detections: [
              {
                bbox: [1, 2, 3, 4],
                confidence: 0.87,
                polygon: [
                  [1, 2],
                  [3, 2],
                  [3, 4],
                ],
              },
            ],
            count: 1,
          },
        }),
        warmupConceptService: vi.fn(),
        createConceptExemplar: vi.fn(),
        applyConceptExemplar: vi.fn(),
      },
      acquireGpuLock: vi.fn().mockResolvedValue({ acquired: true, token: 'gpu-token' }),
      refreshGpuLock: vi.fn().mockResolvedValue(true),
      releaseGpuLock: vi.fn().mockResolvedValue(true),
      sleep: vi.fn(),
      now: () => new Date('2026-03-31T00:00:00.000Z'),
    });

    const result = await service.processJob({
      data: {
        batchJobId: 'batch-1',
        projectId: 'proj-1',
        weedType: 'Lantana',
        mode: 'visual_crop_match',
        exemplars: [{ x1: 1, y1: 1, x2: 5, y2: 5 }],
        exemplarCrops: ['abc123'],
        sourceAssetId: 'asset-1',
        assetIds: ['asset-1'],
        textPrompt: 'Lantana',
        vegetationPrior: false,
      },
      attemptsMade: 0,
      updateProgress: vi.fn().mockResolvedValue(undefined),
    });

    expect(result.terminalState).toBe('failed_persist');
    expect(batchState.status).toBe('FAILED');
    expect(batchState.errorMessage).toContain('tx exploded');
    expect(stageLog).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          stage: 'terminal',
          terminalState: 'failed_persist',
          errorCode: 'PERSIST_FAILED',
        }),
      ])
    );
  });

  it('rescales visual-crop detections back to original image coordinates', async () => {
    const service = new Sam3BatchV2Service({
      prisma: {} as never,
      awsSam3Service: {
        resizeImage: vi.fn().mockResolvedValue({
          buffer: Buffer.from('resized-image'),
          scaling: { scaleFactor: 0.5 },
        }),
        segmentWithExemplars: vi.fn().mockResolvedValue({
          success: true,
          response: {
            detections: [
              {
                bbox: [10, 20, 30, 40],
                confidence: 0.84,
                polygon: [
                  [10, 20],
                  [30, 20],
                  [30, 40],
                  [10, 40],
                ],
              },
            ],
            count: 1,
          },
        }),
      } as any,
      acquireGpuLock: vi.fn(),
      refreshGpuLock: vi.fn(),
      releaseGpuLock: vi.fn(),
      sleep: vi.fn(),
      now: () => new Date('2026-03-31T00:00:00.000Z'),
    });

    const result = await (service as any).runVisualCropMatch(
      {
        id: 'asset-1',
        storageUrl: 'http://localhost/asset-1.jpg',
        s3Key: null,
        s3Bucket: null,
        storageType: 'local',
        imageWidth: 4000,
        imageHeight: 3000,
      },
      Buffer.from('original-image'),
      {
        batchJobId: 'batch-1',
        projectId: 'proj-1',
        weedType: 'Pine Sapling',
        mode: 'visual_crop_match',
        textPrompt: 'Pine Sapling',
        sourceAssetId: 'asset-1',
        sourceImageBuffer: Buffer.from('source-image'),
        exemplars: [{ x1: 1, y1: 2, x2: 3, y2: 4 }],
        exemplarCrops: ['abc123'],
        assets: [],
        missingAssetIds: [],
        cropCount: 1,
      }
    );

    expect(result).toMatchObject({
      assetId: 'asset-1',
      outcome: 'success',
      detections: [
        {
          bbox: [20, 40, 60, 80],
          polygon: [
            [20, 40],
            [60, 40],
            [60, 80],
            [20, 80],
          ],
          confidence: 0.84,
        },
      ],
    });
  });

  it('uses SAM3 visual exemplar crops for visual-match target assets', async () => {
    let stageLog: unknown[] = [];
    const segment = vi.fn().mockResolvedValue({
      success: true,
      response: {
        detections: [
          {
            bbox: [5, 5, 15, 15],
            confidence: 0.9,
            polygon: [
              [5, 5],
              [15, 5],
              [15, 15],
              [5, 15],
            ],
          },
        ],
        count: 1,
      },
    });
    const segmentWithExemplars = vi.fn().mockResolvedValue({
      success: true,
      response: {
        detections: [
          {
            bbox: [20, 25, 40, 45],
            confidence: 0.92,
            polygon: [
              [20, 25],
              [40, 25],
              [40, 45],
              [20, 45],
            ],
          },
        ],
        count: 1,
        mode: 'text_assisted_exemplar_crops',
        warning: 'diagnostic only',
      },
    });
    const warmupConceptService = vi.fn().mockResolvedValue({
      success: true,
      data: { sam3Loaded: true, dinoLoaded: true },
    });
    const createConceptExemplar = vi.fn().mockResolvedValue({
      success: true,
      data: { exemplarId: 'visual-exemplar-1' },
    });
    const applyConceptExemplar = vi.fn();
    const prismaMock = {
      batchJob: {
        findUnique: vi.fn().mockImplementation(async ({ select }) => {
          if (select?.stageLog) {
            return { stageLog };
          }
          if (select?.sourceAssetId) {
            return { sourceAssetId: 'asset-source' };
          }
          return { stageLog };
        }),
        update: vi.fn().mockImplementation(async ({ data }) => {
          if (data?.stageLog) {
            stageLog = data.stageLog as unknown[];
          }
        }),
      },
      asset: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: 'asset-target',
            storageUrl: 'http://localhost/asset-target.jpg',
            s3Key: null,
            s3Bucket: null,
            storageType: 'local',
            imageWidth: 4000,
            imageHeight: 3000,
          },
          {
            id: 'asset-source',
            storageUrl: 'http://localhost/asset-source.jpg',
            s3Key: null,
            s3Bucket: null,
            storageType: 'local',
            imageWidth: 4000,
            imageHeight: 3000,
          },
        ]),
        findUnique: vi.fn().mockResolvedValue({
          id: 'asset-source',
          storageUrl: 'http://localhost/asset-source.jpg',
          s3Key: null,
          s3Bucket: null,
          storageType: 'local',
          imageWidth: 4000,
          imageHeight: 3000,
        }),
      },
      $transaction: vi.fn().mockImplementation(async <T>(callback: (tx: {
        pendingAnnotation: {
          deleteMany: () => Promise<undefined>;
          createMany: () => Promise<undefined>;
        };
        batchJob: {
          update: () => Promise<undefined>;
        };
      }) => Promise<T>) => {
        return callback({
          pendingAnnotation: {
            deleteMany: vi.fn(async () => undefined),
            createMany: vi.fn(async () => undefined),
          },
          batchJob: {
            update: vi.fn(async () => undefined),
          },
        });
      }),
    };

    const service = new Sam3BatchV2Service({
      prisma: prismaMock as never,
      awsSam3Service: {
        isConfigured: vi.fn().mockReturnValue(true),
        isReady: vi.fn().mockReturnValue(true),
        refreshStatus: vi.fn().mockResolvedValue({
          modelLoaded: true,
          instanceState: 'ready',
          ipAddress: '127.0.0.1',
        }),
        startInstance: vi.fn().mockResolvedValue(true),
        resizeImage: vi.fn().mockImplementation(async (imageBuffer: Buffer) => ({
          buffer: imageBuffer,
          scaling: { scaleFactor: 1 },
        })),
        segment,
        segmentWithExemplars,
        warmupConceptService,
        createConceptExemplar,
        applyConceptExemplar,
      },
      acquireGpuLock: vi.fn().mockResolvedValue({ acquired: true, token: 'gpu-token' }),
      refreshGpuLock: vi.fn().mockResolvedValue(true),
      releaseGpuLock: vi.fn().mockResolvedValue(true),
      sleep: vi.fn(),
      now: () => new Date('2026-03-31T00:00:00.000Z'),
    });

    const result = await service.processJob({
      data: {
        batchJobId: 'batch-visual-1',
        projectId: 'proj-1',
        weedType: 'Pine Sapling',
        mode: 'visual_crop_match',
        exemplars: [{ x1: 100, y1: 100, x2: 150, y2: 160 }],
        exemplarSourceWidth: 4000,
        exemplarSourceHeight: 3000,
        exemplarCrops: ['abc123'],
        sourceAssetId: 'asset-source',
        assetIds: ['asset-target', 'asset-source'],
        textPrompt: 'Pine Sapling',
        vegetationPrior: false,
      },
      attemptsMade: 0,
      updateProgress: vi.fn().mockResolvedValue(undefined),
    });

    expect(result.terminalState).toBe('completed');
    expect(result.processedImages).toBe(2);
    expect(result.failedAssets).toBe(0);
    expect(segment).not.toHaveBeenCalled();
    expect(segmentWithExemplars).toHaveBeenCalledTimes(2);
    expect(segmentWithExemplars).toHaveBeenCalledWith(
      expect.objectContaining({
        exemplarCrops: ['abc123'],
        className: 'Pine Sapling',
      })
    );
    expect(warmupConceptService).not.toHaveBeenCalled();
    expect(createConceptExemplar).not.toHaveBeenCalled();
    expect(applyConceptExemplar).not.toHaveBeenCalled();
    expect(stageLog).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          assetId: 'asset-target',
          modeUsed: 'visual_crops',
          cropCount: 1,
          operatorCropCount: 1,
          visualCropSource: 'operator_crops',
        }),
      ])
    );
  });

  it('reuses operator visual crops instead of scaling boxes for each target asset', async () => {
    let stageLog: unknown[] = [];
    const imageBuffer = Buffer.from('image-bytes');
    const operatorCrop = Buffer.from('operator-crop').toString('base64');

    global.fetch = vi.fn().mockImplementation(async () =>
      new Response(imageBuffer, {
        status: 200,
        headers: {
          'content-type': 'image/jpeg',
          'content-length': String(imageBuffer.length),
        },
      })
    ) as typeof fetch;

    const segment = vi.fn().mockResolvedValue({
      success: true,
      response: {
        detections: [
          {
            bbox: [70, 70, 130, 130],
            confidence: 0.91,
            polygon: [
              [100, 70],
              [130, 100],
              [100, 130],
              [70, 100],
            ],
          },
        ],
        count: 1,
      },
    });
    const segmentWithExemplars = vi.fn().mockResolvedValue({
      success: true,
      response: {
        detections: [
          {
            bbox: [70, 70, 130, 130],
            confidence: 0.91,
            polygon: [
              [100, 70],
              [130, 100],
              [100, 130],
              [70, 100],
            ],
          },
        ],
        count: 1,
        mode: 'visual_exemplar_crops',
      },
    });
    const warmupConceptService = vi.fn().mockResolvedValue({
      success: true,
      data: { sam3Loaded: true, dinoLoaded: true },
    });
    const createConceptExemplar = vi.fn().mockResolvedValue({
      success: true,
      data: { exemplarId: 'visual-exemplar-1' },
    });
    const applyConceptExemplar = vi.fn();
    const prismaMock = {
      batchJob: {
        findUnique: vi.fn().mockImplementation(async ({ select }) => {
          if (select?.stageLog) {
            return { stageLog };
          }
          if (select?.sourceAssetId) {
            return { sourceAssetId: 'asset-source' };
          }
          return { stageLog };
        }),
        update: vi.fn().mockImplementation(async ({ data }) => {
          if (data?.stageLog) {
            stageLog = data.stageLog as unknown[];
          }
        }),
      },
      asset: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: 'asset-target',
            storageUrl: 'http://localhost/asset-target.jpg',
            s3Key: null,
            s3Bucket: null,
            storageType: 'local',
            imageWidth: 480,
            imageHeight: 360,
          },
          {
            id: 'asset-source',
            storageUrl: 'http://localhost/asset-source.jpg',
            s3Key: null,
            s3Bucket: null,
            storageType: 'local',
            imageWidth: 240,
            imageHeight: 180,
          },
        ]),
        findUnique: vi.fn().mockResolvedValue({
          id: 'asset-source',
          storageUrl: 'http://localhost/asset-source.jpg',
          s3Key: null,
          s3Bucket: null,
          storageType: 'local',
          imageWidth: 240,
          imageHeight: 180,
        }),
      },
      $transaction: vi.fn().mockImplementation(async <T>(callback: (tx: {
        pendingAnnotation: {
          deleteMany: () => Promise<undefined>;
          createMany: () => Promise<undefined>;
        };
        batchJob: {
          update: () => Promise<undefined>;
        };
      }) => Promise<T>) => {
        return callback({
          pendingAnnotation: {
            deleteMany: vi.fn(async () => undefined),
            createMany: vi.fn(async () => undefined),
          },
          batchJob: {
            update: vi.fn(async () => undefined),
          },
        });
      }),
    };

    const service = new Sam3BatchV2Service({
      prisma: prismaMock as never,
      awsSam3Service: {
        isConfigured: vi.fn().mockReturnValue(true),
        isReady: vi.fn().mockReturnValue(true),
        refreshStatus: vi.fn().mockResolvedValue({
          modelLoaded: true,
          instanceState: 'ready',
          ipAddress: '127.0.0.1',
        }),
        startInstance: vi.fn().mockResolvedValue(true),
        resizeImage: vi.fn().mockImplementation(async (buffer: Buffer) => ({
          buffer,
          scaling: { scaleFactor: 1 },
        })),
        segment,
        segmentWithExemplars,
        warmupConceptService,
        createConceptExemplar,
        applyConceptExemplar,
      },
      acquireGpuLock: vi.fn().mockResolvedValue({ acquired: true, token: 'gpu-token' }),
      refreshGpuLock: vi.fn().mockResolvedValue(true),
      releaseGpuLock: vi.fn().mockResolvedValue(true),
      sleep: vi.fn(),
      now: () => new Date('2026-03-31T00:00:00.000Z'),
    });

    await service.processJob({
      data: {
        batchJobId: 'batch-source-crops-1',
        projectId: 'proj-1',
        weedType: 'Pine Sapling',
        mode: 'visual_crop_match',
        exemplars: [{ x1: 40, y1: 40, x2: 100, y2: 100 }],
        exemplarSourceWidth: 240,
        exemplarSourceHeight: 180,
        exemplarCrops: [operatorCrop],
        sourceAssetId: 'asset-source',
        assetIds: ['asset-target', 'asset-source'],
        textPrompt: 'Pine Sapling',
        vegetationPrior: false,
      },
      attemptsMade: 0,
      updateProgress: vi.fn().mockResolvedValue(undefined),
    });

    expect(createConceptExemplar).not.toHaveBeenCalled();
    expect(applyConceptExemplar).not.toHaveBeenCalled();
    expect(segment).not.toHaveBeenCalled();
    expect(segmentWithExemplars).toHaveBeenCalledTimes(2);
    expect(segmentWithExemplars).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        exemplarCrops: [operatorCrop],
        className: 'Pine Sapling',
      })
    );
    expect(segmentWithExemplars).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        exemplarCrops: [operatorCrop],
        className: 'Pine Sapling',
      })
    );
    expect(stageLog).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          assetId: 'asset-target',
          modeUsed: 'visual_crops',
          visualCropSource: 'operator_crops',
        }),
      ])
    );
  });

  it('builds source-asset visual crops on the server when client crops are unavailable', async () => {
    let stageLog: unknown[] = [];
    const imageBuffer = await sharp({
      create: {
        width: 120,
        height: 90,
        channels: 3,
        background: { r: 34, g: 120, b: 60 },
      },
    })
      .jpeg()
      .toBuffer();

    global.fetch = vi.fn().mockImplementation(async () =>
      new Response(imageBuffer, {
        status: 200,
        headers: {
          'content-type': 'image/jpeg',
          'content-length': String(imageBuffer.length),
        },
      })
    ) as typeof fetch;

    const segment = vi.fn();
    const segmentWithExemplars = vi.fn().mockResolvedValue({
      success: true,
      response: {
        detections: [
          {
            bbox: [12, 12, 28, 28],
            confidence: 0.88,
            polygon: [
              [12, 12],
              [28, 12],
              [28, 28],
              [12, 28],
            ],
          },
        ],
        count: 1,
        mode: 'visual_exemplar_crops',
      },
    });
    const prismaMock = {
      batchJob: {
        findUnique: vi.fn().mockImplementation(async ({ select }) => {
          if (select?.stageLog) {
            return { stageLog };
          }
          if (select?.sourceAssetId) {
            return { sourceAssetId: 'asset-source' };
          }
          return { stageLog };
        }),
        update: vi.fn().mockImplementation(async ({ data }) => {
          if (data?.stageLog) {
            stageLog = data.stageLog as unknown[];
          }
        }),
      },
      asset: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: 'asset-target',
            storageUrl: 'http://localhost/asset-target.jpg',
            s3Key: null,
            s3Bucket: null,
            storageType: 'local',
            imageWidth: 120,
            imageHeight: 90,
          },
          {
            id: 'asset-source',
            storageUrl: 'http://localhost/asset-source.jpg',
            s3Key: null,
            s3Bucket: null,
            storageType: 'local',
            imageWidth: 120,
            imageHeight: 90,
          },
        ]),
        findUnique: vi.fn().mockResolvedValue({
          id: 'asset-source',
          storageUrl: 'http://localhost/asset-source.jpg',
          s3Key: null,
          s3Bucket: null,
          storageType: 'local',
          imageWidth: 120,
          imageHeight: 90,
        }),
      },
      $transaction: vi.fn().mockImplementation(async <T>(callback: (tx: {
        pendingAnnotation: {
          deleteMany: () => Promise<undefined>;
          createMany: () => Promise<undefined>;
        };
        batchJob: {
          update: () => Promise<undefined>;
        };
      }) => Promise<T>) => {
        return callback({
          pendingAnnotation: {
            deleteMany: vi.fn(async () => undefined),
            createMany: vi.fn(async () => undefined),
          },
          batchJob: {
            update: vi.fn(async () => undefined),
          },
        });
      }),
    };

    const service = new Sam3BatchV2Service({
      prisma: prismaMock as never,
      awsSam3Service: {
        isConfigured: vi.fn().mockReturnValue(true),
        isReady: vi.fn().mockReturnValue(true),
        refreshStatus: vi.fn().mockResolvedValue({
          modelLoaded: true,
          instanceState: 'ready',
          ipAddress: '127.0.0.1',
        }),
        startInstance: vi.fn().mockResolvedValue(true),
        resizeImage: vi.fn().mockImplementation(async (buffer: Buffer) => ({
          buffer,
          scaling: { scaleFactor: 1 },
        })),
        segment,
        segmentWithExemplars,
        warmupConceptService: vi.fn(),
        createConceptExemplar: vi.fn(),
        applyConceptExemplar: vi.fn(),
      },
      acquireGpuLock: vi.fn().mockResolvedValue({ acquired: true, token: 'gpu-token' }),
      refreshGpuLock: vi.fn().mockResolvedValue(true),
      releaseGpuLock: vi.fn().mockResolvedValue(true),
      sleep: vi.fn(),
      now: () => new Date('2026-03-31T00:00:00.000Z'),
    });

    const result = await service.processJob({
      data: {
        batchJobId: 'batch-server-crops-1',
        projectId: 'proj-1',
        weedType: 'Pine Sapling',
        mode: 'visual_crop_match',
        exemplars: [{ x1: 10, y1: 10, x2: 35, y2: 35 }],
        exemplarSourceWidth: 120,
        exemplarSourceHeight: 90,
        sourceAssetId: 'asset-source',
        assetIds: ['asset-target', 'asset-source'],
        textPrompt: 'Pine Sapling',
        vegetationPrior: false,
      },
      attemptsMade: 0,
      updateProgress: vi.fn().mockResolvedValue(undefined),
    });

    expect(result.terminalState).toBe('completed');
    expect(segment).not.toHaveBeenCalled();
    expect(segmentWithExemplars).toHaveBeenCalledTimes(2);
    expect(segmentWithExemplars.mock.calls[0][0].exemplarCrops).toEqual([
      expect.any(String),
    ]);
    expect(stageLog).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          stage: 'prepare',
          modeUsed: 'visual_crops',
          cropCount: 1,
          operatorCropCount: 0,
          visualCropSource: 'server_built_crops',
        }),
        expect.objectContaining({
          assetId: 'asset-target',
          modeUsed: 'visual_crops',
          visualCropSource: 'server_built_crops',
        }),
      ])
    );
  });

  it('configures the v2 BullMQ queue with global concurrency 1', async () => {
    const queue = {
      setGlobalConcurrency: vi.fn().mockResolvedValue(undefined),
    };

    await configureSam3BatchV2Queue(queue as never);

    expect(queue.setGlobalConcurrency).toHaveBeenCalledWith(1);
  });
});
