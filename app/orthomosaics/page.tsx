'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { MapPin, Upload, Calendar, Ruler, Mountain, AlertCircle, CheckCircle, Clock, Loader2 } from 'lucide-react';
import { formatBytes, formatDate } from '@/lib/utils';

interface Orthomosaic {
  id: string;
  name: string;
  description: string | null;
  fileSize: bigint;
  centerLat: number;
  centerLon: number;
  captureDate: string | null;
  resolution: number | null;
  area: number | null;
  imageCount: number | null;
  status: 'PENDING' | 'PROCESSING' | 'COMPLETED' | 'FAILED';
  createdAt: string;
  project: {
    id: string;
    name: string;
    location: string | null;
  };
}

export default function OrthomosaicsPage() {
  const [orthomosaics, setOrthomosaics] = useState<Orthomosaic[]>([]);
  const [projects, setProjects] = useState<any[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);

  useEffect(() => {
    fetchOrthomosaics();
    fetchProjects();
  }, []);

  const fetchOrthomosaics = async () => {
    try {
      const response = await fetch('/api/orthomosaics');
      if (response.ok) {
        const data = await response.json();
        setOrthomosaics(data);
      }
    } catch (error) {
      console.error('Error fetching orthomosaics:', error);
    } finally {
      setLoading(false);
    }
  };

  const fetchProjects = async () => {
    try {
      const response = await fetch('/api/projects');
      if (response.ok) {
        const data = await response.json();
        setProjects(data);
      }
    } catch (error) {
      console.error('Error fetching projects:', error);
    }
  };

  const handleFileUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file || !selectedProjectId) return;

    setUploading(true);
    setUploadProgress(0);

    const formData = new FormData();
    formData.append('file', file);
    formData.append('projectId', selectedProjectId);
    formData.append('name', file.name.replace(/\.[^/.]+$/, '')); // Remove extension

    try {
      const xhr = new XMLHttpRequest();
      
      xhr.upload.addEventListener('progress', (e) => {
        if (e.lengthComputable) {
          const percentComplete = (e.loaded / e.total) * 100;
          setUploadProgress(percentComplete);
        }
      });

      xhr.addEventListener('load', () => {
        if (xhr.status === 200) {
          fetchOrthomosaics(); // Refresh list
          setUploadProgress(0);
          setUploading(false);
        }
      });

      xhr.open('POST', '/api/orthomosaics/upload');
      xhr.send(formData);
    } catch (error) {
      console.error('Error uploading orthomosaic:', error);
      setUploading(false);
    }
  };

  const getStatusIcon = (status: string) => {
    switch (status) {
      case 'COMPLETED':
        return <CheckCircle className="w-5 h-5 text-green-500" />;
      case 'PROCESSING':
        return <Loader2 className="w-5 h-5 text-blue-500 animate-spin" />;
      case 'FAILED':
        return <AlertCircle className="w-5 h-5 text-red-500" />;
      default:
        return <Clock className="w-5 h-5 text-gray-500" />;
    }
  };

  const getStatusText = (status: string) => {
    switch (status) {
      case 'COMPLETED':
        return 'Ready';
      case 'PROCESSING':
        return 'Processing tiles...';
      case 'FAILED':
        return 'Processing failed';
      default:
        return 'Waiting to process';
    }
  };

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <div className="bg-gradient-to-r from-green-500 to-blue-500 text-white">
        <div className="container mx-auto px-4 py-8">
          <div className="flex items-center gap-3 mb-4">
            <Mountain className="w-8 h-8" />
            <h1 className="text-3xl font-bold">Orthomosaics</h1>
          </div>
          <p className="text-green-100 max-w-2xl">
            View and manage stitched drone imagery for complete survey areas. Upload GeoTIFF orthomosaics to display them as interactive map tiles.
          </p>
        </div>
      </div>

      <div className="container mx-auto p-6 -mt-4">

        {/* Upload Section */}
        <Card className="mb-8 bg-white shadow-lg border-0 rounded-lg">
          <CardHeader>
            <CardTitle className="text-xl font-semibold text-gray-900">Upload New Orthomosaic</CardTitle>
            <CardDescription className="text-gray-600">
              Upload a GeoTIFF orthomosaic to view it as interactive map tiles with full zoom and pan capability
            </CardDescription>
          </CardHeader>
        <CardContent>
          <div className="space-y-4">
            <div>
              <Label htmlFor="project">Select Project</Label>
              <Select value={selectedProjectId} onValueChange={setSelectedProjectId}>
                <SelectTrigger>
                  <SelectValue placeholder="Choose a project" />
                </SelectTrigger>
                <SelectContent>
                  {projects.map((project) => (
                    <SelectItem key={project.id} value={project.id}>
                      {project.name} {project.location && `- ${project.location}`}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {selectedProjectId && (
              <div>
                <Label htmlFor="file">GeoTIFF File</Label>
                <Input
                  id="file"
                  type="file"
                  accept=".tif,.tiff,.geotiff"
                  onChange={handleFileUpload}
                  disabled={uploading}
                />
                <p className="text-sm text-muted-foreground mt-1">
                  Maximum file size: 2GB. Supported format: GeoTIFF
                </p>
              </div>
            )}

            {uploading && (
              <div className="space-y-2">
                <div className="flex items-center justify-between text-sm">
                  <span>Uploading...</span>
                  <span>{Math.round(uploadProgress)}%</span>
                </div>
                <Progress value={uploadProgress} />
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Orthomosaics Grid */}
      {loading ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
        </div>
      ) : orthomosaics.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-12">
            <Mountain className="w-12 h-12 text-muted-foreground mb-4" />
            <p className="text-muted-foreground text-center">
              No orthomosaics uploaded yet.<br />
              Upload a GeoTIFF to get started.
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {orthomosaics.map((ortho) => (
            <Card key={ortho.id} className="hover:shadow-lg transition-shadow">
              <CardHeader>
                <div className="flex items-start justify-between">
                  <div>
                    <CardTitle className="text-lg">{ortho.name}</CardTitle>
                    {ortho.description && (
                      <CardDescription>{ortho.description}</CardDescription>
                    )}
                  </div>
                  {getStatusIcon(ortho.status)}
                </div>
              </CardHeader>
              <CardContent>
                <div className="space-y-3">
                  {/* Status */}
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-muted-foreground">Status</span>
                    <span className={ortho.status === 'COMPLETED' ? 'text-green-600' : ''}>
                      {getStatusText(ortho.status)}
                    </span>
                  </div>

                  {/* Project */}
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-muted-foreground">Project</span>
                    <span>{ortho.project.name}</span>
                  </div>

                  {/* File Size */}
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-muted-foreground">Size</span>
                    <span>{formatBytes(Number(ortho.fileSize))}</span>
                  </div>

                  {/* Resolution */}
                  {ortho.resolution && (
                    <div className="flex items-center justify-between text-sm">
                      <span className="text-muted-foreground">Resolution</span>
                      <span>{ortho.resolution.toFixed(1)} cm/px</span>
                    </div>
                  )}

                  {/* Area */}
                  {ortho.area && (
                    <div className="flex items-center justify-between text-sm">
                      <span className="text-muted-foreground">Area</span>
                      <span>{ortho.area.toFixed(1)} ha</span>
                    </div>
                  )}

                  {/* Capture Date */}
                  {ortho.captureDate && (
                    <div className="flex items-center justify-between text-sm">
                      <Calendar className="w-4 h-4 text-muted-foreground" />
                      <span>{formatDate(ortho.captureDate)}</span>
                    </div>
                  )}

                  {/* Actions */}
                  <div className="pt-4 flex gap-2">
                    {ortho.status === 'COMPLETED' ? (
                      <>
                        <Link href={`/orthomosaics/${ortho.id}`} className="flex-1">
                          <Button className="w-full bg-gradient-to-r from-green-500 to-blue-500 hover:from-green-600 hover:to-blue-600 text-white shadow-lg" size="sm">
                            <MapPin className="w-4 h-4 mr-2" />
                            View Map
                          </Button>
                        </Link>
                        <Link href={`/map?orthomosaic=${ortho.id}`} className="flex-1">
                          <Button variant="outline" className="w-full border-green-500 text-green-600 hover:bg-green-50" size="sm">
                            Add to Map
                          </Button>
                        </Link>
                      </>
                    ) : (
                      <Button className="w-full" size="sm" disabled>
                        {ortho.status === 'PROCESSING' ? 'Processing...' : 'Not Ready'}
                      </Button>
                    )}
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
      </div>
    </div>
  );
}