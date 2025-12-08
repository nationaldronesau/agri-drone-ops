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
  // Authentication check
  const auth = await getAuthenticatedUser();
  if (!auth.authenticated || !auth.userId) {
    return NextResponse.json(
      { error: 'Authentication required', success: false },
      { status: 401 }
    );
  }

  try {
    // Get all projects user has access to through team membership
    const userTeams = await prisma.teamMember.findMany({
      where: { userId: auth.userId },
      select: { teamId: true },
    });

    const teamIds = userTeams.map(t => t.teamId);

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
    console.error('Failed to fetch batch jobs:', error);
    return NextResponse.json(
      { error: 'Failed to fetch batch jobs', success: false },
      { status: 500 }
    );
  }
}
