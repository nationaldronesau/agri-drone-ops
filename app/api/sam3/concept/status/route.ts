/**
 * SAM3 Concept Propagation Status Endpoint
 *
 * Returns readiness for the concept propagation service (DINOv2 + SAM3).
 */
import { NextResponse } from 'next/server';
import { sam3ConceptService } from '@/lib/services/sam3-concept';

export async function GET(): Promise<NextResponse> {
  try {
    const configured = sam3ConceptService.isConfigured();

    if (!configured) {
      return NextResponse.json({
        configured: false,
        ready: false,
        sam3Loaded: false,
        dinoLoaded: false,
        error: 'Concept service not configured',
      });
    }

    const health = await sam3ConceptService.checkHealth();

    if (!health.success || !health.data) {
      return NextResponse.json({
        configured: true,
        ready: false,
        sam3Loaded: false,
        dinoLoaded: false,
        error: health.error || 'Concept service unavailable',
      });
    }

    const ready = health.data.sam3Loaded && health.data.dinoLoaded;
    return NextResponse.json({
      configured: true,
      ready,
      sam3Loaded: health.data.sam3Loaded,
      dinoLoaded: health.data.dinoLoaded,
    });
  } catch (error) {
    console.error('[SAM3 Concept Status] Error getting status:', error);
    return NextResponse.json(
      {
        configured: false,
        ready: false,
        sam3Loaded: false,
        dinoLoaded: false,
        error: 'Failed to get concept status',
      },
      { status: 500 }
    );
  }
}
