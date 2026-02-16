import { NextRequest, NextResponse } from 'next/server';
import JSZip from 'jszip';
import type { Prisma } from '@prisma/client';
import prisma from '@/lib/db';
import { getAuthenticatedUser, getUserTeamIds } from '@/lib/auth/api-auth';

function escapeCsv(field: unknown): string {
  const str = String(field ?? '');
  if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function escapeXml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function parseLineStringCoordinates(value: Prisma.JsonValue | null | undefined): Array<[number, number]> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];

  const geometry = value as Record<string, Prisma.JsonValue>;
  if (geometry.type !== 'LineString' || !Array.isArray(geometry.coordinates)) {
    return [];
  }

  const coords: Array<[number, number]> = [];
  for (const point of geometry.coordinates) {
    if (!Array.isArray(point) || point.length < 2) continue;
    const lon = typeof point[0] === 'number' ? point[0] : NaN;
    const lat = typeof point[1] === 'number' ? point[1] : NaN;
    if (Number.isFinite(lon) && Number.isFinite(lat)) {
      coords.push([lon, lat]);
    }
  }

  return coords;
}

function parsePolygonRing(value: Prisma.JsonValue | null | undefined): Array<[number, number]> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];

  const geometry = value as Record<string, Prisma.JsonValue>;
  if (geometry.type !== 'Polygon' || !Array.isArray(geometry.coordinates)) {
    return [];
  }

  const firstRing = geometry.coordinates[0];
  if (!Array.isArray(firstRing)) return [];

  const coords: Array<[number, number]> = [];
  for (const point of firstRing) {
    if (!Array.isArray(point) || point.length < 2) continue;
    const lon = typeof point[0] === 'number' ? point[0] : NaN;
    const lat = typeof point[1] === 'number' ? point[1] : NaN;
    if (Number.isFinite(lon) && Number.isFinite(lat)) {
      coords.push([lon, lat]);
    }
  }

  return coords;
}

function toSlug(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

type ParsedMissionMetadata = {
  routeOptimization: {
    baselineDistanceM: number | null;
    optimizedDistanceM: number | null;
    improvementM: number | null;
    improvementPct: number | null;
  };
  weather: {
    decision: string | null;
    riskScore: number | null;
    startTimeUtc: string | null;
    endTimeUtc: string | null;
    avgWindSpeedMps: number | null;
    maxWindGustMps: number | null;
    maxPrecipProbability: number | null;
  };
};

function parseMissionMetadata(value: Prisma.JsonValue | null | undefined): ParsedMissionMetadata {
  const defaults: ParsedMissionMetadata = {
    routeOptimization: {
      baselineDistanceM: null,
      optimizedDistanceM: null,
      improvementM: null,
      improvementPct: null,
    },
    weather: {
      decision: null,
      riskScore: null,
      startTimeUtc: null,
      endTimeUtc: null,
      avgWindSpeedMps: null,
      maxWindGustMps: null,
      maxPrecipProbability: null,
    },
  };

  if (!value || typeof value !== 'object' || Array.isArray(value)) return defaults;
  const record = value as Record<string, Prisma.JsonValue>;
  const routeRaw = record.routeOptimization;
  const weatherRaw = record.weather;

  if (routeRaw && typeof routeRaw === 'object' && !Array.isArray(routeRaw)) {
    const route = routeRaw as Record<string, Prisma.JsonValue>;
    defaults.routeOptimization.baselineDistanceM =
      typeof route.baselineDistanceM === 'number' ? route.baselineDistanceM : null;
    defaults.routeOptimization.optimizedDistanceM =
      typeof route.optimizedDistanceM === 'number' ? route.optimizedDistanceM : null;
    defaults.routeOptimization.improvementM =
      typeof route.improvementM === 'number' ? route.improvementM : null;
    defaults.routeOptimization.improvementPct =
      typeof route.improvementPct === 'number' ? route.improvementPct : null;
  }

  if (weatherRaw && typeof weatherRaw === 'object' && !Array.isArray(weatherRaw)) {
    const weather = weatherRaw as Record<string, Prisma.JsonValue>;
    defaults.weather.decision = typeof weather.decision === 'string' ? weather.decision : null;
    defaults.weather.riskScore = typeof weather.riskScore === 'number' ? weather.riskScore : null;
    defaults.weather.startTimeUtc = typeof weather.startTimeUtc === 'string' ? weather.startTimeUtc : null;
    defaults.weather.endTimeUtc = typeof weather.endTimeUtc === 'string' ? weather.endTimeUtc : null;
    defaults.weather.avgWindSpeedMps =
      typeof weather.avgWindSpeedMps === 'number' ? weather.avgWindSpeedMps : null;
    defaults.weather.maxWindGustMps =
      typeof weather.maxWindGustMps === 'number' ? weather.maxWindGustMps : null;
    defaults.weather.maxPrecipProbability =
      typeof weather.maxPrecipProbability === 'number' ? weather.maxPrecipProbability : null;
  }

  return defaults;
}

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

    const plan = await prisma.sprayPlan.findFirst({
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
        missions: {
          orderBy: { sequence: 'asc' },
          include: {
            zones: {
              orderBy: { priorityScore: 'desc' },
            },
          },
        },
        zones: {
          orderBy: [{ missionId: 'asc' }, { priorityScore: 'desc' }],
        },
      },
    });

    if (!plan) {
      return NextResponse.json({ error: 'Spray plan not found' }, { status: 404 });
    }

    const zip = new JSZip();

    const missionRows = [
      [
        'mission_sequence',
        'mission_name',
        'zone_count',
        'total_area_ha',
        'chemical_liters',
        'estimated_distance_m',
        'estimated_duration_min',
        'route_baseline_distance_m',
        'route_optimized_distance_m',
        'route_saved_distance_m',
        'route_saved_pct',
        'weather_decision',
        'weather_risk_score',
        'planned_start_utc',
        'planned_end_utc',
        'avg_wind_mps',
        'max_gust_mps',
        'max_precip_prob_pct',
      ].join(','),
    ];

    for (const mission of plan.missions) {
      const metadata = parseMissionMetadata(mission.metadata);
      missionRows.push(
        [
          mission.sequence,
          escapeCsv(mission.name),
          mission.zoneCount,
          mission.totalAreaHa.toFixed(4),
          mission.chemicalLiters.toFixed(3),
          mission.estimatedDistanceM.toFixed(1),
          mission.estimatedDurationMin.toFixed(1),
          metadata.routeOptimization.baselineDistanceM?.toFixed(1) ?? '',
          metadata.routeOptimization.optimizedDistanceM?.toFixed(1) ?? '',
          metadata.routeOptimization.improvementM?.toFixed(1) ?? '',
          metadata.routeOptimization.improvementPct?.toFixed(2) ?? '',
          escapeCsv(metadata.weather.decision ?? ''),
          metadata.weather.riskScore?.toFixed(3) ?? '',
          escapeCsv(metadata.weather.startTimeUtc ?? ''),
          escapeCsv(metadata.weather.endTimeUtc ?? ''),
          metadata.weather.avgWindSpeedMps?.toFixed(2) ?? '',
          metadata.weather.maxWindGustMps?.toFixed(2) ?? '',
          metadata.weather.maxPrecipProbability?.toFixed(1) ?? '',
        ].join(',')
      );
    }

    const zoneRows = [
      [
        'zone_id',
        'mission_sequence',
        'species',
        'detection_count',
        'avg_confidence',
        'priority_score',
        'area_ha',
        'recommended_dose_l_per_ha',
        'recommended_liters',
        'centroid_lat',
        'centroid_lon',
        'recommendation_source',
      ].join(','),
    ];

    const missionSequenceById = new Map(plan.missions.map((mission) => [mission.id, mission.sequence]));

    for (const zone of plan.zones) {
      zoneRows.push(
        [
          escapeCsv(zone.id),
          zone.missionId ? missionSequenceById.get(zone.missionId) ?? '' : '',
          escapeCsv(zone.species),
          zone.detectionCount,
          zone.averageConfidence?.toFixed(3) ?? '',
          zone.priorityScore?.toFixed(3) ?? '',
          zone.areaHa.toFixed(4),
          zone.recommendedDosePerHa?.toFixed(3) ?? '',
          zone.recommendedLiters?.toFixed(3) ?? '',
          zone.centroidLat.toFixed(7),
          zone.centroidLon.toFixed(7),
          escapeCsv(zone.recommendationSource ?? ''),
        ].join(',')
      );
    }

    const kmlMissionFolders = plan.missions
      .map((mission) => {
        const routeCoordinates = parseLineStringCoordinates(mission.routeGeoJson);
        const routeCoordinateString = routeCoordinates
          .map(([lon, lat]) => `${lon},${lat},0`)
          .join(' ');

        const routePlacemark = routeCoordinates.length > 1
          ? `<Placemark>
              <name>${escapeXml(mission.name)} Route</name>
              <Style>
                <LineStyle>
                  <color>ff00a5ff</color>
                  <width>3</width>
                </LineStyle>
              </Style>
              <LineString>
                <tessellate>1</tessellate>
                <coordinates>${routeCoordinateString}</coordinates>
              </LineString>
            </Placemark>`
          : '';

        const zonePlacemarks = mission.zones
          .map((zone) => {
            const ring = parsePolygonRing(zone.polygon);
            if (ring.length < 4) return '';

            const coordinates = ring.map(([lon, lat]) => `${lon},${lat},0`).join(' ');
            return `<Placemark>
              <name>${escapeXml(zone.species)} (${zone.detectionCount})</name>
              <ExtendedData>
                <Data name="area_ha"><value>${zone.areaHa.toFixed(4)}</value></Data>
                <Data name="recommended_liters"><value>${(zone.recommendedLiters ?? 0).toFixed(3)}</value></Data>
              </ExtendedData>
              <Style>
                <LineStyle><color>ff2f6fff</color><width>2</width></LineStyle>
                <PolyStyle><color>552f6fff</color></PolyStyle>
              </Style>
              <Polygon>
                <outerBoundaryIs>
                  <LinearRing>
                    <coordinates>${coordinates}</coordinates>
                  </LinearRing>
                </outerBoundaryIs>
              </Polygon>
            </Placemark>`;
          })
          .filter(Boolean)
          .join('\n');

        return `<Folder>
          <name>${escapeXml(mission.name)}</name>
          ${routePlacemark}
          ${zonePlacemarks}
        </Folder>`;
      })
      .join('\n');

    const kmlContent = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Document>
    <name>${escapeXml(plan.name)}</name>
    <description>${escapeXml(plan.project.name)} spray mission pack</description>
    ${kmlMissionFolders}
  </Document>
</kml>`;

    const manifest = {
      plan: {
        id: plan.id,
        name: plan.name,
        status: plan.status,
        progress: plan.progress,
        createdAt: plan.createdAt.toISOString(),
        completedAt: plan.completedAt?.toISOString() ?? null,
      },
      project: {
        id: plan.project.id,
        name: plan.project.name,
        location: plan.project.location,
      },
      totals: {
        missions: plan.missions.length,
        zones: plan.zones.length,
        areaHa: Number(plan.zones.reduce((sum, zone) => sum + zone.areaHa, 0).toFixed(4)),
        chemicalLiters: Number(
          plan.zones.reduce((sum, zone) => sum + (zone.recommendedLiters ?? 0), 0).toFixed(3)
        ),
      },
      summary: plan.summary,
      exportedAt: new Date().toISOString(),
    };

    zip.file('missions.csv', `${missionRows.join('\n')}\n`);
    zip.file('zones.csv', `${zoneRows.join('\n')}\n`);
    zip.file('missions.kml', kmlContent);
    zip.file('manifest.json', JSON.stringify(manifest, null, 2));

    const buffer = await zip.generateAsync({
      type: 'nodebuffer',
      compression: 'DEFLATE',
    });

    const filename = `${toSlug(plan.project.name)}-${toSlug(plan.name)}-mission-pack.zip`;

    return new NextResponse(buffer, {
      status: 200,
      headers: {
        'Content-Type': 'application/zip',
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Cache-Control': 'no-store',
      },
    });
  } catch (error) {
    console.error('[spray-plan] export failed', error);
    return NextResponse.json({ error: 'Failed to export mission pack' }, { status: 500 });
  }
}
