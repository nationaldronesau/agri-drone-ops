const METERS_PER_DEGREE_LAT = 111111;

export interface SessionBiasPoint {
  id: string;
  assetId: string;
  className: string;
  confidence: number;
  lat: number;
  lon: number;
}

export interface SessionBiasCorrection {
  eastMeters: number;
  northMeters: number;
  anchorCount: number;
  magnitudeMeters: number;
}

export interface SessionBiasSolveOptions {
  radiusMeters: number;
  minAnchorsPerAsset?: number;
  maxCorrectionMeters?: number;
  byClass?: boolean;
  minConfidenceWeight?: number;
}

function isFinitePoint(lat: number, lon: number): boolean {
  return (
    Number.isFinite(lat) &&
    Number.isFinite(lon) &&
    lat >= -90 &&
    lat <= 90 &&
    lon >= -180 &&
    lon <= 180
  );
}

function haversineDistanceMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const earthRadiusM = 6371000;
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
      Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return earthRadiusM * c;
}

function metersPerDegreeLon(lat: number): number {
  return METERS_PER_DEGREE_LAT * Math.cos((lat * Math.PI) / 180);
}

function clusterSessionPoints(
  points: SessionBiasPoint[],
  radiusMeters: number,
  byClass: boolean
): SessionBiasPoint[][] {
  const orderedIndexes = points
    .map((_, index) => index)
    .sort((a, b) => points[b].confidence - points[a].confidence);

  const assigned = new Array(points.length).fill(false);
  const clusters: SessionBiasPoint[][] = [];

  for (const seedIndex of orderedIndexes) {
    if (assigned[seedIndex]) continue;
    assigned[seedIndex] = true;
    const seed = points[seedIndex];
    const clusterIndexes = [seedIndex];
    const clusterAssetIds = new Set([seed.assetId]);

    for (const candidateIndex of orderedIndexes) {
      if (assigned[candidateIndex] || candidateIndex === seedIndex) continue;
      const candidate = points[candidateIndex];
      if (byClass && candidate.className !== seed.className) continue;
      if (clusterAssetIds.has(candidate.assetId)) continue;

      const seedDistance = haversineDistanceMeters(
        seed.lat,
        seed.lon,
        candidate.lat,
        candidate.lon
      );
      if (seedDistance > radiusMeters) continue;

      let fitsCluster = true;
      for (const memberIndex of clusterIndexes) {
        const member = points[memberIndex];
        if (member.assetId === candidate.assetId) {
          fitsCluster = false;
          break;
        }
        const memberDistance = haversineDistanceMeters(
          member.lat,
          member.lon,
          candidate.lat,
          candidate.lon
        );
        if (memberDistance > radiusMeters) {
          fitsCluster = false;
          break;
        }
      }

      if (!fitsCluster) continue;

      clusterIndexes.push(candidateIndex);
      clusterAssetIds.add(candidate.assetId);
      assigned[candidateIndex] = true;
    }

    const cluster = clusterIndexes.map((index) => points[index]);
    if (cluster.length >= 2) {
      clusters.push(cluster);
    }
  }

  return clusters;
}

export function solveSessionAssetBias(
  rawPoints: SessionBiasPoint[],
  options: SessionBiasSolveOptions
): Map<string, SessionBiasCorrection> {
  const radiusMeters = Number.isFinite(options.radiusMeters) && options.radiusMeters > 0
    ? options.radiusMeters
    : 2.5;
  const minAnchorsPerAsset = options.minAnchorsPerAsset ?? 3;
  const maxCorrectionMeters = options.maxCorrectionMeters ?? 1.6;
  const byClass = options.byClass ?? true;
  const minConfidenceWeight = options.minConfidenceWeight ?? 0.05;

  const points = rawPoints.filter((point) => isFinitePoint(point.lat, point.lon));
  if (points.length < 4) return new Map();

  const clusters = clusterSessionPoints(points, radiusMeters, byClass);
  if (clusters.length === 0) return new Map();

  const aggregates = new Map<
    string,
    { weightedResidualEast: number; weightedResidualNorth: number; weightSum: number; anchorCount: number }
  >();

  for (const cluster of clusters) {
    let weightSum = 0;
    let weightedLat = 0;
    let weightedLon = 0;
    for (const point of cluster) {
      const weight = Math.max(point.confidence, minConfidenceWeight);
      weightSum += weight;
      weightedLat += point.lat * weight;
      weightedLon += point.lon * weight;
    }
    if (weightSum <= 0) continue;
    const centroidLat = weightedLat / weightSum;
    const centroidLon = weightedLon / weightSum;
    const metersPerLon = metersPerDegreeLon(centroidLat);
    if (!Number.isFinite(metersPerLon) || Math.abs(metersPerLon) < 1e-6) continue;

    for (const point of cluster) {
      const pointWeight = Math.max(point.confidence, minConfidenceWeight);
      const residualEast = (point.lon - centroidLon) * metersPerLon;
      const residualNorth = (point.lat - centroidLat) * METERS_PER_DEGREE_LAT;
      const aggregate = aggregates.get(point.assetId) ?? {
        weightedResidualEast: 0,
        weightedResidualNorth: 0,
        weightSum: 0,
        anchorCount: 0,
      };
      aggregate.weightedResidualEast += residualEast * pointWeight;
      aggregate.weightedResidualNorth += residualNorth * pointWeight;
      aggregate.weightSum += pointWeight;
      aggregate.anchorCount += 1;
      aggregates.set(point.assetId, aggregate);
    }
  }

  const rawCorrections = new Map<string, SessionBiasCorrection>();
  for (const [assetId, aggregate] of aggregates.entries()) {
    if (aggregate.anchorCount < minAnchorsPerAsset || aggregate.weightSum <= 0) continue;
    const eastMeters = -(aggregate.weightedResidualEast / aggregate.weightSum);
    const northMeters = -(aggregate.weightedResidualNorth / aggregate.weightSum);
    const magnitudeMeters = Math.hypot(eastMeters, northMeters);
    rawCorrections.set(assetId, {
      eastMeters,
      northMeters,
      anchorCount: aggregate.anchorCount,
      magnitudeMeters,
    });
  }

  if (rawCorrections.size === 0) return rawCorrections;

  // Remove any global translation by forcing weighted mean correction to zero.
  let meanEast = 0;
  let meanNorth = 0;
  let meanWeight = 0;
  for (const correction of rawCorrections.values()) {
    const weight = Math.max(correction.anchorCount, 1);
    meanEast += correction.eastMeters * weight;
    meanNorth += correction.northMeters * weight;
    meanWeight += weight;
  }
  if (meanWeight > 0) {
    meanEast /= meanWeight;
    meanNorth /= meanWeight;
  }

  const normalized = new Map<string, SessionBiasCorrection>();
  for (const [assetId, correction] of rawCorrections.entries()) {
    let eastMeters = correction.eastMeters - meanEast;
    let northMeters = correction.northMeters - meanNorth;
    const magnitude = Math.hypot(eastMeters, northMeters);
    if (Number.isFinite(maxCorrectionMeters) && maxCorrectionMeters > 0 && magnitude > maxCorrectionMeters) {
      const scale = maxCorrectionMeters / magnitude;
      eastMeters *= scale;
      northMeters *= scale;
    }
    normalized.set(assetId, {
      eastMeters,
      northMeters,
      anchorCount: correction.anchorCount,
      magnitudeMeters: Math.hypot(eastMeters, northMeters),
    });
  }

  return normalized;
}

export function applySessionBiasCorrection(
  lat: number,
  lon: number,
  correction: SessionBiasCorrection
): { lat: number; lon: number } {
  const metersPerLon = metersPerDegreeLon(lat);
  if (!Number.isFinite(metersPerLon) || Math.abs(metersPerLon) < 1e-6) {
    return { lat, lon };
  }
  return {
    lat: lat + correction.northMeters / METERS_PER_DEGREE_LAT,
    lon: lon + correction.eastMeters / metersPerLon,
  };
}
