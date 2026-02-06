/**
 * YOLO Inference Health Check API Route
 *
 * GET /api/inference/health - Check local inference service availability (SAM3 YOLO)
 */
import { NextResponse } from 'next/server';
import { getAuthenticatedUser } from '@/lib/auth/api-auth';

function resolveInferenceBaseUrl() {
  return (
    process.env.YOLO_INFERENCE_URL ||
    process.env.SAM3_SERVICE_URL ||
    process.env.SAM3_API_URL ||
    null
  );
}

async function fetchWithTimeout(url: string, timeoutMs: number = 5000) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    const text = await response.text();
    let data: unknown = text;
    try {
      data = JSON.parse(text);
    } catch {
      // ignore JSON parse errors, return raw text
    }
    return { ok: response.ok, status: response.status, data };
  } finally {
    clearTimeout(timeoutId);
  }
}

export async function GET() {
  try {
    const auth = await getAuthenticatedUser();
    if (!auth.authenticated) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const baseUrl = resolveInferenceBaseUrl();
    if (!baseUrl) {
      return NextResponse.json({
        available: false,
        error: 'Inference service URL not configured',
      });
    }

    // Prefer the YOLO status endpoint
    try {
      const statusResponse = await fetchWithTimeout(`${baseUrl.replace(/\/$/, '')}/api/v1/yolo/status`);
      if (statusResponse.ok) {
        return NextResponse.json({
          available: true,
          status: statusResponse.data,
        });
      }
    } catch (error) {
      // fall through to health fallback
      void error;
    }

    // Fallback to generic health endpoints
    const healthCandidates = [
      `${baseUrl.replace(/\/$/, '')}/api/v1/health`,
      `${baseUrl.replace(/\/$/, '')}/health`,
    ];

    for (const url of healthCandidates) {
      try {
        const response = await fetchWithTimeout(url);
        if (response.ok) {
          return NextResponse.json({
            available: true,
            health: response.data,
          });
        }
      } catch {
        // try next candidate
      }
    }

    return NextResponse.json({
      available: false,
      error: 'Inference service unavailable',
    });
  } catch (error) {
    console.error('Error checking inference health:', error);
    return NextResponse.json(
      { error: 'Failed to check inference health' },
      { status: 500 }
    );
  }
}
