import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/db';
import { getAuthenticatedUser } from '@/lib/auth/api-auth';
import { getReviewItemSummary, toStringArray } from '@/lib/services/review-summary';

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ sessionId: string }> }
) {
  try {
    const { sessionId } = await params;
    const auth = await getAuthenticatedUser();
    if (!auth.authenticated || !auth.userId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const session = await prisma.reviewSession.findUnique({
      where: { id: sessionId },
      include: {
        assignedTo: {
          select: { id: true, name: true, email: true, image: true },
        },
      },
    });

    if (!session) {
      return NextResponse.json({ error: 'Review session not found' }, { status: 404 });
    }

    const membership = await prisma.teamMember.findFirst({
      where: {
        teamId: session.teamId,
        userId: auth.userId,
      },
      select: { id: true },
    });

    if (!membership) {
      return NextResponse.json({ error: 'Access denied' }, { status: 403 });
    }

    const summary = await getReviewItemSummary(prisma, session);

    return NextResponse.json({
      ...session,
      inferenceJobIds: toStringArray(session.inferenceJobIds),
      batchJobIds: toStringArray(session.batchJobIds),
      assetIds: toStringArray(session.assetIds),
      summary,
    });
  } catch (error) {
    console.error('Error fetching review session:', error);
    return NextResponse.json(
      { error: 'Failed to fetch review session' },
      { status: 500 }
    );
  }
}
