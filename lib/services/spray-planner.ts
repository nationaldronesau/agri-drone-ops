import {
  ComplianceLayerType,
  Prisma,
  SprayPlanStatus,
} from '@prisma/client';
import area from '@turf/area';
import buffer from '@turf/buffer';
import turfCentroid from '@turf/centroid';
import difference from '@turf/difference';
import { featureCollection, multiPolygon, polygon } from '@turf/helpers';
import intersect from '@turf/intersect';
import { flattenEach } from '@turf/meta';
import union from '@turf/union';
import type { Feature, MultiPolygon, Polygon, Position } from 'geojson';
import prisma from '@/lib/db';
import {
  assessWeatherWindow,
  fetchWeatherForecast,
  pickForecastPointsForWindow,
  type WeatherForecastSnapshot,
  type WeatherRiskThresholds,
  type WeatherWindowAssessment,
} from '@/lib/services/weather-forecast';

const METERS_PER_DEGREE_LAT = 111_320;

export interface SprayPlanGenerationInput {
  projectId: string;
  teamId: string;
  userId: string;
  name?: string;
  classes?: string[];
  includeAIDetections?: boolean;
  includeManualAnnotations?: boolean;
  includeUnverified?: boolean;
  minConfidence?: number;
  zoneRadiusMeters?: number;
  minDetectionsPerZone?: number;
  maxZonesPerMission?: number;
  maxAreaHaPerMission?: number;
  maxTankLiters?: number;
  droneCruiseSpeedMps?: number;
  sprayRateHaPerMin?: number;
  defaultDosePerHa?: number;
  startLat?: number;
  startLon?: number;
  returnToStart?: boolean;
  includeCompliance?: boolean;
  enableWeatherOptimization?: boolean;
  weatherLookaheadHours?: number;
  maxWindSpeedMps?: number;
  maxGustSpeedMps?: number;
  maxPrecipProbability?: number;
  minTemperatureC?: number;
  maxTemperatureC?: number;
  missionTurnaroundMinutes?: number;
  preferredLaunchTimeUtc?: string;
}

export interface SprayPlanConfig {
  classes: string[];
  includeAIDetections: boolean;
  includeManualAnnotations: boolean;
  includeUnverified: boolean;
  minConfidence: number;
  zoneRadiusMeters: number;
  minDetectionsPerZone: number;
  maxZonesPerMission: number;
  maxAreaHaPerMission: number;
  maxTankLiters: number;
  droneCruiseSpeedMps: number;
  sprayRateHaPerMin: number;
  defaultDosePerHa: number;
  startLat: number | null;
  startLon: number | null;
  returnToStart: boolean;
  includeCompliance: boolean;
  enableWeatherOptimization: boolean;
  weatherLookaheadHours: number;
  maxWindSpeedMps: number;
  maxGustSpeedMps: number;
  maxPrecipProbability: number;
  minTemperatureC: number;
  maxTemperatureC: number;
  missionTurnaroundMinutes: number;
  preferredLaunchTimeUtc: string | null;
}

interface SourcePoint {
  sourceId: string;
  sourceType: 'detection' | 'annotation';
  species: string;
  confidence: number;
  lat: number;
  lon: number;
}

interface Point2D {
  x: number;
  y: number;
}

interface LocalPoint extends SourcePoint, Point2D {}

interface GeoPoint {
  lat: number;
  lon: number;
}

interface ZoneDraft {
  sequence: number;
  species: string;
  detectionCount: number;
  averageConfidence: number;
  priorityScore: number;
  centroidLat: number;
  centroidLon: number;
  polygonRing: Array<[number, number]>;
  areaHa: number;
  recommendedDosePerHa: number;
  recommendedLiters: number;
  recommendationSource: string;
  recommendationChemical: string | null;
  sourcePointIds: string[];
}

interface MissionDraft {
  sequence: number;
  name: string;
  zoneIndexes: number[];
  zoneCount: number;
  totalAreaHa: number;
  chemicalLiters: number;
  estimatedDistanceM: number;
  estimatedDurationMin: number;
  routeCoordinates: Array<[number, number]>;
  routeDistanceBeforeM: number;
  routeDistanceAfterM: number;
}

interface ZoneGenerationResult {
  zones: ZoneDraft[];
  skippedClusters: number;
}

type PolyFeature = Feature<Polygon | MultiPolygon>;

interface ComplianceReport {
  enabled: boolean;
  layerCount: number;
  allowedLayerCount: number;
  exclusionLayerCount: number;
  originalZoneCount: number;
  resultingZoneCount: number;
  fullyExcludedZones: number;
  splitZonesCreated: number;
  excludedAreaHa: number;
  appliedLayerNames: string[];
}

interface MissionWeatherSchedule {
  sequence: number;
  startTimeUtc: string;
  endTimeUtc: string;
  weather: WeatherWindowAssessment;
}

interface WeatherOptimizationReport {
  enabled: boolean;
  used: boolean;
  provider: string | null;
  forecastFetchedAt: string | null;
  forecastPointCount: number;
  recommendedLaunchTimeUtc: string | null;
  launchStrategy: 'AUTO' | 'PREFERRED';
  launchWindowHours: number;
  overallDecision: 'GO' | 'CAUTION' | 'NO_GO' | 'UNKNOWN';
  averageRiskScore: number | null;
  highestMissionRiskScore: number | null;
  noGoMissionCount: number;
  cautionMissionCount: number;
  missionSchedules: MissionWeatherSchedule[];
  notes: string[];
}

type WeatherDecision = 'GO' | 'CAUTION' | 'NO_GO';
type OverallWeatherDecision = WeatherDecision | 'UNKNOWN';

const DEFAULTS: SprayPlanConfig = {
  classes: [],
  includeAIDetections: true,
  includeManualAnnotations: true,
  includeUnverified: false,
  minConfidence: 0.45,
  zoneRadiusMeters: 22,
  minDetectionsPerZone: 2,
  maxZonesPerMission: 16,
  maxAreaHaPerMission: 3.5,
  maxTankLiters: 28,
  droneCruiseSpeedMps: 8,
  sprayRateHaPerMin: 0.28,
  defaultDosePerHa: 1.8,
  startLat: null,
  startLon: null,
  returnToStart: true,
  includeCompliance: true,
  enableWeatherOptimization: true,
  weatherLookaheadHours: 30,
  maxWindSpeedMps: 8,
  maxGustSpeedMps: 11,
  maxPrecipProbability: 35,
  minTemperatureC: 5,
  maxTemperatureC: 35,
  missionTurnaroundMinutes: 8,
  preferredLaunchTimeUtc: null,
};

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function toRadians(value: number): number {
  return (value * Math.PI) / 180;
}

function haversineDistanceMeters(a: GeoPoint, b: GeoPoint): number {
  const earthRadius = 6_371_000;
  const dLat = toRadians(b.lat - a.lat);
  const dLon = toRadians(b.lon - a.lon);
  const lat1 = toRadians(a.lat);
  const lat2 = toRadians(b.lat);

  const sinDLat = Math.sin(dLat / 2);
  const sinDLon = Math.sin(dLon / 2);

  const h = sinDLat * sinDLat + Math.cos(lat1) * Math.cos(lat2) * sinDLon * sinDLon;
  return 2 * earthRadius * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

function parseConfidence(value: Prisma.JsonValue | string | number | null | undefined): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return clamp(value, 0, 1);
  }
  if (typeof value === 'string') {
    if (value === 'CERTAIN') return 0.95;
    if (value === 'LIKELY') return 0.75;
    if (value === 'UNCERTAIN') return 0.5;
    const parsed = parseFloat(value);
    if (Number.isFinite(parsed)) {
      return parsed > 1 ? clamp(parsed / 100, 0, 1) : clamp(parsed, 0, 1);
    }
  }
  return 0.5;
}

function isValidCoordinate(lat: number | null | undefined, lon: number | null | undefined): boolean {
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

function asGeoPoint(lat: number | null | undefined, lon: number | null | undefined): GeoPoint | null {
  if (typeof lat !== 'number' || typeof lon !== 'number') {
    return null;
  }
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    return null;
  }
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) {
    return null;
  }
  return { lat, lon };
}

function normalizeSpecies(species: string): string {
  return species.trim();
}

function parseIsoTimestamp(value: unknown): string | null {
  if (typeof value !== 'string' || value.trim() === '') return null;
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) return null;
  return new Date(timestamp).toISOString();
}

function normalizeConfig(input: SprayPlanGenerationInput): SprayPlanConfig {
  const classes = Array.isArray(input.classes)
    ? input.classes.map((value) => value.trim()).filter(Boolean)
    : [];

  const startLat = typeof input.startLat === 'number' && Number.isFinite(input.startLat)
    ? clamp(input.startLat, -90, 90)
    : null;
  const startLon = typeof input.startLon === 'number' && Number.isFinite(input.startLon)
    ? clamp(input.startLon, -180, 180)
    : null;
  const preferredLaunchTimeUtc = parseIsoTimestamp(input.preferredLaunchTimeUtc);
  const normalizedMinTemperatureC = clamp(input.minTemperatureC ?? DEFAULTS.minTemperatureC, -10, 35);
  const normalizedMaxTemperatureC = clamp(input.maxTemperatureC ?? DEFAULTS.maxTemperatureC, 5, 50);
  const minTemperatureC = Math.min(normalizedMinTemperatureC, normalizedMaxTemperatureC - 1);
  const maxTemperatureC = Math.max(normalizedMaxTemperatureC, minTemperatureC + 1);

  return {
    classes,
    includeAIDetections: input.includeAIDetections ?? DEFAULTS.includeAIDetections,
    includeManualAnnotations: input.includeManualAnnotations ?? DEFAULTS.includeManualAnnotations,
    includeUnverified: input.includeUnverified ?? DEFAULTS.includeUnverified,
    minConfidence: clamp(input.minConfidence ?? DEFAULTS.minConfidence, 0, 1),
    zoneRadiusMeters: clamp(input.zoneRadiusMeters ?? DEFAULTS.zoneRadiusMeters, 8, 250),
    minDetectionsPerZone: Math.max(1, Math.floor(input.minDetectionsPerZone ?? DEFAULTS.minDetectionsPerZone)),
    maxZonesPerMission: Math.max(1, Math.floor(input.maxZonesPerMission ?? DEFAULTS.maxZonesPerMission)),
    maxAreaHaPerMission: clamp(input.maxAreaHaPerMission ?? DEFAULTS.maxAreaHaPerMission, 0.2, 100),
    maxTankLiters: clamp(input.maxTankLiters ?? DEFAULTS.maxTankLiters, 1, 1000),
    droneCruiseSpeedMps: clamp(input.droneCruiseSpeedMps ?? DEFAULTS.droneCruiseSpeedMps, 1, 35),
    sprayRateHaPerMin: clamp(input.sprayRateHaPerMin ?? DEFAULTS.sprayRateHaPerMin, 0.01, 10),
    defaultDosePerHa: clamp(input.defaultDosePerHa ?? DEFAULTS.defaultDosePerHa, 0.01, 50),
    startLat,
    startLon,
    returnToStart: input.returnToStart ?? DEFAULTS.returnToStart,
    includeCompliance: input.includeCompliance ?? DEFAULTS.includeCompliance,
    enableWeatherOptimization: input.enableWeatherOptimization ?? DEFAULTS.enableWeatherOptimization,
    weatherLookaheadHours: Math.max(6, Math.min(72, Math.floor(input.weatherLookaheadHours ?? DEFAULTS.weatherLookaheadHours))),
    maxWindSpeedMps: clamp(input.maxWindSpeedMps ?? DEFAULTS.maxWindSpeedMps, 2, 25),
    maxGustSpeedMps: clamp(input.maxGustSpeedMps ?? DEFAULTS.maxGustSpeedMps, 3, 35),
    maxPrecipProbability: clamp(input.maxPrecipProbability ?? DEFAULTS.maxPrecipProbability, 0, 100),
    minTemperatureC,
    maxTemperatureC,
    missionTurnaroundMinutes: clamp(
      input.missionTurnaroundMinutes ?? DEFAULTS.missionTurnaroundMinutes,
      0,
      120
    ),
    preferredLaunchTimeUtc,
  };
}

function parseGeoCoordinates(value: Prisma.JsonValue | null | undefined): GeoPoint | null {
  if (!value || typeof value !== 'object') return null;

  if (!Array.isArray(value)) {
    const record = value as Record<string, Prisma.JsonValue>;

    if (
      typeof record.centerLat === 'number' &&
      typeof record.centerLon === 'number' &&
      isValidCoordinate(record.centerLat, record.centerLon)
    ) {
      return { lat: record.centerLat, lon: record.centerLon };
    }

    const geometry = record.geometry;
    if (geometry && typeof geometry === 'object' && !Array.isArray(geometry)) {
      const geo = geometry as Record<string, Prisma.JsonValue>;
      const coordinates = geo.coordinates;
      if (Array.isArray(coordinates) && coordinates.length > 0) {
        const first = coordinates[0];
        if (Array.isArray(first)) {
          const ring = first as Prisma.JsonValue[];
          if (ring.length > 0 && Array.isArray(ring[0])) {
            const firstPoint = ring[0] as Prisma.JsonValue[];
            const lon = typeof firstPoint[0] === 'number' ? firstPoint[0] : null;
            const lat = typeof firstPoint[1] === 'number' ? firstPoint[1] : null;
            const point = asGeoPoint(lat, lon);
            if (point) {
              return point;
            }
          }
        }
      }
    }
  }

  return null;
}

function toLocalMeters(point: GeoPoint, origin: GeoPoint): Point2D {
  const latFactor = Math.cos(toRadians(origin.lat));
  const x = (point.lon - origin.lon) * METERS_PER_DEGREE_LAT * latFactor;
  const y = (point.lat - origin.lat) * METERS_PER_DEGREE_LAT;
  return { x, y };
}

function fromLocalMeters(point: Point2D, origin: GeoPoint): GeoPoint {
  const lat = origin.lat + point.y / METERS_PER_DEGREE_LAT;
  const lonFactor = Math.cos(toRadians(origin.lat));
  const lon = origin.lon + point.x / (METERS_PER_DEGREE_LAT * (Math.abs(lonFactor) < 1e-6 ? 1e-6 : lonFactor));
  return { lat, lon };
}

function centroid2D(points: Point2D[]): Point2D {
  if (points.length === 0) {
    return { x: 0, y: 0 };
  }
  const totals = points.reduce(
    (acc, point) => ({ x: acc.x + point.x, y: acc.y + point.y }),
    { x: 0, y: 0 }
  );
  return { x: totals.x / points.length, y: totals.y / points.length };
}

function polygonAreaSquareMeters(points: Point2D[]): number {
  if (points.length < 3) return 0;
  let area = 0;
  for (let i = 0; i < points.length; i += 1) {
    const current = points[i];
    const next = points[(i + 1) % points.length];
    area += current.x * next.y - next.x * current.y;
  }
  return Math.abs(area) / 2;
}

function crossProduct(origin: Point2D, a: Point2D, b: Point2D): number {
  return (a.x - origin.x) * (b.y - origin.y) - (a.y - origin.y) * (b.x - origin.x);
}

function convexHull(points: Point2D[]): Point2D[] {
  if (points.length <= 1) {
    return [...points];
  }

  const sorted = [...points].sort((a, b) => {
    if (a.x === b.x) return a.y - b.y;
    return a.x - b.x;
  });

  const lower: Point2D[] = [];
  for (const point of sorted) {
    while (lower.length >= 2 && crossProduct(lower[lower.length - 2], lower[lower.length - 1], point) <= 0) {
      lower.pop();
    }
    lower.push(point);
  }

  const upper: Point2D[] = [];
  for (let i = sorted.length - 1; i >= 0; i -= 1) {
    const point = sorted[i];
    while (upper.length >= 2 && crossProduct(upper[upper.length - 2], upper[upper.length - 1], point) <= 0) {
      upper.pop();
    }
    upper.push(point);
  }

  lower.pop();
  upper.pop();

  return lower.concat(upper);
}

function createBufferedSquare(center: Point2D, halfSizeMeters: number): Point2D[] {
  return [
    { x: center.x - halfSizeMeters, y: center.y - halfSizeMeters },
    { x: center.x + halfSizeMeters, y: center.y - halfSizeMeters },
    { x: center.x + halfSizeMeters, y: center.y + halfSizeMeters },
    { x: center.x - halfSizeMeters, y: center.y + halfSizeMeters },
  ];
}

function stringifyCellKey(x: number, y: number): string {
  return `${x}:${y}`;
}

function parseCellKey(key: string): { x: number; y: number } {
  const [rawX, rawY] = key.split(':');
  return { x: parseInt(rawX, 10), y: parseInt(rawY, 10) };
}

function clusterPoints(points: SourcePoint[], cellSizeMeters: number): SourcePoint[][] {
  if (points.length === 0) return [];

  const origin = {
    lat: points.reduce((sum, point) => sum + point.lat, 0) / points.length,
    lon: points.reduce((sum, point) => sum + point.lon, 0) / points.length,
  };

  const cells = new Map<string, SourcePoint[]>();

  for (const point of points) {
    const local = toLocalMeters(point, origin);
    const cellX = Math.floor(local.x / cellSizeMeters);
    const cellY = Math.floor(local.y / cellSizeMeters);
    const key = stringifyCellKey(cellX, cellY);

    const existing = cells.get(key) ?? [];
    existing.push(point);
    cells.set(key, existing);
  }

  const visited = new Set<string>();
  const clusters: SourcePoint[][] = [];

  for (const key of cells.keys()) {
    if (visited.has(key)) continue;

    const stack = [key];
    visited.add(key);

    const grouped: SourcePoint[] = [];

    while (stack.length > 0) {
      const currentKey = stack.pop() as string;
      const members = cells.get(currentKey);
      if (members) {
        grouped.push(...members);
      }

      const { x, y } = parseCellKey(currentKey);
      for (let offsetX = -1; offsetX <= 1; offsetX += 1) {
        for (let offsetY = -1; offsetY <= 1; offsetY += 1) {
          const neighborKey = stringifyCellKey(x + offsetX, y + offsetY);
          if (cells.has(neighborKey) && !visited.has(neighborKey)) {
            visited.add(neighborKey);
            stack.push(neighborKey);
          }
        }
      }
    }

    if (grouped.length > 0) {
      clusters.push(grouped);
    }
  }

  return clusters;
}

function nearestNeighborRoute(zoneIndexes: number[], zones: ZoneDraft[], start: GeoPoint): number[] {
  const remaining = [...zoneIndexes];
  const ordered: number[] = [];
  let cursor = start;

  while (remaining.length > 0) {
    let bestIndex = 0;
    let bestDistance = Number.POSITIVE_INFINITY;

    for (let i = 0; i < remaining.length; i += 1) {
      const zone = zones[remaining[i]];
      const distance = haversineDistanceMeters(cursor, {
        lat: zone.centroidLat,
        lon: zone.centroidLon,
      });
      if (distance < bestDistance) {
        bestDistance = distance;
        bestIndex = i;
      }
    }

    const [picked] = remaining.splice(bestIndex, 1);
    ordered.push(picked);
    const zone = zones[picked];
    cursor = { lat: zone.centroidLat, lon: zone.centroidLon };
  }

  return ordered;
}

function estimateRouteDistance(routeCoordinates: Array<[number, number]>): number {
  if (routeCoordinates.length < 2) return 0;

  let total = 0;
  for (let i = 1; i < routeCoordinates.length; i += 1) {
    const previous = routeCoordinates[i - 1];
    const current = routeCoordinates[i];

    total += haversineDistanceMeters(
      { lat: previous[1], lon: previous[0] },
      { lat: current[1], lon: current[0] }
    );
  }

  return total;
}

function buildRouteCoordinatesFromOrder(
  orderedZoneIndexes: number[],
  zones: ZoneDraft[],
  start: GeoPoint,
  returnToStart: boolean
): Array<[number, number]> {
  const coords: Array<[number, number]> = [[start.lon, start.lat]];

  for (const zoneIndex of orderedZoneIndexes) {
    const zone = zones[zoneIndex];
    coords.push([zone.centroidLon, zone.centroidLat]);
  }

  if (returnToStart) {
    coords.push([start.lon, start.lat]);
  }

  return coords;
}

function routeDistanceFromOrder(
  orderedZoneIndexes: number[],
  zones: ZoneDraft[],
  start: GeoPoint,
  returnToStart: boolean
): number {
  const coords = buildRouteCoordinatesFromOrder(orderedZoneIndexes, zones, start, returnToStart);
  return estimateRouteDistance(coords);
}

function twoOptOptimizeOrder(
  orderedZoneIndexes: number[],
  zones: ZoneDraft[],
  start: GeoPoint,
  returnToStart: boolean
): number[] {
  if (orderedZoneIndexes.length < 4) return [...orderedZoneIndexes];

  let bestOrder = [...orderedZoneIndexes];
  let bestDistance = routeDistanceFromOrder(bestOrder, zones, start, returnToStart);
  let improved = true;
  let iterations = 0;

  while (improved && iterations < 8) {
    improved = false;
    iterations += 1;

    for (let i = 0; i < bestOrder.length - 1; i += 1) {
      for (let k = i + 1; k < bestOrder.length; k += 1) {
        const candidate = [
          ...bestOrder.slice(0, i),
          ...bestOrder.slice(i, k + 1).reverse(),
          ...bestOrder.slice(k + 1),
        ];
        const distance = routeDistanceFromOrder(candidate, zones, start, returnToStart);
        if (distance + 0.1 < bestDistance) {
          bestOrder = candidate;
          bestDistance = distance;
          improved = true;
        }
      }
    }
  }

  return bestOrder;
}

function optimizeMissionRoute(
  zoneIndexes: number[],
  zones: ZoneDraft[],
  start: GeoPoint,
  returnToStart: boolean
): {
  orderedZoneIndexes: number[];
  routeCoordinates: Array<[number, number]>;
  baselineDistanceM: number;
  optimizedDistanceM: number;
} {
  const baselineOrder = nearestNeighborRoute(zoneIndexes, zones, start);
  const baselineDistanceM = routeDistanceFromOrder(baselineOrder, zones, start, returnToStart);
  const optimizedOrder = twoOptOptimizeOrder(baselineOrder, zones, start, returnToStart);
  const optimizedDistanceM = routeDistanceFromOrder(optimizedOrder, zones, start, returnToStart);

  return {
    orderedZoneIndexes: optimizedOrder,
    routeCoordinates: buildRouteCoordinatesFromOrder(optimizedOrder, zones, start, returnToStart),
    baselineDistanceM,
    optimizedDistanceM,
  };
}

async function fetchSourcePoints(projectId: string, teamId: string, config: SprayPlanConfig): Promise<SourcePoint[]> {
  const points: SourcePoint[] = [];
  const classFilter = config.classes.length > 0 ? config.classes : null;

  if (config.includeAIDetections) {
    const detections = await prisma.detection.findMany({
      where: {
        asset: {
          projectId,
          project: {
            teamId,
          },
        },
        rejected: false,
        type: { in: ['AI', 'YOLO_LOCAL'] },
        centerLat: { not: null },
        centerLon: { not: null },
        ...(config.includeUnverified
          ? {}
          : {
              OR: [{ verified: true }, { userCorrected: true }],
            }),
        ...(classFilter ? { className: { in: classFilter } } : {}),
      },
      select: {
        id: true,
        className: true,
        confidence: true,
        centerLat: true,
        centerLon: true,
      },
    });

    for (const detection of detections) {
      const coordinate = asGeoPoint(detection.centerLat, detection.centerLon);
      if (!coordinate) continue;
      const confidence = parseConfidence(detection.confidence);
      if (confidence < config.minConfidence) continue;

      points.push({
        sourceId: detection.id,
        sourceType: 'detection',
        species: normalizeSpecies(detection.className),
        confidence,
        lat: coordinate.lat,
        lon: coordinate.lon,
      });
    }
  }

  if (config.includeManualAnnotations) {
    const annotations = await prisma.manualAnnotation.findMany({
      where: {
        session: {
          asset: {
            projectId,
            project: {
              teamId,
            },
          },
        },
        ...(config.includeUnverified ? {} : { verified: true }),
        ...(classFilter ? { weedType: { in: classFilter } } : {}),
      },
      select: {
        id: true,
        weedType: true,
        confidence: true,
        centerLat: true,
        centerLon: true,
        geoCoordinates: true,
      },
    });

    for (const annotation of annotations) {
      const direct = asGeoPoint(annotation.centerLat, annotation.centerLon);
      const fallback = direct ?? parseGeoCoordinates(annotation.geoCoordinates);
      if (!fallback) continue;

      const confidence = parseConfidence(annotation.confidence);
      if (confidence < config.minConfidence) continue;

      points.push({
        sourceId: annotation.id,
        sourceType: 'annotation',
        species: normalizeSpecies(annotation.weedType),
        confidence,
        lat: fallback.lat,
        lon: fallback.lon,
      });
    }
  }

  return points;
}

async function generateZones(points: SourcePoint[], config: SprayPlanConfig): Promise<ZoneGenerationResult> {
  if (points.length === 0) {
    return { zones: [], skippedClusters: 0 };
  }

  const speciesSet = new Set(points.map((point) => point.species.toLowerCase()));
  const recommendations = await prisma.chemicalRecommendation.findMany();
  const recommendationMap = new Map(
    recommendations.map((item) => [item.species.toLowerCase(), item])
  );

  let skippedClusters = 0;
  const zones: ZoneDraft[] = [];

  for (const speciesKey of speciesSet) {
    const speciesPoints = points.filter((point) => point.species.toLowerCase() === speciesKey);
    if (speciesPoints.length === 0) continue;

    const clusters = clusterPoints(speciesPoints, config.zoneRadiusMeters);
    const origin = {
      lat: speciesPoints.reduce((sum, point) => sum + point.lat, 0) / speciesPoints.length,
      lon: speciesPoints.reduce((sum, point) => sum + point.lon, 0) / speciesPoints.length,
    };

    const recommendation = recommendationMap.get(speciesKey);
    const dosePerHa = recommendation?.dosagePerHa ?? config.defaultDosePerHa;

    for (const cluster of clusters) {
      if (cluster.length < config.minDetectionsPerZone) {
        skippedClusters += 1;
        continue;
      }

      const localPoints: LocalPoint[] = cluster.map((point) => ({
        ...point,
        ...toLocalMeters(point, origin),
      }));

      const center = centroid2D(localPoints);
      const hull = convexHull(localPoints);

      const polygonLocal = hull.length >= 3
        ? hull.map(({ x, y }) => ({ x, y }))
        : createBufferedSquare(center, Math.max(4, config.zoneRadiusMeters / 2));

      const areaM2 = polygonAreaSquareMeters(polygonLocal);
      const areaHa = Math.max(0.0001, areaM2 / 10_000);

      const polygonGeo = polygonLocal.map((point) => fromLocalMeters(point, origin));
      const ring: Array<[number, number]> = polygonGeo.map((point) => [point.lon, point.lat]);
      if (ring.length > 0) {
        const first = ring[0];
        const last = ring[ring.length - 1];
        if (first[0] !== last[0] || first[1] !== last[1]) {
          ring.push([first[0], first[1]]);
        }
      }

      const avgConfidence = cluster.reduce((sum, point) => sum + point.confidence, 0) / cluster.length;
      const priorityScore = cluster.length * (0.4 + avgConfidence * 0.6);
      const centerGeo = fromLocalMeters(center, origin);

      zones.push({
        sequence: 0,
        species: cluster[0].species,
        detectionCount: cluster.length,
        averageConfidence: avgConfidence,
        priorityScore,
        centroidLat: centerGeo.lat,
        centroidLon: centerGeo.lon,
        polygonRing: ring,
        areaHa,
        recommendedDosePerHa: dosePerHa,
        recommendedLiters: areaHa * dosePerHa,
        recommendationSource: recommendation ? 'chemical-recommendation' : 'default-dose',
        recommendationChemical: recommendation?.chemical ?? null,
        sourcePointIds: cluster.map((point) => point.sourceId),
      });
    }
  }

  const ordered = zones
    .sort((a, b) => b.priorityScore - a.priorityScore)
    .map((zone, index) => ({ ...zone, sequence: index + 1 }));

  return { zones: ordered, skippedClusters };
}

function splitIntoMissions(zones: ZoneDraft[], config: SprayPlanConfig, start: GeoPoint): MissionDraft[] {
  if (zones.length === 0) return [];

  const unassigned = zones.map((_, index) => index);
  const missions: MissionDraft[] = [];

  while (unassigned.length > 0) {
    const missionZoneIndexes: number[] = [];
    let missionArea = 0;
    let missionLiters = 0;

    const prioritized = [...unassigned].sort((a, b) => zones[b].priorityScore - zones[a].priorityScore);
    const firstZoneIndex = prioritized[0];
    missionZoneIndexes.push(firstZoneIndex);

    missionArea += zones[firstZoneIndex].areaHa;
    missionLiters += zones[firstZoneIndex].recommendedLiters;
    unassigned.splice(unassigned.indexOf(firstZoneIndex), 1);

    while (unassigned.length > 0 && missionZoneIndexes.length < config.maxZonesPerMission) {
      const routeOrder = nearestNeighborRoute(missionZoneIndexes, zones, start);
      const lastZone = zones[routeOrder[routeOrder.length - 1]];

      let bestCandidate: number | null = null;
      let bestDistance = Number.POSITIVE_INFINITY;

      for (const candidateIndex of unassigned) {
        const zone = zones[candidateIndex];
        if (missionArea + zone.areaHa > config.maxAreaHaPerMission) continue;
        if (missionLiters + zone.recommendedLiters > config.maxTankLiters) continue;

        const distance = haversineDistanceMeters(
          { lat: lastZone.centroidLat, lon: lastZone.centroidLon },
          { lat: zone.centroidLat, lon: zone.centroidLon }
        );

        if (distance < bestDistance) {
          bestDistance = distance;
          bestCandidate = candidateIndex;
        }
      }

      if (bestCandidate == null) {
        break;
      }

      missionZoneIndexes.push(bestCandidate);
      missionArea += zones[bestCandidate].areaHa;
      missionLiters += zones[bestCandidate].recommendedLiters;
      unassigned.splice(unassigned.indexOf(bestCandidate), 1);
    }

    const route = optimizeMissionRoute(missionZoneIndexes, zones, start, config.returnToStart);
    const estimatedDistanceM = route.optimizedDistanceM;
    const transitMinutes = estimatedDistanceM / (config.droneCruiseSpeedMps * 60);
    const sprayMinutes = missionArea / config.sprayRateHaPerMin;

    missions.push({
      sequence: missions.length + 1,
      name: `Mission ${missions.length + 1}`,
      zoneIndexes: route.orderedZoneIndexes,
      zoneCount: route.orderedZoneIndexes.length,
      totalAreaHa: missionArea,
      chemicalLiters: missionLiters,
      estimatedDistanceM,
      estimatedDurationMin: transitMinutes + sprayMinutes,
      routeCoordinates: route.routeCoordinates,
      routeDistanceBeforeM: route.baselineDistanceM,
      routeDistanceAfterM: route.optimizedDistanceM,
    });
  }

  return missions;
}

function weatherDecisionSeverity(decision: OverallWeatherDecision): number {
  if (decision === 'NO_GO') return 3;
  if (decision === 'CAUTION') return 2;
  if (decision === 'GO') return 1;
  return 0;
}

function mergeWeatherDecision(
  current: OverallWeatherDecision,
  next: OverallWeatherDecision
): OverallWeatherDecision {
  return weatherDecisionSeverity(next) > weatherDecisionSeverity(current) ? next : current;
}

function thresholdsFromConfig(config: SprayPlanConfig): WeatherRiskThresholds {
  return {
    maxWindSpeedMps: config.maxWindSpeedMps,
    maxGustSpeedMps: config.maxGustSpeedMps,
    maxPrecipProbability: config.maxPrecipProbability,
    minTemperatureC: config.minTemperatureC,
    maxTemperatureC: config.maxTemperatureC,
  };
}

function evaluateLaunchCandidate(
  launchMs: number,
  missions: MissionDraft[],
  forecast: WeatherForecastSnapshot,
  thresholds: WeatherRiskThresholds,
  turnaroundMinutes: number
): {
  missionSchedules: MissionWeatherSchedule[];
  overallDecision: OverallWeatherDecision;
  averageRiskScore: number | null;
  highestRiskScore: number | null;
  noGoMissionCount: number;
  cautionMissionCount: number;
  objectiveScore: number;
} {
  const missionSchedules: MissionWeatherSchedule[] = [];
  let cursor = launchMs;
  const turnaroundMs = Math.max(0, Math.round(turnaroundMinutes * 60_000));

  let overallDecision: OverallWeatherDecision = 'GO';
  let noGoMissionCount = 0;
  let cautionMissionCount = 0;
  const scores: number[] = [];

  for (const mission of missions) {
    const durationMs = Math.max(60_000, Math.round(mission.estimatedDurationMin * 60_000));
    const startMs = cursor;
    const endMs = startMs + durationMs;
    const points = pickForecastPointsForWindow(forecast, startMs, endMs);
    const assessment = assessWeatherWindow(points, thresholds);

    if (assessment.decision === 'NO_GO') noGoMissionCount += 1;
    if (assessment.decision === 'CAUTION') cautionMissionCount += 1;

    scores.push(assessment.score);
    overallDecision = mergeWeatherDecision(overallDecision, assessment.decision as WeatherDecision);

    missionSchedules.push({
      sequence: mission.sequence,
      startTimeUtc: new Date(startMs).toISOString(),
      endTimeUtc: new Date(endMs).toISOString(),
      weather: assessment,
    });

    cursor = endMs + turnaroundMs;
  }

  const averageRiskScore = scores.length > 0
    ? scores.reduce((sum, score) => sum + score, 0) / scores.length
    : null;
  const highestRiskScore = scores.length > 0 ? Math.max(...scores) : null;
  const objectiveScore =
    (averageRiskScore ?? 1) * 100 +
    (highestRiskScore ?? 1) * 80 +
    noGoMissionCount * 400 +
    cautionMissionCount * 120;

  return {
    missionSchedules,
    overallDecision,
    averageRiskScore,
    highestRiskScore,
    noGoMissionCount,
    cautionMissionCount,
    objectiveScore,
  };
}

function collectLaunchCandidates(
  config: SprayPlanConfig,
  forecast: WeatherForecastSnapshot
): Array<{ launchMs: number; strategy: 'AUTO' | 'PREFERRED' }> {
  const candidates = new Map<number, 'AUTO' | 'PREFERRED'>();
  const now = Date.now();
  const forecastTimes = forecast.points
    .map((point) => new Date(point.timestamp).getTime())
    .filter((timestamp) => Number.isFinite(timestamp));
  const forecastStartMs = forecastTimes.length > 0 ? Math.min(...forecastTimes) : now;
  const forecastEndMs = forecastTimes.length > 0 ? Math.max(...forecastTimes) : now;

  if (config.preferredLaunchTimeUtc) {
    const preferredMs = new Date(config.preferredLaunchTimeUtc).getTime();
    if (
      Number.isFinite(preferredMs) &&
      preferredMs >= now &&
      preferredMs >= forecastStartMs &&
      preferredMs <= forecastEndMs + 60 * 60 * 1000
    ) {
      candidates.set(preferredMs, 'PREFERRED');
    }
  }

  for (const point of forecast.points) {
    const launchMs = new Date(point.timestamp).getTime();
    if (!Number.isFinite(launchMs) || launchMs < now) continue;
    if (!candidates.has(launchMs)) {
      candidates.set(launchMs, 'AUTO');
    }
  }

  return Array.from(candidates.entries())
    .sort((a, b) => a[0] - b[0])
    .slice(0, 36)
    .map(([launchMs, strategy]) => ({ launchMs, strategy }));
}

async function optimizeWeatherWindowForMissions(
  missions: MissionDraft[],
  config: SprayPlanConfig,
  start: GeoPoint
): Promise<WeatherOptimizationReport> {
  if (!config.enableWeatherOptimization || missions.length === 0) {
    return {
      enabled: config.enableWeatherOptimization,
      used: false,
      provider: null,
      forecastFetchedAt: null,
      forecastPointCount: 0,
      recommendedLaunchTimeUtc: null,
      launchStrategy: config.preferredLaunchTimeUtc ? 'PREFERRED' : 'AUTO',
      launchWindowHours: config.weatherLookaheadHours,
      overallDecision: 'UNKNOWN',
      averageRiskScore: null,
      highestMissionRiskScore: null,
      noGoMissionCount: 0,
      cautionMissionCount: 0,
      missionSchedules: [],
      notes: config.enableWeatherOptimization ? ['Weather optimization skipped due to no missions'] : [],
    };
  }

  try {
    const forecast = await fetchWeatherForecast(start.lat, start.lon, config.weatherLookaheadHours);
    const thresholds = thresholdsFromConfig(config);
    const launchCandidates = collectLaunchCandidates(config, forecast);

    if (launchCandidates.length === 0) {
      return {
        enabled: true,
        used: false,
        provider: forecast.provider,
        forecastFetchedAt: forecast.fetchedAt,
        forecastPointCount: forecast.points.length,
        recommendedLaunchTimeUtc: null,
        launchStrategy: config.preferredLaunchTimeUtc ? 'PREFERRED' : 'AUTO',
        launchWindowHours: config.weatherLookaheadHours,
        overallDecision: 'UNKNOWN',
        averageRiskScore: null,
        highestMissionRiskScore: null,
        noGoMissionCount: 0,
        cautionMissionCount: 0,
        missionSchedules: [],
        notes: ['No future forecast timestamps available for scheduling'],
      };
    }

    const evaluated = launchCandidates.map((candidate) => ({
      candidate,
      result: evaluateLaunchCandidate(
        candidate.launchMs,
        missions,
        forecast,
        thresholds,
        config.missionTurnaroundMinutes
      ),
    }));

    const best = evaluated.sort((a, b) => a.result.objectiveScore - b.result.objectiveScore)[0];
    const bestStrategy = best.candidate.strategy;
    const notes: string[] = [];

    if (config.preferredLaunchTimeUtc && bestStrategy !== 'PREFERRED') {
      notes.push('Preferred launch time was superseded by a safer forecast window');
    } else if (bestStrategy === 'PREFERRED') {
      notes.push('Preferred launch time selected');
    }

    notes.push(
      `Thresholds: wind <= ${config.maxWindSpeedMps.toFixed(1)} m/s, gust <= ${config.maxGustSpeedMps.toFixed(1)} m/s, precip <= ${config.maxPrecipProbability.toFixed(0)}%`
    );

    return {
      enabled: true,
      used: true,
      provider: forecast.provider,
      forecastFetchedAt: forecast.fetchedAt,
      forecastPointCount: forecast.points.length,
      recommendedLaunchTimeUtc: new Date(best.candidate.launchMs).toISOString(),
      launchStrategy: bestStrategy,
      launchWindowHours: config.weatherLookaheadHours,
      overallDecision: best.result.overallDecision,
      averageRiskScore: best.result.averageRiskScore,
      highestMissionRiskScore: best.result.highestRiskScore,
      noGoMissionCount: best.result.noGoMissionCount,
      cautionMissionCount: best.result.cautionMissionCount,
      missionSchedules: best.result.missionSchedules,
      notes,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown weather optimization error';
    return {
      enabled: true,
      used: false,
      provider: null,
      forecastFetchedAt: null,
      forecastPointCount: 0,
      recommendedLaunchTimeUtc: null,
      launchStrategy: config.preferredLaunchTimeUtc ? 'PREFERRED' : 'AUTO',
      launchWindowHours: config.weatherLookaheadHours,
      overallDecision: 'UNKNOWN',
      averageRiskScore: null,
      highestMissionRiskScore: null,
      noGoMissionCount: 0,
      cautionMissionCount: 0,
      missionSchedules: [],
      notes: [`Weather optimization unavailable: ${message}`],
    };
  }
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
      merged = candidate;
      continue;
    }

    // Fallback when turf union cannot merge (invalid topology in one geometry).
    merged = multiPolygon([
      ...toMultiPolygonCoordinates(merged),
      ...toMultiPolygonCoordinates(next),
    ]);
  }

  return merged;
}

function extractPolygonFeaturesFromJson(value: unknown): PolyFeature[] {
  if (!value || typeof value !== 'object') return [];

  const record = value as Record<string, unknown>;
  const type = record.type;

  if (type === 'FeatureCollection' && Array.isArray(record.features)) {
    return record.features.flatMap((feature) => extractPolygonFeaturesFromJson(feature));
  }

  if (type === 'Feature' && record.geometry) {
    const geometryFeatures = extractPolygonFeaturesFromJson(record.geometry);
    return geometryFeatures.length > 0
      ? geometryFeatures.map((feature) => ({
          ...feature,
          properties: typeof record.properties === 'object' && record.properties ? record.properties : {},
        }))
      : [];
  }

  if (type === 'Polygon') {
    const coordinates = record.coordinates;
    if (Array.isArray(coordinates)) {
      return [
        {
          type: 'Feature',
          properties: {},
          geometry: {
            type: 'Polygon',
            coordinates: coordinates as Position[][],
          },
        },
      ];
    }
  }

  if (type === 'MultiPolygon') {
    const coordinates = record.coordinates;
    if (Array.isArray(coordinates)) {
      return [
        {
          type: 'Feature',
          properties: {},
          geometry: {
            type: 'MultiPolygon',
            coordinates: coordinates as Position[][][],
          },
        },
      ];
    }
  }

  return [];
}

function applyBufferToFeature(feature: PolyFeature, meters: number): PolyFeature {
  const distance = Math.max(0, meters);
  if (distance <= 0) return feature;

  const buffered = buffer(feature, distance, { units: 'meters' });
  if (!buffered) return feature;
  if (buffered.geometry.type !== 'Polygon' && buffered.geometry.type !== 'MultiPolygon') {
    return feature;
  }
  return buffered as PolyFeature;
}

function zoneToPolygonFeature(zone: ZoneDraft): Feature<Polygon> {
  return polygon([zone.polygonRing as unknown as Position[]]);
}

function splitFeatureToPolygons(feature: PolyFeature): Array<Feature<Polygon>> {
  const result: Array<Feature<Polygon>> = [];
  flattenEach(featureCollection([feature]), (current) => {
    if (current.geometry.type === 'Polygon') {
      result.push(current as Feature<Polygon>);
    }
  });
  return result;
}

function polygonAreaHa(feature: Feature<Polygon>): number {
  return area(feature) / 10_000;
}

function polygonRingFromFeature(feature: Feature<Polygon>): Array<[number, number]> {
  const ring = feature.geometry.coordinates[0] ?? [];
  return ring
    .filter((coord): coord is Position => Array.isArray(coord) && coord.length >= 2)
    .map((coord) => [Number(coord[0]), Number(coord[1])] as [number, number])
    .filter(([lon, lat]) => Number.isFinite(lon) && Number.isFinite(lat));
}

function centroidFromFeature(feature: Feature<Polygon>): GeoPoint | null {
  const center = turfCentroid(feature);
  const coords = center.geometry.coordinates;
  if (!Array.isArray(coords) || coords.length < 2) return null;

  const lon = typeof coords[0] === 'number' ? coords[0] : NaN;
  const lat = typeof coords[1] === 'number' ? coords[1] : NaN;
  return asGeoPoint(lat, lon);
}

async function applyComplianceLayersToZones(
  zones: ZoneDraft[],
  config: SprayPlanConfig,
  projectId: string,
  teamId: string
): Promise<{ zones: ZoneDraft[]; report: ComplianceReport }> {
  const baseReport: ComplianceReport = {
    enabled: config.includeCompliance,
    layerCount: 0,
    allowedLayerCount: 0,
    exclusionLayerCount: 0,
    originalZoneCount: zones.length,
    resultingZoneCount: zones.length,
    fullyExcludedZones: 0,
    splitZonesCreated: 0,
    excludedAreaHa: 0,
    appliedLayerNames: [],
  };

  if (!config.includeCompliance || zones.length === 0) {
    return { zones, report: baseReport };
  }

  const layers = await prisma.complianceLayer.findMany({
    where: {
      teamId,
      projectId,
      isActive: true,
      layerType: { in: [ComplianceLayerType.ALLOWED_AREA, ComplianceLayerType.EXCLUSION_AREA] },
    },
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      name: true,
      layerType: true,
      bufferMeters: true,
      geometry: true,
    },
  });

  if (layers.length === 0) {
    return { zones, report: baseReport };
  }

  const allowedFeatures: PolyFeature[] = [];
  const exclusionFeatures: PolyFeature[] = [];
  const appliedLayerNames = new Set<string>();

  for (const layer of layers) {
    const features = extractPolygonFeaturesFromJson(layer.geometry);
    if (features.length === 0) continue;

    for (const feature of features) {
      if (layer.layerType === ComplianceLayerType.ALLOWED_AREA) {
        allowedFeatures.push(feature);
      } else if (layer.layerType === ComplianceLayerType.EXCLUSION_AREA) {
        exclusionFeatures.push(applyBufferToFeature(feature, layer.bufferMeters ?? 0));
      }
    }

    appliedLayerNames.add(layer.name);
  }

  const allowedUnion = mergePolygonFeatures(allowedFeatures);
  const exclusionUnion = mergePolygonFeatures(exclusionFeatures);

  const adjustedZones: ZoneDraft[] = [];
  let fullyExcludedZones = 0;
  let splitZonesCreated = 0;
  let excludedAreaHa = 0;

  for (const zone of zones) {
    const originalArea = zone.areaHa;
    let working: PolyFeature | null = zoneToPolygonFeature(zone);

    if (working && allowedUnion) {
      working = intersect(featureCollection([working, allowedUnion]));
    }

    if (working && exclusionUnion) {
      working = difference(featureCollection([working, exclusionUnion]));
    }

    if (!working) {
      fullyExcludedZones += 1;
      excludedAreaHa += originalArea;
      continue;
    }

    const pieces = splitFeatureToPolygons(working).filter((piece) => polygonAreaHa(piece) > 0.00001);
    if (pieces.length === 0) {
      fullyExcludedZones += 1;
      excludedAreaHa += originalArea;
      continue;
    }

    if (pieces.length > 1) {
      splitZonesCreated += pieces.length - 1;
    }

    let retainedArea = 0;

    for (const piece of pieces) {
      const areaHa = polygonAreaHa(piece);
      const center = centroidFromFeature(piece);
      const ring = polygonRingFromFeature(piece);
      if (!center || ring.length < 4) continue;

      retainedArea += areaHa;
      const areaRatio = originalArea > 0 ? Math.max(0.05, Math.min(1, areaHa / originalArea)) : 1;

      adjustedZones.push({
        ...zone,
        sequence: 0,
        areaHa,
        centroidLat: center.lat,
        centroidLon: center.lon,
        polygonRing: ring,
        detectionCount: Math.max(1, Math.round(zone.detectionCount * areaRatio)),
        priorityScore: zone.priorityScore * areaRatio,
        recommendedLiters: areaHa * zone.recommendedDosePerHa,
      });
    }

    excludedAreaHa += Math.max(0, originalArea - retainedArea);
  }

  const ordered = adjustedZones
    .sort((a, b) => b.priorityScore - a.priorityScore)
    .map((zone, index) => ({ ...zone, sequence: index + 1 }));

  return {
    zones: ordered,
    report: {
      enabled: true,
      layerCount: layers.length,
      allowedLayerCount: layers.filter((layer) => layer.layerType === ComplianceLayerType.ALLOWED_AREA).length,
      exclusionLayerCount: layers.filter((layer) => layer.layerType === ComplianceLayerType.EXCLUSION_AREA).length,
      originalZoneCount: zones.length,
      resultingZoneCount: ordered.length,
      fullyExcludedZones,
      splitZonesCreated,
      excludedAreaHa: Number(excludedAreaHa.toFixed(4)),
      appliedLayerNames: Array.from(appliedLayerNames),
    },
  };
}

function defaultPlanName(projectName: string): string {
  const date = new Date().toISOString().slice(0, 10);
  return `${projectName} Spray Plan ${date}`;
}

export async function createSprayPlan(input: SprayPlanGenerationInput): Promise<{ planId: string }> {
  const config = normalizeConfig(input);
  const project = await prisma.project.findFirst({
    where: {
      id: input.projectId,
      teamId: input.teamId,
    },
    select: {
      id: true,
      name: true,
      centerLat: true,
      centerLon: true,
    },
  });

  if (!project) {
    throw new Error('Project not found or access denied');
  }

  const plan = await prisma.sprayPlan.create({
    data: {
      name: input.name?.trim() || defaultPlanName(project.name),
      teamId: input.teamId,
      projectId: input.projectId,
      createdById: input.userId,
      status: SprayPlanStatus.QUEUED,
      progress: 0,
      config: config as unknown as Prisma.InputJsonValue,
    },
    select: { id: true },
  });

  // Fire-and-forget generation so the API can return immediately.
  setTimeout(() => {
    void runSprayPlan(plan.id).catch((error) => {
      console.error('[spray-planner] plan execution error', { planId: plan.id, error });
    });
  }, 0);

  return { planId: plan.id };
}

export async function runSprayPlan(planId: string): Promise<void> {
  const plan = await prisma.sprayPlan.findUnique({
    where: { id: planId },
    include: {
      project: {
        select: {
          id: true,
          name: true,
          centerLat: true,
          centerLon: true,
        },
      },
    },
  });

  if (!plan) {
    throw new Error('Plan not found');
  }

  const rawConfig = plan.config as Prisma.JsonValue;
  const parsedInput = (rawConfig && typeof rawConfig === 'object' && !Array.isArray(rawConfig)
    ? (rawConfig as Partial<SprayPlanConfig>)
    : {}) as Partial<SprayPlanConfig>;

  const config: SprayPlanConfig = {
    ...DEFAULTS,
    ...parsedInput,
    classes: Array.isArray(parsedInput.classes)
      ? parsedInput.classes.filter((value): value is string => typeof value === 'string')
      : [],
    startLat:
      typeof parsedInput.startLat === 'number' && Number.isFinite(parsedInput.startLat)
        ? parsedInput.startLat
        : null,
    startLon:
      typeof parsedInput.startLon === 'number' && Number.isFinite(parsedInput.startLon)
        ? parsedInput.startLon
        : null,
    includeCompliance:
      typeof parsedInput.includeCompliance === 'boolean'
        ? parsedInput.includeCompliance
        : DEFAULTS.includeCompliance,
    enableWeatherOptimization:
      typeof parsedInput.enableWeatherOptimization === 'boolean'
        ? parsedInput.enableWeatherOptimization
        : DEFAULTS.enableWeatherOptimization,
    weatherLookaheadHours:
      typeof parsedInput.weatherLookaheadHours === 'number' && Number.isFinite(parsedInput.weatherLookaheadHours)
        ? clamp(Math.floor(parsedInput.weatherLookaheadHours), 6, 72)
        : DEFAULTS.weatherLookaheadHours,
    maxWindSpeedMps:
      typeof parsedInput.maxWindSpeedMps === 'number' && Number.isFinite(parsedInput.maxWindSpeedMps)
        ? clamp(parsedInput.maxWindSpeedMps, 2, 25)
        : DEFAULTS.maxWindSpeedMps,
    maxGustSpeedMps:
      typeof parsedInput.maxGustSpeedMps === 'number' && Number.isFinite(parsedInput.maxGustSpeedMps)
        ? clamp(parsedInput.maxGustSpeedMps, 3, 35)
        : DEFAULTS.maxGustSpeedMps,
    maxPrecipProbability:
      typeof parsedInput.maxPrecipProbability === 'number' && Number.isFinite(parsedInput.maxPrecipProbability)
        ? clamp(parsedInput.maxPrecipProbability, 0, 100)
        : DEFAULTS.maxPrecipProbability,
    minTemperatureC:
      typeof parsedInput.minTemperatureC === 'number' && Number.isFinite(parsedInput.minTemperatureC)
        ? clamp(parsedInput.minTemperatureC, -10, 35)
        : DEFAULTS.minTemperatureC,
    maxTemperatureC:
      typeof parsedInput.maxTemperatureC === 'number' && Number.isFinite(parsedInput.maxTemperatureC)
        ? clamp(parsedInput.maxTemperatureC, 5, 50)
        : DEFAULTS.maxTemperatureC,
    missionTurnaroundMinutes:
      typeof parsedInput.missionTurnaroundMinutes === 'number' && Number.isFinite(parsedInput.missionTurnaroundMinutes)
        ? clamp(parsedInput.missionTurnaroundMinutes, 0, 120)
        : DEFAULTS.missionTurnaroundMinutes,
    preferredLaunchTimeUtc:
      typeof parsedInput.preferredLaunchTimeUtc === 'string'
        ? parseIsoTimestamp(parsedInput.preferredLaunchTimeUtc)
        : DEFAULTS.preferredLaunchTimeUtc,
  };

  if (config.minTemperatureC >= config.maxTemperatureC) {
    const midpoint = (config.minTemperatureC + config.maxTemperatureC) / 2;
    config.minTemperatureC = midpoint - 0.5;
    config.maxTemperatureC = midpoint + 0.5;
  }

  await prisma.sprayPlan.update({
    where: { id: planId },
    data: {
      status: SprayPlanStatus.PROCESSING,
      progress: 5,
      errorMessage: null,
      startedAt: new Date(),
      completedAt: null,
    },
  });

  try {
    const points = await fetchSourcePoints(plan.projectId, plan.teamId, config);

    await prisma.sprayPlan.update({
      where: { id: planId },
      data: { progress: 25 },
    });

    if (points.length === 0) {
      throw new Error('No eligible detections/annotations found for this plan');
    }

    const zoneResult = await generateZones(points, config);

    await prisma.sprayPlan.update({
      where: { id: planId },
      data: { progress: 55 },
    });

    if (zoneResult.zones.length === 0) {
      throw new Error('No zones generated. Loosen filters or reduce minimum detections per zone.');
    }

    const complianceResult = await applyComplianceLayersToZones(
      zoneResult.zones,
      config,
      plan.projectId,
      plan.teamId
    );

    await prisma.sprayPlan.update({
      where: { id: planId },
      data: { progress: 65 },
    });

    if (complianceResult.zones.length === 0) {
      throw new Error('All generated zones were excluded by compliance layers.');
    }

    const start: GeoPoint = {
      lat: config.startLat ?? plan.project.centerLat ?? complianceResult.zones[0].centroidLat,
      lon: config.startLon ?? plan.project.centerLon ?? complianceResult.zones[0].centroidLon,
    };

    const missions = splitIntoMissions(complianceResult.zones, config, start);
    const weatherReport = await optimizeWeatherWindowForMissions(missions, config, start);
    const weatherByMissionSequence = new Map(
      weatherReport.missionSchedules.map((missionSchedule) => [missionSchedule.sequence, missionSchedule])
    );
    const routeDistanceBeforeTotal = missions.reduce((sum, mission) => sum + mission.routeDistanceBeforeM, 0);
    const routeDistanceAfterTotal = missions.reduce((sum, mission) => sum + mission.routeDistanceAfterM, 0);
    const routeDistanceSaved = Math.max(0, routeDistanceBeforeTotal - routeDistanceAfterTotal);

    await prisma.sprayPlan.update({
      where: { id: planId },
      data: { progress: 82 },
    });

    await prisma.$transaction(async (tx) => {
      await tx.sprayZone.deleteMany({ where: { sprayPlanId: planId } });
      await tx.sprayMission.deleteMany({ where: { sprayPlanId: planId } });

      const missionIdByZoneIndex = new Map<number, string>();

      for (const mission of missions) {
        const scheduledWeather = weatherByMissionSequence.get(mission.sequence);
        const routeImprovementM = Math.max(0, mission.routeDistanceBeforeM - mission.routeDistanceAfterM);

        const createdMission = await tx.sprayMission.create({
          data: {
            sprayPlanId: planId,
            sequence: mission.sequence,
            name: mission.name,
            status: 'ready',
            zoneCount: mission.zoneCount,
            totalAreaHa: mission.totalAreaHa,
            chemicalLiters: mission.chemicalLiters,
            estimatedDistanceM: mission.estimatedDistanceM,
            estimatedDurationMin: mission.estimatedDurationMin,
            routeGeoJson: {
              type: 'LineString',
              coordinates: mission.routeCoordinates,
            } as Prisma.InputJsonValue,
            metadata: {
              routeOptimization: {
                algorithm: 'nearest-neighbor+2-opt',
                baselineDistanceM: Number(mission.routeDistanceBeforeM.toFixed(1)),
                optimizedDistanceM: Number(mission.routeDistanceAfterM.toFixed(1)),
                improvementM: Number(routeImprovementM.toFixed(1)),
                improvementPct:
                  mission.routeDistanceBeforeM > 0
                    ? Number(((routeImprovementM / mission.routeDistanceBeforeM) * 100).toFixed(2))
                    : 0,
              },
              weather: scheduledWeather
                ? {
                    decision: scheduledWeather.weather.decision,
                    riskScore: Number(scheduledWeather.weather.score.toFixed(3)),
                    startTimeUtc: scheduledWeather.startTimeUtc,
                    endTimeUtc: scheduledWeather.endTimeUtc,
                    sampleCount: scheduledWeather.weather.sampleCount,
                    avgWindSpeedMps: Number(scheduledWeather.weather.avgWindSpeedMps.toFixed(2)),
                    maxWindSpeedMps: Number(scheduledWeather.weather.maxWindSpeedMps.toFixed(2)),
                    avgWindGustMps: Number(scheduledWeather.weather.avgWindGustMps.toFixed(2)),
                    maxWindGustMps: Number(scheduledWeather.weather.maxWindGustMps.toFixed(2)),
                    avgPrecipProbability: Number(scheduledWeather.weather.avgPrecipProbability.toFixed(1)),
                    maxPrecipProbability: Number(scheduledWeather.weather.maxPrecipProbability.toFixed(1)),
                    avgTemperatureC: Number(scheduledWeather.weather.avgTemperatureC.toFixed(2)),
                    minTemperatureC: Number(scheduledWeather.weather.minTemperatureC.toFixed(2)),
                    maxTemperatureC: Number(scheduledWeather.weather.maxTemperatureC.toFixed(2)),
                    reasons: scheduledWeather.weather.reasons,
                  }
                : null,
            } as Prisma.InputJsonValue,
          },
          select: { id: true },
        });

        for (const zoneIndex of mission.zoneIndexes) {
          missionIdByZoneIndex.set(zoneIndex, createdMission.id);
        }
      }

      for (let i = 0; i < complianceResult.zones.length; i += 1) {
        const zone = complianceResult.zones[i];
        const missionId = missionIdByZoneIndex.get(i) ?? null;

        await tx.sprayZone.create({
          data: {
            sprayPlanId: planId,
            missionId,
            species: zone.species,
            detectionCount: zone.detectionCount,
            averageConfidence: zone.averageConfidence,
            priorityScore: zone.priorityScore,
            centroidLat: zone.centroidLat,
            centroidLon: zone.centroidLon,
            polygon: {
              type: 'Polygon',
              coordinates: [zone.polygonRing],
            } as Prisma.InputJsonValue,
            areaHa: zone.areaHa,
            recommendedDosePerHa: zone.recommendedDosePerHa,
            recommendedLiters: zone.recommendedLiters,
            recommendationSource: zone.recommendationSource,
            metadata: {
              sourcePointIds: zone.sourcePointIds,
              recommendationChemical: zone.recommendationChemical,
              sequence: zone.sequence,
            } as Prisma.InputJsonValue,
          },
        });
      }

      const speciesCounts = new Map<string, number>();
      for (const zone of complianceResult.zones) {
        speciesCounts.set(zone.species, (speciesCounts.get(zone.species) ?? 0) + zone.detectionCount);
      }

      const summary = {
        totals: {
          sourcePointCount: points.length,
          zoneCount: complianceResult.zones.length,
          missionCount: missions.length,
          totalAreaHa: Number(complianceResult.zones.reduce((sum, zone) => sum + zone.areaHa, 0).toFixed(4)),
          totalChemicalLiters: Number(complianceResult.zones.reduce((sum, zone) => sum + zone.recommendedLiters, 0).toFixed(3)),
          skippedClusters: zoneResult.skippedClusters,
        },
        optimization: {
          routeAlgorithm: 'nearest-neighbor+2-opt',
          baselineDistanceM: Number(routeDistanceBeforeTotal.toFixed(1)),
          optimizedDistanceM: Number(routeDistanceAfterTotal.toFixed(1)),
          savedDistanceM: Number(routeDistanceSaved.toFixed(1)),
          savedDistancePct:
            routeDistanceBeforeTotal > 0
              ? Number(((routeDistanceSaved / routeDistanceBeforeTotal) * 100).toFixed(2))
              : 0,
        },
        weather: weatherReport,
        compliance: complianceResult.report,
        speciesBreakdown: Array.from(speciesCounts.entries()).map(([species, count]) => ({ species, count })),
        generatedAt: new Date().toISOString(),
      };

      await tx.sprayPlan.update({
        where: { id: planId },
        data: {
          status: SprayPlanStatus.READY,
          progress: 100,
          summary: summary as unknown as Prisma.InputJsonValue,
          completedAt: new Date(),
        },
      });
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to generate spray plan';
    await prisma.sprayPlan.update({
      where: { id: planId },
      data: {
        status: SprayPlanStatus.FAILED,
        progress: 100,
        errorMessage: message,
        completedAt: new Date(),
      },
    });

    throw error;
  }
}
