/**
 * Pending Annotations API
 *
 * Manage pending annotations from batch SAM3 processing.
 *
 * Security:
 * - Authentication required for all operations
 * - Project membership validation through batch job's project
 * - Session validation ensures session belongs to same asset AND project
 * - Transactions ensure atomic accept/reject operations
 * - Input validation on annotation IDs and actions
 */
import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { getAuthenticatedUser, checkProjectAccess } from '@/lib/auth/api-auth';

// GET: List pending annotations (requires auth + project access)
export async function GET(request: NextRequest): Promise<NextResponse> {
  // Authentication check
  const auth = await getAuthenticatedUser();
  if (!auth.authenticated || !auth.userId) {
    return NextResponse.json(
      { error: 'Authentication required', success: false },
      { status: 401 }
    );
  }

  const { searchParams } = new URL(request.url);
  const batchJobId = searchParams.get('batchJobId');
  const projectId = searchParams.get('projectId');
  const status = searchParams.get('status');
  const minConfidence = searchParams.get('minConfidence');

  // Must filter by batchJobId or projectId
  if (!batchJobId && !projectId) {
    return NextResponse.json(
      { error: 'batchJobId or projectId required', success: false },
      { status: 400 }
    );
  }

  // Validate ID formats
  if (batchJobId && !/^c[a-z0-9]{24,}$/i.test(batchJobId)) {
    return NextResponse.json(
      { error: 'Invalid batchJobId format', success: false },
      { status: 400 }
    );
  }
  if (projectId && !/^c[a-z0-9]{24,}$/i.test(projectId)) {
    return NextResponse.json(
      { error: 'Invalid projectId format', success: false },
      { status: 400 }
    );
  }

  try {
    // If filtering by batchJobId, get the project from the batch job
    let targetProjectId = projectId;
    if (batchJobId && !projectId) {
      const batchJob = await prisma.batchJob.findUnique({
        where: { id: batchJobId },
        select: { projectId: true },
      });
      if (!batchJob) {
        return NextResponse.json(
          { error: 'Batch job not found', success: false },
          { status: 404 }
        );
      }
      targetProjectId = batchJob.projectId;
    }

    // Verify project access
    const projectAccess = await checkProjectAccess(targetProjectId!);
    if (!projectAccess.hasAccess) {
      return NextResponse.json(
        { error: projectAccess.error || 'Access denied', success: false },
        { status: 403 }
      );
    }

    // Build query
    const where: Record<string, unknown> = {};

    if (batchJobId) {
      where.batchJobId = batchJobId;
    } else if (projectId) {
      // Filter by project through batch job
      where.batchJob = { projectId };
    }

    if (status) {
      where.status = status.toUpperCase();
    }

    if (minConfidence) {
      const confidence = parseFloat(minConfidence);
      if (!isNaN(confidence) && confidence >= 0 && confidence <= 1) {
        where.confidence = { gte: confidence };
      }
    }

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
            projectId: true,
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
  // Authentication check
  const auth = await getAuthenticatedUser();
  if (!auth.authenticated || !auth.userId) {
    return NextResponse.json(
      { error: 'Authentication required', success: false },
      { status: 401 }
    );
  }

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

    // Get pending annotations with project info
    const pendingAnnotations = await prisma.pendingAnnotation.findMany({
      where: { id: { in: annotationIds } },
      include: {
        asset: {
          select: {
            id: true,
            projectId: true,
          }
        },
        batchJob: {
          select: {
            id: true,
            projectId: true,
          }
        },
      }
    });

    if (pendingAnnotations.length === 0) {
      return NextResponse.json(
        { error: 'No annotations found', success: false },
        { status: 404 }
      );
    }

    // Verify all annotations are from the same project
    const projectIds = new Set(pendingAnnotations.map(a => a.batchJob.projectId));
    if (projectIds.size > 1) {
      return NextResponse.json(
        { error: 'Cannot modify annotations from multiple projects', success: false },
        { status: 400 }
      );
    }

    // Check project access
    const annotationProjectId = pendingAnnotations[0].batchJob.projectId;
    const projectAccess = await checkProjectAccess(annotationProjectId);
    if (!projectAccess.hasAccess) {
      return NextResponse.json(
        { error: projectAccess.error || 'Access denied', success: false },
        { status: 403 }
      );
    }

    const newStatus = action === 'accept' ? 'ACCEPTED' : 'REJECTED';

    // If accepting with a session, validate session ownership and project
    if (action === 'accept' && sessionId) {
      // Validate sessionId format
      if (!/^c[a-z0-9]{24,}$/i.test(sessionId)) {
        return NextResponse.json(
          { error: 'Invalid session ID format', success: false },
          { status: 400 }
        );
      }

      // Get the session with asset and project info
      const session = await prisma.annotationSession.findUnique({
        where: { id: sessionId },
        select: {
          id: true,
          assetId: true,
          asset: {
            select: {
              id: true,
              projectId: true,
            }
          }
        },
      });

      if (!session) {
        return NextResponse.json(
          { error: 'Session not found', success: false },
          { status: 404 }
        );
      }

      // Verify session belongs to the same project as the annotations
      if (session.asset.projectId !== annotationProjectId) {
        return NextResponse.json(
          { error: 'Session does not belong to the same project as annotations', success: false },
          { status: 403 }
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
            reviewedBy: auth.userId,
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
          reviewedBy: auth.userId,
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
