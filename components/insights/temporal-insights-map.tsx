"use client";

import { useMemo } from "react";
import {
  CircleMarker,
  GeoJSON,
  MapContainer,
  Popup,
  TileLayer,
} from "react-leaflet";
import type { LatLngBoundsExpression } from "leaflet";
import L from "leaflet";
import type { Feature, Geometry } from "geojson";
import "leaflet/dist/leaflet.css";

type ChangeType = "NEW" | "PERSISTENT" | "RESOLVED" | "UNOBSERVED";

export interface MapChangeItem {
  id: string;
  changeType: ChangeType;
  species: string;
  riskScore: number;
  confidence: number | null;
  comparisonLat: number | null;
  comparisonLon: number | null;
  baselineLat: number | null;
  baselineLon: number | null;
}

export interface MapHotspotItem {
  id: string;
  species: string;
  priorityScore: number | null;
  avgRiskScore: number | null;
  itemCount: number;
  polygon: unknown;
  centroidLat: number;
  centroidLon: number;
}

function isFiniteCoordinate(lat: number | null | undefined, lon: number | null | undefined): lat is number {
  return (
    typeof lat === "number" &&
    typeof lon === "number" &&
    Number.isFinite(lat) &&
    Number.isFinite(lon) &&
    lat >= -90 &&
    lat <= 90 &&
    lon >= -180 &&
    lon <= 180
  );
}

function toGeoJsonFeature(value: unknown): Feature<Geometry> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const type = record.type;

  if (type === "Feature" && record.geometry && typeof record.geometry === "object") {
    return value as Feature<Geometry>;
  }
  if ((type === "Polygon" || type === "MultiPolygon") && record.coordinates) {
    return {
      type: "Feature",
      geometry: value as Geometry,
      properties: {},
    };
  }

  return null;
}

function colorForChangeType(changeType: ChangeType): string {
  if (changeType === "NEW") return "#ef4444";
  if (changeType === "PERSISTENT") return "#f59e0b";
  if (changeType === "RESOLVED") return "#10b981";
  return "#6b7280";
}

export default function TemporalInsightsMap({
  changes,
  hotspots,
}: {
  changes: MapChangeItem[];
  hotspots: MapHotspotItem[];
}) {
  const bounds = useMemo<LatLngBoundsExpression | null>(() => {
    const coordinates: Array<[number, number]> = [];

    for (const hotspot of hotspots) {
      if (isFiniteCoordinate(hotspot.centroidLat, hotspot.centroidLon)) {
        coordinates.push([hotspot.centroidLat, hotspot.centroidLon]);
      }
    }

    for (const item of changes) {
      if (isFiniteCoordinate(item.comparisonLat, item.comparisonLon)) {
        coordinates.push([item.comparisonLat, item.comparisonLon]);
      } else if (isFiniteCoordinate(item.baselineLat, item.baselineLon)) {
        coordinates.push([item.baselineLat, item.baselineLon]);
      }
    }

    if (coordinates.length === 0) return null;
    return L.latLngBounds(coordinates);
  }, [changes, hotspots]);

  const center = useMemo<[number, number]>(() => {
    if (!bounds) return [-27.4698, 153.0251];
    const latLngBounds = L.latLngBounds(bounds);
    const c = latLngBounds.getCenter();
    return [c.lat, c.lng];
  }, [bounds]);

  return (
    <MapContainer
      center={center}
      zoom={13}
      style={{ height: "420px", width: "100%" }}
      bounds={bounds ?? undefined}
      boundsOptions={{ padding: [24, 24] }}
    >
      <TileLayer
        attribution="&copy; OpenStreetMap contributors"
        url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
      />

      {hotspots.map((hotspot) => {
        const feature = toGeoJsonFeature(hotspot.polygon);
        if (!feature) return null;

        return (
          <GeoJSON
            key={hotspot.id}
            data={feature}
            style={{
              color: "#2563eb",
              weight: 2,
              fillOpacity: 0.12,
            }}
          >
            <Popup>
              <div className="text-sm">
                <p className="font-semibold">{hotspot.species}</p>
                <p>Items: {hotspot.itemCount}</p>
                <p>Priority: {(hotspot.priorityScore ?? 0).toFixed(2)}</p>
              </div>
            </Popup>
          </GeoJSON>
        );
      })}

      {changes.map((item) => {
        const hasComparison = isFiniteCoordinate(item.comparisonLat, item.comparisonLon);
        const hasBaseline = isFiniteCoordinate(item.baselineLat, item.baselineLon);
        const lat = hasComparison
          ? (item.comparisonLat as number)
          : hasBaseline
            ? (item.baselineLat as number)
            : null;
        const lon = hasComparison
          ? (item.comparisonLon as number)
          : hasBaseline
            ? (item.baselineLon as number)
            : null;
        if (lat == null || lon == null) return null;

        return (
          <CircleMarker
            key={item.id}
            center={[lat, lon]}
            radius={4}
            color={colorForChangeType(item.changeType)}
            fillOpacity={0.9}
            weight={1}
          >
            <Popup>
              <div className="text-sm">
                <p className="font-semibold">{item.species}</p>
                <p>Type: {item.changeType}</p>
                <p>Risk: {item.riskScore.toFixed(2)}</p>
                <p>Confidence: {(item.confidence ?? 0).toFixed(2)}</p>
              </div>
            </Popup>
          </CircleMarker>
        );
      })}
    </MapContainer>
  );
}

