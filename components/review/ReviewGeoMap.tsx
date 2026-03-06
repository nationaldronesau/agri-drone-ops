'use client';

import { useMemo } from 'react';
import {
  CircleMarker,
  MapContainer,
  Popup,
  TileLayer,
} from 'react-leaflet';
import type { LatLngBoundsExpression } from 'leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';

type ReviewStatus = 'pending' | 'accepted' | 'rejected';

interface ReviewMapItem {
  id: string;
  source: 'manual' | 'pending' | 'detection';
  assetId: string;
  className: string;
  confidence: number;
  status: ReviewStatus;
  centerLat?: number | null;
  centerLon?: number | null;
  asset: {
    fileName: string;
  };
}

interface ReviewGeoMapProps {
  items: ReviewMapItem[];
  selectedAssetId?: string;
  className?: string;
}

function isFiniteCoordinate(
  lat: number | null | undefined,
  lon: number | null | undefined
): lat is number {
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

function markerColor(status: ReviewStatus): string {
  if (status === 'accepted') return '#16a34a';
  if (status === 'rejected') return '#dc2626';
  return '#f59e0b';
}

export default function ReviewGeoMap({
  items,
  selectedAssetId,
  className,
}: ReviewGeoMapProps) {
  const points = useMemo(
    () =>
      items.filter((item) => isFiniteCoordinate(item.centerLat, item.centerLon)),
    [items]
  );

  const bounds = useMemo<LatLngBoundsExpression | null>(() => {
    if (points.length === 0) return null;
    return L.latLngBounds(
      points.map((item) => [item.centerLat as number, item.centerLon as number])
    );
  }, [points]);

  const center = useMemo<[number, number]>(() => {
    if (!bounds) return [-27.4698, 153.0251];
    const latLngBounds = L.latLngBounds(bounds);
    const mapCenter = latLngBounds.getCenter();
    return [mapCenter.lat, mapCenter.lng];
  }, [bounds]);

  if (points.length === 0) {
    return (
      <div
        className={`flex h-[600px] items-center justify-center rounded-lg border border-dashed text-sm text-gray-500 ${className ?? ''}`}
      >
        No detections with valid geolocation in this filtered set.
      </div>
    );
  }

  return (
    <div className={`h-[600px] overflow-hidden rounded-lg border ${className ?? ''}`}>
      <MapContainer
        center={center}
        zoom={16}
        style={{ height: '100%', width: '100%' }}
        bounds={bounds ?? undefined}
        boundsOptions={{ padding: [24, 24] }}
      >
        <TileLayer
          attribution="&copy; Esri"
          url="https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"
        />

        {points.map((item) => {
          const isActiveAsset = selectedAssetId != null && item.assetId === selectedAssetId;
          return (
            <CircleMarker
              key={item.id}
              center={[item.centerLat as number, item.centerLon as number]}
              radius={isActiveAsset ? 7 : 5}
              color={markerColor(item.status)}
              fillOpacity={0.9}
              weight={isActiveAsset ? 3 : 1}
            >
              <Popup>
                <div className="space-y-1 text-sm">
                  <div className="font-semibold text-gray-900">{item.className}</div>
                  <div className="text-xs text-gray-600">{item.asset.fileName}</div>
                  <div className="text-xs text-gray-600">
                    {Math.round(item.confidence * 100)}% · {item.status} · {item.source}
                  </div>
                </div>
              </Popup>
            </CircleMarker>
          );
        })}
      </MapContainer>
    </div>
  );
}
