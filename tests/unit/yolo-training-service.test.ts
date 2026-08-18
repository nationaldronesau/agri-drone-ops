import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  PINE_SAPLING_YOLO_MODEL_ID,
  PINE_SAPLING_YOLO_MODEL_NAME,
  YOLOService,
  resolveYoloServiceModelName,
} from '@/lib/services/yolo';
import { awsSam3Service } from '@/lib/services/aws-sam3';

describe('yolo training service', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('sends dataset augmentation through to the AWS YOLO 11 training request', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ job_id: 'job-1', status: 'queued' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    );
    global.fetch = fetchMock as typeof fetch;
    const service = new YOLOService({ baseUrl: 'http://yolo.test', timeout: 1000 });

    await service.startTraining({
      dataset_s3_path: 's3://bucket/datasets/project/v1/',
      model_name: 'lantana-v1',
      base_model: 'yolo11m',
      epochs: 50,
      batch_size: 8,
      image_size: 960,
      learning_rate: 0.005,
      augmentation: {
        preset: 'agricultural',
        fliplr: 0.5,
        degrees: 12,
        hsv_v: 0.2,
      },
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe('http://yolo.test/api/v1/train');
    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(body).toMatchObject({
      dataset_s3_path: 's3://bucket/datasets/project/v1/',
      model_name: 'lantana-v1',
      base_model: 'yolo11m',
      epochs: 50,
      batch_size: 8,
      image_size: 960,
      learning_rate: 0.005,
      augmentation: {
        preset: 'agricultural',
        fliplr: 0.5,
        degrees: 12,
        hsv_v: 0.2,
      },
      fliplr: 0.5,
      degrees: 12,
      hsv_v: 0.2,
    });
  });

  it('fails with a clear unavailable-service error when YOLO training cannot be reached', async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error('connect ECONNREFUSED')) as typeof fetch;
    const service = new YOLOService({ baseUrl: 'http://yolo.test', timeout: 1000 });

    await expect(
      service.startTraining({
        dataset_s3_path: 's3://bucket/datasets/project/v1/',
        model_name: 'lantana-v1',
      })
    ).rejects.toMatchObject({
      name: 'YOLOServiceError',
      statusCode: 503,
      message: 'Failed to connect to YOLO service: connect ECONNREFUSED',
    });
  });

  it('starts and discovers the shared GPU pool before a YOLO request', async () => {
    vi.spyOn(awsSam3Service, 'isConfigured').mockReturnValue(true);
    vi.spyOn(awsSam3Service, 'isReady').mockReturnValue(false);
    const startInstance = vi.spyOn(awsSam3Service, 'startInstance').mockResolvedValue(true);
    vi.spyOn(awsSam3Service, 'getStatus').mockReturnValue({
      ipAddress: '172.31.19.222',
    } as ReturnType<typeof awsSam3Service.getStatus>);

    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({
        status: 'healthy',
        gpu_available: true,
        active_training_jobs: 0,
        cached_models: [],
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    );
    global.fetch = fetchMock as typeof fetch;

    const service = new YOLOService({
      baseUrl: 'http://stopped-legacy-host:8001',
      useSharedGpuPool: true,
      timeout: 1000,
    });

    await expect(service.checkHealth()).resolves.toMatchObject({ status: 'healthy' });
    expect(startInstance).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe('http://172.31.19.222:8001/health');
  });

  it('reports a clear error when the shared GPU pool cannot start', async () => {
    vi.spyOn(awsSam3Service, 'isConfigured').mockReturnValue(true);
    vi.spyOn(awsSam3Service, 'isReady').mockReturnValue(false);
    vi.spyOn(awsSam3Service, 'startInstance').mockResolvedValue(false);

    const service = new YOLOService({
      useSharedGpuPool: true,
      timeout: 1000,
    });

    await expect(service.checkHealth()).rejects.toMatchObject({
      name: 'YOLOServiceError',
      statusCode: 503,
      message: 'Unable to start the shared SAM3/YOLO GPU instance pool',
    });
  });

  it('maps the deployed pine sapling DB model to the registered YOLO service model name', () => {
    expect(
      resolveYoloServiceModelName({
        id: PINE_SAPLING_YOLO_MODEL_ID,
        name: 'Test Pine Saplings',
        version: 1,
      })
    ).toBe(PINE_SAPLING_YOLO_MODEL_NAME);
  });

  it('keeps the generic name-version mapping for other YOLO models', () => {
    expect(
      resolveYoloServiceModelName({
        id: 'other-model',
        name: 'lantana',
        version: 3,
      })
    ).toBe('lantana-v3');
  });
});
