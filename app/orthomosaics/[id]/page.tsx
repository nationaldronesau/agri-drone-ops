'use client';

import { useState, useEffect } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import dynamic from 'next/dynamic';
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ArrowLeft, MapPin, Calendar, Ruler, Mountain, Layers, ZoomIn, RotateCcw } from 'lucide-react';
import { formatBytes, formatDate } from '@/lib/utils';

// Dynamically import the map component to avoid SSR issues
const OrthomosaicMap = dynamic(() => import('@/components/orthomosaic-map'), {
  ssr: false,
  loading: () => (
    <div className="w-full h-[600px] bg-gray-100 rounded-lg flex items-center justify-center">
      <div className="text-center">
        <Mountain className="w-12 h-12 text-gray-400 mx-auto mb-4" />
        <p className="text-gray-500">Loading map...</p>
      </div>
    </div>
  )
});

interface Orthomosaic {
  id: string;
  name: string;
  description: string | null;
  fileSize: bigint;
  bounds: any;
  centerLat: number;
  centerLon: number;
  minZoom: number;
  maxZoom: number;
  captureDate: string | null;
  resolution: number | null;
  area: number | null;
  imageCount: number | null;
  status: string;
  createdAt: string;
  project: {
    id: string;
    name: string;
    location: string | null;
  };
}

export default function OrthomosaicViewerPage() {
  const params = useParams();
  const [orthomosaic, setOrthomosaic] = useState<Orthomosaic | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [downloading, setDownloading] = useState(false);
  const [mapControls, setMapControls] = useState({
    showLayers: true,
    showMeasurement: false,
    opacity: 1
  });

  useEffect(() => {
    if (params?.id) {
      fetchOrthomosaic(params.id as string);
    }
  }, [params?.id]);

  const fetchOrthomosaic = async (id: string) => {
    try {
      setLoading(true);
      setError(null);
      const response = await fetch(`/api/orthomosaics/${id}`);
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(data.error || 'Failed to load orthomosaic');
      }
      setOrthomosaic(data);
    } catch (error) {
      console.error('Error fetching orthomosaic:', error);
      setOrthomosaic(null);
      setError(error instanceof Error ? error.message : 'Failed to load orthomosaic');
    } finally {
      setLoading(false);
    }
  };

  const handleDownload = async () => {
    if (!orthomosaic) return;
    setActionError(null);
    setDownloading(true);
    try {
      const response = await fetch(`/api/orthomosaics/${orthomosaic.id}/signed-url`);
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.url) {
        throw new Error(data.error || 'Failed to fetch download URL');
      }
      window.open(data.url, "_blank", "noopener,noreferrer");
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to download file');
    } finally {
      setDownloading(false);
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="text-center">
          <Mountain className="w-16 h-16 text-gray-400 mx-auto mb-4 animate-pulse" />
          <p className="text-gray-500">Loading orthomosaic...</p>
        </div>
      </div>
    );
  }

  if (!orthomosaic) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="text-center">
          <Mountain className="w-16 h-16 text-gray-400 mx-auto mb-4" />
          <p className="text-gray-500 mb-4">
            {error || 'Orthomosaic not found'}
          </p>
          <Link href="/orthomosaics">
            <Button>Back to Orthomosaics</Button>
          </Link>
        </div>
      </div>
    );
  }

  const statusMeta = {
    COMPLETED: { label: 'Ready', className: 'bg-green-100 text-green-800' },
    PROCESSING: { label: 'Processing', className: 'bg-blue-100 text-blue-800' },
    FAILED: { label: 'Failed', className: 'bg-red-100 text-red-800' },
    PENDING: { label: 'Pending', className: 'bg-gray-100 text-gray-800' },
  }[orthomosaic.status] || { label: orthomosaic.status, className: 'bg-gray-100 text-gray-800' };

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <div className="bg-gradient-to-r from-green-500 to-blue-500 text-white">
        <div className="container mx-auto px-4 py-6">
          <div className="flex items-center gap-4 mb-4">
            <Link href="/orthomosaics">
              <Button variant="ghost" size="sm" className="text-white hover:bg-white/20">
                <ArrowLeft className="w-4 h-4 mr-2" />
                Back
              </Button>
            </Link>
            <div className="flex items-center gap-3">
              <Mountain className="w-8 h-8" />
              <div>
                <h1 className="text-2xl font-bold">{orthomosaic.name}</h1>
                <p className="text-green-100">{orthomosaic.project.name}</p>
              </div>
            </div>
          </div>
          
          <div className="flex flex-wrap gap-4 text-sm">
            <div className="flex items-center gap-2">
              <MapPin className="w-4 h-4" />
              <span>{orthomosaic.centerLat.toFixed(4)}, {orthomosaic.centerLon.toFixed(4)}</span>
            </div>
            {orthomosaic.area && (
              <div className="flex items-center gap-2">
                <Layers className="w-4 h-4" />
                <span>{orthomosaic.area.toFixed(1)} hectares</span>
              </div>
            )}
            {orthomosaic.resolution && (
              <div className="flex items-center gap-2">
                <Ruler className="w-4 h-4" />
                <span>{orthomosaic.resolution.toFixed(1)} cm/pixel</span>
              </div>
            )}
            {orthomosaic.captureDate && (
              <div className="flex items-center gap-2">
                <Calendar className="w-4 h-4" />
                <span>{formatDate(orthomosaic.captureDate)}</span>
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="container mx-auto p-6 -mt-4">
        <div className="grid lg:grid-cols-4 gap-6">
          {/* Map Viewer */}
          <div className="lg:col-span-3">
            <Card className="bg-white shadow-lg border-0 rounded-lg overflow-hidden">
              <CardHeader className="pb-4">
                <div className="flex items-center justify-between">
                  <CardTitle className="text-xl font-semibold">Interactive Map</CardTitle>
                  <div className="flex gap-2">
                    <Button 
                      variant="outline" 
                      size="sm"
                      onClick={() => setMapControls(prev => ({ ...prev, showLayers: !prev.showLayers }))}
                    >
                      <Layers className="w-4 h-4 mr-2" />
                      Layers
                    </Button>
                    <Button variant="outline" size="sm">
                      <ZoomIn className="w-4 h-4 mr-2" />
                      Zoom
                    </Button>
                  </div>
                </div>
              </CardHeader>
              <CardContent className="p-0">
                <div className="relative">
                  <OrthomosaicMap
                    orthomosaic={orthomosaic}
                    controls={mapControls}
                    onControlsChange={setMapControls}
                  />
                  
                  {/* Map Overlay Controls */}
                  <div className="absolute top-4 right-4 bg-white rounded-lg shadow-lg p-3 space-y-2">
                    <div className="text-xs text-gray-600 mb-2">Opacity</div>
                    <input
                      type="range"
                      min="0"
                      max="1"
                      step="0.1"
                      value={mapControls.opacity}
                      onChange={(e) => setMapControls(prev => ({ 
                        ...prev, 
                        opacity: parseFloat(e.target.value) 
                      }))}
                      className="w-20"
                    />
                    <div className="text-xs text-gray-500">{Math.round(mapControls.opacity * 100)}%</div>
                  </div>
                </div>
              </CardContent>
            </Card>
          </div>

          {/* Sidebar */}
          <div className="space-y-6">
            {/* Properties */}
            <Card className="bg-white shadow-lg border-0 rounded-lg">
              <CardHeader>
                <CardTitle className="text-lg">Properties</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div>
                  <div className="text-sm text-gray-600 mb-1">Status</div>
                  <Badge className={statusMeta.className}>
                    {statusMeta.label}
                  </Badge>
                </div>

                <div>
                  <div className="text-sm text-gray-600 mb-1">File Size</div>
                  <div className="text-sm font-medium">{formatBytes(Number(orthomosaic.fileSize))}</div>
                </div>

                {orthomosaic.imageCount && (
                  <div>
                    <div className="text-sm text-gray-600 mb-1">Source Images</div>
                    <div className="text-sm font-medium">{orthomosaic.imageCount.toLocaleString()}</div>
                  </div>
                )}

                <div>
                  <div className="text-sm text-gray-600 mb-1">Zoom Levels</div>
                  <div className="text-sm font-medium">{orthomosaic.minZoom} - {orthomosaic.maxZoom}</div>
                </div>

                <div>
                  <div className="text-sm text-gray-600 mb-1">Created</div>
                  <div className="text-sm font-medium">{formatDate(orthomosaic.createdAt)}</div>
                </div>

                {orthomosaic.description && (
                  <div>
                    <div className="text-sm text-gray-600 mb-1">Description</div>
                    <div className="text-sm">{orthomosaic.description}</div>
                  </div>
                )}
              </CardContent>
            </Card>

            {/* Actions */}
            <Card className="bg-white shadow-lg border-0 rounded-lg">
              <CardHeader>
                <CardTitle className="text-lg">Actions</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                {actionError && (
                  <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
                    {actionError}
                  </div>
                )}
                <Link href={`/map?orthomosaic=${orthomosaic.id}`} className="block">
                  <Button className="w-full bg-gradient-to-r from-green-500 to-blue-500 hover:from-green-600 hover:to-blue-600 text-white shadow-lg">
                    <Layers className="w-4 h-4 mr-2" />
                    Add to Main Map
                  </Button>
                </Link>
                
                <Button
                  variant="outline"
                  className="w-full border-green-500 text-green-600 hover:bg-green-50"
                  onClick={handleDownload}
                  disabled={downloading}
                >
                  <Mountain className="w-4 h-4 mr-2" />
                  {downloading ? "Preparing download..." : "Download Original"}
                </Button>
                
                <Button variant="outline" className="w-full" disabled title="Reprocessing not yet available">
                  <RotateCcw className="w-4 h-4 mr-2" />
                  Reprocess Tiles
                </Button>
              </CardContent>
            </Card>

            {/* Project Info */}
            <Card className="bg-white shadow-lg border-0 rounded-lg">
              <CardHeader>
                <CardTitle className="text-lg">Project</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-2">
                  <div>
                    <div className="text-sm text-gray-600">Name</div>
                    <div className="font-medium">{orthomosaic.project.name}</div>
                  </div>
                  {orthomosaic.project.location && (
                    <div>
                      <div className="text-sm text-gray-600">Location</div>
                      <div className="font-medium">{orthomosaic.project.location}</div>
                    </div>
                  )}
                  <Link href={`/projects/${orthomosaic.project.id}`} className="block mt-3">
                    <Button variant="outline" size="sm" className="w-full">
                      View Project
                    </Button>
                  </Link>
                </div>
              </CardContent>
            </Card>
          </div>
        </div>
      </div>
    </div>
  );
}
