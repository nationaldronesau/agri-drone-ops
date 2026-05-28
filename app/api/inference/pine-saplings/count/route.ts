/**
 * Pine Sapling Count API Route
 *
 * GET /api/inference/pine-saplings/count - Count stored georeferenced detections
 */
import { NextRequest, NextResponse } from 'next/server';
import { Prisma } from '@prisma/client';
import prisma from '@/lib/db';
import { checkProjectAccess } from '@/lib/auth/api-auth';
import { clusterPineSaplingDetections } from '@/lib/services/pine-sapling-count';
import {
  PINE_SAPLING_CLASS_NAME,
  PINE_SAPLING_PROJECT_ID,
  PINE_SAPLING_YOLO_MODEL_ID,
} from '@/lib/services/yolo';

const MAX_RETURNED_CLUSTERS = 500;

function parseBoolean(value: string | null): boolean {
  if (!value) {
    return false;
  }
  return ['1', 'true', 'yes'].includes(value.toLowerCase());
}

function parseClusterRadiusMeters(value: string | null): number {
  if (!value) {
    return 0;
  }

  const radius = Number.parseFloat(value);
  if (!Number.isFinite(radius) || radius < 0) {
    return 0;
  }

  return Math.min(radius, 50);
}

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const projectId = searchParams.get('projectId') || PINE_SAPLING_PROJECT_ID;
    const modelId = searchParams.get('modelId') || PINE_SAPLING_YOLO_MODEL_ID;
    const reviewedOnly = parseBoolean(searchParams.get('reviewedOnly'));
    const clusterRadiusMeters = parseClusterRadiusMeters(
      searchParams.get('clusterRadiusMeters')
    );

    const projectAccess = await checkProjectAccess(projectId);
    if (!projectAccess.authenticated) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    if (!projectAccess.hasAccess) {
      return NextResponse.json(
        { error: projectAccess.error || 'Access denied' },
        { status: 403 }
      );
    }

    const where: Prisma.DetectionWhereInput = {
      customModelId: modelId,
      className: PINE_SAPLING_CLASS_NAME,
      rejected: false,
      centerLat: { not: null },
      centerLon: { not: null },
      asset: { projectId },
      ...(reviewedOnly
        ? {
            OR: [{ verified: true }, { userCorrected: true }],
          }
        : {}),
    };

    const detections = await prisma.detection.findMany({
      where,
      select: {
        id: true,
        assetId: true,
        centerLat: true,
        centerLon: true,
        confidence: true,
      },
      orderBy: { createdAt: 'desc' },
    });

    const clusters = clusterPineSaplingDetections(detections, clusterRadiusMeters);

    return NextResponse.json({
      projectId,
      modelId,
      className: PINE_SAPLING_CLASS_NAME,
      reviewedOnly,
      clusterRadiusMeters,
      storedDetections: detections.length,
      georeferencedDetections: detections.length,
      count: clusters.length,
      clustersReturned: Math.min(clusters.length, MAX_RETURNED_CLUSTERS),
      clustersTruncated: clusters.length > MAX_RETURNED_CLUSTERS,
      clusters: clusters.slice(0, MAX_RETURNED_CLUSTERS),
    });
  } catch (error) {
    console.error('Error counting pine saplings:', error);
    return NextResponse.json(
      { error: 'Failed to count pine saplings' },
      { status: 500 }
    );
  }
}
