/**
 * Pending Annotations API
 *
 * Manage pending annotations from batch SAM3 processing.
 *
 * Security:
 * - Session validation ensures session belongs to same asset
 * - Transactions ensure atomic accept/reject operations
 * - Input validation on annotation IDs and actions
 */
import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';

// GET: List pending annotations
export async function GET(request: NextRequest): Promise<NextResponse> {
  const { searchParams } = new URL(request.url);
  const batchJobId = searchParams.get('batchJobId');
  const status = searchParams.get('status');
  const minConfidence = searchParams.get('minConfidence');

  const where: Record<string, unknown> = {};

  if (batchJobId) {
    where.batchJobId = batchJobId;
  }

  if (status) {
    where.status = status.toUpperCase();
  }

  if (minConfidence) {
    where.confidence = { gte: parseFloat(minConfidence) };
  }

  try {
    const annotations = await prisma.pendingAnnotation.findMany({
      where,
      include: {
        asset: {
          select: {
            id: true,
            fileName: true,
            storageUrl: true,
            thumbnailUrl: true,
          }
        },
        batchJob: {
          select: {
            id: true,
            weedType: true,
          }
        }
      },
      orderBy: { confidence: 'desc' },
      take: 100,
    });

    return NextResponse.json({
      success: true,
      annotations,
      count: annotations.length,
    });
  } catch (error) {
    console.error('Failed to list pending annotations:', error);
    return NextResponse.json(
      { error: 'Failed to list annotations', success: false },
      { status: 500 }
    );
  }
}

// POST: Bulk accept/reject annotations
export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const body = await request.json();
    const { annotationIds, action, sessionId } = body;

    if (!annotationIds?.length || !action) {
      return NextResponse.json(
        { error: 'annotationIds and action required', success: false },
        { status: 400 }
      );
    }

    // Validate annotation IDs format (CUID)
    for (const id of annotationIds) {
      if (typeof id !== 'string' || !/^c[a-z0-9]{24,}$/i.test(id)) {
        return NextResponse.json(
          { error: 'Invalid annotation ID format', success: false },
          { status: 400 }
        );
      }
    }

    if (!['accept', 'reject'].includes(action)) {
      return NextResponse.json(
        { error: 'action must be "accept" or "reject"', success: false },
        { status: 400 }
      );
    }

    // Get pending annotations
    const pendingAnnotations = await prisma.pendingAnnotation.findMany({
      where: { id: { in: annotationIds } },
      include: {
        asset: true,
        batchJob: true,
      }
    });

    if (pendingAnnotations.length === 0) {
      return NextResponse.json(
        { error: 'No annotations found', success: false },
        { status: 404 }
      );
    }

    const newStatus = action === 'accept' ? 'ACCEPTED' : 'REJECTED';

    // If accepting with a session, validate session ownership
    if (action === 'accept' && sessionId) {
      // Validate sessionId format
      if (!/^c[a-z0-9]{24,}$/i.test(sessionId)) {
        return NextResponse.json(
          { error: 'Invalid session ID format', success: false },
          { status: 400 }
        );
      }

      // Get the session and verify it exists
      const session = await prisma.annotationSession.findUnique({
        where: { id: sessionId },
        select: { id: true, assetId: true },
      });

      if (!session) {
        return NextResponse.json(
          { error: 'Session not found', success: false },
          { status: 404 }
        );
      }

      // Verify all pending annotations belong to the same asset as the session
      const assetIds = new Set(pendingAnnotations.map(a => a.assetId));
      if (assetIds.size > 1) {
        return NextResponse.json(
          { error: 'Cannot accept annotations from multiple assets in one session', success: false },
          { status: 400 }
        );
      }

      const annotationAssetId = pendingAnnotations[0].assetId;
      if (annotationAssetId !== session.assetId) {
        return NextResponse.json(
          { error: 'Session does not belong to the same asset as annotations', success: false },
          { status: 403 }
        );
      }

      // Use transaction for atomic accept operation
      await prisma.$transaction(async (tx) => {
        // Create ManualAnnotation records for each accepted annotation
        for (const pending of pendingAnnotations) {
          await tx.manualAnnotation.create({
            data: {
              sessionId,
              weedType: pending.weedType,
              confidence: pending.confidence >= 0.8 ? 'CERTAIN' : pending.confidence >= 0.5 ? 'LIKELY' : 'UNCERTAIN',
              coordinates: pending.polygon,
              geoCoordinates: pending.geoPolygon,
              centerLat: pending.centerLat,
              centerLon: pending.centerLon,
              notes: `Auto-detected via batch SAM3 (${Math.round(pending.confidence * 100)}% confidence)`,
              verified: true,
            }
          });
        }

        // Update pending annotation status
        await tx.pendingAnnotation.updateMany({
          where: { id: { in: annotationIds } },
          data: {
            status: newStatus,
            reviewedAt: new Date(),
          }
        });
      });
    } else {
      // For reject action or accept without session, just update status
      await prisma.pendingAnnotation.updateMany({
        where: { id: { in: annotationIds } },
        data: {
          status: newStatus,
          reviewedAt: new Date(),
        }
      });
    }

    return NextResponse.json({
      success: true,
      action,
      count: pendingAnnotations.length,
    });
  } catch (error) {
    console.error('Failed to update pending annotations:', error);
    return NextResponse.json(
      { error: 'Failed to update annotations', success: false },
      { status: 500 }
    );
  }
}
