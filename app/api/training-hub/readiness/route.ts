import { NextResponse } from 'next/server';
import { getAuthenticatedUser } from '@/lib/auth/api-auth';
import { checkRedisConnection } from '@/lib/queue/redis';
import {
  summarizeCommercialWorkflowReadiness,
} from '@/lib/services/commercial-workflow-readiness';
import { roboflowService } from '@/lib/services/roboflow';
import { sam3Orchestrator } from '@/lib/services/sam3-orchestrator';
import { yoloService } from '@/lib/services/yolo';

export async function GET() {
  try {
    const auth = await getAuthenticatedUser();
    if (!auth.authenticated) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const [samStatus, queueReady, yoloResult] = await Promise.all([
      sam3Orchestrator.getStatus(),
      checkRedisConnection(),
      yoloService
        .checkHealth()
        .then((health) => ({ ready: health.status === 'healthy', health, error: null }))
        .catch((error) => ({
          ready: false,
          health: null,
          error: error instanceof Error ? error.message : 'YOLO service unavailable',
        })),
    ]);

    const roboflowModelCount = roboflowService.getEnabledModels().length;
    const roboflowConfigured = Boolean(
      process.env.ROBOFLOW_API_KEY &&
        process.env.ROBOFLOW_WORKSPACE &&
        roboflowModelCount > 0
    );

    const readiness = summarizeCommercialWorkflowReadiness({
      samConfigured: samStatus.awsConfigured,
      samReady: samStatus.awsAvailable,
      samState: samStatus.awsState,
      samGpuAvailable: samStatus.awsGpuAvailable,
      samModelLoaded: samStatus.awsModelLoaded,
      queueReady,
      yoloReady: yoloResult.ready,
      yoloError: yoloResult.error,
      roboflowConfigured,
      roboflowModelCount,
    });

    return NextResponse.json({
      ...readiness,
      raw: {
        sam: {
          configured: samStatus.awsConfigured,
          state: samStatus.awsState,
          ready: samStatus.awsAvailable,
          gpuAvailable: samStatus.awsGpuAvailable,
          modelLoaded: samStatus.awsModelLoaded,
        },
        queue: { ready: queueReady },
        yolo: {
          ready: yoloResult.ready,
          health: yoloResult.health,
          error: yoloResult.error,
        },
        roboflow: {
          configured: roboflowConfigured,
          enabledModelCount: roboflowModelCount,
        },
      },
    });
  } catch (error) {
    console.error('[Training Hub Readiness] Failed to build readiness summary:', error);
    return NextResponse.json(
      { error: 'Failed to check commercial workflow readiness' },
      { status: 500 }
    );
  }
}
