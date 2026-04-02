import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { configureSam3BatchV2Queue } from '@/lib/queue/batch-queue-v2';
import { Sam3BatchV2Service } from '@/lib/services/sam3-batch-v2';

describe('sam3-batch-v2', () => {
  const originalFetch = global.fetch;

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

  it('uses source-image box matching before concept-backed visual matching for target assets', async () => {
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
    const createConceptExemplar = vi.fn().mockResolvedValue({
      success: true,
      data: { exemplarId: 'visual-exemplar-1' },
    });
    const applyConceptExemplar = vi.fn().mockResolvedValue({
      success: true,
      data: {
        detections: [
          {
            bbox: [20, 25, 40, 45],
            confidence: 0.82,
            similarity: 0.88,
            polygon: [
              [20, 25],
              [40, 25],
              [40, 45],
              [20, 45],
            ],
            class_name: 'object',
          },
        ],
        processingTimeMs: 12,
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
      $transaction: vi.fn().mockImplementation(async <T>(callback: (tx: any) => Promise<T>) => {
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
        segment,
        segmentWithExemplars: vi.fn(),
        warmupConceptService: vi.fn().mockResolvedValue({
          success: true,
          data: { sam3Loaded: true, dinoLoaded: true },
        }),
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
      },
      attemptsMade: 0,
      updateProgress: vi.fn().mockResolvedValue(undefined),
    });

    expect(result.terminalState).toBe('completed');
    expect(segment).toHaveBeenCalledTimes(1);
    expect(createConceptExemplar).toHaveBeenCalledTimes(1);
    expect(createConceptExemplar).toHaveBeenCalledWith(
      expect.objectContaining({
        className: 'Pine Sapling',
        imageId: 'asset-source',
      })
    );
    expect(applyConceptExemplar).toHaveBeenCalledTimes(1);
    expect((service as any).awsSam3Service.segmentWithExemplars).not.toHaveBeenCalled();
  });

  it('configures the v2 BullMQ queue with global concurrency 1', async () => {
    const queue = {
      setGlobalConcurrency: vi.fn().mockResolvedValue(undefined),
    };

    await configureSam3BatchV2Queue(queue as never);

    expect(queue.setGlobalConcurrency).toHaveBeenCalledWith(1);
  });
});
