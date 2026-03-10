import fs from "node:fs";
import path from "node:path";
import { PrismaClient } from "@prisma/client";

type GeoPoint = { lat: number; lon: number };

type CandidateParams = {
  yawOffsetDeg: number;
  fovScale: number;
  altitudeScale: number;
};

type EvalMetrics = {
  count: number;
  rmse: number;
  p50: number;
  p90: number;
  p95: number;
  f1At2m: number;
  f1At3m: number;
};

type EvalResult = {
  params: CandidateParams;
  metrics: EvalMetrics;
};

type ParsedArgs = {
  sessionId: string;
  truthKml: string;
  apply: boolean;
  profileName?: string;
  minConfidence: number;
  dedupeRadiusM: number;
};

type PreprocessedDetection = {
  sourceId: string;
  sourceAssetId: string;
  confidence: number;
  gpsLat: number;
  gpsLon: number;
  altitude: number;
  gimbalYaw: number;
  baseFov: number;
  imageWidth: number;
  imageHeight: number;
  pixelX: number;
  pixelY: number;
};

type PredictedDetection = {
  sourceAssetId: string;
  className: string;
  confidence: number;
  centerLat: number;
  centerLon: number;
};

const prisma = new PrismaClient();
const METERS_PER_DEGREE_LAT = 111_111;
const DEFAULT_CAMERA_FOV = 84;
const DEFAULT_ALTITUDE = 100;
const MIN_IMAGE_DIMENSION_PX = 16;

function parseArgs(argv: string[]): ParsedArgs {
  const args = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 1) {
    const raw = argv[i];
    if (!raw.startsWith("--")) continue;
    const key = raw.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      args.set(key, "true");
    } else {
      args.set(key, next);
      i += 1;
    }
  }

  const sessionId = args.get("sessionId") || args.get("session");
  const truthKml = args.get("truthKml") || args.get("truth");
  if (!sessionId || !truthKml) {
    throw new Error(
      "Usage: tsx scripts/calibrate-camera-profile.ts --sessionId <id> --truthKml <path> [--apply] [--profileName <name>] [--minConfidence 0.49] [--dedupeRadiusM 1.8]"
    );
  }

  const minConfidenceRaw = Number(args.get("minConfidence") ?? "0.49");
  const dedupeRadiusRaw = Number(args.get("dedupeRadiusM") ?? "1.8");
  if (!Number.isFinite(minConfidenceRaw) || minConfidenceRaw < 0 || minConfidenceRaw > 1) {
    throw new Error("minConfidence must be a number in [0, 1]");
  }
  if (!Number.isFinite(dedupeRadiusRaw) || dedupeRadiusRaw <= 0) {
    throw new Error("dedupeRadiusM must be a positive number");
  }

  return {
    sessionId,
    truthKml: path.resolve(truthKml),
    apply: args.has("apply"),
    profileName: args.get("profileName")?.trim() || undefined,
    minConfidence: minConfidenceRaw,
    dedupeRadiusM: dedupeRadiusRaw,
  };
}

function toFiniteNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Number(value.trim());
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function parseCenterBox(bbox: unknown): { x: number; y: number } | null {
  if (!Array.isArray(bbox) || bbox.length < 4) {
    return null;
  }
  const x1 = toFiniteNumber(bbox[0]);
  const y1 = toFiniteNumber(bbox[1]);
  const x2 = toFiniteNumber(bbox[2]);
  const y2 = toFiniteNumber(bbox[3]);
  if (x1 == null || y1 == null || x2 == null || y2 == null || x2 <= x1 || y2 <= y1) {
    return null;
  }
  return { x: (x1 + x2) / 2, y: (y1 + y2) / 2 };
}

function parseKmlPoints(filePath: string): GeoPoint[] {
  const raw = fs.readFileSync(filePath, "utf8");
  const coordinatePattern = /<coordinates>\s*([^<]+?)\s*<\/coordinates>/g;
  const points: GeoPoint[] = [];

  let match: RegExpExecArray | null = coordinatePattern.exec(raw);
  while (match) {
    const [lonRaw, latRaw] = match[1].trim().split(",");
    const lat = Number(latRaw);
    const lon = Number(lonRaw);
    if (Number.isFinite(lat) && Number.isFinite(lon)) {
      points.push({ lat, lon });
    }
    match = coordinatePattern.exec(raw);
  }
  return points;
}

function haversineDistanceMeters(a: GeoPoint, b: GeoPoint): number {
  const earthRadiusM = 6_371_000;
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * earthRadiusM * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

function readMetadataNumber(metadata: Record<string, unknown>, keys: string[]): number | null {
  for (const key of keys) {
    const value = toFiniteNumber(metadata[key]);
    if (value != null) return value;
  }
  return null;
}

function resolveImageDimensions(
  imageWidth: number | null,
  imageHeight: number | null,
  metadata: Record<string, unknown>
): { imageWidth: number | null; imageHeight: number | null } {
  const width = Math.max(
    toFiniteNumber(imageWidth) ?? 0,
    readMetadataNumber(metadata, ["ExifImageWidth", "ImageWidth", "PixelXDimension", "imageWidth"]) ?? 0
  );
  const height = Math.max(
    toFiniteNumber(imageHeight) ?? 0,
    readMetadataNumber(metadata, ["ExifImageHeight", "ImageHeight", "PixelYDimension", "imageHeight"]) ?? 0
  );
  return {
    imageWidth: width >= MIN_IMAGE_DIMENSION_PX ? width : null,
    imageHeight: height >= MIN_IMAGE_DIMENSION_PX ? height : null,
  };
}

function resolveAltitude(altitude: number | null, metadata: Record<string, unknown>): number {
  const relativeAltitude = readMetadataNumber(metadata, ["RelativeAltitude", "drone-dji:RelativeAltitude"]);
  if (relativeAltitude != null && relativeAltitude > 0) return relativeAltitude;

  const directAltitude = toFiniteNumber(altitude);
  if (directAltitude != null && directAltitude > 0) return directAltitude;

  const absoluteAltitude = readMetadataNumber(metadata, [
    "AbsoluteAltitude",
    "drone-dji:AbsoluteAltitude",
    "GPSAltitude",
    "altitude",
  ]);
  if (absoluteAltitude != null && absoluteAltitude > 0) return absoluteAltitude;
  return DEFAULT_ALTITUDE;
}

function resolveBaseFov(
  cameraFov: number | null,
  imageWidth: number,
  metadata: Record<string, unknown>
): number {
  const explicit = toFiniteNumber(cameraFov);
  if (explicit != null && explicit > 0 && explicit < 180) return explicit;

  const calibratedFocalLength = readMetadataNumber(metadata, [
    "CalibratedFocalLength",
    "drone-dji:CalibratedFocalLength",
  ]);
  if (calibratedFocalLength != null && calibratedFocalLength > 0) {
    const derived = (2 * Math.atan((imageWidth / 2) / calibratedFocalLength) * 180) / Math.PI;
    if (derived > 0 && derived < 180) return derived;
  }

  const focalLength35 = readMetadataNumber(metadata, [
    "FocalLengthIn35mmFormat",
    "FocalLengthIn35mmFilm",
    "drone-dji:FocalLengthIn35mmFormat",
  ]);
  if (focalLength35 != null && focalLength35 > 0) {
    const derived = (2 * Math.atan(36 / (2 * focalLength35)) * 180) / Math.PI;
    if (derived > 0 && derived < 180) return derived;
  }

  return DEFAULT_CAMERA_FOV;
}

function normalizePixel(rawX: number, rawY: number, imageWidth: number, imageHeight: number): { x: number; y: number } {
  const looksNormalized = rawX >= 0 && rawX <= 1 && rawY >= 0 && rawY <= 1;
  const absX = looksNormalized ? rawX * imageWidth : rawX;
  const absY = looksNormalized ? rawY * imageHeight : rawY;
  return {
    x: Math.max(0, Math.min(imageWidth, absX)),
    y: Math.max(0, Math.min(imageHeight, absY)),
  };
}

function projectDetection(
  item: PreprocessedDetection,
  params: CandidateParams
): PredictedDetection {
  const normalizedPixel = normalizePixel(item.pixelX, item.pixelY, item.imageWidth, item.imageHeight);
  const normalizedX = normalizedPixel.x / item.imageWidth - 0.5;
  const normalizedY = normalizedPixel.y / item.imageHeight - 0.5;

  const cameraFov = item.baseFov * params.fovScale;
  const altitude = item.altitude * params.altitudeScale;
  const hFovRad = (cameraFov * Math.PI) / 180;
  const vFovRad = hFovRad * (item.imageHeight / item.imageWidth);

  const angleX = normalizedX * hFovRad;
  const angleY = normalizedY * vFovRad;
  const offsetEast = altitude * Math.tan(angleX);
  const offsetNorth = -altitude * Math.tan(angleY);

  const yawRad = ((item.gimbalYaw + params.yawOffsetDeg) * Math.PI) / 180;
  const rotatedEast = offsetEast * Math.cos(yawRad) + offsetNorth * Math.sin(yawRad);
  const rotatedNorth = -offsetEast * Math.sin(yawRad) + offsetNorth * Math.cos(yawRad);

  const metersPerLon = METERS_PER_DEGREE_LAT * Math.cos((item.gpsLat * Math.PI) / 180);
  return {
    sourceAssetId: item.sourceAssetId,
    className: "Pine Sapling",
    confidence: item.confidence,
    centerLat: item.gpsLat + rotatedNorth / METERS_PER_DEGREE_LAT,
    centerLon: item.gpsLon + rotatedEast / metersPerLon,
  };
}

function dedupePredictions(
  detections: PredictedDetection[],
  dedupeRadiusM: number
): PredictedDetection[] {
  const orderedIndexes = detections
    .map((_, index) => index)
    .sort((a, b) => (detections[b].confidence ?? 0) - (detections[a].confidence ?? 0));

  const assigned = new Array(detections.length).fill(false);
  const deduped: PredictedDetection[] = [];

  for (const seedIndex of orderedIndexes) {
    if (assigned[seedIndex]) continue;
    assigned[seedIndex] = true;
    const seed = detections[seedIndex];
    const clusterIndexes = [seedIndex];
    const clusterAssetIds = new Set([seed.sourceAssetId]);

    for (const candidateIndex of orderedIndexes) {
      if (assigned[candidateIndex] || candidateIndex === seedIndex) continue;
      const candidate = detections[candidateIndex];
      if (clusterAssetIds.has(candidate.sourceAssetId)) continue;

      const seedDistance = haversineDistanceMeters(
        { lat: seed.centerLat, lon: seed.centerLon },
        { lat: candidate.centerLat, lon: candidate.centerLon }
      );
      if (seedDistance > dedupeRadiusM) continue;

      let matchesCluster = true;
      for (const clusterIndex of clusterIndexes) {
        const member = detections[clusterIndex];
        if (member.sourceAssetId === candidate.sourceAssetId) {
          matchesCluster = false;
          break;
        }
        const clusterDistance = haversineDistanceMeters(
          { lat: member.centerLat, lon: member.centerLon },
          { lat: candidate.centerLat, lon: candidate.centerLon }
        );
        if (clusterDistance > dedupeRadiusM) {
          matchesCluster = false;
          break;
        }
      }
      if (!matchesCluster) continue;

      clusterIndexes.push(candidateIndex);
      clusterAssetIds.add(candidate.sourceAssetId);
      assigned[candidateIndex] = true;
    }

    if (clusterIndexes.length === 1) {
      deduped.push(seed);
      continue;
    }

    let weightSum = 0;
    let weightedLat = 0;
    let weightedLon = 0;
    for (const clusterIndex of clusterIndexes) {
      const member = detections[clusterIndex];
      const weight = Math.max(member.confidence ?? 0, 1e-6);
      weightSum += weight;
      weightedLat += member.centerLat * weight;
      weightedLon += member.centerLon * weight;
    }
    deduped.push({
      ...seed,
      centerLat: weightedLat / weightSum,
      centerLon: weightedLon / weightSum,
      confidence: weightSum / clusterIndexes.length,
    });
  }

  return deduped;
}

function oneToOneF1(predictions: GeoPoint[], truth: GeoPoint[], thresholdM: number): number {
  const candidatePairs: Array<[number, number, number]> = [];
  for (let i = 0; i < predictions.length; i += 1) {
    for (let j = 0; j < truth.length; j += 1) {
      const distance = haversineDistanceMeters(predictions[i], truth[j]);
      if (distance <= thresholdM) {
        candidatePairs.push([distance, i, j]);
      }
    }
  }
  candidatePairs.sort((a, b) => a[0] - b[0]);

  const usedPred = new Array(predictions.length).fill(false);
  const usedTruth = new Array(truth.length).fill(false);
  let tp = 0;
  for (const [, predIndex, truthIndex] of candidatePairs) {
    if (usedPred[predIndex] || usedTruth[truthIndex]) continue;
    usedPred[predIndex] = true;
    usedTruth[truthIndex] = true;
    tp += 1;
  }

  const fp = predictions.length - tp;
  const fn = truth.length - tp;
  const precision = tp / (tp + fp || 1);
  const recall = tp / (tp + fn || 1);
  return (2 * precision * recall) / (precision + recall || 1);
}

function nearestDistanceMetrics(predictions: GeoPoint[], truth: GeoPoint[]): Omit<EvalMetrics, "f1At2m" | "f1At3m"> {
  const distances: number[] = [];
  let squaredError = 0;
  for (const predicted of predictions) {
    let nearestDistance = Number.POSITIVE_INFINITY;
    for (const target of truth) {
      const distance = haversineDistanceMeters(predicted, target);
      if (distance < nearestDistance) {
        nearestDistance = distance;
      }
    }
    distances.push(nearestDistance);
    squaredError += nearestDistance ** 2;
  }

  distances.sort((a, b) => a - b);
  const percentile = (p: number): number =>
    distances[Math.min(distances.length - 1, Math.floor((distances.length - 1) * p))];

  return {
    count: predictions.length,
    rmse: Math.sqrt(squaredError / predictions.length),
    p50: percentile(0.5),
    p90: percentile(0.9),
    p95: percentile(0.95),
  };
}

function evaluateParams(
  items: PreprocessedDetection[],
  truthPoints: GeoPoint[],
  params: CandidateParams,
  dedupeRadiusM: number
): EvalResult {
  const projected = items.map((item) => projectDetection(item, params));
  const deduped = dedupePredictions(projected, dedupeRadiusM);
  const predictionPoints = deduped.map((detection) => ({
    lat: detection.centerLat,
    lon: detection.centerLon,
  }));
  const nearestMetrics = nearestDistanceMetrics(predictionPoints, truthPoints);
  return {
    params,
    metrics: {
      ...nearestMetrics,
      f1At2m: oneToOneF1(predictionPoints, truthPoints, 2),
      f1At3m: oneToOneF1(predictionPoints, truthPoints, 3),
    },
  };
}

function betterThan(a: EvalResult, b: EvalResult): boolean {
  if (a.metrics.f1At2m !== b.metrics.f1At2m) return a.metrics.f1At2m > b.metrics.f1At2m;
  if (a.metrics.f1At3m !== b.metrics.f1At3m) return a.metrics.f1At3m > b.metrics.f1At3m;
  return a.metrics.rmse < b.metrics.rmse;
}

function fitParams(items: PreprocessedDetection[], truthPoints: GeoPoint[], dedupeRadiusM: number): EvalResult {
  let best = evaluateParams(
    items,
    truthPoints,
    { yawOffsetDeg: 0, fovScale: 1, altitudeScale: 1 },
    dedupeRadiusM
  );

  for (let yaw = -6; yaw <= 6.0001; yaw += 0.25) {
    const candidate = evaluateParams(
      items,
      truthPoints,
      { ...best.params, yawOffsetDeg: Number(yaw.toFixed(3)) },
      dedupeRadiusM
    );
    if (betterThan(candidate, best)) {
      best = candidate;
    }
  }

  for (let fovScale = 0.9; fovScale <= 1.1 + Number.EPSILON; fovScale += 0.01) {
    const candidate = evaluateParams(
      items,
      truthPoints,
      { ...best.params, fovScale: Number(fovScale.toFixed(4)) },
      dedupeRadiusM
    );
    if (betterThan(candidate, best)) {
      best = candidate;
    }
  }

  for (let altitudeScale = 0.9; altitudeScale <= 1.1 + Number.EPSILON; altitudeScale += 0.01) {
    const candidate = evaluateParams(
      items,
      truthPoints,
      { ...best.params, altitudeScale: Number(altitudeScale.toFixed(4)) },
      dedupeRadiusM
    );
    if (betterThan(candidate, best)) {
      best = candidate;
    }
  }

  const center = { ...best.params };
  for (let yaw = center.yawOffsetDeg - 0.6; yaw <= center.yawOffsetDeg + 0.6 + Number.EPSILON; yaw += 0.1) {
    for (let fovScale = center.fovScale - 0.02; fovScale <= center.fovScale + 0.02 + Number.EPSILON; fovScale += 0.005) {
      for (let altitudeScale = center.altitudeScale - 0.02; altitudeScale <= center.altitudeScale + 0.02 + Number.EPSILON; altitudeScale += 0.005) {
        const candidate = evaluateParams(
          items,
          truthPoints,
          {
            yawOffsetDeg: Number(yaw.toFixed(4)),
            fovScale: Number(fovScale.toFixed(5)),
            altitudeScale: Number(altitudeScale.toFixed(5)),
          },
          dedupeRadiusM
        );
        if (betterThan(candidate, best)) {
          best = candidate;
        }
      }
    }
  }

  return best;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!fs.existsSync(args.truthKml)) {
    throw new Error(`Truth KML not found: ${args.truthKml}`);
  }

  const session = await prisma.reviewSession.findUnique({
    where: { id: args.sessionId },
    select: {
      id: true,
      projectId: true,
      teamId: true,
      createdAt: true,
      assetIds: true,
      batchJobIds: true,
    },
  });
  if (!session) {
    throw new Error(`Review session not found: ${args.sessionId}`);
  }

  const assetIds = Array.isArray(session.assetIds) ? (session.assetIds as string[]) : [];
  const batchJobIds = Array.isArray(session.batchJobIds) ? (session.batchJobIds as string[]) : [];

  const [assets, pendingAnnotations] = await Promise.all([
    prisma.asset.findMany({
      where: { id: { in: assetIds } },
      select: {
        id: true,
        fileName: true,
        gpsLatitude: true,
        gpsLongitude: true,
        altitude: true,
        gimbalYaw: true,
        cameraFov: true,
        imageWidth: true,
        imageHeight: true,
        metadata: true,
      },
      orderBy: { fileName: "asc" },
    }),
    prisma.pendingAnnotation.findMany({
      where: {
        assetId: { in: assetIds },
        status: "PENDING",
        confidence: { gte: args.minConfidence },
        ...(batchJobIds.length > 0
          ? { batchJobId: { in: batchJobIds } }
          : { createdAt: { gte: session.createdAt } }),
      },
      select: {
        id: true,
        assetId: true,
        confidence: true,
        bbox: true,
      },
    }),
  ]);

  const assetById = new Map(assets.map((asset) => [asset.id, asset]));
  const preprocessed: PreprocessedDetection[] = [];
  for (const pending of pendingAnnotations) {
    const asset = assetById.get(pending.assetId);
    if (!asset) continue;
    const centerBox = parseCenterBox(pending.bbox);
    if (!centerBox) continue;
    const metadata = asRecord(asset.metadata);
    const resolvedDimensions = resolveImageDimensions(asset.imageWidth, asset.imageHeight, metadata);
    if (resolvedDimensions.imageWidth == null || resolvedDimensions.imageHeight == null) continue;
    const gpsLat = toFiniteNumber(asset.gpsLatitude);
    const gpsLon = toFiniteNumber(asset.gpsLongitude);
    if (gpsLat == null || gpsLon == null) continue;

    preprocessed.push({
      sourceId: pending.id,
      sourceAssetId: asset.id,
      confidence: pending.confidence,
      gpsLat,
      gpsLon,
      altitude: resolveAltitude(asset.altitude, metadata),
      gimbalYaw: toFiniteNumber(asset.gimbalYaw) ?? 0,
      baseFov: resolveBaseFov(asset.cameraFov, resolvedDimensions.imageWidth, metadata),
      imageWidth: resolvedDimensions.imageWidth,
      imageHeight: resolvedDimensions.imageHeight,
      pixelX: centerBox.x,
      pixelY: centerBox.y,
    });
  }

  if (preprocessed.length === 0) {
    throw new Error("No valid detections found for calibration.");
  }

  const truthPoints = parseKmlPoints(args.truthKml);
  if (truthPoints.length === 0) {
    throw new Error("No coordinate points found in truth KML.");
  }

  const baseline = evaluateParams(
    preprocessed,
    truthPoints,
    { yawOffsetDeg: 0, fovScale: 1, altitudeScale: 1 },
    args.dedupeRadiusM
  );
  const best = fitParams(preprocessed, truthPoints, args.dedupeRadiusM);

  let appliedProfile: {
    id: string;
    name: string;
    yawOffsetDeg: number | null;
    fovScale: number | null;
    altitudeScale: number | null;
  } | null = null;

  if (args.apply) {
    const firstMetadata = asRecord(assets[0]?.metadata);
    const make = String(firstMetadata.Make ?? firstMetadata["drone-dji:Make"] ?? "Unknown");
    const model = String(firstMetadata.Model ?? firstMetadata["drone-dji:Model"] ?? "Camera");
    const profileName = args.profileName ?? `${make} ${model} Auto Cal`;
    const fittedAt = new Date().toISOString();

    const profile = await prisma.cameraProfile.upsert({
      where: {
        teamId_name: {
          teamId: session.teamId,
          name: profileName,
        },
      },
      update: {
        yawOffsetDeg: best.params.yawOffsetDeg,
        fovScale: best.params.fovScale,
        altitudeScale: best.params.altitudeScale,
        description: `Auto-calibrated from review session ${session.id} at ${fittedAt}`,
      },
      create: {
        teamId: session.teamId,
        name: profileName,
        description: `Auto-calibrated from review session ${session.id} at ${fittedAt}`,
        yawOffsetDeg: best.params.yawOffsetDeg,
        fovScale: best.params.fovScale,
        altitudeScale: best.params.altitudeScale,
      },
      select: {
        id: true,
        name: true,
        yawOffsetDeg: true,
        fovScale: true,
        altitudeScale: true,
      },
    });

    await prisma.project.update({
      where: { id: session.projectId },
      data: { cameraProfileId: profile.id },
    });

    for (const asset of assets) {
      const baseMetadata = asRecord(asset.metadata);
      const existingGeoOverrides =
        baseMetadata.geoOverrides && typeof baseMetadata.geoOverrides === "object"
          ? (baseMetadata.geoOverrides as Record<string, unknown>)
          : {};

      const mergedMetadata: Record<string, unknown> = {
        ...baseMetadata,
        GeoYawOffsetDeg: best.params.yawOffsetDeg,
        GeoFovScale: best.params.fovScale,
        GeoAltitudeScale: best.params.altitudeScale,
        geoOverrides: {
          ...existingGeoOverrides,
          GeoYawOffsetDeg: best.params.yawOffsetDeg,
          GeoFovScale: best.params.fovScale,
          GeoAltitudeScale: best.params.altitudeScale,
          cameraProfileId: profile.id,
          cameraProfileName: profile.name,
          fittedFromReviewSessionId: session.id,
          fittedAt,
        },
      };

      await prisma.asset.update({
        where: { id: asset.id },
        data: {
          cameraProfileId: profile.id,
          metadata: mergedMetadata,
        },
      });
    }

    appliedProfile = profile;
  }

  const output = {
    sessionId: session.id,
    projectId: session.projectId,
    teamId: session.teamId,
    truthKml: args.truthKml,
    counts: {
      assets: assets.length,
      pendingDetections: pendingAnnotations.length,
      fittedDetections: preprocessed.length,
      truthPoints: truthPoints.length,
    },
    baseline,
    best,
    applied: Boolean(args.apply),
    profile: appliedProfile,
  };

  console.log(JSON.stringify(output, null, 2));
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
