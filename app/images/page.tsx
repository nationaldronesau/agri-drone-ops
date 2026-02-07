"use client";

import { useEffect, useState } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { MapPin, Calendar, Eye, Edit3, FolderOpen } from "lucide-react";
import Link from "next/link";
import Image from "next/image";

interface Project {
  id: string;
  name: string;
  location: string | null;
}

interface Asset {
  id: string;
  fileName: string;
  storageUrl: string;
  fileSize: number;
  mimeType: string;
  annotationCount?: number;
  geoQuality?: "high" | "medium" | "low" | "missing";
  geoMissing?: string[];
  geoHasCalibration?: boolean;
  geoHasLrf?: boolean;
  gpsLatitude: number | null;
  gpsLongitude: number | null;
  altitude: number | null;
  gimbalPitch: number | null;
  gimbalRoll: number | null;
  gimbalYaw: number | null;
  imageWidth?: number | null;
  imageHeight?: number | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
  project?: Project;
}

export default function ImagesPage() {
  const [assets, setAssets] = useState<Asset[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState<string>('all');
  const [loading, setLoading] = useState(true);
  const [selectedAsset, setSelectedAsset] = useState<Asset | null>(null);
  const [projectsError, setProjectsError] = useState<string | null>(null);
  const [assetsError, setAssetsError] = useState<string | null>(null);

  // Fetch projects on mount
  useEffect(() => {
    fetchProjects();
  }, []);

  // Fetch assets when project filter changes
  useEffect(() => {
    fetchAssets(selectedProjectId);
  }, [selectedProjectId]);

  const fetchProjects = async () => {
    try {
      setProjectsError(null);
      const response = await fetch('/api/projects');
      if (!response.ok) {
        throw new Error('Failed to load projects');
      }
      const data = await response.json();
      setProjects(data.projects || []);
    } catch (error) {
      console.error('Failed to fetch projects:', error);
      setProjectsError(error instanceof Error ? error.message : 'Failed to load projects');
    }
  };

  const fetchAssets = async (projectId: string) => {
    try {
      setLoading(true);
      setAssetsError(null);
      const url = projectId && projectId !== 'all'
        ? `/api/assets?projectId=${projectId}`
        : '/api/assets';
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error('Failed to load images');
      }
      const data = await response.json();
      setAssets(data.assets || []);
    } catch (error) {
      console.error('Failed to fetch assets:', error);
      setAssetsError(error instanceof Error ? error.message : 'Failed to load images');
      setAssets([]);
    } finally {
      setLoading(false);
    }
  };

  const handleProjectChange = (value: string) => {
    setSelectedProjectId(value);
  };

  const formatFileSize = (bytes: number) => {
    if (bytes < 1024) return bytes + ' bytes';
    if (bytes < 1048576) return Math.round(bytes / 1024) + ' KB';
    return Math.round(bytes / 1048576) + ' MB';
  };

  const formatDate = (dateString: string) => {
    return new Date(dateString).toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });
  };

  const getGeoBadge = (quality?: Asset["geoQuality"]) => {
    switch (quality) {
      case "high":
        return { label: "Geo: High", className: "bg-emerald-600 text-white" };
      case "medium":
        return { label: "Geo: Medium", className: "bg-amber-500 text-white" };
      case "low":
        return { label: "Geo: Low", className: "bg-orange-500 text-white" };
      case "missing":
        return { label: "Geo: Missing", className: "bg-red-600 text-white" };
      default:
        return { label: "Geo: Unknown", className: "bg-gray-500 text-white" };
    }
  };

  return (
    <div className="p-6 lg:p-8">
        <div className="mb-6">
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
            <div>
              <h1 className="text-2xl font-bold text-gray-900 mb-1">Uploaded Images</h1>
              <p className="text-gray-600">
                {assets.length} image{assets.length !== 1 ? 's' : ''}{' '}
                {selectedProjectId !== 'all' ? 'in selected project' : 'across all projects'}
              </p>
            </div>
            <div className="flex items-center gap-2">
              <FolderOpen className="w-4 h-4 text-gray-500" />
              <Select value={selectedProjectId} onValueChange={handleProjectChange}>
                <SelectTrigger className="w-[220px]">
                  <SelectValue placeholder="Filter by project" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Projects</SelectItem>
                  {projects.map((project) => (
                    <SelectItem key={project.id} value={project.id}>
                      {project.name}
                      {project.location && (
                        <span className="text-gray-400 ml-1">({project.location})</span>
                      )}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
        </div>

        {projectsError && (
          <div className="mb-6 rounded-lg border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700">
            {projectsError}
          </div>
        )}

        {loading ? (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {[...Array(6)].map((_, i) => (
              <Card key={i} className="overflow-hidden">
                <div className="aspect-video bg-gray-200 animate-pulse" />
                <CardContent className="p-4 space-y-2">
                  <div className="h-4 bg-gray-200 rounded animate-pulse w-3/4" />
                  <div className="h-3 bg-gray-200 rounded animate-pulse w-1/2" />
                </CardContent>
              </Card>
            ))}
          </div>
        ) : assetsError ? (
          <Card className="text-center py-12">
            <CardContent className="space-y-3">
              <p className="text-sm text-red-600">{assetsError}</p>
              <Button variant="outline" onClick={() => fetchAssets(selectedProjectId)}>
                Retry
              </Button>
            </CardContent>
          </Card>
        ) : assets.length === 0 ? (
          <Card className="text-center py-12">
            <CardContent>
              <p className="text-gray-500 mb-4">No images uploaded yet</p>
              <Link href="/upload">
                <Button>Upload Your First Image</Button>
              </Link>
            </CardContent>
          </Card>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {assets.map((asset) => (
              <Card key={asset.id} className="overflow-hidden hover:shadow-lg transition-shadow">
                <div className="aspect-video relative bg-gray-100">
                  <Image
                    src={asset.storageUrl}
                    alt={asset.fileName}
                    fill
                    className="object-cover"
                    sizes="(max-width: 768px) 100vw, (max-width: 1200px) 50vw, 33vw"
                    onError={(e) => {
                      e.currentTarget.style.display = "none";
                    }}
                    unoptimized
                  />
                  <div className="absolute top-2 left-2 flex flex-col gap-1">
                    <div
                      className={`rounded-full px-2 py-0.5 text-xs font-medium shadow ${
                        asset.annotationCount && asset.annotationCount > 0
                          ? 'bg-green-600 text-white'
                          : 'bg-gray-500 text-white'
                      }`}
                    >
                      {asset.annotationCount && asset.annotationCount > 0
                        ? `Labeled (${asset.annotationCount})`
                        : 'Unlabeled'}
                    </div>
                    <div
                      className={`rounded-full px-2 py-0.5 text-xs font-medium shadow ${getGeoBadge(asset.geoQuality).className}`}
                      title={
                        asset.geoMissing && asset.geoMissing.length > 0
                          ? `Missing: ${asset.geoMissing.join(", ")}`
                          : undefined
                      }
                    >
                      {getGeoBadge(asset.geoQuality).label}
                    </div>
                  </div>
                  <div className="absolute top-2 right-2 flex gap-2">
                    <Link href={`/annotate/${asset.id}`}>
                      <Button
                        size="sm"
                        className="bg-green-600 hover:bg-green-700 text-white shadow-lg"
                        title="Manual Annotation"
                      >
                        <Edit3 className="w-4 h-4" />
                      </Button>
                    </Link>
                    <Button
                      size="sm"
                      className="bg-blue-600 hover:bg-blue-700 text-white shadow-lg"
                      onClick={() => setSelectedAsset(asset)}
                      title="View Details"
                    >
                      <Eye className="w-4 h-4" />
                    </Button>
                  </div>
                </div>
                <CardContent className="p-4">
                  <h3 className="font-semibold text-gray-900 truncate mb-2">{asset.fileName}</h3>

                  {asset.project && selectedProjectId === 'all' && (
                    <div className="mb-2">
                      <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-blue-100 text-blue-800">
                        <FolderOpen className="w-3 h-3 mr-1" />
                        {asset.project.name}
                      </span>
                    </div>
                  )}

                  <div className="space-y-2 text-sm">
                    {asset.gpsLatitude && asset.gpsLongitude && (
                      <div className="flex items-center gap-2 text-gray-600">
                        <MapPin className="w-4 h-4 text-green-600" />
                        <span>
                          {asset.gpsLatitude.toFixed(6)}, {asset.gpsLongitude.toFixed(6)}
                        </span>
                      </div>
                    )}
                    
                    {asset.altitude && (
                      <div className="flex items-center gap-2 text-gray-600">
                        <span className="text-xs font-medium">ALT</span>
                        <span>{Math.round(asset.altitude)}m</span>
                      </div>
                    )}
                    
                    <div className="flex items-center gap-2 text-gray-600">
                      <Calendar className="w-4 h-4" />
                      <span>{formatDate(asset.createdAt)}</span>
                    </div>
                    
                    <div className="flex items-center gap-2 text-gray-600">
                      <span className="text-xs">{formatFileSize(asset.fileSize)}</span>
                    </div>
                  </div>

                  {(asset.gimbalPitch !== null || asset.gimbalRoll !== null || asset.gimbalYaw !== null) && (
                    <div className="mt-3 pt-3 border-t">
                      <p className="text-xs text-gray-500 mb-1">Gimbal Angles</p>
                      <div className="flex gap-3 text-xs">
                        {asset.gimbalPitch !== null && (
                          <span>P: {asset.gimbalPitch.toFixed(1)}°</span>
                        )}
                        {asset.gimbalRoll !== null && (
                          <span>R: {asset.gimbalRoll.toFixed(1)}°</span>
                        )}
                        {asset.gimbalYaw !== null && (
                          <span>Y: {asset.gimbalYaw.toFixed(1)}°</span>
                        )}
                      </div>
                    </div>
                  )}
                </CardContent>
              </Card>
            ))}
          </div>
        )}

        {/* Detail Modal */}
        {selectedAsset && (
          <div className="fixed inset-0 bg-black/50 flex items-center justify-center p-4 z-50" onClick={() => setSelectedAsset(null)}>
            <Card className="max-w-4xl w-full max-h-[90vh] overflow-auto" onClick={(e) => e.stopPropagation()}>
              <CardHeader>
                <CardTitle>{selectedAsset.fileName}</CardTitle>
                <CardDescription>Image Details and Metadata</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="grid md:grid-cols-2 gap-6">
                  <div>
                    <Image
                      src={selectedAsset.storageUrl}
                      alt={selectedAsset.fileName}
                      width={selectedAsset.imageWidth ?? 1200}
                      height={selectedAsset.imageHeight ?? 800}
                      className="w-full h-auto rounded-lg"
                      unoptimized
                    />
                  </div>
                  <div className="space-y-4">
                    <div>
                      <h3 className="font-semibold mb-2">Location Data</h3>
                      <div className="space-y-1 text-sm">
                        <p>Latitude: {selectedAsset.gpsLatitude || 'N/A'}</p>
                        <p>Longitude: {selectedAsset.gpsLongitude || 'N/A'}</p>
                        <p>Altitude: {selectedAsset.altitude ? `${Math.round(selectedAsset.altitude)}m` : 'N/A'}</p>
                        <p>
                          Geo Quality:{" "}
                          <span className="font-medium">
                            {getGeoBadge(selectedAsset.geoQuality).label.replace("Geo: ", "")}
                          </span>
                        </p>
                        {selectedAsset.geoMissing && selectedAsset.geoMissing.length > 0 && (
                          <p className="text-xs text-gray-500">
                            Missing: {selectedAsset.geoMissing.join(", ")}
                          </p>
                        )}
                      </div>
                    </div>
                    
                    <div>
                      <h3 className="font-semibold mb-2">Gimbal Data</h3>
                      <div className="space-y-1 text-sm">
                        <p>Pitch: {selectedAsset.gimbalPitch?.toFixed(1) || 'N/A'}°</p>
                        <p>Roll: {selectedAsset.gimbalRoll?.toFixed(1) || 'N/A'}°</p>
                        <p>Yaw: {selectedAsset.gimbalYaw?.toFixed(1) || 'N/A'}°</p>
                      </div>
                    </div>

                    {selectedAsset.metadata && (
                      <div>
                        <h3 className="font-semibold mb-2">Additional Metadata</h3>
                        <pre className="text-xs bg-gray-100 p-2 rounded overflow-auto max-h-48">
                          {JSON.stringify(selectedAsset.metadata, null, 2)}
                        </pre>
                      </div>
                    )}
                  </div>
                </div>
                <div className="mt-6 flex justify-between">
                  <Link href={`/annotate/${selectedAsset.id}`}>
                    <Button className="bg-gradient-to-r from-green-500 to-blue-500 hover:from-green-600 hover:to-blue-600">
                      <Edit3 className="w-4 h-4 mr-2" />
                      Manual Annotation
                    </Button>
                  </Link>
                  <Button variant="outline" onClick={() => setSelectedAsset(null)}>
                    Close
                  </Button>
                </div>
              </CardContent>
            </Card>
          </div>
        )}
    </div>
  );
}
