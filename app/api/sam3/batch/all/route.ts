/**
 * SAM3 Batch Jobs - All Projects
 *
 * GET: List all batch jobs across all accessible projects
 *
 * Security:
 * - Authentication required
 * - Only returns batch jobs from projects the user has access to
 */
import { NextResponse } from 'next/server';
import prisma from '@/lib/db';
import { getAuthenticatedUser } from '@/lib/auth/api-auth';

export async function GET(): Promise<NextResponse> {
  try {
    // Authentication check (now inside try-catch)
    let auth;
    try {
      auth = await getAuthenticatedUser();
    } catch (authError) {
      console.error('[Batch/All] Auth error:', authError);
      return NextResponse.json(
        { error: 'Authentication check failed', success: false },
        { status: 500 }
      );
    }

    if (!auth.authenticated || !auth.userId) {
      return NextResponse.json(
        { error: 'Authentication required', success: false },
        { status: 401 }
      );
    }

    // Get all projects user has access to through team membership
    const userTeams = await prisma.teamMember.findMany({
      where: { userId: auth.userId },
      select: { teamId: true },
    });

    const teamIds = userTeams.map(t => t.teamId);

    // Handle empty teamIds case
    if (teamIds.length === 0) {
      console.log('[Batch/All] User has no team memberships:', auth.userId);
      return NextResponse.json({
        success: true,
        batchJobs: [],
      });
    }

    // Get all batch jobs from accessible projects
    const batchJobs = await prisma.batchJob.findMany({
      where: {
        project: {
          teamId: { in: teamIds },
        },
      },
      include: {
        project: {
          select: {
            id: true,
            name: true,
          },
        },
        _count: {
          select: { pendingAnnotations: true },
        },
      },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });

    return NextResponse.json({
      success: true,
      batchJobs,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error('Failed to fetch batch jobs:', {
      message: errorMessage,
      stack: error instanceof Error ? error.stack : undefined,
      errorType: error?.constructor?.name,
    });

    // Check for specific error types
    let clientError = 'Failed to fetch batch jobs';
    if (errorMessage.includes('prisma') || errorMessage.includes('database')) {
      clientError = 'Database error - please try again';
    }

    return NextResponse.json(
      {
        error: clientError,
        success: false,
        details: process.env.NODE_ENV === 'development' ? errorMessage : undefined,
      },
      { status: 500 }
    );
  }
}
