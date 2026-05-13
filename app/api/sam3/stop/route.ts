/**
 * SAM3 Stop Instance Endpoint
 *
 * Stops the AWS EC2 SAM3 instance for manual dashboard control.
 */
import { NextResponse } from 'next/server';
import { sam3Orchestrator } from '@/lib/services/sam3-orchestrator';

export async function POST(): Promise<NextResponse> {
  try {
    await sam3Orchestrator.stopAWSInstance();

    return NextResponse.json({
      success: true,
      message: 'SAM3 GPU instance stop requested',
    });
  } catch (error) {
    console.error('[SAM3 Stop] Error stopping instance:', error);
    return NextResponse.json(
      {
        success: false,
        message: 'Failed to stop SAM3 instance',
        error: error instanceof Error ? error.message : 'Unknown error',
      },
      { status: 500 }
    );
  }
}
