/**
 * YOLO Service Health Check API Route
 *
 * GET /api/training/health - Check EC2 YOLO service availability
 */
import { NextResponse } from 'next/server';
import { getAuthenticatedUser } from '@/lib/auth/api-auth';
import { yoloRuntimeService } from '@/lib/services/yolo-runtime';

export async function GET() {
  try {
    const auth = await getAuthenticatedUser();
    if (!auth.authenticated) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const runtime = await yoloRuntimeService.getStatus({ refresh: true, checkHealth: true });
    return NextResponse.json({
      available: runtime.healthy,
      runtime,
      error: runtime.healthy ? null : runtime.lastError || 'Service unavailable',
    });
  } catch (error) {
    console.error('Error checking YOLO health:', error);
    return NextResponse.json(
      { error: 'Failed to check service health' },
      { status: 500 }
    );
  }
}
