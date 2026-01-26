"use client";

import { useEffect, useMemo, useState } from "react";
import { MapContainer, TileLayer, Marker, Popup, useMap } from "react-leaflet";
import MarkerClusterGroup from "react-leaflet-cluster";
import { Button } from "@/components/ui/button";
import { ArrowLeft, Layers, AlertTriangle } from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import "leaflet/dist/leaflet.css";
import L from "leaflet";

// Fix leaflet marker icons
if (typeof window !== "undefined") {
  delete (L.Icon.Default.prototype as any)._getIconUrl;
  L.Icon.Default.mergeOptions({
    iconRetinaUrl: "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-icon-2x.png",
    iconUrl: "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-icon.png",
    shadowUrl: "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-shadow.png",
  });
}

interface Asset {
  id: string;
  fileName: string;
  storageUrl: string;
  gpsLatitude: number | null;
  gpsLongitude: number | null;
  altitude: number | null;
  gimbalPitch: number | null;
  gimbalRoll: number | null;
  gimbalYaw: number | null;
  flightSession: string | null;
  createdAt: string;
  project: {
    id: string;
    name: string;
    location: string | null;
    purpose: string;
    season: string | null;
  };
}

interface Detection {
  id: string;
  className: string;
  confidence: number;
  centerLat: number | null;
  centerLon: number | null;
  metadata: any;
  asset: {
    id: string;
    fileName: string;
    project: {
      name: string;
      location: string | null;
    };
  };
}

interface Orthomosaic {
  id: string;
  name: string;
  projectId: string;
  bounds: any;
  centerLat: number;
  centerLon: number;
  minZoom: number;
  maxZoom: number;
}

// Create custom detection marker icon
const createDetectionIcon = (color: string) => {
  return L.divIcon({
    html: `<div style="background:${color};width:16px;height:16px;border-radius:50%;border:2px solid #000;box-shadow:0 1px 3px rgba(0,0,0,0.4);"></div>`,
    className: 'detection-marker',
    iconSize: L.point(16, 16),
    iconAnchor: L.point(8, 8),
  });
};

function MapViewUpdater({
  bounds,
  center,
  zoom,
}: {
  bounds: L.LatLngBoundsExpression | null;
  center: [number, number];
  zoom: number;
}) {
  const map = useMap();

  useEffect(() => {
    if (bounds) {
      map.fitBounds(bounds, { padding: [20, 20] });
      return;
    }
    map.setView(center, zoom);
  }, [bounds, center, map, zoom]);

  return null;
}

export default function MapComponent() {
  const searchParams = useSearchParams();
  const projectParam = searchParams.get("project");
  const orthomosaicParam = searchParams.get("orthomosaic");

  const [assets, setAssets] = useState<Asset[]>([]);
  const [detections, setDetections] = useState<Detection[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [mapCenter, setMapCenter] = useState<[number, number]>([-27.4698, 153.0251]); // Brisbane default
  const [satelliteLayer, setSatelliteLayer] = useState(true);
  const [showDroneImages, setShowDroneImages] = useState(true);
  const [showDetections, setShowDetections] = useState(true);
  const [focusedOrthomosaic, setFocusedOrthomosaic] = useState<Orthomosaic | null>(null);
  const [orthomosaicError, setOrthomosaicError] = useState<string | null>(null);

  // Filters
  const [selectedLocation, setSelectedLocation] = useState<string>("all");
  const [selectedProject, setSelectedProject] = useState<string>("all");
  const [selectedPurpose, setSelectedPurpose] = useState<string>("all");

  useEffect(() => {
    fetchAssets();
    fetchDetections();
  }, []);

  useEffect(() => {
    if (projectParam) {
      setSelectedProject(projectParam);
    }
  }, [projectParam]);

  useEffect(() => {
    if (!orthomosaicParam) {
      setFocusedOrthomosaic(null);
      setOrthomosaicError(null);
      return;
    }

    let active = true;
    const loadOrthomosaic = async () => {
      try {
        const res = await fetch(`/api/orthomosaics/${orthomosaicParam}`);
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          throw new Error(data.error || "Failed to load orthomosaic");
        }
        if (!active) return;
        setFocusedOrthomosaic(data);
        setOrthomosaicError(null);
        if (!projectParam && data.projectId) {
          setSelectedProject(data.projectId);
        }
        if (Number.isFinite(data.centerLat) && Number.isFinite(data.centerLon)) {
          setMapCenter([data.centerLat, data.centerLon]);
        }
      } catch (err) {
        if (!active) return;
        setFocusedOrthomosaic(null);
        setOrthomosaicError(err instanceof Error ? err.message : "Failed to load orthomosaic");
      }
    };

    loadOrthomosaic();
    return () => {
      active = false;
    };
  }, [orthomosaicParam, projectParam]);

  const fetchAssets = async () => {
    try {
      const res = await fetch("/api/assets");
      if (!res.ok) {
        throw new Error(`Failed to fetch assets: ${res.status}`);
      }
      const data = await res.json();
      const assets = data.assets || [];
      const withGPS = assets.filter((a: Asset) =>
        a.gpsLatitude != null && a.gpsLongitude != null &&
        Number.isFinite(a.gpsLatitude) && Number.isFinite(a.gpsLongitude)
      );
      setAssets(withGPS);

      if (withGPS.length > 0) {
        setMapCenter([withGPS[0].gpsLatitude!, withGPS[0].gpsLongitude!]);
      }
    } catch (err) {
      console.error("Error fetching assets:", err);
      setError(err instanceof Error ? err.message : "Failed to load assets");
    } finally {
      setLoading(false);
    }
  };

  const fetchDetections = async () => {
    try {
      // Use all=true to get all detections for map display
      const res = await fetch("/api/detections?all=true&geoOnly=true");
      if (!res.ok) {
        throw new Error(`Failed to fetch detections: ${res.status}`);
      }
      const data = await res.json();
      // Filter for valid coordinates (not null and not NaN)
      setDetections(data.filter((d: Detection) =>
        d.centerLat != null && d.centerLon != null &&
        Number.isFinite(d.centerLat) && Number.isFinite(d.centerLon)
      ));
    } catch (err) {
      console.error("Error fetching detections:", err);
      // Don't set main error - detections are secondary to assets
    }
  };

  // Filtered list
  const filteredAssets = useMemo(() => {
    return assets.filter(a => {
      if (selectedLocation !== "all" && a.project.location !== selectedLocation) return false;
      if (selectedProject !== "all" && a.project.id !== selectedProject) return false;
      if (selectedPurpose !== "all" && a.project.purpose !== selectedPurpose) return false;
      return true;
    });
  }, [assets, selectedLocation, selectedProject, selectedPurpose]);

  const orthomosaicBounds = useMemo(() => {
    const coords = focusedOrthomosaic?.bounds?.coordinates?.[0];
    if (!coords || coords.length === 0) return null;
    return L.latLngBounds(
      coords.map((coord: [number, number]) => [coord[1], coord[0]])
    );
  }, [focusedOrthomosaic]);

  const assetBounds = useMemo(() => {
    const assetsToUse = filteredAssets.length > 0 ? filteredAssets : assets;
    if (assetsToUse.length === 0) return null;
    return L.latLngBounds(
      assetsToUse.map(a => [a.gpsLatitude!, a.gpsLongitude!])
    );
  }, [assets, filteredAssets]);

  const boundsToFit = orthomosaicBounds || assetBounds;

  const calculateMapBounds = () => {
    if (
      focusedOrthomosaic &&
      Number.isFinite(focusedOrthomosaic.centerLat) &&
      Number.isFinite(focusedOrthomosaic.centerLon)
    ) {
      return {
        center: [focusedOrthomosaic.centerLat, focusedOrthomosaic.centerLon] as [number, number],
        zoom: 15,
      };
    }

    if (assetBounds) {
      const center = assetBounds.getCenter();
      return { center: [center.lat, center.lng] as [number, number], zoom: 15 };
    }

    return { center: mapCenter, zoom: 13 };
  };

  const { center, zoom } = calculateMapBounds();

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <header className="bg-white border-b border-gray-200">
        <div className="container mx-auto px-4 py-4 flex items-center justify-between">
          <Link href="/dashboard">
            <Button variant="ghost" size="sm">
              <ArrowLeft className="w-4 h-4 mr-2" /> Back
            </Button>
          </Link>
          <Button variant={satelliteLayer ? "default" : "outline"} onClick={() => setSatelliteLayer(!satelliteLayer)}>
            <Layers className="w-4 h-4 mr-2" /> Satellite
          </Button>
        </div>
      </header>

      {/* Map Section */}
      <main className="container mx-auto px-4 py-8">
        {orthomosaicError && (
          <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700">
            {orthomosaicError}
          </div>
        )}
        {focusedOrthomosaic && (
          <div className="mb-4 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-blue-200 bg-blue-50 px-4 py-2 text-sm text-blue-700">
            <span>Orthomosaic overlay: {focusedOrthomosaic.name}</span>
            <Link href={`/orthomosaics/${focusedOrthomosaic.id}`} className="font-medium underline">
              Open details
            </Link>
          </div>
        )}
        {loading ? (
          <p>Loading map data...</p>
        ) : error ? (
          <div className="flex items-center justify-center h-96 bg-red-50 rounded-lg border border-red-200">
            <div className="text-center">
              <AlertTriangle className="w-12 h-12 text-red-500 mx-auto mb-4" />
              <h3 className="text-lg font-semibold text-red-800">Failed to Load Map Data</h3>
              <p className="text-red-600 mt-2">{error}</p>
              <Button
                variant="outline"
                className="mt-4"
                onClick={() => {
                  setError(null);
                  setLoading(true);
                  fetchAssets();
                  fetchDetections();
                }}
              >
                Retry
              </Button>
            </div>
          </div>
        ) : (
          <MapContainer center={center} zoom={zoom} style={{ height: "600px", width: "100%" }}>
            <MapViewUpdater bounds={boundsToFit} center={center} zoom={zoom} />
            <TileLayer
              attribution={satelliteLayer ? "&copy; Esri" : "&copy; OpenStreetMap"}
              url={
                satelliteLayer
                  ? "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"
                  : "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
              }
            />
            {focusedOrthomosaic && (
              <TileLayer
                attribution={`© ${focusedOrthomosaic.name}`}
                url={`/api/tiles/${focusedOrthomosaic.id}/{z}/{x}/{y}.png`}
                opacity={0.75}
                maxZoom={focusedOrthomosaic.maxZoom}
                minZoom={focusedOrthomosaic.minZoom}
              />
            )}
            {focusedOrthomosaic && (
              <Marker position={[focusedOrthomosaic.centerLat, focusedOrthomosaic.centerLon]}>
                <Popup>
                  <p className="font-medium">{focusedOrthomosaic.name}</p>
                  <p className="text-xs text-gray-500">Orthomosaic center</p>
                </Popup>
              </Marker>
            )}
            {showDroneImages &&
              filteredAssets.map(a => (
                <Marker key={a.id} position={[a.gpsLatitude!, a.gpsLongitude!]}>
                  <Popup>
                    <div>
                      <img src={a.storageUrl} alt={a.fileName} className="w-full h-24 object-cover" />
                      <p>{a.project.name}</p>
                    </div>
                  </Popup>
                </Marker>
              ))}
            {/* Use MarkerClusterGroup with Marker (not CircleMarker) for proper clustering */}
            {showDetections && detections.length > 0 && (
              <MarkerClusterGroup
                chunkedLoading
                maxClusterRadius={50}
                spiderfyOnMaxZoom={true}
                showCoverageOnHover={false}
                iconCreateFunction={(cluster: any) => {
                  const count = cluster.getChildCount();
                  // Color based on cluster size
                  let size = 'small';
                  let color = '#22c55e'; // green
                  if (count > 100) {
                    size = 'large';
                    color = '#ef4444'; // red
                  } else if (count > 10) {
                    size = 'medium';
                    color = '#f97316'; // orange
                  }
                  const dimension = size === 'large' ? 50 : size === 'medium' ? 40 : 30;
                  return L.divIcon({
                    html: `<div style="background:${color};color:white;border-radius:50%;width:${dimension}px;height:${dimension}px;display:flex;align-items:center;justify-content:center;font-weight:bold;border:2px solid white;box-shadow:0 2px 4px rgba(0,0,0,0.3);">${count}</div>`,
                    className: 'detection-cluster',
                    iconSize: L.point(dimension, dimension),
                  });
                }}
              >
                {detections.map(d => (
                  <Marker
                    key={d.id}
                    position={[d.centerLat!, d.centerLon!]}
                    icon={createDetectionIcon(d.metadata?.color || "#FF6B6B")}
                  >
                    <Popup>
                      <p>{d.className} - {(d.confidence * 100).toFixed(1)}%</p>
                    </Popup>
                  </Marker>
                ))}
              </MarkerClusterGroup>
            )}
          </MapContainer>
        )}
      </main>
    </div>
  );
}
