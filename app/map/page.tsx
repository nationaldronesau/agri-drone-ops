"use client";

import { useEffect, useState } from 'react';
import { MapContainer, TileLayer, Marker, Popup } from 'react-leaflet';
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { ArrowLeft, MapPin, Camera, Layers, Settings, Download } from "lucide-react";
import Link from "next/link";
import 'leaflet/dist/leaflet.css';
import L from 'leaflet';

// Fix leaflet default marker icon issue
delete (L.Icon.Default.prototype as any)._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-icon-2x.png',
  iconUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-icon.png',
  shadowUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-shadow.png',
});

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

export default function MapPage() {
  const [assets, setAssets] = useState<Asset[]>([]);
  const [loading, setLoading] = useState(true);
  const [mapCenter, setMapCenter] = useState<[number, number]>([-27.4698, 153.0251]); // Brisbane default
  const [satelliteLayer, setSatelliteLayer] = useState(true);
  const [showDroneImages, setShowDroneImages] = useState(true);
  
  // Filtering state
  const [selectedLocation, setSelectedLocation] = useState<string>('all');
  const [selectedProject, setSelectedProject] = useState<string>('all');
  const [selectedPurpose, setSelectedPurpose] = useState<string>('all');

  useEffect(() => {
    fetchAssets();
  }, []);

  const fetchAssets = async () => {
    try {
      const response = await fetch('/api/assets');
      if (response.ok) {
        const data = await response.json();
        const assetsWithGPS = data.filter((asset: Asset) => 
          asset.gpsLatitude !== null && asset.gpsLongitude !== null
        );
        setAssets(assetsWithGPS);
        
        // Center map on first image with GPS
        if (assetsWithGPS.length > 0) {
          setMapCenter([assetsWithGPS[0].gpsLatitude!, assetsWithGPS[0].gpsLongitude!]);
        }
      }
    } catch (error) {
      console.error('Failed to fetch assets:', error);
    } finally {
      setLoading(false);
    }
  };

  // Filter assets based on selections
  const filteredAssets = assets.filter(asset => {
    if (selectedLocation !== 'all' && asset.project.location !== selectedLocation) return false;
    if (selectedProject !== 'all' && asset.project.id !== selectedProject) return false;
    if (selectedPurpose !== 'all' && asset.project.purpose !== selectedPurpose) return false;
    return true;
  });

  const calculateMapBounds = () => {
    const assetsToUse = filteredAssets.length > 0 ? filteredAssets : assets;
    if (assetsToUse.length === 0) return { center: mapCenter, zoom: 13 };
    
    const latitudes = assetsToUse.map(a => a.gpsLatitude!);
    const longitudes = assetsToUse.map(a => a.gpsLongitude!);
    
    const centerLat = latitudes.reduce((a, b) => a + b, 0) / latitudes.length;
    const centerLon = longitudes.reduce((a, b) => a + b, 0) / longitudes.length;
    
    return { center: [centerLat, centerLon] as [number, number], zoom: 15 };
  };

  const { center, zoom } = calculateMapBounds();

  // Get unique values for filters
  const uniqueLocations = [...new Set(assets.map(a => a.project.location).filter(Boolean))];
  const uniqueProjects = [...new Set(assets.map(a => ({ id: a.project.id, name: a.project.name })))];
  const uniquePurposes = [...new Set(assets.map(a => a.project.purpose))];

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <header className="bg-white border-b border-gray-200">
        <div className="container mx-auto px-4 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center space-x-4">
              <Link href="/test-dashboard">
                <Button variant="ghost" size="sm">
                  <ArrowLeft className="w-4 h-4 mr-2" />
                  Back to Dashboard
                </Button>
              </Link>
              <div className="flex items-center space-x-2">
                <div className="w-8 h-8 bg-gradient-to-r from-green-500 to-blue-500 rounded-lg"></div>
                <span className="text-xl font-bold bg-gradient-to-r from-green-600 to-blue-600 bg-clip-text text-transparent">
                  AgriDrone Ops
                </span>
              </div>
            </div>
            <div className="flex items-center space-x-2">
              <Button 
                variant={satelliteLayer ? "default" : "outline"} 
                size="sm"
                onClick={() => setSatelliteLayer(!satelliteLayer)}
              >
                <Layers className="w-4 h-4 mr-2" />
                Satellite
              </Button>
              <Button variant="outline" size="sm">
                <Download className="w-4 h-4 mr-2" />
                Export
              </Button>
            </div>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="container mx-auto px-4 py-8">
        <div className="mb-6">
          <h1 className="text-3xl font-bold text-gray-900 mb-2">Field Map</h1>
          <p className="text-gray-600">
            {filteredAssets.length} of {assets.length} georeferenced image{assets.length !== 1 ? 's' : ''} displayed
            {filteredAssets.length !== assets.length && ' (filtered)'}
          </p>
        </div>

        {loading ? (
          <div className="text-center py-12">
            <p className="text-gray-500">Loading map data...</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 lg:grid-cols-4 gap-6">
            {/* Map */}
            <div className="lg:col-span-3">
              <Card className="overflow-hidden">
                <CardContent className="p-0">
                  {filteredAssets.length === 0 ? (
                    <div className="h-[600px] flex items-center justify-center bg-gray-50">
                      <div className="text-center">
                        <p className="text-gray-500 mb-4">
                          {assets.length === 0 ? 'No images with GPS coordinates found' : 'No images match the current filters'}
                        </p>
                        {assets.length === 0 && (
                          <Link href="/upload">
                            <Button className="bg-gradient-to-r from-green-500 to-blue-500 hover:from-green-600 hover:to-blue-600">
                              Upload Images with GPS Data
                            </Button>
                          </Link>
                        )}
                      </div>
                    </div>
                  ) : (
                    <div className="h-[600px] w-full">
                      <MapContainer 
                        center={center} 
                        zoom={zoom} 
                        style={{ height: '100%', width: '100%' }}
                      >
                        <TileLayer
                          attribution={satelliteLayer ? 
                            '&copy; <a href="https://www.esri.com/">Esri</a>' : 
                            '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
                          }
                          url={satelliteLayer ?
                            "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}" :
                            "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
                          }
                        />
                        {showDroneImages && filteredAssets.map((asset) => (
                          asset.gpsLatitude && asset.gpsLongitude && (
                            <Marker 
                              key={asset.id} 
                              position={[asset.gpsLatitude, asset.gpsLongitude]}
                            >
                              <Popup>
                                <div className="min-w-[200px]">
                                  <img 
                                    src={asset.storageUrl} 
                                    alt={asset.fileName}
                                    className="w-full h-24 object-cover rounded mb-2"
                                  />
                                  <h3 className="font-semibold text-sm mb-1">{asset.fileName}</h3>
                                  <div className="text-xs text-gray-600 space-y-1">
                                    <p>🏢 {asset.project.name}</p>
                                    {asset.project.location && <p>📍 {asset.project.location}</p>}
                                    {asset.flightSession && <p>✈️ {asset.flightSession}</p>}
                                    <p>📏 {asset.gpsLatitude?.toFixed(6)}, {asset.gpsLongitude?.toFixed(6)}</p>
                                    {asset.altitude && <p>⬆️ {Math.round(asset.altitude)}m altitude</p>}
                                    {asset.gimbalPitch !== null && (
                                      <p>📐 Gimbal: {asset.gimbalPitch?.toFixed(1)}° pitch</p>
                                    )}
                                    <p>📅 {new Date(asset.createdAt).toLocaleDateString()}</p>
                                  </div>
                                </div>
                              </Popup>
                            </Marker>
                          )
                        ))}
                      </MapContainer>
                    </div>
                  )}
                </CardContent>
              </Card>
            </div>

            {/* Sidebar */}
            <div className="space-y-4">
              <Card>
                <CardHeader>
                  <CardTitle className="text-lg">Filters</CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  <div>
                    <label className="text-sm font-medium">Location</label>
                    <select 
                      value={selectedLocation} 
                      onChange={(e) => setSelectedLocation(e.target.value)}
                      className="w-full mt-1 px-3 py-2 border border-gray-300 rounded-md text-sm"
                    >
                      <option value="all">All Locations</option>
                      {uniqueLocations.map(location => (
                        <option key={location} value={location}>{location}</option>
                      ))}
                    </select>
                  </div>
                  
                  <div>
                    <label className="text-sm font-medium">Project</label>
                    <select 
                      value={selectedProject} 
                      onChange={(e) => setSelectedProject(e.target.value)}
                      className="w-full mt-1 px-3 py-2 border border-gray-300 rounded-md text-sm"
                    >
                      <option value="all">All Projects</option>
                      {uniqueProjects.map(project => (
                        <option key={project.id} value={project.id}>{project.name}</option>
                      ))}
                    </select>
                  </div>
                  
                  <div>
                    <label className="text-sm font-medium">Purpose</label>
                    <select 
                      value={selectedPurpose} 
                      onChange={(e) => setSelectedPurpose(e.target.value)}
                      className="w-full mt-1 px-3 py-2 border border-gray-300 rounded-md text-sm"
                    >
                      <option value="all">All Purposes</option>
                      {uniquePurposes.map(purpose => (
                        <option key={purpose} value={purpose}>{purpose.replace('_', ' ')}</option>
                      ))}
                    </select>
                  </div>
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle className="text-lg">Map Statistics</CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  <div className="flex justify-between">
                    <span className="text-sm text-gray-600">Displayed Images:</span>
                    <span className="font-semibold">{filteredAssets.length}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-sm text-gray-600">Total Images:</span>
                    <span className="font-semibold">{assets.length}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-sm text-gray-600">Coverage Area:</span>
                    <span className="font-semibold">~ {(filteredAssets.length * 0.5).toFixed(1)} ha</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-sm text-gray-600">Flight Altitude:</span>
                    <span className="font-semibold">
                      {filteredAssets.length > 0 && filteredAssets[0].altitude 
                        ? `${Math.round(filteredAssets[0].altitude)}m`
                        : 'N/A'
                      }
                    </span>
                  </div>
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle className="text-lg">Map Layers</CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  <div className="flex items-center justify-between">
                    <span className="text-sm">Satellite Imagery</span>
                    <input 
                      type="checkbox" 
                      checked={satelliteLayer} 
                      onChange={() => setSatelliteLayer(!satelliteLayer)}
                      className="rounded" 
                    />
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-sm">Drone Images</span>
                    <input 
                      type="checkbox" 
                      checked={showDroneImages} 
                      onChange={() => setShowDroneImages(!showDroneImages)}
                      className="rounded" 
                    />
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-sm text-gray-400">Weed Detections</span>
                    <input type="checkbox" disabled className="rounded opacity-50" />
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-sm text-gray-400">Flight Path</span>
                    <input type="checkbox" disabled className="rounded opacity-50" />
                  </div>
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle className="text-lg">Quick Actions</CardTitle>
                </CardHeader>
                <CardContent className="space-y-2">
                  <Link href="/upload" className="block">
                    <Button className="w-full bg-gradient-to-r from-green-500 to-blue-500 hover:from-green-600 hover:to-blue-600">
                      <Camera className="w-4 h-4 mr-2" />
                      Upload Images
                    </Button>
                  </Link>
                  <Button variant="outline" className="w-full">
                    <MapPin className="w-4 h-4 mr-2" />
                    Export Coordinates
                  </Button>
                  <Button variant="outline" className="w-full" disabled>
                    <Settings className="w-4 h-4 mr-2" />
                    Run AI Detection
                  </Button>
                </CardContent>
              </Card>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}