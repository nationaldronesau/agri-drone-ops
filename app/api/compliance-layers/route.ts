import { ComplianceLayerType, ComplianceSourceFormat, Prisma } from '@prisma/client';
import area from '@turf/area';
import { multiPolygon, polygon } from '@turf/helpers';
import type { Feature, MultiPolygon, Polygon, Position } from 'geojson';
import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/db';
import { checkProjectAccess, getAuthenticatedUser, getUserTeamIds } from '@/lib/auth/api-auth';

type PolyFeature = Feature<Polygon | MultiPolygon>;

function toMultiPolygonCoordinates(feature: PolyFeature): Position[][][] {
  if (feature.geometry.type === 'Polygon') {
    return [feature.geometry.coordinates];
  }
  return feature.geometry.coordinates;
}

function extractPolygonFeaturesFromJson(value: unknown): PolyFeature[] {
  if (!value || typeof value !== 'object') return [];

  const record = value as Record<string, unknown>;
  const type = record.type;

  if (type === 'FeatureCollection' && Array.isArray(record.features)) {
    return record.features.flatMap((feature) => extractPolygonFeaturesFromJson(feature));
  }

  if (type === 'Feature' && record.geometry) {
    return extractPolygonFeaturesFromJson(record.geometry).map((feature) => ({
      ...feature,
      properties: typeof record.properties === 'object' && record.properties ? record.properties : {},
    }));
  }

  if (type === 'Polygon' && Array.isArray(record.coordinates)) {
    return [
      {
        type: 'Feature',
        properties: {},
        geometry: {
          type: 'Polygon',
          coordinates: record.coordinates as Position[][],
        },
      },
    ];
  }

  if (type === 'MultiPolygon' && Array.isArray(record.coordinates)) {
    return [
      {
        type: 'Feature',
        properties: {},
        geometry: {
          type: 'MultiPolygon',
          coordinates: record.coordinates as Position[][][],
        },
      },
    ];
  }

  return [];
}

function normalizeGeometry(input: unknown): { geometry: Polygon | MultiPolygon; featureCount: number; areaHa: number } | null {
  const features = extractPolygonFeaturesFromJson(input);
  if (features.length === 0) return null;

  const multiCoords = features.flatMap((feature) => toMultiPolygonCoordinates(feature));
  if (multiCoords.length === 0) return null;

  const geometry: Polygon | MultiPolygon =
    multiCoords.length === 1
      ? { type: 'Polygon', coordinates: multiCoords[0] }
      : { type: 'MultiPolygon', coordinates: multiCoords };

  const feature = geometry.type === 'Polygon' ? polygon(geometry.coordinates) : multiPolygon(geometry.coordinates);
  const areaHa = area(feature) / 10_000;

  return {
    geometry,
    featureCount: features.length,
    areaHa,
  };
}

export async function GET(request: NextRequest) {
  try {
    const auth = await getAuthenticatedUser();
    if (!auth.authenticated || !auth.userId) {
      return NextResponse.json({ error: auth.error || 'Unauthorized' }, { status: 401 });
    }

    const memberships = await getUserTeamIds();
    if (memberships.dbError) {
      return NextResponse.json({ error: 'Failed to load team memberships' }, { status: 500 });
    }

    if (memberships.teamIds.length === 0) {
      return NextResponse.json({ layers: [] });
    }

    const projectId = request.nextUrl.searchParams.get('projectId');
    if (projectId) {
      const access = await checkProjectAccess(projectId);
      if (!access.hasAccess) {
        return NextResponse.json({ error: access.error || 'Access denied' }, { status: 403 });
      }
    }

    const layers = await prisma.complianceLayer.findMany({
      where: {
        teamId: { in: memberships.teamIds },
        ...(projectId ? { projectId } : {}),
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
      orderBy: { createdAt: 'desc' },
    });

    return NextResponse.json({ layers });
  } catch (error) {
    console.error('[compliance-layers] list failed', error);
    return NextResponse.json({ error: 'Failed to load compliance layers' }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const auth = await getAuthenticatedUser();
    if (!auth.authenticated || !auth.userId) {
      return NextResponse.json({ error: auth.error || 'Unauthorized' }, { status: 401 });
    }

    const body = await request.json();
    const projectId = typeof body?.projectId === 'string' ? body.projectId : null;
    if (!projectId) {
      return NextResponse.json({ error: 'projectId is required' }, { status: 400 });
    }

    const access = await checkProjectAccess(projectId);
    if (!access.hasAccess || !access.teamId) {
      return NextResponse.json({ error: access.error || 'Access denied' }, { status: 403 });
    }

    const name = typeof body?.name === 'string' && body.name.trim() ? body.name.trim() : null;
    if (!name) {
      return NextResponse.json({ error: 'name is required' }, { status: 400 });
    }

    const layerTypeRaw = typeof body?.layerType === 'string' ? body.layerType.toUpperCase() : '';
    if (!(layerTypeRaw in ComplianceLayerType)) {
      return NextResponse.json({ error: 'Invalid layerType' }, { status: 400 });
    }

    const sourceFormatRaw = typeof body?.sourceFormat === 'string' ? body.sourceFormat.toUpperCase() : 'GEOJSON';
    if (!(sourceFormatRaw in ComplianceSourceFormat)) {
      return NextResponse.json({ error: 'Invalid sourceFormat' }, { status: 400 });
    }

    const normalized = normalizeGeometry(body?.geometry);
    if (!normalized) {
      return NextResponse.json({ error: 'geometry must contain Polygon or MultiPolygon GeoJSON' }, { status: 400 });
    }

    const bufferMeters =
      typeof body?.bufferMeters === 'number' && Number.isFinite(body.bufferMeters)
        ? Math.max(0, Math.min(5000, body.bufferMeters))
        : 0;

    const metadataInput =
      body?.metadata && typeof body.metadata === 'object' && !Array.isArray(body.metadata)
        ? (body.metadata as Record<string, unknown>)
        : {};

    const layer = await prisma.complianceLayer.create({
      data: {
        projectId,
        teamId: access.teamId,
        createdById: auth.userId,
        name,
        layerType: ComplianceLayerType[layerTypeRaw as keyof typeof ComplianceLayerType],
        sourceFormat: ComplianceSourceFormat[sourceFormatRaw as keyof typeof ComplianceSourceFormat],
        geometry: normalized.geometry as unknown as Prisma.InputJsonValue,
        bufferMeters,
        isActive: body?.isActive === false ? false : true,
        metadata: {
          ...metadataInput,
          importSummary: {
            featureCount: normalized.featureCount,
            areaHa: Number(normalized.areaHa.toFixed(4)),
          },
        } as Prisma.InputJsonValue,
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

    return NextResponse.json({ success: true, layer }, { status: 201 });
  } catch (error) {
    console.error('[compliance-layers] create failed', error);
    const message = error instanceof Error ? error.message : 'Failed to create compliance layer';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
