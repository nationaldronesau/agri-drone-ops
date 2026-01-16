/**
 * SAM3 Concept Warmup Endpoint
 *
 * Triggers the concept propagation service to load SAM3 + DINOv2 models.
 */
import { NextResponse } from 'next/server';
import { sam3ConceptService } from '@/lib/services/sam3-concept';

export async function POST(): Promise<NextResponse> {
  try {
    const configured = sam3ConceptService.isConfigured();
    if (!configured) {
      return NextResponse.json(
        {
          configured: false,
          ready: false,
          sam3Loaded: false,
          dinoLoaded: false,
          error: 'Concept service not configured',
        },
        { status: 400 }
      );
    }

    const warmup = await sam3ConceptService.warmup();
    if (!warmup.success || !warmup.data) {
      return NextResponse.json(
        {
          configured: true,
          ready: false,
          sam3Loaded: false,
          dinoLoaded: false,
          error: warmup.error || 'Concept warmup failed',
        },
        { status: 503 }
      );
    }

    const ready = warmup.data.sam3Loaded && warmup.data.dinoLoaded;
    return NextResponse.json({
      configured: true,
      ready,
      sam3Loaded: warmup.data.sam3Loaded,
      dinoLoaded: warmup.data.dinoLoaded,
    });
  } catch (error) {
    console.error('[SAM3 Concept Warmup] Error warming up:', error);
    return NextResponse.json(
      {
        configured: false,
        ready: false,
        sam3Loaded: false,
        dinoLoaded: false,
        error: 'Failed to warm up concept service',
      },
      { status: 500 }
    );
  }
}
