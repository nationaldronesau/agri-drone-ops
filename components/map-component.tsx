"use client";

import { useEffect, useState } from "react";
import { MapContainer, TileLayer, Marker, Popup, CircleMarker } from "react-leaflet";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { ArrowLeft, MapPin, Camera, Layers, Settings, Download, Brain, AlertTriangle } from "lucide-react";
import Link from "next/link";
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

export default function MapComponent() {
  const [assets, setAssets] = useState<Asset[]>([]);
  const [detections, setDetections] = useState<Detection[]>([]);
  const [loading, setLoading] = useState(true);
  const [mapCenter, setMapCenter] = useState<[number, number]>([-27.4698, 153.0251]); // Brisbane default
  const [satelliteLayer, setSatelliteLayer] = useState(true);
  const [showDroneImages, setShowDroneImages] = useState(true);
  const [showDetections, setShowDetections] = useState(true);

  // Filters
  const [selectedLocation, setSelectedLocation] = useState<string>("all");
  const [selectedProject, setSelectedProject] = useState<string>("all");
  const [selectedPurpose, setSelectedPurpose] = useState<string>("all");

  useEffect(() => {
    fetchAssets();
    fetchDetections();
  }, []);

  const fetchAssets = async () => {
    try {
      const res = await fetch("/api/assets");
      if (res.ok) {
        const data = await res.json();
        const assets = data.assets || [];
        const withGPS = assets.filter((a: Asset) => a.gpsLatitude && a.gpsLongitude);
        setAssets(withGPS);

        if (withGPS.length > 0) {
          setMapCenter([withGPS[0].gpsLatitude!, withGPS[0].gpsLongitude!]);
        }
      }
    } catch (err) {
      console.error("Error fetching assets:", err);
    } finally {
      setLoading(false);
    }
  };

  const fetchDetections = async () => {
    try {
      // Use all=true to get all detections for map display
      const res = await fetch("/api/detections?all=true");
      if (res.ok) {
        const data = await res.json();
        setDetections(data.filter((d: Detection) => d.centerLat && d.centerLon));
      }
    } catch (err) {
      console.error("Error fetching detections:", err);
    }
  };

  // Filtered list
  const filteredAssets = assets.filter(a => {
    if (selectedLocation !== "all" && a.project.location !== selectedLocation) return false;
    if (selectedProject !== "all" && a.project.id !== selectedProject) return false;
    if (selectedPurpose !== "all" && a.project.purpose !== selectedPurpose) return false;
    return true;
  });

  const calculateMapBounds = () => {
    const assetsToUse = filteredAssets.length > 0 ? filteredAssets : assets;
    if (assetsToUse.length === 0) return { center: mapCenter, zoom: 13 };

    const lat = assetsToUse.map(a => a.gpsLatitude!);
    const lon = assetsToUse.map(a => a.gpsLongitude!);

    const centerLat = lat.reduce((a, b) => a + b, 0) / lat.length;
    const centerLon = lon.reduce((a, b) => a + b, 0) / lon.length;

    return { center: [centerLat, centerLon] as [number, number], zoom: 15 };
  };

  const { center, zoom } = calculateMapBounds();

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <header className="bg-white border-b border-gray-200">
        <div className="container mx-auto px-4 py-4 flex items-center justify-between">
          <Link href="/test-dashboard">
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
        {loading ? (
          <p>Loading map data...</p>
        ) : (
          <MapContainer center={center} zoom={zoom} style={{ height: "600px", width: "100%" }}>
            <TileLayer
              attribution={satelliteLayer ? "&copy; Esri" : "&copy; OpenStreetMap"}
              url={
                satelliteLayer
                  ? "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"
                  : "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
              }
            />
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
            {showDetections &&
              detections.map(d => (
                <CircleMarker
                  key={d.id}
                  center={[d.centerLat!, d.centerLon!]}
                  radius={8}
                  pathOptions={{
                    fillColor: d.metadata?.color || "#FF6B6B",
                    color: "#000",
                    weight: 2,
                    opacity: 1,
                    fillOpacity: 0.8,
                  }}
                >
                  <Popup>
                    <p>{d.className} - {(d.confidence * 100).toFixed(1)}%</p>
                  </Popup>
                </CircleMarker>
              ))}
          </MapContainer>
        )}
      </main>
    </div>
  );
}
