import { ComplianceLayerType, ComplianceSourceFormat } from '@prisma/client';
import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/db';
import { getAuthenticatedUser, getUserTeamIds } from '@/lib/auth/api-auth';

export async function GET(_request: NextRequest, { params }: { params: { id: string } }) {
  try {
    const auth = await getAuthenticatedUser();
    if (!auth.authenticated || !auth.userId) {
      return NextResponse.json({ error: auth.error || 'Unauthorized' }, { status: 401 });
    }

    const memberships = await getUserTeamIds();
    if (memberships.dbError) {
      return NextResponse.json({ error: 'Failed to load team memberships' }, { status: 500 });
    }

    const layer = await prisma.complianceLayer.findFirst({
      where: {
        id: params.id,
        teamId: { in: memberships.teamIds },
      },
      include: {
        project: {
          select: {
            id: true,
            name: true,
            location: true,
          },
        },
      },
    });

    if (!layer) {
      return NextResponse.json({ error: 'Compliance layer not found' }, { status: 404 });
    }

    return NextResponse.json(layer);
  } catch (error) {
    console.error('[compliance-layer] detail failed', error);
    return NextResponse.json({ error: 'Failed to load compliance layer' }, { status: 500 });
  }
}

export async function PATCH(request: NextRequest, { params }: { params: { id: string } }) {
  try {
    const auth = await getAuthenticatedUser();
    if (!auth.authenticated || !auth.userId) {
      return NextResponse.json({ error: auth.error || 'Unauthorized' }, { status: 401 });
    }

    const memberships = await getUserTeamIds();
    if (memberships.dbError) {
      return NextResponse.json({ error: 'Failed to load team memberships' }, { status: 500 });
    }

    const existing = await prisma.complianceLayer.findFirst({
      where: {
        id: params.id,
        teamId: { in: memberships.teamIds },
      },
      select: { id: true },
    });

    if (!existing) {
      return NextResponse.json({ error: 'Compliance layer not found' }, { status: 404 });
    }

    const body = await request.json();
    const patch: Record<string, unknown> = {};

    if (typeof body?.name === 'string' && body.name.trim()) {
      patch.name = body.name.trim();
    }

    if (typeof body?.bufferMeters === 'number' && Number.isFinite(body.bufferMeters)) {
      patch.bufferMeters = Math.max(0, Math.min(5000, body.bufferMeters));
    }

    if (typeof body?.isActive === 'boolean') {
      patch.isActive = body.isActive;
    }

    if (typeof body?.layerType === 'string') {
      const layerTypeRaw = body.layerType.toUpperCase();
      if (!(layerTypeRaw in ComplianceLayerType)) {
        return NextResponse.json({ error: 'Invalid layerType' }, { status: 400 });
      }
      patch.layerType = ComplianceLayerType[layerTypeRaw as keyof typeof ComplianceLayerType];
    }

    if (typeof body?.sourceFormat === 'string') {
      const sourceFormatRaw = body.sourceFormat.toUpperCase();
      if (!(sourceFormatRaw in ComplianceSourceFormat)) {
        return NextResponse.json({ error: 'Invalid sourceFormat' }, { status: 400 });
      }
      patch.sourceFormat = ComplianceSourceFormat[sourceFormatRaw as keyof typeof ComplianceSourceFormat];
    }

    if (Object.keys(patch).length === 0) {
      return NextResponse.json({ error: 'No valid fields to update' }, { status: 400 });
    }

    const layer = await prisma.complianceLayer.update({
      where: { id: params.id },
      data: patch,
      include: {
        project: {
          select: {
            id: true,
            name: true,
            location: true,
          },
        },
      },
    });

    return NextResponse.json({ success: true, layer });
  } catch (error) {
    console.error('[compliance-layer] update failed', error);
    return NextResponse.json({ error: 'Failed to update compliance layer' }, { status: 500 });
  }
}

export async function DELETE(_request: NextRequest, { params }: { params: { id: string } }) {
  try {
    const auth = await getAuthenticatedUser();
    if (!auth.authenticated || !auth.userId) {
      return NextResponse.json({ error: auth.error || 'Unauthorized' }, { status: 401 });
    }

    const memberships = await getUserTeamIds();
    if (memberships.dbError) {
      return NextResponse.json({ error: 'Failed to load team memberships' }, { status: 500 });
    }

    const existing = await prisma.complianceLayer.findFirst({
      where: {
        id: params.id,
        teamId: { in: memberships.teamIds },
      },
      select: { id: true },
    });

    if (!existing) {
      return NextResponse.json({ error: 'Compliance layer not found' }, { status: 404 });
    }

    await prisma.complianceLayer.delete({ where: { id: params.id } });
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('[compliance-layer] delete failed', error);
    return NextResponse.json({ error: 'Failed to delete compliance layer' }, { status: 500 });
  }
}
