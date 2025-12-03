/**
 * SAM3 Status Endpoint
 *
 * Returns the current status of all SAM3 backends (AWS and Roboflow).
 * Used by the frontend to display backend status and availability.
 */
import { NextResponse } from 'next/server';
import { sam3Orchestrator } from '@/lib/services/sam3-orchestrator';
import { getSchedulerStatus } from '@/lib/services/sam3-shutdown-scheduler';

export async function GET(): Promise<NextResponse> {
  try {
    const status = await sam3Orchestrator.getStatus();
    const schedulerStatus = getSchedulerStatus();

    return NextResponse.json({
      aws: {
        configured: status.awsConfigured,
        state: status.awsState,
        ready: status.awsAvailable,
        gpuAvailable: status.awsGpuAvailable,
        modelLoaded: status.awsModelLoaded,
      },
      roboflow: {
        configured: status.roboflowConfigured,
        ready: status.roboflowConfigured, // Roboflow is always "ready" if configured
      },
      preferredBackend: status.preferredBackend,
      funMessage: status.funMessage,
      scheduler: schedulerStatus,
    });
  } catch (error) {
    console.error('[SAM3 Status] Error getting status:', error);
    return NextResponse.json(
      {
        error: 'Failed to get SAM3 status',
        aws: { configured: false, state: 'error', ready: false },
        roboflow: { configured: Boolean(process.env.ROBOFLOW_API_KEY), ready: false },
        preferredBackend: 'none',
        funMessage: 'Houston, we have a problem...',
      },
      { status: 500 }
    );
  }
}
