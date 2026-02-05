import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/db';
import { getAuthenticatedUser } from '@/lib/auth/api-auth';
import { datasetPreparation } from '@/lib/services/dataset-preparation';

function isDatasetVersionsEnabled(features: unknown): boolean {
  if (process.env.ENABLE_DATASET_VERSIONS === 'true') return true;
  if (!features || typeof features !== 'object') return false;
  return Boolean((features as Record<string, unknown>).datasetVersions);
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
      select: { id: true, features: true },
    });

    if (!project) {
      return NextResponse.json({ error: 'Project not found or access denied' }, { status: 403 });
    }

    if (!isDatasetVersionsEnabled(project.features)) {
      return NextResponse.json({ error: 'Feature not enabled' }, { status: 403 });
    }

    const body = await request.json();
    const { splits, filters, classes } = body || {};
    const selectedClasses = Array.isArray(classes) && classes.length > 0
      ? classes
      : Array.isArray(filters?.weedTypes) && filters.weedTypes.length > 0
        ? filters.weedTypes
        : undefined;

    const preview = await datasetPreparation.previewDataset({
      projectId,
      classes: selectedClasses,
      splitRatio: splits,
      includeAIDetections: filters?.includeAIDetections ?? true,
      includeManualAnnotations: filters?.includeManual ?? true,
      includeSAM3: filters?.includeSAM3 ?? false,
      minConfidence: filters?.minConfidence ?? 0.5,
      verifiedOnly: filters?.verifiedOnly ?? false,
      createdBefore: new Date(),
    });

    return NextResponse.json({ preview });
  } catch (error) {
    console.error('Error previewing dataset version:', error);
    return NextResponse.json({ error: 'Failed to preview dataset version' }, { status: 500 });
  }
}
