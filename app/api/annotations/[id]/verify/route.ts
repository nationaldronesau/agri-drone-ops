import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth/config';
import prisma from '@/lib/db';
import { isAuthBypassed } from '@/lib/utils/auth-bypass';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    // Auth check with explicit bypass for development
    let userId: string | null = null;

    if (!isAuthBypassed()) {
      const session = await getServerSession(authOptions);
      if (!session?.user?.id) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
      }
      userId = session.user.id;
    }

    const { id } = await params;

    // Fetch annotation with project/team info for authorization
    const annotation = await prisma.manualAnnotation.findUnique({
      where: { id },
      include: {
        session: {
          include: {
            asset: {
              include: {
                project: {
                  include: {
                    team: {
                      include: {
                        members: true,
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    });

    if (!annotation) {
      return NextResponse.json(
        { error: 'Annotation not found' },
        { status: 404 }
      );
    }

    // Authorization check - verify user has access to this project's team
    if (!isAuthBypassed() && userId) {
      const team = annotation.session.asset.project?.team;
      if (team) {
        const isMember = team.members.some((member) => member.userId === userId);
        if (!isMember) {
          return NextResponse.json(
            { error: 'You do not have access to this annotation' },
            { status: 403 }
          );
        }
      }
    }

    const updated = await prisma.manualAnnotation.update({
      where: { id },
      data: {
        verified: true,
        verifiedAt: new Date(),
        verifiedBy: userId || undefined,
      },
    });

    return NextResponse.json({
      id: updated.id,
      verified: updated.verified,
      verifiedAt: updated.verifiedAt,
    });
  } catch (error) {
    console.error('Error verifying annotation:', error);
    return NextResponse.json(
      { error: 'Failed to verify annotation' },
      { status: 500 }
    );
  }
}
