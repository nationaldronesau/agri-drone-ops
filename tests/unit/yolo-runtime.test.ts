import { describe, expect, it, vi } from 'vitest';
import { StartInstancesCommand } from '@aws-sdk/client-ec2';
import { YOLORuntimeService } from '@/lib/services/yolo-runtime';

function describeResponse(state: string, ip?: string) {
  return {
    Reservations: [
      {
        Instances: [
          {
            State: { Name: state },
            PublicIpAddress: ip,
          },
        ],
      },
    ],
  };
}

describe('YOLO runtime lifecycle', () => {
  it('does not start EC2 during passive status checks', async () => {
    const sent: unknown[] = [];
    const ec2Client = {
      send: vi.fn(async (command: unknown) => {
        sent.push(command);
        return describeResponse('stopped');
      }),
    };

    const service = new YOLORuntimeService({
      env: {
        YOLO_EC2_INSTANCE_ID: 'i-yolo',
        YOLO_EC2_REGION: 'ap-southeast-2',
      } as unknown as NodeJS.ProcessEnv,
      ec2Client,
      fetchFn: vi.fn() as unknown as typeof fetch,
      sleepFn: async () => {},
    });

    const status = await service.getStatus({ refresh: true, checkHealth: true });

    expect(status.state).toBe('stopped');
    expect(status.healthy).toBe(false);
    expect(sent.some((command) => command instanceof StartInstancesCommand)).toBe(false);
  });

  it('starts a stopped managed EC2 instance and waits for YOLO health', async () => {
    const sent: unknown[] = [];
    const describeStates = [
      describeResponse('stopped'),
      describeResponse('pending'),
      describeResponse('running', '13.54.121.111'),
    ];
    const ec2Client = {
      send: vi.fn(async (command: unknown) => {
        sent.push(command);
        if (command instanceof StartInstancesCommand) {
          return {};
        }
        return describeStates.shift() || describeResponse('running', '13.54.121.111');
      }),
    };
    const fetchFn = vi.fn(async () => (
      new Response(
        JSON.stringify({
          status: 'healthy',
          gpu_available: true,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    )) as unknown as typeof fetch;

    const service = new YOLORuntimeService({
      env: {
        YOLO_EC2_INSTANCE_ID: 'i-yolo',
        YOLO_EC2_REGION: 'ap-southeast-2',
        YOLO_PORT: '8001',
        YOLO_STARTUP_TIMEOUT_MS: '30000',
      } as unknown as NodeJS.ProcessEnv,
      ec2Client,
      fetchFn,
      sleepFn: async () => {},
    });

    const result = await service.ensureReady();

    expect(result.ready).toBe(true);
    expect(result.state).toBe('ready');
    expect(result.baseUrl).toBe('http://13.54.121.111:8001');
    expect(sent.some((command) => command instanceof StartInstancesCommand)).toBe(true);
    expect(fetchFn).toHaveBeenCalledWith(
      'http://13.54.121.111:8001/health',
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
  });

  it('checks an explicit URL without attempting EC2 lifecycle actions', async () => {
    const fetchFn = vi.fn(async () => (
      new Response(JSON.stringify({ status: 'healthy' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    )) as unknown as typeof fetch;

    const service = new YOLORuntimeService({
      env: {
        YOLO_SERVICE_URL: 'http://localhost:8001/',
      } as unknown as NodeJS.ProcessEnv,
      fetchFn,
      sleepFn: async () => {},
    });

    const result = await service.ensureReady();

    expect(result.ready).toBe(true);
    expect(result.managedInstance).toBe(false);
    expect(result.baseUrl).toBe('http://localhost:8001');
  });
});
