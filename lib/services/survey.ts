import { Prisma } from '@prisma/client';
import area from '@turf/area';
import buffer from '@turf/buffer';
import { featureCollection, multiPolygon, point } from '@turf/helpers';
import union from '@turf/union';
import type { Feature, MultiPolygon, Polygon } from 'geojson';
import prisma from '@/lib/db';

type PolyFeature = Feature<Polygon | MultiPolygon>;
type AssetCoverageInput = {
  id: string;
  flightSession: string | null;
  flightDate: Date | null;
  createdAt: Date;
  gpsLatitude: number | null;
  gpsLongitude: number | null;
  altitude: number | null;
  cameraFov: number | null;
};

type BackfillState = {
  status: 'idle' | 'running' | 'completed' | 'failed';
  startedAt?: string;
  endedAt?: string;
  error?: string;
};

const SURVEY_BACKFILL_STATES = new Map<string, BackfillState>();
const MIN_COVERAGE_RADIUS_M = 12;
const MAX_COVERAGE_RADIUS_M = 80;
const FALLBACK_COVERAGE_RADIUS_M = 25;

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function toUtcDateStamp(value: Date): string {
  const year = value.getUTCFullYear();
  const month = String(value.getUTCMonth() + 1).padStart(2, '0');
  const day = String(value.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function slugifySurveyKey(value: string): string {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120);
  return slug || 'survey';
}

export function deriveSurveyKey(input: {
  flightSession?: string | null;
  flightDate?: Date | null;
  createdAt?: Date | null;
}): string {
  const flightSession = typeof input.flightSession === 'string' ? input.flightSession.trim() : '';
  if (flightSession.length > 0) {
    return slugifySurveyKey(flightSession);
  }

  const sourceDate = input.flightDate || input.createdAt || new Date();
  return `date-${toUtcDateStamp(sourceDate)}`;
}

function deriveSurveyNameFromKey(key: string): string {
  if (key.startsWith('date-')) {
    return `Survey ${key.replace(/^date-/, '')}`;
  }

  return key
    .split('-')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function isFiniteCoordinate(lat: number | null, lon: number | null): lat is number {
  return (
    typeof lat === 'number' &&
    typeof lon === 'number' &&
    Number.isFinite(lat) &&
    Number.isFinite(lon) &&
    lat >= -90 &&
    lat <= 90 &&
    lon >= -180 &&
    lon <= 180
  );
}

function computeCoverageRadiusMeters(asset: AssetCoverageInput): number {
  if (
    typeof asset.altitude === 'number' &&
    Number.isFinite(asset.altitude) &&
    typeof asset.cameraFov === 'number' &&
    Number.isFinite(asset.cameraFov)
  ) {
    const safeAltitude = asset.altitude > 0 ? asset.altitude : 30;
    const safeFov = clamp(asset.cameraFov, 1, 170);
    const radius = safeAltitude * Math.tan((safeFov * Math.PI) / 360);
    return clamp(radius, MIN_COVERAGE_RADIUS_M, MAX_COVERAGE_RADIUS_M);
  }

  return FALLBACK_COVERAGE_RADIUS_M;
}

function toMultiPolygonCoordinates(feature: PolyFeature): number[][][][] {
  if (feature.geometry.type === 'Polygon') {
    return [feature.geometry.coordinates as number[][][]];
  }
  return feature.geometry.coordinates as number[][][][];
}

function mergePolygonFeatures(features: PolyFeature[]): PolyFeature | null {
  if (features.length === 0) return null;
  if (features.length === 1) return features[0];

  let merged = features[0];
  for (let i = 1; i < features.length; i += 1) {
    const next = features[i];
    const candidate = union(featureCollection([merged, next]));
    if (candidate) {
      merged = candidate as PolyFeature;
      continue;
    }

    merged = multiPolygon([
      ...toMultiPolygonCoordinates(merged),
      ...toMultiPolygonCoordinates(next),
    ]) as PolyFeature;
  }

  return merged;
}

function computeCoverageGeometry(assets: AssetCoverageInput[]): {
  geometry: Prisma.JsonValue | null;
  coverageMethod: string | null;
  coverageAreaHa: number | null;
} {
  const circles: PolyFeature[] = [];
  for (const asset of assets) {
    if (!isFiniteCoordinate(asset.gpsLatitude, asset.gpsLongitude)) continue;
    const radius = computeCoverageRadiusMeters(asset);
    const feature = buffer(
      point([asset.gpsLongitude as number, asset.gpsLatitude as number]),
      radius,
      { units: 'meters' }
    ) as PolyFeature | null;
    if (feature) {
      circles.push(feature);
    }
  }

  if (circles.length === 0) {
    return {
      geometry: null,
      coverageMethod: null,
      coverageAreaHa: null,
    };
  }

  const merged = mergePolygonFeatures(circles);
  if (!merged) {
    return {
      geometry: null,
      coverageMethod: null,
      coverageAreaHa: null,
    };
  }

  return {
    geometry: merged.geometry as unknown as Prisma.JsonValue,
    coverageMethod: 'buffer_union',
    coverageAreaHa: Number((area(merged) / 10000).toFixed(4)),
  };
}

type BackfillGroup = {
  key: string;
  name: string;
  startedAt: Date;
  endedAt: Date;
  assets: AssetCoverageInput[];
};

function groupAssetsBySurvey(assets: AssetCoverageInput[]): BackfillGroup[] {
  const groups = new Map<string, BackfillGroup>();

  for (const asset of assets) {
    const key = deriveSurveyKey({
      flightSession: asset.flightSession,
      flightDate: asset.flightDate,
      createdAt: asset.createdAt,
    });
    const timestamp = asset.flightDate || asset.createdAt;
    const existing = groups.get(key);
    if (!existing) {
      groups.set(key, {
        key,
        name:
          typeof asset.flightSession === 'string' && asset.flightSession.trim().length > 0
            ? asset.flightSession.trim()
            : deriveSurveyNameFromKey(key),
        startedAt: timestamp,
        endedAt: timestamp,
        assets: [asset],
      });
      continue;
    }

    if (timestamp < existing.startedAt) {
      existing.startedAt = timestamp;
    }
    if (timestamp > existing.endedAt) {
      existing.endedAt = timestamp;
    }
    existing.assets.push(asset);
  }

  return Array.from(groups.values()).sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime());
}

export async function resolveSurveyForAsset(
  tx: Prisma.TransactionClient,
  input: {
    projectId: string;
    teamId: string;
    flightSession?: string | null;
    flightDate?: Date | null;
    createdAt: Date;
  }
): Promise<string> {
  const surveyKey = deriveSurveyKey({
    flightSession: input.flightSession,
    flightDate: input.flightDate,
    createdAt: input.createdAt,
  });

  const surveyName =
    typeof input.flightSession === 'string' && input.flightSession.trim().length > 0
      ? input.flightSession.trim()
      : deriveSurveyNameFromKey(surveyKey);
  const timestamp = input.flightDate || input.createdAt;

  const existing = await tx.survey.findUnique({
    where: {
      projectId_surveyKey: {
        projectId: input.projectId,
        surveyKey,
      },
    },
    select: {
      id: true,
      startedAt: true,
      endedAt: true,
      assetCount: true,
      name: true,
    },
  });

  if (!existing) {
    const created = await tx.survey.create({
      data: {
        teamId: input.teamId,
        projectId: input.projectId,
        surveyKey,
        name: surveyName,
        startedAt: timestamp,
        endedAt: timestamp,
        assetCount: 1,
      },
      select: { id: true },
    });
    return created.id;
  }

  await tx.survey.update({
    where: { id: existing.id },
    data: {
      startedAt: timestamp < existing.startedAt ? timestamp : existing.startedAt,
      endedAt: timestamp > existing.endedAt ? timestamp : existing.endedAt,
      assetCount: { increment: 1 },
      name: existing.name || surveyName,
      status: 'ACTIVE',
    },
  });

  return existing.id;
}

export async function backfillProjectSurveys(projectId: string): Promise<{
  totalAssets: number;
  assignedAssets: number;
  surveys: number;
}> {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { id: true, teamId: true },
  });
  if (!project) {
    throw new Error('Project not found');
  }

  const assets = await prisma.asset.findMany({
    where: { projectId },
    select: {
      id: true,
      flightSession: true,
      flightDate: true,
      createdAt: true,
      gpsLatitude: true,
      gpsLongitude: true,
      altitude: true,
      cameraFov: true,
    },
  });

  if (assets.length === 0) {
    return { totalAssets: 0, assignedAssets: 0, surveys: 0 };
  }

  const groups = groupAssetsBySurvey(assets);
  const surveyByKey = new Map<string, string>();

  await prisma.$transaction(async (tx) => {
    for (const group of groups) {
      const coverage = computeCoverageGeometry(group.assets);
      const existing = await tx.survey.findUnique({
        where: {
          projectId_surveyKey: {
            projectId,
            surveyKey: group.key,
          },
        },
        select: {
          id: true,
          startedAt: true,
          endedAt: true,
          metadata: true,
          coverageMethod: true,
        },
      });

      if (!existing) {
        const created = await tx.survey.create({
          data: {
            teamId: project.teamId,
            projectId,
            name: group.name,
            surveyKey: group.key,
            startedAt: group.startedAt,
            endedAt: group.endedAt,
            assetCount: group.assets.length,
            coverageGeometry: coverage.geometry as Prisma.InputJsonValue | undefined,
            coverageMethod: coverage.coverageMethod,
            metadata: coverage.coverageAreaHa == null
              ? undefined
              : ({ coverageAreaHa: coverage.coverageAreaHa } as Prisma.InputJsonValue),
          },
          select: { id: true },
        });
        surveyByKey.set(group.key, created.id);
        continue;
      }

      const metadataRecord =
        existing.metadata && typeof existing.metadata === 'object' && !Array.isArray(existing.metadata)
          ? (existing.metadata as Record<string, unknown>)
          : {};

      const updated = await tx.survey.update({
        where: { id: existing.id },
        data: {
          name: group.name,
          startedAt: group.startedAt < existing.startedAt ? group.startedAt : existing.startedAt,
          endedAt: group.endedAt > existing.endedAt ? group.endedAt : existing.endedAt,
          assetCount: group.assets.length,
          coverageGeometry: coverage.geometry as Prisma.InputJsonValue | undefined,
          coverageMethod: coverage.coverageMethod ?? existing.coverageMethod ?? null,
          metadata: {
            ...metadataRecord,
            ...(coverage.coverageAreaHa != null ? { coverageAreaHa: coverage.coverageAreaHa } : {}),
          } as Prisma.InputJsonValue,
          status: 'ACTIVE',
        },
        select: { id: true },
      });
      surveyByKey.set(group.key, updated.id);
    }

    await tx.asset.updateMany({
      where: { projectId },
      data: { surveyId: null },
    });

    for (const group of groups) {
      const surveyId = surveyByKey.get(group.key);
      if (!surveyId) continue;
      const ids = group.assets.map((asset) => asset.id);
      await tx.asset.updateMany({
        where: { id: { in: ids } },
        data: { surveyId },
      });
    }
  });

  const assignedAssets = await prisma.asset.count({
    where: { projectId, surveyId: { not: null } },
  });

  return {
    totalAssets: assets.length,
    assignedAssets,
    surveys: groups.length,
  };
}

export function scheduleProjectSurveyBackfill(projectId: string): void {
  const existingState = SURVEY_BACKFILL_STATES.get(projectId);
  if (existingState?.status === 'running') return;

  const startedAt = new Date().toISOString();

  SURVEY_BACKFILL_STATES.set(projectId, {
    status: 'running',
    startedAt,
  });

  setTimeout(() => {
    void backfillProjectSurveys(projectId)
      .then(() => {
        SURVEY_BACKFILL_STATES.set(projectId, {
          status: 'completed',
          startedAt,
          endedAt: new Date().toISOString(),
        });
      })
      .catch((error) => {
        SURVEY_BACKFILL_STATES.set(projectId, {
          status: 'failed',
          startedAt,
          endedAt: new Date().toISOString(),
          error: error instanceof Error ? error.message : 'Backfill failed',
        });
      });
  }, 0);
}

export async function getProjectSurveyBackfillStatus(projectId: string): Promise<{
  status: BackfillState['status'];
  startedAt?: string;
  endedAt?: string;
  error?: string;
  totalAssets: number;
  assignedAssets: number;
  stale: boolean;
}> {
  const [totalAssets, assignedAssets] = await Promise.all([
    prisma.asset.count({ where: { projectId } }),
    prisma.asset.count({ where: { projectId, surveyId: { not: null } } }),
  ]);

  const stale = totalAssets > 0 && assignedAssets < totalAssets;
  const state = SURVEY_BACKFILL_STATES.get(projectId);

  return {
    status: state?.status || 'idle',
    startedAt: state?.startedAt,
    endedAt: state?.endedAt,
    error: state?.error,
    totalAssets,
    assignedAssets,
    stale,
  };
}

export async function listProjectSurveys(projectId: string) {
  return prisma.survey.findMany({
    where: { projectId },
    orderBy: [{ startedAt: 'desc' }, { createdAt: 'desc' }],
    select: {
      id: true,
      name: true,
      surveyKey: true,
      status: true,
      startedAt: true,
      endedAt: true,
      assetCount: true,
      coverageGeometry: true,
      coverageMethod: true,
      metadata: true,
      createdAt: true,
      updatedAt: true,
    },
  });
}
