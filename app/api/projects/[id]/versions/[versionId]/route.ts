import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/db';
import { getAuthenticatedUser, getUserTeamMemberships, canManageTeam } from '@/lib/auth/api-auth';
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

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; versionId: string }> }
) {
  try {
    const auth = await getAuthenticatedUser();
    if (!auth.authenticated || !auth.userId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { id: projectId, versionId } = await params;
    const dataset = await trainingDatasetVersionService.getVersionWithStats(versionId);

    if (!dataset || dataset.projectId !== projectId) {
      return NextResponse.json({ error: 'Version not found' }, { status: 404 });
    }

    const hasAccess = await prisma.project.findFirst({
      where: {
        id: projectId,
        team: { members: { some: { userId: auth.userId } } },
      },
      select: { id: true, features: true },
    });

    if (!hasAccess) {
      return NextResponse.json({ error: 'Project not found or access denied' }, { status: 403 });
    }

    return NextResponse.json({
      dataset: {
        ...dataset,
        classes: parseJsonArray(dataset.classes),
        augmentationConfig: parseJsonObject(dataset.augmentationConfig),
      },
      featureEnabled: isDatasetVersionsEnabled(hasAccess.features),
    });
  } catch (error) {
    console.error('Error fetching dataset version:', error);
    return NextResponse.json({ error: 'Failed to fetch dataset version' }, { status: 500 });
  }
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; versionId: string }> }
) {
  try {
    const auth = await getAuthenticatedUser();
    if (!auth.authenticated || !auth.userId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { id: projectId, versionId } = await params;
    const project = await prisma.project.findUnique({
      where: { id: projectId },
      select: { id: true, teamId: true, features: true },
    });

    if (!project) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 });
    }

    const memberships = await getUserTeamMemberships();
    if (memberships.dbError) {
      return NextResponse.json({ error: 'Database error' }, { status: 500 });
    }

    if (!canManageTeam(memberships.memberships, project.teamId)) {
      return NextResponse.json({ error: 'Access denied' }, { status: 403 });
    }

    if (!isDatasetVersionsEnabled(project.features)) {
      return NextResponse.json({ error: 'Feature not enabled' }, { status: 403 });
    }

    const dataset = await prisma.trainingDataset.findUnique({
      where: { id: versionId },
      select: { id: true, projectId: true },
    });
    if (!dataset || dataset.projectId !== projectId) {
      return NextResponse.json({ error: 'Version not found' }, { status: 404 });
    }

    const body = await request.json();
    const { status } = body || {};
    if (!status || typeof status !== 'string') {
      return NextResponse.json({ error: 'status is required' }, { status: 400 });
    }
    const allowed = new Set(['CREATING', 'READY', 'TRAINING', 'FAILED', 'ARCHIVED']);
    if (!allowed.has(status)) {
      return NextResponse.json({ error: 'Invalid status' }, { status: 400 });
    }

    const updated = await prisma.trainingDataset.update({
      where: { id: versionId },
      data: { status },
    });

    return NextResponse.json({ dataset: updated });
  } catch (error) {
    console.error('Error updating dataset version:', error);
    return NextResponse.json({ error: 'Failed to update dataset version' }, { status: 500 });
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; versionId: string }> }
) {
  try {
    const auth = await getAuthenticatedUser();
    if (!auth.authenticated || !auth.userId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { id: projectId, versionId } = await params;
    const project = await prisma.project.findUnique({
      where: { id: projectId },
      select: { id: true, teamId: true, features: true },
    });

    if (!project) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 });
    }

    const memberships = await getUserTeamMemberships();
    if (memberships.dbError) {
      return NextResponse.json({ error: 'Database error' }, { status: 500 });
    }

    if (!canManageTeam(memberships.memberships, project.teamId)) {
      return NextResponse.json({ error: 'Access denied' }, { status: 403 });
    }

    if (!isDatasetVersionsEnabled(project.features)) {
      return NextResponse.json({ error: 'Feature not enabled' }, { status: 403 });
    }

    const dataset = await prisma.trainingDataset.findUnique({
      where: { id: versionId },
      select: { id: true, projectId: true },
    });
    if (!dataset || dataset.projectId !== projectId) {
      return NextResponse.json({ error: 'Version not found' }, { status: 404 });
    }

    const updated = await prisma.trainingDataset.update({
      where: { id: versionId },
      data: { status: 'ARCHIVED' },
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Error archiving dataset version:', error);
    return NextResponse.json({ error: 'Failed to archive dataset version' }, { status: 500 });
  }
}
