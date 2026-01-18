import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/db';
import { getAuthenticatedUser } from '@/lib/auth/api-auth';
import { normalizeDetectionType } from '@/lib/utils/detection-types';

type ReviewAction = 'accept' | 'reject' | 'correct' | 'edit';
type ReviewSource = 'manual' | 'pending' | 'detection';

function confidenceToEnum(confidence: number): 'CERTAIN' | 'LIKELY' | 'UNCERTAIN' {
  if (confidence >= 0.8) return 'CERTAIN';
  if (confidence >= 0.5) return 'LIKELY';
  return 'UNCERTAIN';
}

export async function POST(
  request: NextRequest,
  { params }: { params: { sessionId: string } }
) {
  try {
    const auth = await getAuthenticatedUser();
    if (!auth.authenticated || !auth.userId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = await request.json();
    const action = body.action as ReviewAction | undefined;
    const source = body.source as ReviewSource | undefined;
    const itemId = (body.itemId || body.sourceId || body.originalItemId) as string | undefined;
    const correctedClassRaw = body.correctedClass as string | undefined;
    const newAnnotationId = body.newAnnotationId as string | undefined;

    if (!action || !source || !itemId) {
      return NextResponse.json(
        { error: 'action, source, and itemId are required' },
        { status: 400 }
      );
    }

    const session = await prisma.reviewSession.findUnique({
      where: { id: params.sessionId },
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

    const now = new Date();

    if (action === 'edit') {
      if (!newAnnotationId) {
        return NextResponse.json(
          { error: 'newAnnotationId is required for edit action' },
          { status: 400 }
        );
      }

      const result = await prisma.$transaction(async (tx) => {
        let created = false;
        try {
          await tx.reviewSessionEdit.create({
            data: {
              reviewSessionId: params.sessionId,
              sourceType: source,
              sourceId: itemId,
              newAnnotationId,
            },
          });
          created = true;
        } catch (error: any) {
          if (error?.code === 'P2002') {
            await tx.reviewSessionEdit.update({
              where: {
                reviewSessionId_sourceType_sourceId: {
                  reviewSessionId: params.sessionId,
                  sourceType: source,
                  sourceId: itemId,
                },
              },
              data: { newAnnotationId },
            });
          } else {
            throw error;
          }
        }

        if (source === 'manual') {
          await tx.manualAnnotation.update({
            where: { id: itemId },
            data: {
              verified: false,
              verifiedAt: now,
              verifiedBy: auth.userId,
            },
          });
        } else if (source === 'pending') {
          await tx.pendingAnnotation.update({
            where: { id: itemId },
            data: {
              status: 'REJECTED',
              reviewedAt: now,
              reviewedBy: auth.userId,
            },
          });
        } else {
          await tx.detection.update({
            where: { id: itemId },
            data: {
              rejected: true,
              verified: false,
              reviewedAt: now,
              reviewedBy: auth.userId,
            },
          });
        }

        await tx.manualAnnotation.update({
          where: { id: newAnnotationId },
          data: {
            verified: true,
            verifiedAt: now,
            verifiedBy: auth.userId,
          },
        });

        if (created) {
          await tx.reviewSession.update({
            where: { id: params.sessionId },
            data: {
              itemsReviewed: { increment: 1 },
            },
          });
        }

        return { created };
      });

      return NextResponse.json({ success: true, created: result.created });
    }

    const correctedClass = correctedClassRaw ? normalizeDetectionType(correctedClassRaw) : null;

    const result = await prisma.$transaction(async (tx) => {
      let prevStatus: 'pending' | 'accepted' | 'rejected' = 'pending';
      let nextStatus: 'pending' | 'accepted' | 'rejected' = 'pending';

      if (source === 'manual') {
        const annotation = await tx.manualAnnotation.findUnique({
          where: { id: itemId },
          select: { verified: true, verifiedAt: true, weedType: true },
        });
        if (!annotation) throw new Error('Manual annotation not found');

        prevStatus = annotation.verified
          ? 'accepted'
          : annotation.verifiedAt
            ? 'rejected'
            : 'pending';

        if (action === 'reject') {
          nextStatus = 'rejected';
          await tx.manualAnnotation.update({
            where: { id: itemId },
            data: {
              verified: false,
              verifiedAt: now,
              verifiedBy: auth.userId,
            },
          });
        } else {
          nextStatus = 'accepted';
          await tx.manualAnnotation.update({
            where: { id: itemId },
            data: {
              weedType: correctedClass ?? annotation.weedType,
              verified: true,
              verifiedAt: now,
              verifiedBy: auth.userId,
            },
          });
        }
      } else if (source === 'pending') {
        const pending = await tx.pendingAnnotation.findUnique({
          where: { id: itemId },
          include: { asset: { select: { id: true } } },
        });
        if (!pending) throw new Error('Pending annotation not found');

        prevStatus =
          pending.status === 'ACCEPTED'
            ? 'accepted'
            : pending.status === 'REJECTED'
              ? 'rejected'
              : 'pending';

        if (action === 'reject') {
          nextStatus = 'rejected';
          await tx.pendingAnnotation.update({
            where: { id: itemId },
            data: {
              status: 'REJECTED',
              reviewedAt: now,
              reviewedBy: auth.userId,
            },
          });
        } else {
          if (action === 'correct' && !correctedClass) {
            throw new Error('correctedClass is required for correct action');
          }

          nextStatus = 'accepted';
          let annotationSession = await tx.annotationSession.findFirst({
            where: { assetId: pending.assetId, status: 'IN_PROGRESS' },
          });

          if (!annotationSession) {
            annotationSession = await tx.annotationSession.create({
              data: {
                assetId: pending.assetId,
                userId: auth.userId,
                status: 'IN_PROGRESS',
              },
            });
          }

          await tx.manualAnnotation.create({
            data: {
              sessionId: annotationSession.id,
              weedType: correctedClass ?? pending.weedType,
              confidence: confidenceToEnum(pending.confidence),
              coordinates: pending.polygon,
              geoCoordinates: pending.geoPolygon,
              centerLat: pending.centerLat,
              centerLon: pending.centerLon,
              verified: true,
              verifiedAt: now,
              verifiedBy: auth.userId,
              notes: `Accepted from review session (${Math.round(pending.confidence * 100)}% confidence)`,
            },
          });

          await tx.pendingAnnotation.update({
            where: { id: itemId },
            data: {
              status: 'ACCEPTED',
              reviewedAt: now,
              reviewedBy: auth.userId,
            },
          });
        }
      } else {
        const detection = await tx.detection.findUnique({
          where: { id: itemId },
          select: {
            verified: true,
            rejected: true,
            userCorrected: true,
            className: true,
            originalClass: true,
          },
        });
        if (!detection) throw new Error('Detection not found');

        prevStatus = detection.rejected
          ? 'rejected'
          : detection.verified || detection.userCorrected
            ? 'accepted'
            : 'pending';

        if (action === 'reject') {
          nextStatus = 'rejected';
          await tx.detection.update({
            where: { id: itemId },
            data: {
              rejected: true,
              verified: false,
              reviewedAt: now,
              reviewedBy: auth.userId,
            },
          });
        } else if (action === 'correct') {
          if (!correctedClass) {
            throw new Error('correctedClass is required for correct action');
          }

          nextStatus = 'accepted';
          await tx.detection.update({
            where: { id: itemId },
            data: {
              className: correctedClass,
              originalClass: detection.originalClass ?? detection.className,
              userCorrected: true,
              verified: true,
              rejected: false,
              reviewedAt: now,
              reviewedBy: auth.userId,
            },
          });
        } else {
          nextStatus = 'accepted';
          await tx.detection.update({
            where: { id: itemId },
            data: {
              verified: true,
              rejected: false,
              reviewedAt: now,
              reviewedBy: auth.userId,
            },
          });
        }
      }

      if (prevStatus === 'pending' && nextStatus !== 'pending') {
        await tx.reviewSession.update({
          where: { id: params.sessionId },
          data: {
            itemsReviewed: { increment: 1 },
            ...(nextStatus === 'accepted' ? { itemsAccepted: { increment: 1 } } : {}),
            ...(nextStatus === 'rejected' ? { itemsRejected: { increment: 1 } } : {}),
          },
        });
      }

      return { prevStatus, nextStatus };
    });

    return NextResponse.json({ success: true, ...result });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to update review item';
    console.error('Review action error:', message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
