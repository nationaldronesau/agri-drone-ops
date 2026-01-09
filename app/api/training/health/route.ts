/**
 * YOLO Service Health Check API Route
 *
 * GET /api/training/health - Check EC2 YOLO service availability
 */
import { NextResponse } from 'next/server';
import { getAuthenticatedUser } from '@/lib/auth/api-auth';
import { yoloService } from '@/lib/services/yolo';

export async function GET() {
  try {
    const auth = await getAuthenticatedUser();
    if (!auth.authenticated) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    try {
      const health = await yoloService.checkHealth();
      const available = health.status === 'healthy';
      return NextResponse.json({
        available,
        health,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Service unavailable';
      return NextResponse.json({
        available: false,
        error: message,
      });
    }
  } catch (error) {
    console.error('Error checking YOLO health:', error);
    return NextResponse.json(
      { error: 'Failed to check service health' },
      { status: 500 }
    );
  }
}
