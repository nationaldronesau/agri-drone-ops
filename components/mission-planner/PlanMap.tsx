"use client";

import { Fragment, useEffect, useMemo } from 'react';
import { MapContainer, TileLayer, Polygon, CircleMarker, Popup, Polyline, useMap } from 'react-leaflet';
import L from 'leaflet';
import type { Prisma } from '@prisma/client';
import 'leaflet/dist/leaflet.css';

interface ZoneItem {
  id: string;
  missionId: string | null;
  species: string;
  detectionCount: number;
  centroidLat: number;
  centroidLon: number;
  areaHa: number;
  recommendedLiters: number | null;
  polygon: Prisma.JsonValue;
}

interface MissionItem {
  id: string;
  sequence: number;
  name: string;
  routeGeoJson: Prisma.JsonValue | null;
  metadata: Prisma.JsonValue | null;
}

interface PlanMapProps {
  zones: ZoneItem[];
  missions: MissionItem[];
  complianceLayers: Array<{
    id: string;
    name: string;
    layerType: 'ALLOWED_AREA' | 'EXCLUSION_AREA' | 'REFERENCE';
    isActive: boolean;
    geometry: Prisma.JsonValue;
  }>;
}

const missionColors = [
  '#2563eb',
  '#dc2626',
  '#16a34a',
  '#d97706',
  '#7c3aed',
  '#0f766e',
  '#be123c',
  '#4f46e5',
  '#0369a1',
  '#1d4ed8',
];

type WeatherDecision = 'GO' | 'CAUTION' | 'NO_GO' | 'UNKNOWN';

interface MissionWeatherMetadata {
  decision: WeatherDecision;
  riskScore: number | null;
  avgWindSpeedMps: number | null;
  maxWindGustMps: number | null;
  maxPrecipProbability: number | null;
  reasons: string[];
}

const WEATHER_STYLE: Record<
  WeatherDecision,
  { fill: string; stroke: string; route: string; marker: string; baseOpacity: number }
> = {
  GO: {
    fill: '#22c55e',
    stroke: '#15803d',
    route: '#16a34a',
    marker: '#15803d',
    baseOpacity: 0.16,
  },
  CAUTION: {
    fill: '#f59e0b',
    stroke: '#b45309',
    route: '#d97706',
    marker: '#b45309',
    baseOpacity: 0.22,
  },
  NO_GO: {
    fill: '#ef4444',
    stroke: '#b91c1c',
    route: '#dc2626',
    marker: '#b91c1c',
    baseOpacity: 0.28,
  },
  UNKNOWN: {
    fill: '#94a3b8',
    stroke: '#475569',
    route: '#64748b',
    marker: '#475569',
    baseOpacity: 0.18,
  },
};

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function FitBounds({ bounds }: { bounds: L.LatLngBoundsExpression | null }) {
  const map = useMap();

  useEffect(() => {
    if (bounds) {
      map.fitBounds(bounds, { padding: [20, 20] });
    }
  }, [bounds, map]);

  return null;
}

function parsePolygonRings(value: Prisma.JsonValue): Array<Array<[number, number]>> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];

  const obj = value as Record<string, Prisma.JsonValue>;

  if (obj.type === 'Feature' && obj.geometry) {
    return parsePolygonRings(obj.geometry);
  }

  if (obj.type === 'FeatureCollection' && Array.isArray(obj.features)) {
    return obj.features.flatMap((feature) => parsePolygonRings(feature));
  }

  if (obj.type === 'Polygon' && Array.isArray(obj.coordinates)) {
    const firstRing = obj.coordinates[0];
    if (!Array.isArray(firstRing)) return [];
    const points: Array<[number, number]> = [];
    for (const point of firstRing) {
      if (!Array.isArray(point) || point.length < 2) continue;
      const lon = typeof point[0] === 'number' ? point[0] : NaN;
      const lat = typeof point[1] === 'number' ? point[1] : NaN;
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
      points.push([lat, lon]);
    }
    return points.length >= 3 ? [points] : [];
  }

  if (obj.type === 'MultiPolygon' && Array.isArray(obj.coordinates)) {
    const polygons: Array<Array<[number, number]>> = [];
    for (const polygonCoords of obj.coordinates) {
      if (!Array.isArray(polygonCoords) || polygonCoords.length === 0) continue;
      const firstRing = polygonCoords[0];
      if (!Array.isArray(firstRing)) continue;
      const points: Array<[number, number]> = [];
      for (const point of firstRing) {
        if (!Array.isArray(point) || point.length < 2) continue;
        const lon = typeof point[0] === 'number' ? point[0] : NaN;
        const lat = typeof point[1] === 'number' ? point[1] : NaN;
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
        points.push([lat, lon]);
      }
      if (points.length >= 3) {
        polygons.push(points);
      }
    }
    return polygons;
  }

  return [];
}

function parseRoute(value: Prisma.JsonValue | null): Array<[number, number]> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];

  const obj = value as Record<string, Prisma.JsonValue>;
  if (obj.type !== 'LineString' || !Array.isArray(obj.coordinates)) return [];

  const points: Array<[number, number]> = [];
  for (const point of obj.coordinates) {
    if (!Array.isArray(point) || point.length < 2) continue;
    const lon = typeof point[0] === 'number' ? point[0] : NaN;
    const lat = typeof point[1] === 'number' ? point[1] : NaN;
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    points.push([lat, lon]);
  }

  return points;
}

function parseMissionWeatherMetadata(value: Prisma.JsonValue | null): MissionWeatherMetadata {
  const fallback: MissionWeatherMetadata = {
    decision: 'UNKNOWN',
    riskScore: null,
    avgWindSpeedMps: null,
    maxWindGustMps: null,
    maxPrecipProbability: null,
    reasons: [],
  };

  if (!value || typeof value !== 'object' || Array.isArray(value)) return fallback;
  const metadata = value as Record<string, Prisma.JsonValue>;
  const weatherRaw = metadata.weather;
  if (!weatherRaw || typeof weatherRaw !== 'object' || Array.isArray(weatherRaw)) return fallback;
  const weather = weatherRaw as Record<string, Prisma.JsonValue>;

  const decisionRaw = typeof weather.decision === 'string' ? weather.decision.toUpperCase() : 'UNKNOWN';
  const decision: WeatherDecision =
    decisionRaw === 'GO' || decisionRaw === 'CAUTION' || decisionRaw === 'NO_GO'
      ? decisionRaw
      : 'UNKNOWN';

  return {
    decision,
    riskScore: typeof weather.riskScore === 'number' ? weather.riskScore : null,
    avgWindSpeedMps: typeof weather.avgWindSpeedMps === 'number' ? weather.avgWindSpeedMps : null,
    maxWindGustMps: typeof weather.maxWindGustMps === 'number' ? weather.maxWindGustMps : null,
    maxPrecipProbability:
      typeof weather.maxPrecipProbability === 'number' ? weather.maxPrecipProbability : null,
    reasons: Array.isArray(weather.reasons)
      ? weather.reasons.filter((reason): reason is string => typeof reason === 'string').slice(0, 3)
      : [],
  };
}

export default function PlanMap({ zones, missions, complianceLayers }: PlanMapProps) {
  const center: [number, number] = useMemo(() => {
    if (zones.length === 0) return [-27.4698, 153.0251];
    const avgLat = zones.reduce((sum, zone) => sum + zone.centroidLat, 0) / zones.length;
    const avgLon = zones.reduce((sum, zone) => sum + zone.centroidLon, 0) / zones.length;
    return [avgLat, avgLon];
  }, [zones]);

  const missionColorById = useMemo(() => {
    const map = new Map<string, string>();
    for (const mission of missions) {
      map.set(mission.id, missionColors[(mission.sequence - 1) % missionColors.length]);
    }
    return map;
  }, [missions]);

  const missionWeatherById = useMemo(() => {
    const map = new Map<string, MissionWeatherMetadata>();
    for (const mission of missions) {
      map.set(mission.id, parseMissionWeatherMetadata(mission.metadata));
    }
    return map;
  }, [missions]);

  const bounds = useMemo(() => {
    const points = zones.map((zone) => L.latLng(zone.centroidLat, zone.centroidLon));
    if (points.length === 0) return null;
    return L.latLngBounds(points);
  }, [zones]);

  return (
    <div className="relative h-[420px] w-full overflow-hidden rounded-lg border border-gray-200">
      <MapContainer center={center} zoom={14} className="h-full w-full" scrollWheelZoom>
        <TileLayer
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        />

        <FitBounds bounds={bounds} />

        {missions.map((mission) => {
          const route = parseRoute(mission.routeGeoJson);
          if (route.length < 2) return null;
          const weather = missionWeatherById.get(mission.id);
          const weatherStyle = WEATHER_STYLE[weather?.decision ?? 'UNKNOWN'];
          return (
            <Polyline
              key={mission.id}
              positions={route}
              pathOptions={{
                color: weatherStyle.route,
                weight: 3,
                opacity: 0.9,
                dashArray: weather?.decision === 'NO_GO' ? '8 6' : undefined,
              }}
            >
              <Popup>
                <div className="space-y-1 text-xs">
                  <p className="font-semibold text-gray-900">{mission.name}</p>
                  <p>
                    Weather: <span className="font-medium">{weather?.decision ?? 'UNKNOWN'}</span>
                  </p>
                  {weather?.riskScore != null && <p>Risk Score: {weather.riskScore.toFixed(3)}</p>}
                </div>
              </Popup>
            </Polyline>
          );
        })}

        {complianceLayers
          .filter((layer) => layer.isActive)
          .map((layer) => {
            const rings = parsePolygonRings(layer.geometry);
            if (rings.length === 0) return null;

            const color =
              layer.layerType === 'ALLOWED_AREA'
                ? '#059669'
                : layer.layerType === 'EXCLUSION_AREA'
                  ? '#b91c1c'
                  : '#7c3aed';
            const fillOpacity =
              layer.layerType === 'ALLOWED_AREA'
                ? 0.06
                : layer.layerType === 'EXCLUSION_AREA'
                  ? 0.14
                  : 0.08;

            return rings.map((ring, index) => (
              <Polygon
                key={`${layer.id}:${index}`}
                positions={ring}
                pathOptions={{
                  color,
                  weight: 2,
                  fillOpacity,
                  dashArray: layer.layerType === 'EXCLUSION_AREA' ? '4 4' : '2 6',
                }}
              >
                <Popup>
                  <div className="space-y-1 text-xs">
                    <p className="font-semibold text-gray-900">{layer.name}</p>
                    <p>
                      {layer.layerType === 'ALLOWED_AREA'
                        ? 'Allowed spray area'
                        : layer.layerType === 'EXCLUSION_AREA'
                          ? 'Exclusion area'
                          : 'Reference boundary'}
                    </p>
                  </div>
                </Popup>
              </Polygon>
            ));
          })}

        {zones.map((zone) => {
          const polygonPoints = parsePolygonRings(zone.polygon)[0] ?? [];
          const missionColor = zone.missionId ? missionColorById.get(zone.missionId) ?? '#2563eb' : '#6b7280';
          const weather = zone.missionId ? missionWeatherById.get(zone.missionId) : undefined;
          const weatherStyle = WEATHER_STYLE[weather?.decision ?? 'UNKNOWN'];
          const riskOpacityBoost = weather?.riskScore != null ? clamp(weather.riskScore * 0.18, 0, 0.18) : 0;
          const fillOpacity = clamp(weatherStyle.baseOpacity + riskOpacityBoost, 0.1, 0.42);

          return (
            <Fragment key={zone.id}>
              {polygonPoints.length >= 3 && (
                <Polygon
                  positions={polygonPoints}
                  pathOptions={{
                    color: weatherStyle.stroke,
                    weight: 2,
                    fillColor: weatherStyle.fill,
                    fillOpacity,
                  }}
                >
                  <Popup>
                    <div className="space-y-1 text-xs">
                      <p className="font-semibold text-gray-900">{zone.species}</p>
                      <p>Detections: {zone.detectionCount}</p>
                      <p>Area: {zone.areaHa.toFixed(3)} ha</p>
                      <p>Chemical: {(zone.recommendedLiters ?? 0).toFixed(2)} L</p>
                      <p>
                        Weather: <span className="font-medium">{weather?.decision ?? 'UNKNOWN'}</span>
                      </p>
                      {weather?.riskScore != null && <p>Risk Score: {weather.riskScore.toFixed(3)}</p>}
                      {weather?.avgWindSpeedMps != null && weather?.maxWindGustMps != null && (
                        <p>
                          Wind/Gust: {weather.avgWindSpeedMps.toFixed(1)} / {weather.maxWindGustMps.toFixed(1)} m/s
                        </p>
                      )}
                      {weather?.maxPrecipProbability != null && (
                        <p>Max Precip: {weather.maxPrecipProbability.toFixed(0)}%</p>
                      )}
                      {weather?.reasons.map((reason) => (
                        <p key={reason} className="text-gray-700">
                          {reason}
                        </p>
                      ))}
                    </div>
                  </Popup>
                </Polygon>
              )}
              <CircleMarker
                center={[zone.centroidLat, zone.centroidLon]}
                radius={5}
                pathOptions={{
                  color: '#111827',
                  fillColor: weatherStyle.marker,
                  fillOpacity: 0.95,
                  weight: 1,
                }}
              >
                <Popup>
                  <div className="space-y-1 text-xs">
                    <p className="font-semibold text-gray-900">{zone.species}</p>
                    <p>Detections: {zone.detectionCount}</p>
                    <p>Area: {zone.areaHa.toFixed(3)} ha</p>
                    <p>Chemical: {(zone.recommendedLiters ?? 0).toFixed(2)} L</p>
                    <p className="text-gray-600">Mission Color: {missionColor}</p>
                  </div>
                </Popup>
              </CircleMarker>
            </Fragment>
          );
        })}
      </MapContainer>
      <div className="pointer-events-none absolute right-3 top-3 z-[1000] w-44 rounded-md border border-gray-200 bg-white/95 p-2 text-[11px] shadow-sm backdrop-blur">
        <p className="mb-1 font-semibold text-gray-800">Weather Risk Overlay</p>
        <p className="mb-2 text-gray-600">Zone tint reflects mission weather risk.</p>
        {(['GO', 'CAUTION', 'NO_GO', 'UNKNOWN'] as WeatherDecision[]).map((decision) => (
          <div key={decision} className="mb-1 flex items-center gap-2 text-gray-700 last:mb-0">
            <span
              className="inline-block h-2.5 w-2.5 rounded-sm"
              style={{ backgroundColor: WEATHER_STYLE[decision].fill }}
            />
            <span>{decision}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
