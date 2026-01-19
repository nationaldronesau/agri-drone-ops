import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/db';
import { getAuthenticatedUser } from '@/lib/auth/api-auth';
import { normalizeDetectionType } from '@/lib/utils/detection-types';

type ReviewAction = 'accept' | 'reject';
type ReviewSource = 'manual' | 'pending' | 'detection';

function confidenceToEnum(confidence: number): 'CERTAIN' | 'LIKELY' | 'UNCERTAIN' {
  if (confidence >= 0.8) return 'CERTAIN';
  if (confidence >= 0.5) return 'LIKELY';
  return 'UNCERTAIN';
}

function parseCornerBox(value: unknown): [number, number, number, number] | null {
  if (!value) return null;
  let parsed: unknown = value;
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (Array.isArray(parsed) && parsed.length >= 4) {
    const [x1, y1, x2, y2] = parsed as number[];
    if (![x1, y1, x2, y2].every((val) => Number.isFinite(val))) return null;
    return [x1, y1, x2, y2];
  }
  return null;
}

function bboxToPolygon(bbox: [number, number, number, number]): number[][] {
  const [x1, y1, x2, y2] = bbox;
  return [
    [x1, y1],
    [x2, y1],
    [x2, y2],
    [x1, y2],
  ];
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
    const items = body.items as Array<{
      source: ReviewSource;
      itemId: string;
      correctedClass?: string;
    }> | undefined;

    if (!action || !items || !Array.isArray(items) || items.length === 0) {
      return NextResponse.json(
        { error: 'action and items are required' },
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
    let reviewedInc = 0;
    let acceptedInc = 0;
    let rejectedInc = 0;
    const errors: Array<{ itemId: string; error: string }> = [];

    await prisma.$transaction(async (tx) => {
      for (const item of items) {
        const itemId = item?.itemId;
        const source = item?.source;
        if (!itemId || !source) {
          errors.push({ itemId: itemId || 'unknown', error: 'Missing source or itemId' });
          continue;
        }

        try {
          let prevStatus: 'pending' | 'accepted' | 'rejected' = 'pending';
          let nextStatus: 'pending' | 'accepted' | 'rejected' = 'pending';

          if (source === 'manual') {
            const annotation = await tx.manualAnnotation.findUnique({
              where: { id: itemId },
              select: { verified: true, verifiedAt: true, weedType: true },
            });
            if (!annotation) {
              throw new Error('Manual annotation not found');
            }

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
                  weedType: item.correctedClass
                    ? normalizeDetectionType(item.correctedClass)
                    : annotation.weedType,
                  verified: true,
                  verifiedAt: now,
                  verifiedBy: auth.userId,
                },
              });
            }
          } else if (source === 'pending') {
            const pending = await tx.pendingAnnotation.findUnique({
              where: { id: itemId },
            });
            if (!pending) {
              throw new Error('Pending annotation not found');
            }

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

              const pendingPolygon = Array.isArray(pending.polygon)
                ? (pending.polygon as number[][])
                : [];
              let polygon = pendingPolygon;
              if (polygon.length < 3) {
                const bbox = parseCornerBox(pending.bbox);
                if (bbox) {
                  polygon = bboxToPolygon(bbox);
                }
              }

              await tx.manualAnnotation.create({
                data: {
                  sessionId: annotationSession.id,
                  weedType: item.correctedClass
                    ? normalizeDetectionType(item.correctedClass)
                    : pending.weedType,
                  confidence: confidenceToEnum(pending.confidence),
                  coordinates: polygon,
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
            if (!detection) {
              throw new Error('Detection not found');
            }

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
            reviewedInc += 1;
            if (nextStatus === 'accepted') acceptedInc += 1;
            if (nextStatus === 'rejected') rejectedInc += 1;
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : 'Failed to update item';
          errors.push({ itemId, error: message });
        }
      }

      if (reviewedInc > 0 || acceptedInc > 0 || rejectedInc > 0) {
        await tx.reviewSession.update({
          where: { id: params.sessionId },
          data: {
            ...(reviewedInc > 0 ? { itemsReviewed: { increment: reviewedInc } } : {}),
            ...(acceptedInc > 0 ? { itemsAccepted: { increment: acceptedInc } } : {}),
            ...(rejectedInc > 0 ? { itemsRejected: { increment: rejectedInc } } : {}),
          },
        });
      }
    });

    if (errors.length > 0) {
      return NextResponse.json(
        {
          success: false,
          reviewedInc,
          acceptedInc,
          rejectedInc,
          errors,
        },
        { status: 207 }
      );
    }

    return NextResponse.json({
      success: true,
      reviewedInc,
      acceptedInc,
      rejectedInc,
    });
  } catch (error) {
    console.error('Bulk review action error:', error);
    return NextResponse.json(
      { error: 'Failed to process bulk review action' },
      { status: 500 }
    );
  }
}
