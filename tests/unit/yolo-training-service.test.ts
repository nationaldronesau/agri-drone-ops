import { afterEach, describe, expect, it, vi } from 'vitest';
import { YOLOService } from '@/lib/services/yolo';

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
});
