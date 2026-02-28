/**
 * SAM3 Health Check API Route
 *
 * Reports orchestrator-aware backend availability.
 */
import { NextResponse } from 'next/server';
import { sam3Orchestrator } from '@/lib/services/sam3-orchestrator';

export interface SAM3HealthResponse {
  available: boolean;
  mode: 'realtime' | 'degraded' | 'loading' | 'unavailable';
  device: 'aws-sam3' | 'roboflow-serverless' | null;
  latencyMs: number | null;
  preferredBackend?: 'aws' | 'roboflow' | 'none';
  details?: {
    awsConfigured: boolean;
    awsState: string;
    awsGpuAvailable: boolean;
    awsModelLoaded: boolean;
    roboflowConfigured: boolean;
  };
  error?: string;
}

export async function GET(): Promise<NextResponse<SAM3HealthResponse>> {
  const startTime = Date.now();

  try {
    const status = await sam3Orchestrator.getStatus();
    const latencyMs = Date.now() - startTime;

    if (status.awsAvailable) {
      return NextResponse.json({
        available: true,
        mode: 'realtime',
        device: 'aws-sam3',
        latencyMs,
        preferredBackend: status.preferredBackend,
        details: {
          awsConfigured: status.awsConfigured,
          awsState: status.awsState,
          awsGpuAvailable: status.awsGpuAvailable,
          awsModelLoaded: status.awsModelLoaded,
          roboflowConfigured: status.roboflowConfigured,
        },
      });
    }

    if (status.awsConfigured && !status.awsModelLoaded) {
      return NextResponse.json({
        available: false,
        mode: 'loading',
        device: null,
        latencyMs,
        preferredBackend: status.preferredBackend,
        details: {
          awsConfigured: status.awsConfigured,
          awsState: status.awsState,
          awsGpuAvailable: status.awsGpuAvailable,
          awsModelLoaded: status.awsModelLoaded,
          roboflowConfigured: status.roboflowConfigured,
        },
        error: 'AWS SAM3 configured but model is not loaded yet',
      });
    }

    if (status.roboflowConfigured) {
      return NextResponse.json({
        available: true,
        mode: 'degraded',
        device: 'roboflow-serverless',
        latencyMs,
        preferredBackend: status.preferredBackend,
        details: {
          awsConfigured: status.awsConfigured,
          awsState: status.awsState,
          awsGpuAvailable: status.awsGpuAvailable,
          awsModelLoaded: status.awsModelLoaded,
          roboflowConfigured: status.roboflowConfigured,
        },
        error: 'AWS unavailable, using Roboflow fallback',
      });
    }

    return NextResponse.json({
      available: false,
      mode: 'unavailable',
      device: null,
      latencyMs,
      preferredBackend: status.preferredBackend,
      details: {
        awsConfigured: status.awsConfigured,
        awsState: status.awsState,
        awsGpuAvailable: status.awsGpuAvailable,
        awsModelLoaded: status.awsModelLoaded,
        roboflowConfigured: status.roboflowConfigured,
      },
      error: 'No SAM3 backend available (AWS not ready, Roboflow not configured)',
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';

    return NextResponse.json({
      available: false,
      mode: 'unavailable',
      device: null,
      latencyMs: null,
      error: `Health check failed: ${errorMessage}`,
    });
  }
}
