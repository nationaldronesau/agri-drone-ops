/**
 * SAM3 Health Check API Route
 *
 * Checks if Roboflow SAM3 serverless API is configured and accessible.
 */
import { NextResponse } from 'next/server';

const ROBOFLOW_API_KEY = process.env.ROBOFLOW_API_KEY;

export interface SAM3HealthResponse {
  available: boolean;
  mode: 'realtime' | 'degraded' | 'loading' | 'unavailable';
  device: 'roboflow-serverless' | null;
  latencyMs: number | null;
}

export async function GET(): Promise<NextResponse<SAM3HealthResponse>> {
  // Check if Roboflow API key is configured
  if (!ROBOFLOW_API_KEY) {
    return NextResponse.json({
      available: false,
      mode: 'unavailable',
      device: null,
      latencyMs: null,
    });
  }

  try {
    // Test Roboflow API connectivity
    const startTime = Date.now();

    // Use the Roboflow workspace API to verify key is valid
    const testUrl = `https://api.roboflow.com/?api_key=${ROBOFLOW_API_KEY}`;

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
        mode: 'realtime',
        device: 'roboflow-serverless',
        latencyMs,
      });
    } else {
      console.warn('Roboflow API returned non-OK status:', response.status);
      return NextResponse.json({
        available: false,
        mode: 'unavailable',
        device: null,
        latencyMs,
      });
    }
  } catch (error) {
    console.log('Roboflow health check failed:', error instanceof Error ? error.message : 'Unknown error');

    return NextResponse.json({
      available: false,
      mode: 'unavailable',
      device: null,
      latencyMs: null,
    });
  }
}
