import {
  Prisma,
  TemporalChangeType,
  TemporalRunStatus,
  TemporalSignalType,
} from '@prisma/client';
import area from '@turf/area';
import booleanPointInPolygon from '@turf/boolean-point-in-polygon';
import buffer from '@turf/buffer';
import turfCentroid from '@turf/centroid';
import convex from '@turf/convex';
import { featureCollection, multiPolygon, point } from '@turf/helpers';
import intersect from '@turf/intersect';
import union from '@turf/union';
import type { Feature, MultiPolygon, Point, Polygon, Position } from 'geojson';
import prisma from '@/lib/db';
import { sanitizeClassName } from '@/lib/services/dataset-preparation';

type PolyFeature = Feature<Polygon | MultiPolygon>;
type PointFeature = Feature<Point>;

type TemporalSignal = {
  signalType: TemporalSignalType;
  signalId: string;
  species: string;
  confidence: number;
  lat: number;
  lon: number;
  geometry: PolyFeature | null;
};

type ChangeDraft = {
  changeType: TemporalChangeType;
  species: string;
  signalTypeBaseline: TemporalSignalType | null;
  signalIdBaseline: string | null;
  signalTypeComparison: TemporalSignalType | null;
  signalIdComparison: string | null;
  baselineLat: number | null;
  baselineLon: number | null;
  comparisonLat: number | null;
  comparisonLon: number | null;
  distanceM: number | null;
  overlapScore: number | null;
  confidence: number | null;
  riskScore: number;
  geometry: Prisma.JsonValue | null;
  metadata: Prisma.JsonValue | null;
};

type HotspotDraft = {
  species: string;
  changeMix: Prisma.JsonValue;
  itemCount: number;
  avgConfidence: number | null;
  avgRiskScore: number | null;
  centroidLat: number;
  centroidLon: number;
  polygon: Prisma.JsonValue;
  areaHa: number;
  priorityScore: number | null;
  metadata: Prisma.JsonValue | null;
};

type CoverageCircle = {
  lat: number;
  lon: number;
  radiusM: number;
};

type CoverageResult = {
  geometry: PolyFeature | null;
  circles: CoverageCircle[];
};

type RunConfig = {
  species?: string[];
  minConfidence?: number;
};

const MATCH_DISTANCE_M = 8;
const CLOSE_MATCH_DISTANCE_M = 3;
const OVERLAP_GATE = 0.1;
const DENSITY_RADIUS_M = 15;
const HOTSPOT_EPS_M = 20;
const HOTSPOT_MIN_POINTS = 2;
const HOTSPOT_SINGLETON_BUFFER_M = 5;
const HOTSPOT_FINAL_BUFFER_M = 4;

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function isFiniteCoordinate(lat: number | null | undefined, lon: number | null | undefined): lat is number {
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

function normalizeSpecies(value: string): string {
  return sanitizeClassName(value || '');
}

function normalizeConfidence(value: number | null | undefined, fallback = 0.5): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback;
  }
  return clamp(value, 0, 1);
}

function manualConfidenceToScore(value: string | null | undefined): number {
  if (value === 'CERTAIN') return 0.95;
  if (value === 'LIKELY') return 0.75;
  return 0.5;
}

function toRadians(value: number): number {
  return (value * Math.PI) / 180;
}

function haversineDistanceMeters(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const earthRadius = 6_371_000;
  const dLat = toRadians(b.lat - a.lat);
  const dLon = toRadians(b.lon - a.lon);
  const lat1 = toRadians(a.lat);
  const lat2 = toRadians(b.lat);
  const h =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  return 2 * earthRadius * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

function toMultiPolygonCoordinates(feature: PolyFeature): Position[][][] {
  if (feature.geometry.type === 'Polygon') {
    return [feature.geometry.coordinates];
  }
  return feature.geometry.coordinates;
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

function extractPolygonFeature(value: unknown): PolyFeature | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const type = record.type;

  if (type === 'Feature' && record.geometry) {
    return extractPolygonFeature(record.geometry);
  }
  if (type === 'FeatureCollection' && Array.isArray(record.features)) {
    for (const feature of record.features) {
      const parsed = extractPolygonFeature(feature);
      if (parsed) return parsed;
    }
    return null;
  }

  if (type === 'Polygon' || type === 'MultiPolygon') {
    return {
      type: 'Feature',
      geometry: record as unknown as Polygon | MultiPolygon,
      properties: {},
    };
  }

  return null;
}

function toPointFeature(lat: number, lon: number): PointFeature {
  return point([lon, lat]);
}

function getSignalPositionFromGeometry(geometry: PolyFeature | null): { lat: number; lon: number } | null {
  if (!geometry) return null;
  try {
    const center = turfCentroid(geometry);
    const [lon, lat] = center.geometry.coordinates;
    if (isFiniteCoordinate(lat, lon)) {
      return { lat, lon };
    }
  } catch {
    return null;
  }
  return null;
}

function computeOverlapScore(
  baseline: TemporalSignal,
  comparison: TemporalSignal,
  distanceM: number
): number {
  if (!baseline.geometry || !comparison.geometry) {
    return distanceM <= CLOSE_MATCH_DISTANCE_M ? 1 : 0;
  }

  try {
    const intersection = intersect(featureCollection([baseline.geometry, comparison.geometry]));
    if (!intersection) return 0;
    const intersectionArea = area(intersection);
    if (intersectionArea <= 0) return 0;
    const baselineArea = area(baseline.geometry);
    const comparisonArea = area(comparison.geometry);
    const unionArea = baselineArea + comparisonArea - intersectionArea;
    if (unionArea <= 0) return 0;
    return clamp(intersectionArea / unionArea, 0, 1);
  } catch {
    return 0;
  }
}

function computeCoverageRadiusMeters(asset: {
  altitude: number | null;
  cameraFov: number | null;
}): number {
  if (
    typeof asset.altitude === 'number' &&
    Number.isFinite(asset.altitude) &&
    typeof asset.cameraFov === 'number' &&
    Number.isFinite(asset.cameraFov)
  ) {
    const safeAltitude = asset.altitude > 0 ? asset.altitude : 30;
    const safeFov = clamp(asset.cameraFov, 1, 170);
    const radius = safeAltitude * Math.tan((safeFov * Math.PI) / 360);
    return clamp(radius, 12, 80);
  }

  return 25;
}

async function buildSurveyCoverage(surveyId: string): Promise<CoverageResult> {
  const assets = await prisma.asset.findMany({
    where: { surveyId },
    select: {
      gpsLatitude: true,
      gpsLongitude: true,
      altitude: true,
      cameraFov: true,
    },
  });

  const circles: CoverageCircle[] = [];
  const polygons: PolyFeature[] = [];

  for (const asset of assets) {
    if (!isFiniteCoordinate(asset.gpsLatitude, asset.gpsLongitude)) continue;
    const radiusM = computeCoverageRadiusMeters(asset);
    circles.push({
      lat: asset.gpsLatitude as number,
      lon: asset.gpsLongitude as number,
      radiusM,
    });
    const circle = buffer(point([asset.gpsLongitude as number, asset.gpsLatitude as number]), radiusM, {
      units: 'meters',
    }) as PolyFeature | null;
    if (circle) polygons.push(circle);
  }

  return {
    geometry: mergePolygonFeatures(polygons),
    circles,
  };
}

function isCoveredByComparisonCoverage(
  lat: number,
  lon: number,
  coverage: CoverageResult
): boolean {
  if (coverage.geometry) {
    try {
      return booleanPointInPolygon(toPointFeature(lat, lon), coverage.geometry);
    } catch {
      // Fallback to circle checks below.
    }
  }

  for (const circle of coverage.circles) {
    const distance = haversineDistanceMeters({ lat, lon }, { lat: circle.lat, lon: circle.lon });
    if (distance <= circle.radiusM) return true;
  }
  return false;
}

async function loadSurveySignals(
  surveyId: string,
  filter: { species: Set<string> | null; minConfidence: number }
): Promise<TemporalSignal[]> {
  const [detections, manualAnnotations, pending] = await Promise.all([
    prisma.detection.findMany({
      where: {
        asset: { surveyId },
        type: { in: ['AI', 'YOLO_LOCAL'] },
        rejected: false,
        OR: [{ verified: true }, { userCorrected: true }],
      },
      select: {
        id: true,
        className: true,
        confidence: true,
        centerLat: true,
        centerLon: true,
        geoCoordinates: true,
      },
    }),
    prisma.manualAnnotation.findMany({
      where: {
        session: { asset: { surveyId } },
        verified: true,
      },
      select: {
        id: true,
        weedType: true,
        roboflowClassName: true,
        confidence: true,
        centerLat: true,
        centerLon: true,
        geoCoordinates: true,
      },
    }),
    prisma.pendingAnnotation.findMany({
      where: {
        asset: { surveyId },
        status: 'ACCEPTED',
      },
      select: {
        id: true,
        weedType: true,
        confidence: true,
        centerLat: true,
        centerLon: true,
        geoPolygon: true,
      },
    }),
  ]);

  const signals: TemporalSignal[] = [];

  for (const detection of detections) {
    const species = normalizeSpecies(detection.className);
    if (!species) continue;
    if (filter.species && !filter.species.has(species)) continue;
    const confidence = normalizeConfidence(detection.confidence, 0.5);
    if (confidence < filter.minConfidence) continue;

    const geometry = extractPolygonFeature(detection.geoCoordinates);
    let lat = detection.centerLat;
    let lon = detection.centerLon;
    if (!isFiniteCoordinate(lat, lon)) {
      const fallback = getSignalPositionFromGeometry(geometry);
      lat = fallback?.lat ?? null;
      lon = fallback?.lon ?? null;
    }
    if (!isFiniteCoordinate(lat, lon)) continue;

    signals.push({
      signalType: TemporalSignalType.DETECTION,
      signalId: detection.id,
      species,
      confidence,
      lat: lat as number,
      lon: lon as number,
      geometry,
    });
  }

  for (const annotation of manualAnnotations) {
    const species = normalizeSpecies(annotation.roboflowClassName || annotation.weedType);
    if (!species) continue;
    if (filter.species && !filter.species.has(species)) continue;
    const confidence = manualConfidenceToScore(annotation.confidence);
    if (confidence < filter.minConfidence) continue;

    const geometry = extractPolygonFeature(annotation.geoCoordinates);
    let lat = annotation.centerLat;
    let lon = annotation.centerLon;
    if (!isFiniteCoordinate(lat, lon)) {
      const fallback = getSignalPositionFromGeometry(geometry);
      lat = fallback?.lat ?? null;
      lon = fallback?.lon ?? null;
    }
    if (!isFiniteCoordinate(lat, lon)) continue;

    signals.push({
      signalType: TemporalSignalType.MANUAL,
      signalId: annotation.id,
      species,
      confidence,
      lat: lat as number,
      lon: lon as number,
      geometry,
    });
  }

  for (const pendingAnnotation of pending) {
    const species = normalizeSpecies(pendingAnnotation.weedType);
    if (!species) continue;
    if (filter.species && !filter.species.has(species)) continue;
    const confidence = normalizeConfidence(pendingAnnotation.confidence, 0.5);
    if (confidence < filter.minConfidence) continue;

    const geometry = extractPolygonFeature(pendingAnnotation.geoPolygon);
    let lat = pendingAnnotation.centerLat;
    let lon = pendingAnnotation.centerLon;
    if (!isFiniteCoordinate(lat, lon)) {
      const fallback = getSignalPositionFromGeometry(geometry);
      lat = fallback?.lat ?? null;
      lon = fallback?.lon ?? null;
    }
    if (!isFiniteCoordinate(lat, lon)) continue;

    signals.push({
      signalType: TemporalSignalType.SAM3,
      signalId: pendingAnnotation.id,
      species,
      confidence,
      lat: lat as number,
      lon: lon as number,
      geometry,
    });
  }

  return signals;
}

function speciesSetFromConfig(config: RunConfig): Set<string> | null {
  if (!Array.isArray(config.species) || config.species.length === 0) {
    return null;
  }
  const values = config.species
    .map((value) => normalizeSpecies(value))
    .filter(Boolean);
  return values.length > 0 ? new Set(values) : null;
}

function computeRiskScores(changes: ChangeDraft[]): void {
  const candidates = changes.filter(
    (item) =>
      item.changeType === TemporalChangeType.NEW || item.changeType === TemporalChangeType.PERSISTENT
  );

  for (const item of changes) {
    if (
      item.changeType !== TemporalChangeType.NEW &&
      item.changeType !== TemporalChangeType.PERSISTENT
    ) {
      item.riskScore = 0;
    }
  }

  for (const item of candidates) {
    if (
      typeof item.comparisonLat !== 'number' ||
      typeof item.comparisonLon !== 'number' ||
      !Number.isFinite(item.comparisonLat) ||
      !Number.isFinite(item.comparisonLon)
    ) {
      item.riskScore = 0;
      continue;
    }

    let neighborCount = 0;
    for (const other of candidates) {
      if (other === item) continue;
      if (
        typeof other.comparisonLat !== 'number' ||
        typeof other.comparisonLon !== 'number' ||
        !Number.isFinite(other.comparisonLat) ||
        !Number.isFinite(other.comparisonLon)
      ) {
        continue;
      }
      const distance = haversineDistanceMeters(
        { lat: item.comparisonLat, lon: item.comparisonLon },
        { lat: other.comparisonLat, lon: other.comparisonLon }
      );
      if (distance <= DENSITY_RADIUS_M) neighborCount += 1;
    }

    const localDensity = Math.min(1, neighborCount / 5);
    const confidence = clamp(item.confidence ?? 0.5, 0, 1);
    const persistenceBoost =
      item.changeType === TemporalChangeType.PERSISTENT ? 0.2 : 0;
    item.riskScore = clamp(0.6 * confidence + 0.3 * localDensity + persistenceBoost, 0, 1);
  }
}

function collectHotspotCandidateIndices(changes: ChangeDraft[]): number[] {
  const indices: number[] = [];
  for (let i = 0; i < changes.length; i += 1) {
    const item = changes[i];
    if (
      item.changeType !== TemporalChangeType.NEW &&
      item.changeType !== TemporalChangeType.PERSISTENT
    ) {
      continue;
    }
    if (
      typeof item.comparisonLat !== 'number' ||
      typeof item.comparisonLon !== 'number' ||
      !Number.isFinite(item.comparisonLat) ||
      !Number.isFinite(item.comparisonLon)
    ) {
      continue;
    }
    indices.push(i);
  }
  return indices;
}

function neighborsWithinDistance(
  changes: ChangeDraft[],
  candidateIndexes: number[],
  sourceIndex: number,
  epsMeters: number
): number[] {
  const source = changes[sourceIndex];
  if (
    typeof source.comparisonLat !== 'number' ||
    typeof source.comparisonLon !== 'number' ||
    !Number.isFinite(source.comparisonLat) ||
    !Number.isFinite(source.comparisonLon)
  ) {
    return [];
  }

  const neighbors: number[] = [];
  for (const index of candidateIndexes) {
    const candidate = changes[index];
    if (
      typeof candidate.comparisonLat !== 'number' ||
      typeof candidate.comparisonLon !== 'number' ||
      !Number.isFinite(candidate.comparisonLat) ||
      !Number.isFinite(candidate.comparisonLon)
    ) {
      continue;
    }
    const distance = haversineDistanceMeters(
      { lat: source.comparisonLat, lon: source.comparisonLon },
      { lat: candidate.comparisonLat, lon: candidate.comparisonLon }
    );
    if (distance <= epsMeters) {
      neighbors.push(index);
    }
  }
  return neighbors;
}

function clusterDbscan(changes: ChangeDraft[]): number[][] {
  const candidateIndexes = collectHotspotCandidateIndices(changes);
  const visited = new Set<number>();
  const assigned = new Set<number>();
  const clusters: number[][] = [];
  const noise: number[] = [];

  for (const index of candidateIndexes) {
    if (visited.has(index)) continue;
    visited.add(index);

    const neighbors = neighborsWithinDistance(changes, candidateIndexes, index, HOTSPOT_EPS_M);
    if (neighbors.length < HOTSPOT_MIN_POINTS) {
      noise.push(index);
      continue;
    }

    const cluster = new Set<number>();
    const queue = [...neighbors];
    cluster.add(index);

    while (queue.length > 0) {
      const current = queue.shift() as number;
      if (!visited.has(current)) {
        visited.add(current);
        const currentNeighbors = neighborsWithinDistance(
          changes,
          candidateIndexes,
          current,
          HOTSPOT_EPS_M
        );
        if (currentNeighbors.length >= HOTSPOT_MIN_POINTS) {
          queue.push(...currentNeighbors);
        }
      }
      cluster.add(current);
    }

    const clusterArray = Array.from(cluster);
    clusterArray.forEach((id) => assigned.add(id));
    clusters.push(clusterArray);
  }

  for (const index of noise) {
    if (!assigned.has(index)) {
      clusters.push([index]);
    }
  }

  return clusters;
}

function clusterToGeometry(changes: ChangeDraft[], indexes: number[]): PolyFeature | null {
  const points: PointFeature[] = [];
  for (const index of indexes) {
    const item = changes[index];
    if (
      typeof item.comparisonLat !== 'number' ||
      typeof item.comparisonLon !== 'number' ||
      !Number.isFinite(item.comparisonLat) ||
      !Number.isFinite(item.comparisonLon)
    ) {
      continue;
    }
    points.push(toPointFeature(item.comparisonLat, item.comparisonLon));
  }

  if (points.length === 0) return null;

  let basePolygon: PolyFeature | null = null;
  if (points.length >= 3) {
    try {
      const hull = convex(featureCollection(points));
      if (hull) {
        basePolygon = hull as PolyFeature;
      }
    } catch {
      basePolygon = null;
    }
  }

  if (!basePolygon) {
    const centerLat =
      points.reduce((sum, feature) => sum + feature.geometry.coordinates[1], 0) / points.length;
    const centerLon =
      points.reduce((sum, feature) => sum + feature.geometry.coordinates[0], 0) / points.length;
    basePolygon = buffer(point([centerLon, centerLat]), HOTSPOT_SINGLETON_BUFFER_M, {
      units: 'meters',
    }) as PolyFeature;
  }

  if (!basePolygon) return null;

  const expanded = buffer(basePolygon, HOTSPOT_FINAL_BUFFER_M, {
    units: 'meters',
  }) as PolyFeature | null;
  return expanded || basePolygon;
}

function buildHotspots(changes: ChangeDraft[]): HotspotDraft[] {
  const clusters = clusterDbscan(changes);
  const hotspots: HotspotDraft[] = [];

  for (const indexes of clusters) {
    if (indexes.length === 0) continue;
    const entries = indexes.map((index) => changes[index]);
    const geometry = clusterToGeometry(changes, indexes);
    if (!geometry) continue;

    const centroid = turfCentroid(geometry);
    const [centroidLon, centroidLat] = centroid.geometry.coordinates;
    if (!isFiniteCoordinate(centroidLat, centroidLon)) continue;

    const itemCount = entries.length;
    const avgConfidence =
      itemCount > 0
        ? entries.reduce((sum, item) => sum + (item.confidence ?? 0), 0) / itemCount
        : null;
    const avgRiskScore =
      itemCount > 0 ? entries.reduce((sum, item) => sum + item.riskScore, 0) / itemCount : null;

    const changeMix = {
      new: entries.filter((item) => item.changeType === TemporalChangeType.NEW).length,
      persistent: entries.filter((item) => item.changeType === TemporalChangeType.PERSISTENT).length,
      resolved: entries.filter((item) => item.changeType === TemporalChangeType.RESOLVED).length,
      unobserved: entries.filter((item) => item.changeType === TemporalChangeType.UNOBSERVED).length,
    };
    const speciesCounts = entries.reduce<Record<string, number>>((acc, item) => {
      acc[item.species] = (acc[item.species] || 0) + 1;
      return acc;
    }, {});
    const dominantSpecies = Object.entries(speciesCounts).sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'unknown';

    const priorityScore = clamp(
      0.6 * (avgRiskScore ?? 0) + 0.4 * Math.min(1, itemCount / 10),
      0,
      1
    );

    hotspots.push({
      species: dominantSpecies,
      changeMix: changeMix as Prisma.JsonValue,
      itemCount,
      avgConfidence: avgConfidence == null ? null : Number(avgConfidence.toFixed(4)),
      avgRiskScore: avgRiskScore == null ? null : Number(avgRiskScore.toFixed(4)),
      centroidLat,
      centroidLon,
      polygon: geometry.geometry as unknown as Prisma.JsonValue,
      areaHa: Number((area(geometry) / 10000).toFixed(4)),
      priorityScore: Number(priorityScore.toFixed(4)),
      metadata: {
        speciesCounts,
      } as Prisma.JsonValue,
    });
  }

  return hotspots.sort((a, b) => (b.priorityScore ?? 0) - (a.priorityScore ?? 0));
}

function changeDraftToCreateInput(
  runId: string,
  change: ChangeDraft
): Prisma.TemporalChangeItemCreateManyInput {
  return {
    runId,
    changeType: change.changeType,
    species: change.species,
    signalTypeBaseline: change.signalTypeBaseline,
    signalIdBaseline: change.signalIdBaseline,
    signalTypeComparison: change.signalTypeComparison,
    signalIdComparison: change.signalIdComparison,
    baselineLat: change.baselineLat,
    baselineLon: change.baselineLon,
    comparisonLat: change.comparisonLat,
    comparisonLon: change.comparisonLon,
    distanceM: change.distanceM,
    overlapScore: change.overlapScore,
    confidence: change.confidence,
    riskScore: change.riskScore,
    geometry: change.geometry as Prisma.InputJsonValue | undefined,
    metadata: change.metadata as Prisma.InputJsonValue | undefined,
  };
}

function hotspotDraftToCreateInput(
  runId: string,
  hotspot: HotspotDraft
): Prisma.TemporalHotspotCreateManyInput {
  return {
    runId,
    species: hotspot.species,
    changeMix: hotspot.changeMix as Prisma.InputJsonValue,
    itemCount: hotspot.itemCount,
    avgConfidence: hotspot.avgConfidence,
    avgRiskScore: hotspot.avgRiskScore,
    centroidLat: hotspot.centroidLat,
    centroidLon: hotspot.centroidLon,
    polygon: hotspot.polygon as Prisma.InputJsonValue,
    areaHa: hotspot.areaHa,
    priorityScore: hotspot.priorityScore,
    metadata: hotspot.metadata as Prisma.InputJsonValue | undefined,
  };
}

function chunkArray<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

function buildSummary(changes: ChangeDraft[], hotspots: HotspotDraft[]): Prisma.JsonValue {
  const counts = {
    new: changes.filter((item) => item.changeType === TemporalChangeType.NEW).length,
    persistent: changes.filter((item) => item.changeType === TemporalChangeType.PERSISTENT).length,
    resolved: changes.filter((item) => item.changeType === TemporalChangeType.RESOLVED).length,
    unobserved: changes.filter((item) => item.changeType === TemporalChangeType.UNOBSERVED).length,
  };

  const speciesBreakdownMap = new Map<
    string,
    { new: number; persistent: number; resolved: number; unobserved: number }
  >();
  for (const change of changes) {
    const existing = speciesBreakdownMap.get(change.species) || {
      new: 0,
      persistent: 0,
      resolved: 0,
      unobserved: 0,
    };
    if (change.changeType === TemporalChangeType.NEW) existing.new += 1;
    if (change.changeType === TemporalChangeType.PERSISTENT) existing.persistent += 1;
    if (change.changeType === TemporalChangeType.RESOLVED) existing.resolved += 1;
    if (change.changeType === TemporalChangeType.UNOBSERVED) existing.unobserved += 1;
    speciesBreakdownMap.set(change.species, existing);
  }

  const risk = {
    high: changes.filter((item) => item.riskScore >= 0.8).length,
    medium: changes.filter((item) => item.riskScore >= 0.55 && item.riskScore < 0.8).length,
    low: changes.filter((item) => item.riskScore > 0 && item.riskScore < 0.55).length,
  };

  return {
    counts,
    risk,
    hotspotCount: hotspots.length,
    speciesBreakdown: Array.from(speciesBreakdownMap.entries())
      .map(([species, stats]) => ({ species, ...stats }))
      .sort((a, b) => b.new + b.persistent - (a.new + a.persistent)),
  } as Prisma.JsonValue;
}

function buildMatchingChanges(
  baselineSignals: TemporalSignal[],
  comparisonSignals: TemporalSignal[],
  comparisonCoverage: CoverageResult
): ChangeDraft[] {
  const changes: ChangeDraft[] = [];
  const speciesSet = new Set([
    ...baselineSignals.map((signal) => signal.species),
    ...comparisonSignals.map((signal) => signal.species),
  ]);

  for (const species of speciesSet) {
    const baseline = baselineSignals.filter((signal) => signal.species === species);
    const comparison = comparisonSignals.filter((signal) => signal.species === species);
    const matchedBaseline = new Set<string>();
    const matchedComparison = new Set<string>();

    const candidates: Array<{
      baseline: TemporalSignal;
      comparison: TemporalSignal;
      distanceM: number;
      overlapScore: number;
      cost: number;
    }> = [];

    for (const left of baseline) {
      for (const right of comparison) {
        const distanceM = haversineDistanceMeters(
          { lat: left.lat, lon: left.lon },
          { lat: right.lat, lon: right.lon }
        );
        if (distanceM > MATCH_DISTANCE_M) continue;
        const overlapScore = computeOverlapScore(left, right, distanceM);
        const validMatch =
          distanceM <= CLOSE_MATCH_DISTANCE_M || overlapScore >= OVERLAP_GATE;
        if (!validMatch) continue;

        const cost = 0.7 * (distanceM / MATCH_DISTANCE_M) + 0.3 * (1 - overlapScore);
        candidates.push({
          baseline: left,
          comparison: right,
          distanceM,
          overlapScore,
          cost,
        });
      }
    }

    candidates.sort((a, b) => {
      if (a.cost !== b.cost) return a.cost - b.cost;
      if (a.baseline.signalId !== b.baseline.signalId) {
        return a.baseline.signalId.localeCompare(b.baseline.signalId);
      }
      return a.comparison.signalId.localeCompare(b.comparison.signalId);
    });

    for (const candidate of candidates) {
      if (
        matchedBaseline.has(candidate.baseline.signalId) ||
        matchedComparison.has(candidate.comparison.signalId)
      ) {
        continue;
      }

      matchedBaseline.add(candidate.baseline.signalId);
      matchedComparison.add(candidate.comparison.signalId);
      changes.push({
        changeType: TemporalChangeType.PERSISTENT,
        species,
        signalTypeBaseline: candidate.baseline.signalType,
        signalIdBaseline: candidate.baseline.signalId,
        signalTypeComparison: candidate.comparison.signalType,
        signalIdComparison: candidate.comparison.signalId,
        baselineLat: candidate.baseline.lat,
        baselineLon: candidate.baseline.lon,
        comparisonLat: candidate.comparison.lat,
        comparisonLon: candidate.comparison.lon,
        distanceM: Number(candidate.distanceM.toFixed(4)),
        overlapScore: Number(candidate.overlapScore.toFixed(4)),
        confidence: Number(
          Math.max(candidate.baseline.confidence, candidate.comparison.confidence).toFixed(4)
        ),
        riskScore: 0,
        geometry: {
          baseline: candidate.baseline.geometry?.geometry ?? null,
          comparison: candidate.comparison.geometry?.geometry ?? null,
        } as Prisma.JsonValue,
        metadata: {
          matchCost: Number(candidate.cost.toFixed(4)),
        } as Prisma.JsonValue,
      });
    }

    for (const left of baseline) {
      if (matchedBaseline.has(left.signalId)) continue;
      const covered = isCoveredByComparisonCoverage(left.lat, left.lon, comparisonCoverage);
      changes.push({
        changeType: covered ? TemporalChangeType.RESOLVED : TemporalChangeType.UNOBSERVED,
        species,
        signalTypeBaseline: left.signalType,
        signalIdBaseline: left.signalId,
        signalTypeComparison: null,
        signalIdComparison: null,
        baselineLat: left.lat,
        baselineLon: left.lon,
        comparisonLat: null,
        comparisonLon: null,
        distanceM: null,
        overlapScore: null,
        confidence: Number(left.confidence.toFixed(4)),
        riskScore: 0,
        geometry: {
          baseline: left.geometry?.geometry ?? null,
        } as Prisma.JsonValue,
        metadata: {
          coverageAware: true,
          comparisonCovered: covered,
        } as Prisma.JsonValue,
      });
    }

    for (const right of comparison) {
      if (matchedComparison.has(right.signalId)) continue;
      changes.push({
        changeType: TemporalChangeType.NEW,
        species,
        signalTypeBaseline: null,
        signalIdBaseline: null,
        signalTypeComparison: right.signalType,
        signalIdComparison: right.signalId,
        baselineLat: null,
        baselineLon: null,
        comparisonLat: right.lat,
        comparisonLon: right.lon,
        distanceM: null,
        overlapScore: null,
        confidence: Number(right.confidence.toFixed(4)),
        riskScore: 0,
        geometry: {
          comparison: right.geometry?.geometry ?? null,
        } as Prisma.JsonValue,
        metadata: {
          coverageAware: true,
        } as Prisma.JsonValue,
      });
    }
  }

  return changes;
}

export async function runTemporalComparisonRun(runId: string): Promise<{
  processedSignals: number;
  changeItems: number;
  hotspots: number;
  summary: Prisma.JsonValue;
}> {
  const run = await prisma.temporalComparisonRun.findUnique({
    where: { id: runId },
    select: {
      id: true,
      teamId: true,
      projectId: true,
      baselineSurveyId: true,
      comparisonSurveyId: true,
      createdById: true,
      config: true,
    },
  });

  if (!run) {
    throw new Error('Temporal comparison run not found');
  }

  const configRecord =
    run.config && typeof run.config === 'object' && !Array.isArray(run.config)
      ? (run.config as Record<string, unknown>)
      : {};
  const config: RunConfig = {
    species: Array.isArray(configRecord.species)
      ? configRecord.species.filter((value): value is string => typeof value === 'string')
      : undefined,
    minConfidence:
      typeof configRecord.minConfidence === 'number' && Number.isFinite(configRecord.minConfidence)
        ? clamp(configRecord.minConfidence, 0, 1)
        : 0.45,
  };

  await prisma.temporalComparisonRun.update({
    where: { id: runId },
    data: {
      status: TemporalRunStatus.PROCESSING,
      progress: 10,
      startedAt: new Date(),
      completedAt: null,
      errorMessage: null,
    },
  });

  try {
    const speciesFilter = speciesSetFromConfig(config);
    const [baselineSignals, comparisonSignals, comparisonCoverage] = await Promise.all([
      loadSurveySignals(run.baselineSurveyId, {
        species: speciesFilter,
        minConfidence: config.minConfidence ?? 0.45,
      }),
      loadSurveySignals(run.comparisonSurveyId, {
        species: speciesFilter,
        minConfidence: config.minConfidence ?? 0.45,
      }),
      buildSurveyCoverage(run.comparisonSurveyId),
    ]);

    await prisma.temporalComparisonRun.update({
      where: { id: runId },
      data: {
        progress: 30,
      },
    });

    const changes = buildMatchingChanges(
      baselineSignals,
      comparisonSignals,
      comparisonCoverage
    );

    await prisma.temporalComparisonRun.update({
      where: { id: runId },
      data: {
        progress: 55,
      },
    });

    computeRiskScores(changes);

    await prisma.temporalComparisonRun.update({
      where: { id: runId },
      data: {
        progress: 75,
      },
    });

    const hotspots = buildHotspots(changes);

    await prisma.temporalComparisonRun.update({
      where: { id: runId },
      data: {
        progress: 90,
      },
    });

    const summary = buildSummary(changes, hotspots);

    await prisma.$transaction(async (tx) => {
      await tx.temporalChangeItem.deleteMany({ where: { runId } });
      await tx.temporalHotspot.deleteMany({ where: { runId } });

      const changeRows = changes.map((change) => changeDraftToCreateInput(runId, change));
      const hotspotRows = hotspots.map((hotspot) => hotspotDraftToCreateInput(runId, hotspot));

      for (const chunk of chunkArray(changeRows, 500)) {
        if (chunk.length === 0) continue;
        await tx.temporalChangeItem.createMany({
          data: chunk,
        });
      }

      for (const chunk of chunkArray(hotspotRows, 250)) {
        if (chunk.length === 0) continue;
        await tx.temporalHotspot.createMany({
          data: chunk,
        });
      }

      await tx.temporalComparisonRun.update({
        where: { id: runId },
        data: {
          status: TemporalRunStatus.READY,
          progress: 100,
          summary: summary as Prisma.InputJsonValue,
          completedAt: new Date(),
        },
      });

      await tx.auditLog.create({
        data: {
          action: 'CREATE',
          entityType: 'TemporalComparisonRun',
          entityId: runId,
          userId: run.createdById,
          beforeState: null,
          afterState: {
            status: TemporalRunStatus.READY,
            changeCount: changeRows.length,
            hotspotCount: hotspotRows.length,
          } as Prisma.InputJsonValue,
        },
      });
    });

    return {
      processedSignals: baselineSignals.length + comparisonSignals.length,
      changeItems: changes.length,
      hotspots: hotspots.length,
      summary,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Temporal comparison failed';
    await prisma.$transaction(async (tx) => {
      await tx.temporalComparisonRun.update({
        where: { id: runId },
        data: {
          status: TemporalRunStatus.FAILED,
          progress: 100,
          completedAt: new Date(),
          errorMessage: message,
        },
      });
      await tx.auditLog.create({
        data: {
          action: 'CREATE',
          entityType: 'TemporalComparisonRun',
          entityId: runId,
          userId: run.createdById,
          beforeState: null,
          afterState: {
            status: TemporalRunStatus.FAILED,
            error: message,
          } as Prisma.InputJsonValue,
        },
      });
    });
    throw error;
  }
}
