/**
 * SAM3 Start Instance Endpoint
 *
 * Triggers the AWS EC2 SAM3 instance to start.
 * Returns immediately with a fun loading message while the instance starts in the background.
 */
import { NextResponse } from 'next/server';
import { sam3Orchestrator } from '@/lib/services/sam3-orchestrator';

export async function POST(): Promise<NextResponse> {
  try {
    const result = await sam3Orchestrator.ensureAWSReady();

    return NextResponse.json({
      success: true,
      ready: result.ready,
      starting: result.starting,
      message: result.message,
    });
  } catch (error) {
    console.error('[SAM3 Start] Error starting instance:', error);
    return NextResponse.json(
      {
        success: false,
        ready: false,
        starting: false,
        message: 'Failed to start SAM3 instance',
        error: (error as Error).message,
      },
      { status: 500 }
    );
  }
}
