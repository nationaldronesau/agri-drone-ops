export interface PineSaplingCountDetection {
  id: string;
  assetId: string;
  centerLat: number | null;
  centerLon: number | null;
  confidence: number | null;
}

export interface PineSaplingCluster {
  id: string;
  count: number;
  centerLat: number;
  centerLon: number;
  maxConfidence: number | null;
  detectionIds: string[];
  assetIds: string[];
}

const EARTH_RADIUS_METERS = 6371008.8;

function toRadians(value: number): number {
  return (value * Math.PI) / 180;
}

export function distanceMeters(
  first: { lat: number; lon: number },
  second: { lat: number; lon: number }
): number {
  const lat1 = toRadians(first.lat);
  const lat2 = toRadians(second.lat);
  const deltaLat = toRadians(second.lat - first.lat);
  const deltaLon = toRadians(second.lon - first.lon);

  const a =
    Math.sin(deltaLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(deltaLon / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

  return EARTH_RADIUS_METERS * c;
}

export function clusterPineSaplingDetections(
  detections: PineSaplingCountDetection[],
  radiusMeters: number
): PineSaplingCluster[] {
  const geoDetections = detections.filter(
    (detection): detection is PineSaplingCountDetection & { centerLat: number; centerLon: number } =>
      typeof detection.centerLat === 'number' &&
      Number.isFinite(detection.centerLat) &&
      typeof detection.centerLon === 'number' &&
      Number.isFinite(detection.centerLon)
  );

  if (!Number.isFinite(radiusMeters) || radiusMeters <= 0) {
    return geoDetections.map((detection) => ({
      id: detection.id,
      count: 1,
      centerLat: detection.centerLat,
      centerLon: detection.centerLon,
      maxConfidence: detection.confidence,
      detectionIds: [detection.id],
      assetIds: [detection.assetId],
    }));
  }

  const clusters: PineSaplingCluster[] = [];

  for (const detection of geoDetections) {
    const matchingCluster = clusters.find(
      (cluster) =>
        distanceMeters(
          { lat: detection.centerLat, lon: detection.centerLon },
          { lat: cluster.centerLat, lon: cluster.centerLon }
        ) <= radiusMeters
    );

    if (!matchingCluster) {
      clusters.push({
        id: detection.id,
        count: 1,
        centerLat: detection.centerLat,
        centerLon: detection.centerLon,
        maxConfidence: detection.confidence,
        detectionIds: [detection.id],
        assetIds: [detection.assetId],
      });
      continue;
    }

    const nextCount = matchingCluster.count + 1;
    matchingCluster.centerLat =
      (matchingCluster.centerLat * matchingCluster.count + detection.centerLat) / nextCount;
    matchingCluster.centerLon =
      (matchingCluster.centerLon * matchingCluster.count + detection.centerLon) / nextCount;
    matchingCluster.count = nextCount;
    if (matchingCluster.maxConfidence == null) {
      matchingCluster.maxConfidence = detection.confidence;
    } else if (detection.confidence != null) {
      matchingCluster.maxConfidence = Math.max(matchingCluster.maxConfidence, detection.confidence);
    }
    matchingCluster.detectionIds.push(detection.id);
    if (!matchingCluster.assetIds.includes(detection.assetId)) {
      matchingCluster.assetIds.push(detection.assetId);
    }
  }

  return clusters;
}
