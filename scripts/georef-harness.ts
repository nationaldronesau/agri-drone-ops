import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PrismaClient, type Prisma } from '@prisma/client';

type ParsedArgs = {
  projectId?: string;
  outputDir: string;
  fixedElevationM: number;
  limit?: number;
  help: boolean;
};

type GeoPoint = { lat: number; lon: number };

type EdgeName = 'midLeft' | 'midRight' | 'midTop' | 'midBottom';

type ProjectedEdge = {
  pixel: { x: number; y: number };
  geo: GeoPoint | null;
  offsetFromCentreM: {
    east: number;
    north: number;
    radial: number;
  } | null;
};

type HarnessRow = {
  assetId: string;
  fileName: string;
  projectId: string;
  projectName: string;
  flightSession: string;
  elevation: {
    source: 'lrf_target_alt_metadata' | 'fixed_elevation';
    /** Elevation the projection actually used (after service fallbacks). */
    metres: number;
    /** Elevation the harness asked the stub to serve. */
    requestedMetres: number;
  };
  imageSize: { width: number; height: number };
  centrePixel: { x: number; y: number };
  centreProjection: GeoPoint | null;
  lrfTarget: GeoPoint & { distanceM: number };
  centreErrorM: number | null;
  edges: Record<EdgeName, ProjectedEdge>;
};

type FlightReport = {
  generatedAt: string;
  projectionPath: 'pixelToGeoWithDSM_photogrammetry_lrf_removed';
  networkElevationDisabled: true;
  project: { id: string; name: string };
  flightSession: string;
  summary: {
    count: number;
    projectedCount: number;
    failedCount: number;
    p50CentreErrorM: number | null;
    p90CentreErrorM: number | null;
    worst5: Array<{ assetId: string; fileName: string; centreErrorM: number }>;
  };
  rows: HarnessRow[];
};

const assetSelect = {
  id: true,
  fileName: true,
  projectId: true,
  flightSession: true,
  gpsLatitude: true,
  gpsLongitude: true,
  altitude: true,
  gimbalPitch: true,
  gimbalRoll: true,
  gimbalYaw: true,
  cameraFov: true,
  imageWidth: true,
  imageHeight: true,
  lrfDistance: true,
  lrfTargetLat: true,
  lrfTargetLon: true,
  metadata: true,
  project: {
    select: {
      id: true,
      name: true,
    },
  },
} satisfies Prisma.AssetSelect;

type AssetRow = Prisma.AssetGetPayload<{ select: typeof assetSelect }>;

const LRF_METADATA_KEYS = [
  'LRFTargetDistance',
  'drone-dji:LRFTargetDistance',
  'LRFTargetLat',
  'drone-dji:LRFTargetLat',
  'LRFTargetLon',
  'drone-dji:LRFTargetLon',
  'LRFTargetAlt',
  'drone-dji:LRFTargetAlt',
] as const;

const GPS_LATITUDE_KEYS = [
  'GpsLatitude',
  'GPSLatitude',
  'Latitude',
  'latitude',
  'drone-dji:GPSLatitude',
  'drone-dji:GpsLatitude',
] as const;
const GPS_LONGITUDE_KEYS = [
  'GpsLongitude',
  'GPSLongitude',
  'Longitude',
  'longitude',
  'drone-dji:GPSLongitude',
  'drone-dji:GpsLongitude',
] as const;
const GIMBAL_PITCH_KEYS = [
  'GimbalPitchDegree',
  'drone-dji:GimbalPitchDegree',
] as const;
const GIMBAL_ROLL_KEYS = [
  'GimbalRollDegree',
  'drone-dji:GimbalRollDegree',
] as const;
const GIMBAL_YAW_KEYS = [
  'GimbalYawDegree',
  'FlightYawDegree',
  'drone-dji:GimbalYawDegree',
  'drone-dji:FlightYawDegree',
] as const;

function parseArgs(argv: string[]): ParsedArgs {
  const valueFor = (flag: string): string | undefined => {
    const index = argv.indexOf(flag);
    return index >= 0 ? argv[index + 1] : undefined;
  };

  const fixedElevationRaw = valueFor('--fixed-elevation');
  const fixedElevationM = fixedElevationRaw == null ? 0 : Number(fixedElevationRaw);
  if (!Number.isFinite(fixedElevationM)) {
    throw new Error('--fixed-elevation must be a finite number in metres');
  }

  const limitRaw = valueFor('--limit');
  const limit = limitRaw == null ? undefined : Number(limitRaw);
  if (limit != null && (!Number.isInteger(limit) || limit <= 0)) {
    throw new Error('--limit must be a positive integer');
  }

  const outputArg = valueFor('--output-dir');
  const outputDir = path.resolve(
    outputArg ?? path.join(os.tmpdir(), 'agri-drone-ops-georef-harness')
  );

  return {
    projectId: valueFor('--project'),
    outputDir,
    fixedElevationM,
    limit,
    help: argv.includes('--help') || argv.includes('-h'),
  };
}

function printHelp(): void {
  console.log(
    [
      'Usage: npm run georef:harness -- [options]',
      '',
      'Measures the current photogrammetric projection against stored LRF targets.',
      'All elevation HTTP is intercepted locally; this script never calls the network.',
      '',
      'Options:',
      '  --project <id>             Restrict assets to one project',
      '  --limit <count>            Limit source assets for a quick sample',
      '  --fixed-elevation <metres> Offline elevation when LRFTargetAlt is absent (default: 0)',
      '  --output-dir <path>        Report directory (default: OS temp directory)',
      '  --help                     Show this help',
    ].join('\n')
  );
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function toFiniteNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function readNumber(metadata: Record<string, unknown>, keys: readonly string[]): number | null {
  for (const key of keys) {
    const value = toFiniteNumber(metadata[key]);
    if (value != null) return value;
  }
  return null;
}

function withoutLrfMetadata(metadata: Record<string, unknown>): Record<string, unknown> {
  const copy = { ...metadata };
  for (const key of LRF_METADATA_KEYS) delete copy[key];
  return copy;
}

function haversineDistanceM(a: GeoPoint, b: GeoPoint): number {
  const earthRadiusM = 6_371_000;
  const radians = Math.PI / 180;
  const dLat = (b.lat - a.lat) * radians;
  const dLon = (b.lon - a.lon) * radians;
  const sinLat = Math.sin(dLat / 2);
  const sinLon = Math.sin(dLon / 2);
  const value =
    sinLat * sinLat +
    Math.cos(a.lat * radians) *
      Math.cos(b.lat * radians) *
      sinLon *
      sinLon;
  return earthRadiusM * 2 * Math.atan2(Math.sqrt(value), Math.sqrt(1 - value));
}

function offsetFromCentre(centre: GeoPoint, edge: GeoPoint): {
  east: number;
  north: number;
  radial: number;
} {
  const radians = Math.PI / 180;
  const east =
    (edge.lon - centre.lon) * 111111 * Math.cos(centre.lat * radians);
  const north = (edge.lat - centre.lat) * 111111;
  return {
    east,
    north,
    radial: haversineDistanceM(centre, edge),
  };
}

function percentile(values: number[], quantile: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const position = (sorted.length - 1) * quantile;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  const weight = position - lower;
  return sorted[lower] * (1 - weight) + sorted[upper] * weight;
}

function slug(value: string): string {
  const base =
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 52) || 'unassigned';
  // Distinct raw values must never share an output path, even when they
  // differ only by case, punctuation, or truncated characters.
  const digest = createHash('sha1').update(value).digest('hex').slice(0, 7);
  return `${base}-${digest}`;
}

function formatMetric(value: number | null): string {
  return value == null ? 'n/a' : value.toFixed(3);
}

function buildReport(rows: HarnessRow[], generatedAt: string): FlightReport {
  const first = rows[0];
  const successfulRows = rows.filter(
    (row): row is HarnessRow & { centreErrorM: number } => row.centreErrorM != null
  );
  const errors = successfulRows.map((row) => row.centreErrorM);
  const worst5 = [...successfulRows]
    .sort((a, b) => b.centreErrorM - a.centreErrorM)
    .slice(0, 5)
    .map((row) => ({
      assetId: row.assetId,
      fileName: row.fileName,
      centreErrorM: row.centreErrorM,
    }));

  return {
    generatedAt,
    projectionPath: 'pixelToGeoWithDSM_photogrammetry_lrf_removed',
    networkElevationDisabled: true,
    project: { id: first.projectId, name: first.projectName },
    flightSession: first.flightSession,
    summary: {
      count: rows.length,
      projectedCount: successfulRows.length,
      failedCount: rows.length - successfulRows.length,
      p50CentreErrorM: percentile(errors, 0.5),
      p90CentreErrorM: percentile(errors, 0.9),
      worst5,
    },
    rows,
  };
}

function renderMarkdown(report: FlightReport): string {
  const lines = [
    `# Georeferencing harness: ${report.project.name} / ${report.flightSession}`,
    '',
    `Generated: ${report.generatedAt}`,
    '',
    `Projection path: \`${report.projectionPath}\``,
    '',
    'LRF fields were removed from a copy of each asset before projection. Elevation HTTP was replaced with the deterministic per-row value shown below.',
    '',
    '## Summary',
    '',
    `- Count: ${report.summary.count}`,
    `- Projected: ${report.summary.projectedCount}`,
    `- Failed: ${report.summary.failedCount}`,
    `- Centre error p50: ${formatMetric(report.summary.p50CentreErrorM)} m`,
    `- Centre error p90: ${formatMetric(report.summary.p90CentreErrorM)} m`,
    '',
    '## Worst 5 centre-pixel errors',
    '',
    '| Asset ID | File | Error (m) |',
    '|---|---|---:|',
    ...report.summary.worst5.map(
      (row) => `| ${row.assetId} | ${row.fileName.replaceAll('|', '\\|')} | ${row.centreErrorM.toFixed(3)} |`
    ),
    ...(report.summary.worst5.length === 0 ? ['| n/a | no successful projections | n/a |'] : []),
    '',
    '## Asset comparison rows',
    '',
    '| Asset ID | Elevation source | Elev. (m) | Centre error (m) | Left (m) | Right (m) | Top (m) | Bottom (m) |',
    '|---|---|---:|---:|---:|---:|---:|---:|',
    ...report.rows.map((row) => {
      const edge = (name: EdgeName): string =>
        formatMetric(row.edges[name].offsetFromCentreM?.radial ?? null);
      return `| ${row.assetId} | ${row.elevation.source} | ${row.elevation.metres.toFixed(3)} | ${formatMetric(row.centreErrorM)} | ${edge('midLeft')} | ${edge('midRight')} | ${edge('midTop')} | ${edge('midBottom')} |`;
    }),
    '',
    'Signed east/north edge offsets and projected coordinates are retained in the matching JSON report.',
    '',
  ];
  return lines.join('\n');
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }

  if (!process.env.DATABASE_URL) {
    console.log('[georef-harness] No database configured: DATABASE_URL is not set.');
    console.log(
      '[georef-harness] Set DATABASE_URL to the Prisma MySQL database, then rerun `npm run georef:harness`.'
    );
    console.log(
      '[georef-harness] No reports were written; this is the expected zero-data/offline checkout path.'
    );
    return;
  }

  let offlineElevationM = args.fixedElevationM;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ results: [{ elevation: offlineElevationM }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });

  const prisma = new PrismaClient();
  try {
    const [georeferencing, precision, elevation] = await Promise.all([
      import('@/lib/utils/georeferencing'),
      import('@/lib/utils/precision-georeferencing'),
      import('@/lib/services/elevation'),
    ]);
    const elevationInternals = elevation.elevationService as unknown as {
      clearCache(): void;
      minRequestInterval: number;
    };
    elevationInternals.minRequestInterval = 0;

    const sourceAssets = await prisma.asset.findMany({
      where: {
        ...(args.projectId ? { projectId: args.projectId } : {}),
      },
      select: assetSelect,
      orderBy: [{ projectId: 'asc' }, { flightSession: 'asc' }, { id: 'asc' }],
      ...(args.limit ? { take: args.limit } : {}),
    });

    if (sourceAssets.length === 0) {
      console.log('[georef-harness] The selected database/project contains zero assets.');
      console.log(
        '[georef-harness] Upload or point DATABASE_URL at historical DJI assets, then rerun the command.'
      );
      return;
    }

    const exclusionCounts = new Map<string, number>();
    const exclude = (reason: string): void => {
      exclusionCounts.set(reason, (exclusionCounts.get(reason) ?? 0) + 1);
    };
    const eligible: Array<{
      asset: AssetRow;
      metadata: Record<string, unknown>;
      width: number;
      height: number;
      altitude: number;
      gpsLatitude: number;
      gpsLongitude: number;
      gimbalPitch: number;
      gimbalRoll: number;
      gimbalYaw: number;
      lrfDistance: number;
      lrfTargetLat: number;
      lrfTargetLon: number;
    }> = [];

    for (const asset of sourceAssets) {
      const metadata = asRecord(asset.metadata);
      const gpsLatitude =
        toFiniteNumber(asset.gpsLatitude) ?? readNumber(metadata, GPS_LATITUDE_KEYS);
      const gpsLongitude =
        toFiniteNumber(asset.gpsLongitude) ?? readNumber(metadata, GPS_LONGITUDE_KEYS);
      const lrfDistance =
        toFiniteNumber(asset.lrfDistance) ??
        readNumber(metadata, ['LRFTargetDistance', 'drone-dji:LRFTargetDistance']);
      const lrfTargetLat =
        toFiniteNumber(asset.lrfTargetLat) ??
        readNumber(metadata, ['LRFTargetLat', 'drone-dji:LRFTargetLat']);
      const lrfTargetLon =
        toFiniteNumber(asset.lrfTargetLon) ??
        readNumber(metadata, ['LRFTargetLon', 'drone-dji:LRFTargetLon']);
      if (
        gpsLatitude == null ||
        gpsLongitude == null ||
        lrfDistance == null ||
        lrfDistance <= 0 ||
        lrfTargetLat == null ||
        lrfTargetLon == null
      ) {
        exclude('missing GPS or LRF target latitude, longitude, or distance');
        continue;
      }
      if (!precision.getPrecisionMetadataStatus(metadata).hasCalibration) {
        exclude('missing calibrated focal length or optical centre metadata');
        continue;
      }
      const gimbalPitch =
        toFiniteNumber(asset.gimbalPitch) ?? readNumber(metadata, GIMBAL_PITCH_KEYS);
      const gimbalRoll =
        toFiniteNumber(asset.gimbalRoll) ?? readNumber(metadata, GIMBAL_ROLL_KEYS);
      const gimbalYaw =
        toFiniteNumber(asset.gimbalYaw) ?? readNumber(metadata, GIMBAL_YAW_KEYS);
      if (
        gimbalPitch == null ||
        gimbalRoll == null ||
        gimbalYaw == null
      ) {
        exclude('missing gimbal pitch, roll, or yaw');
        continue;
      }
      const dimensions = georeferencing.resolveProjectionImageDimensions(
        asset.imageWidth,
        asset.imageHeight,
        metadata
      );
      if (dimensions.imageWidth == null || dimensions.imageHeight == null) {
        exclude('missing image dimensions');
        continue;
      }
      const altitude = georeferencing.resolveProjectionAltitude(asset.altitude, metadata);
      if (altitude == null) {
        exclude('missing projection altitude');
        continue;
      }
      eligible.push({
        asset,
        metadata,
        width: dimensions.imageWidth,
        height: dimensions.imageHeight,
        altitude,
        gpsLatitude,
        gpsLongitude,
        gimbalPitch,
        gimbalRoll,
        gimbalYaw,
        lrfDistance,
        lrfTargetLat,
        lrfTargetLon,
      });
    }

    if (eligible.length === 0) {
      console.log(
        `[georef-harness] Scanned ${sourceAssets.length} assets, but none had all GPS, LRF, gimbal, calibration, dimension, and altitude inputs.`
      );
      for (const [reason, count] of exclusionCounts) {
        console.log(`[georef-harness] Excluded ${count}: ${reason}.`);
      }
      console.log(
        '[georef-harness] Calibration requires CalibratedFocalLength plus CalibratedOpticalCenterX/Y in Asset.metadata.'
      );
      return;
    }

    console.log(
      `[georef-harness] Projecting ${eligible.length} assets through the current photogrammetric path with elevation HTTP disabled.`
    );

    const rows: HarnessRow[] = [];
    for (const item of eligible) {
      const {
        asset,
        metadata,
        width,
        height,
        altitude,
        gpsLatitude,
        gpsLongitude,
        gimbalPitch,
        gimbalRoll,
        gimbalYaw,
        lrfDistance,
        lrfTargetLat,
        lrfTargetLon,
      } = item;
      const lrfTarget = {
        lat: lrfTargetLat,
        lon: lrfTargetLon,
        distanceM: lrfDistance,
      };
      const lrfTargetAltitude = readNumber(metadata, [
        'LRFTargetAlt',
        'drone-dji:LRFTargetAlt',
      ]);
      offlineElevationM = lrfTargetAltitude ?? args.fixedElevationM;
      elevationInternals.clearCache();

      const projectionAsset = {
        gpsLatitude,
        gpsLongitude,
        altitude,
        gimbalPitch,
        gimbalRoll,
        gimbalYaw,
        cameraFov: asset.cameraFov,
        imageWidth: width,
        imageHeight: height,
        metadata: withoutLrfMetadata(metadata),
        lrfDistance: null,
        lrfTargetLat: null,
        lrfTargetLon: null,
      };
      const centrePixel = { x: width / 2, y: height / 2 };
      const edgePixels: Record<EdgeName, { x: number; y: number }> = {
        midLeft: { x: 0, y: height / 2 },
        midRight: { x: width, y: height / 2 },
        midTop: { x: width / 2, y: 0 },
        midBottom: { x: width / 2, y: height },
      };

      const centreProjection = await georeferencing.pixelToGeoWithDSM(
        projectionAsset,
        centrePixel
      );
      const projectedEdges = await Promise.all(
        (Object.entries(edgePixels) as Array<[EdgeName, { x: number; y: number }]>).map(
          async ([name, pixel]) => [
            name,
            await georeferencing.pixelToGeoWithDSM(projectionAsset, pixel),
          ] as const
        )
      );
      const edges = Object.fromEntries(
        projectedEdges.map(([name, geo]) => [
          name,
          {
            pixel: edgePixels[name],
            geo,
            offsetFromCentreM:
              centreProjection && geo ? offsetFromCentre(centreProjection, geo) : null,
          },
        ])
      ) as Record<EdgeName, ProjectedEdge>;

      rows.push({
        assetId: asset.id,
        fileName: asset.fileName,
        projectId: asset.project.id,
        projectName: asset.project.name,
        flightSession: asset.flightSession?.trim() || 'unassigned',
        elevation: {
          source: lrfTargetAltitude == null ? 'fixed_elevation' : 'lrf_target_alt_metadata',
          // getTerrainElevation applies `result?.elevation || 100`, so a
          // stubbed elevation of exactly 0 reaches the projection as 100 m.
          // Record what the projection actually used, not just what we asked
          // for. PR 3 fixes the accessor's falsy fallback itself.
          metres: offlineElevationM || 100,
          requestedMetres: offlineElevationM,
        },
        imageSize: { width, height },
        centrePixel,
        centreProjection,
        lrfTarget,
        centreErrorM: centreProjection
          ? haversineDistanceM(centreProjection, lrfTarget)
          : null,
        edges,
      });
    }

    const groups = new Map<string, HarnessRow[]>();
    for (const row of rows) {
      const key = `${row.projectId}\u0000${row.flightSession}`;
      groups.set(key, [...(groups.get(key) ?? []), row]);
    }

    await fs.mkdir(args.outputDir, { recursive: true });
    const generatedAt = new Date().toISOString();
    for (const groupRows of groups.values()) {
      const report = buildReport(groupRows, generatedAt);
      const fileStem = [
        slug(report.project.name),
        slug(report.project.id),
        slug(report.flightSession),
      ].join('--');
      const jsonPath = path.join(args.outputDir, `${fileStem}.json`);
      const markdownPath = path.join(args.outputDir, `${fileStem}.md`);
      await Promise.all([
        fs.writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8'),
        fs.writeFile(markdownPath, renderMarkdown(report), 'utf8'),
      ]);
      console.log(
        `[georef-harness] ${report.project.name} / ${report.flightSession}: count=${report.summary.count}, p50=${formatMetric(report.summary.p50CentreErrorM)}m, p90=${formatMetric(report.summary.p90CentreErrorM)}m`
      );
      console.log(`[georef-harness] JSON: ${jsonPath}`);
      console.log(`[georef-harness] Markdown: ${markdownPath}`);
    }
  } finally {
    globalThis.fetch = originalFetch;
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[georef-harness] Failed: ${message}`);
  process.exitCode = 1;
});
