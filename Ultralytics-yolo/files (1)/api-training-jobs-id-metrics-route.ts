/**
 * Training Job Metrics History API
 * 
 * Location: app/api/training/jobs/[id]/metrics/route.ts
 * 
 * GET /api/training/jobs/[id]/metrics - Get full training history for charts
 */

import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { yoloService } from '@/lib/services/yolo';
import { TrainingStatus } from '@prisma/client';

export async function GET(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const jobId = params.id;
    
    const job = await prisma.trainingJob.findUnique({
      where: { id: jobId },
      select: {
        id: true,
        ec2JobId: true,
        status: true,
        epochs: true,
        currentEpoch: true,
        metricsHistory: true,
      },
    });

    if (!job) {
      return NextResponse.json(
        { error: 'Training job not found' },
        { status: 404 }
      );
    }

    // If we have cached history and job is complete, return it
    if (job.metricsHistory && job.status === TrainingStatus.COMPLETED) {
      return NextResponse.json({
        jobId: job.id,
        totalEpochs: job.epochs,
        currentEpoch: job.currentEpoch,
        history: JSON.parse(job.metricsHistory),
      });
    }

    // For active jobs, fetch live from EC2
    if (job.ec2JobId) {
      try {
        const ec2History = await yoloService.getTrainingHistory(job.ec2JobId);
        
        // Cache the history in database for completed jobs
        if (job.status === TrainingStatus.COMPLETED || ec2History.epochs.length > 0) {
          await prisma.trainingJob.update({
            where: { id: jobId },
            data: {
              metricsHistory: JSON.stringify(ec2History.epochs),
            },
          });
        }

        return NextResponse.json({
          jobId: job.id,
          totalEpochs: job.epochs,
          currentEpoch: ec2History.epochs.length,
          history: ec2History.epochs,
        });

      } catch (ec2Error) {
        console.error('Failed to fetch metrics from EC2:', ec2Error);
        
        // Return cached history if available
        if (job.metricsHistory) {
          return NextResponse.json({
            jobId: job.id,
            totalEpochs: job.epochs,
            currentEpoch: job.currentEpoch,
            history: JSON.parse(job.metricsHistory),
            warning: 'Using cached data - EC2 sync failed',
          });
        }
      }
    }

    // No history available
    return NextResponse.json({
      jobId: job.id,
      totalEpochs: job.epochs,
      currentEpoch: job.currentEpoch,
      history: [],
    });

  } catch (error) {
    console.error('Error fetching training metrics:', error);
    return NextResponse.json(
      { error: 'Failed to fetch training metrics' },
      { status: 500 }
    );
  }
}
