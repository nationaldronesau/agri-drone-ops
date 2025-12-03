/**
 * SAM3 Health Check API Route - Roboflow Integration
 *
 * Checks if Roboflow SAM3 workflow is configured and accessible.
 */
import { NextResponse } from 'next/server';

const ROBOFLOW_API_KEY = process.env.ROBOFLOW_API_KEY;
const ROBOFLOW_WORKSPACE = process.env.ROBOFLOW_WORKSPACE;
const ROBOFLOW_SAM3_WORKFLOW_ID = process.env.ROBOFLOW_SAM3_WORKFLOW_ID || 'sam3-forestry';

export interface SAM3HealthResponse {
  available: boolean;
  mode: 'realtime' | 'degraded' | 'loading' | 'unavailable';
  device: 'roboflow-cloud' | null;
  latencyMs: number | null;
  workflowId: string | null;
}

export async function GET(): Promise<NextResponse<SAM3HealthResponse>> {
  // Check if Roboflow is configured
  if (!ROBOFLOW_API_KEY || !ROBOFLOW_WORKSPACE) {
    return NextResponse.json({
      available: false,
      mode: 'unavailable',
      device: null,
      latencyMs: null,
      workflowId: null,
    });
  }

  try {
    // Test Roboflow API connectivity with a lightweight call
    // We'll just check if the workspace is accessible
    const startTime = Date.now();

    const testUrl = `https://api.roboflow.com/${ROBOFLOW_WORKSPACE}?api_key=${ROBOFLOW_API_KEY}`;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);

    const response = await fetch(testUrl, {
      method: 'GET',
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    const latencyMs = Date.now() - startTime;

    if (response.ok) {
      return NextResponse.json({
        available: true,
        mode: 'realtime',  // Roboflow cloud is always "realtime"
        device: 'roboflow-cloud',
        latencyMs,
        workflowId: ROBOFLOW_SAM3_WORKFLOW_ID,
      });
    } else {
      console.warn('Roboflow API returned non-OK status:', response.status);
      return NextResponse.json({
        available: false,
        mode: 'unavailable',
        device: null,
        latencyMs,
        workflowId: null,
      });
    }
  } catch (error) {
    console.log('Roboflow health check failed:', error instanceof Error ? error.message : 'Unknown error');

    return NextResponse.json({
      available: false,
      mode: 'unavailable',
      device: null,
      latencyMs: null,
      workflowId: null,
    });
  }
}
