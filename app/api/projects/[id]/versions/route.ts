import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/db';
import { getAuthenticatedUser } from '@/lib/auth/api-auth';
import { trainingDatasetVersionService } from '@/lib/services/training-dataset-version';

function isDatasetVersionsEnabled(features: unknown): boolean {
  if (process.env.ENABLE_DATASET_VERSIONS === 'true') return true;
  if (!features || typeof features !== 'object') return false;
  return Boolean((features as Record<string, unknown>).datasetVersions);
}

function parseJsonArray(value: string | null | undefined): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function parseJsonObject(value: string | null | undefined) {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const auth = await getAuthenticatedUser();
    if (!auth.authenticated || !auth.userId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { id: projectId } = await params;
    const project = await prisma.project.findFirst({
      where: {
        id: projectId,
        team: { members: { some: { userId: auth.userId } } },
      },
      select: {
        id: true,
        teamId: true,
        features: true,
      },
    });

    if (!project) {
      return NextResponse.json({ error: 'Project not found or access denied' }, { status: 403 });
    }

    if (!isDatasetVersionsEnabled(project.features)) {
      return NextResponse.json({ error: 'Feature not enabled' }, { status: 403 });
    }

    const body = await request.json();
    const {
      idempotencyKey,
      displayName,
      name,
      preprocessing,
      augmentation,
      splits,
      filters,
      classes,
    } = body || {};

    if (splits) {
      const total = (splits.train ?? 0) + (splits.val ?? 0) + (splits.test ?? 0);
      if (total <= 0) {
        return NextResponse.json({ error: 'splits must have positive values' }, { status: 400 });
      }
    }

    const result = await trainingDatasetVersionService.createVersion({
      projectId,
      teamId: project.teamId,
      createdById: auth.userId,
      name,
      displayName,
      idempotencyKey,
      classes,
      preprocessing,
      augmentation,
      splits,
      filters,
    });

    const dataset = result.dataset;
    const preview = result.preview;

    return NextResponse.json({
      dataset: {
        ...dataset,
        classes: parseJsonArray(dataset.classes),
        augmentationConfig: parseJsonObject(dataset.augmentationConfig),
      },
      stats: {
        imageCount: preview.imageCount,
        annotationCount: preview.labelCount,
        classCounts: preview.classCounts,
        nextVersion: dataset.version,
      },
    });
  } catch (error) {
    console.error('Error creating dataset version:', error);
    const message = error instanceof Error ? error.message : 'Failed to create dataset version';
    const status = message.toLowerCase().includes('no annotated images') ? 400 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const auth = await getAuthenticatedUser();
    if (!auth.authenticated || !auth.userId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { id: projectId } = await params;
    const project = await prisma.project.findFirst({
      where: {
        id: projectId,
        team: { members: { some: { userId: auth.userId } } },
      },
      select: {
        id: true,
        name: true,
        features: true,
        _count: { select: { assets: true } },
      },
    });

    if (!project) {
      return NextResponse.json({ error: 'Project not found or access denied' }, { status: 403 });
    }

    const [versions, manualCount, detectionCount] = await Promise.all([
      trainingDatasetVersionService.listVersions(projectId),
      prisma.manualAnnotation.count({
        where: { session: { asset: { projectId } }, verified: true },
      }),
      prisma.detection.count({
        where: {
          asset: { projectId },
          type: { in: ['AI', 'YOLO_LOCAL'] },
          rejected: false,
        },
      }),
    ]);

    const formatted = versions.map((version) => ({
      ...version,
      classes: parseJsonArray(version.classes),
      augmentationConfig: parseJsonObject(version.augmentationConfig),
    }));

    return NextResponse.json({
      versions: formatted,
      project: {
        id: project.id,
        name: project.name,
        totalImages: project._count.assets,
        totalAnnotations: manualCount + detectionCount,
      },
      featureEnabled: isDatasetVersionsEnabled(project.features),
    });
  } catch (error) {
    console.error('Error listing dataset versions:', error);
    return NextResponse.json({ error: 'Failed to list dataset versions' }, { status: 500 });
  }
}
