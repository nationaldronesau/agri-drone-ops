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
  error?: string;
}

export async function GET(): Promise<NextResponse<SAM3HealthResponse>> {
  // Check if Roboflow API key is configured
  if (!ROBOFLOW_API_KEY) {
    return NextResponse.json({
      available: false,
      mode: 'unavailable',
      device: null,
      latencyMs: null,
      error: 'Roboflow API key not configured',
    });
  }

  try {
    // Test Roboflow API connectivity using Authorization header (not query param)
    const startTime = Date.now();

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);

    // Use POST to concept_segment with minimal payload to verify API access
    // This avoids exposing API key in query strings
    const response = await fetch('https://api.roboflow.com/', {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${ROBOFLOW_API_KEY}`,
        'Content-Type': 'application/json',
      },
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    const latencyMs = Date.now() - startTime;

    // Roboflow API returns 401 for invalid key, 200 for valid
    if (response.ok || response.status === 200) {
      return NextResponse.json({
        available: true,
        mode: 'realtime',
        device: 'roboflow-serverless',
        latencyMs,
      });
    } else if (response.status === 401) {
      return NextResponse.json({
        available: false,
        mode: 'unavailable',
        device: null,
        latencyMs,
        error: 'Invalid API key',
      });
    } else {
      return NextResponse.json({
        available: false,
        mode: 'unavailable',
        device: null,
        latencyMs,
        error: `API returned status ${response.status}`,
      });
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.log('Roboflow health check failed:', errorMessage);

    return NextResponse.json({
      available: false,
      mode: 'unavailable',
      device: null,
      latencyMs: null,
      error: errorMessage.includes('abort') ? 'Request timeout' : 'Connection failed',
    });
  }
}
