"use client";

import { useState, useEffect, useCallback } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Download, FileText, Map, AlertTriangle, Database } from "lucide-react";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import { WorkflowGuide } from "@/components/workflow-guide";

interface Project {
  id: string;
  name: string;
  location: string | null;
  purpose: string;
}

interface Detection {
  id: string;
  className: string;
  confidence: number;
  centerLat: number | null;
  centerLon: number | null;
  type?: 'ai' | 'manual' | 'sam3';
  metadata: Record<string, unknown> | null;
  createdAt: string;
  asset: {
    id: string;
    fileName: string;
    altitude: number | null;
    project: {
      name: string;
      location: string | null;
    };
  };
}

export default function ExportPage() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [detections, setDetections] = useState<Detection[]>([]);
  const [selectedProject, setSelectedProject] = useState<string>("all");
  const [selectedClasses, setSelectedClasses] = useState<string[]>([]);
  const [exportFormat, setExportFormat] = useState<"csv" | "kml" | "shapefile">("csv");
  const [includeMetadata, setIncludeMetadata] = useState(true);
  const [includeAI, setIncludeAI] = useState(true);
  const [includeManual, setIncludeManual] = useState(true);
  const [includeSam3, setIncludeSam3] = useState(false);
  const [loading, setLoading] = useState(false);
  const [projectsError, setProjectsError] = useState<string | null>(null);
  const [detectionsError, setDetectionsError] = useState<string | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);
  // Threshold for when to recommend/require streaming export
  const LARGE_DATASET_THRESHOLD = 1000;

  // Helper function to validate coordinates
  const isValidCoordinate = (lat: number | null | undefined, lon: number | null | undefined): boolean => {
    if (lat == null || lon == null) return false;
    return Number.isFinite(lat) && Number.isFinite(lon) &&
           lat >= -90 && lat <= 90 &&
           lon >= -180 && lon <= 180;
  };

  const fetchProjects = useCallback(async () => {
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
  }, []);

  const fetchAllDetections = useCallback(async () => {
    const allDetections: Detection[] = [];
    const failures: string[] = [];

    setDetectionsError(null);

    // Fetch AI detections if enabled (use all=true to bypass pagination for export)
    if (includeAI) {
      try {
        const aiUrl = selectedProject !== "all"
          ? `/api/detections?projectId=${selectedProject}&all=true`
          : '/api/detections?all=true';
        const aiResponse = await fetch(aiUrl);
        if (!aiResponse.ok) {
          throw new Error(`AI detections request failed (${aiResponse.status})`);
        }
        const aiData = (await aiResponse.json()) as Detection[];
        const aiDetections = aiData.map((d) => ({ ...d, type: 'ai' as const }));
        allDetections.push(...aiDetections);
      } catch (error) {
        console.error('Failed to fetch AI detections:', error);
        failures.push('AI detections');
      }
    }

    // Fetch manual + optional SAM3 annotations (use all=true to bypass pagination for export)
    if (includeManual || includeSam3) {
      try {
        const params = new URLSearchParams({ all: 'true' });
        if (selectedProject !== "all") {
          params.set('projectId', selectedProject);
        }
        if (!includeManual) {
          params.set('includeManual', 'false');
        }
        if (includeSam3) {
          params.set('includePending', 'true');
        }

        const manualResponse = await fetch(`/api/annotations/export?${params.toString()}`);
        if (!manualResponse.ok) {
          throw new Error(`Manual annotations request failed (${manualResponse.status})`);
        }
        const manualData = await manualResponse.json();
        allDetections.push(...manualData);
      } catch (error) {
        console.error('Failed to fetch manual annotations:', error);
        failures.push('manual annotations');
      }
    }

    setDetections(allDetections);

    // Extract unique classes
    const classes = [...new Set(allDetections.map((d: Detection) => d.className))];
    setSelectedClasses(classes);

    if (failures.length > 0) {
      setDetectionsError(`Some data failed to load: ${failures.join(', ')}`);
    }
  }, [includeAI, includeManual, includeSam3, selectedProject]);

  useEffect(() => {
    fetchProjects();
    fetchAllDetections();
  }, [fetchProjects, fetchAllDetections]);

  useEffect(() => {
    fetchAllDetections();
  }, [fetchAllDetections]);

  const filteredDetections = detections.filter(detection => {
    if (selectedClasses.length > 0 && !selectedClasses.includes(detection.className)) {
      return false;
    }
    return isValidCoordinate(detection.centerLat, detection.centerLon);
  });

  const toggleClass = (className: string) => {
    setSelectedClasses(prev => 
      prev.includes(className) 
        ? prev.filter(c => c !== className)
        : [...prev, className]
    );
  };

  const handleExport = async () => {
    await exportWithStreaming();
  };

  const exportWithStreaming = async () => {
    setLoading(true);
    setExportError(null);
    try {
      const params = new URLSearchParams({
        format: exportFormat,
        includeAI: includeAI.toString(),
        includeManual: includeManual.toString(),
      });
      if (includeSam3) {
        params.set("includePending", "true");
      }

      if (selectedProject !== "all") {
        params.set("projectId", selectedProject);
      }

      if (selectedClasses.length > 0) {
        params.set("classes", selectedClasses.join(","));
      }

      const response = await fetch(`/api/export/stream?${params.toString()}`);

      if (!response.ok) {
        throw new Error("Export failed");
      }

      // Create blob from stream and download
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `weed-detections-${new Date().toISOString().split("T")[0]}.zip`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (error) {
      console.error("Streaming export failed:", error);
      const message = error instanceof Error ? error.message : "Export failed. Please try again.";
      setExportError(message);
    } finally {
      setLoading(false);
    }
  };

  const uniqueClasses = [...new Set(detections.map(d => d.className))];
  const sam3Count = filteredDetections.filter(d => d.type === 'sam3').length;

  return (
    <div className="p-6 lg:p-8">
        <div className="max-w-4xl mx-auto space-y-6">
          <WorkflowGuide current="export" />
          <Card>
            <CardHeader>
              <CardTitle className="text-2xl">Export Detection Data</CardTitle>
              <CardDescription>
                Export weed detection coordinates for spray drone operations. 
                Choose your format and filter the data as needed.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
              {(projectsError || detectionsError || exportError) && (
                <div className="space-y-2">
                  {projectsError && (
                    <div className="flex items-center gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
                      <AlertTriangle className="h-4 w-4" />
                      <span>{projectsError}</span>
                    </div>
                  )}
                  {detectionsError && (
                    <div className="flex items-center gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
                      <AlertTriangle className="h-4 w-4" />
                      <span>{detectionsError}</span>
                    </div>
                  )}
                  {exportError && (
                    <div className="flex items-center gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
                      <AlertTriangle className="h-4 w-4" />
                      <span>{exportError}</span>
                    </div>
                  )}
                </div>
              )}
              {/* Project Filter */}
              <div className="space-y-2">
                <Label htmlFor="project">Filter by Project</Label>
                <Select value={selectedProject} onValueChange={setSelectedProject}>
                  <SelectTrigger id="project">
                    <SelectValue placeholder="All projects" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Projects</SelectItem>
                    {projects.map(project => (
                      <SelectItem key={project.id} value={project.id}>
                        {project.name} {project.location && `- ${project.location}`}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {/* Weed Type Filter */}
              <div className="space-y-2">
                <Label>Filter by Weed Type</Label>
                <div className="grid grid-cols-2 gap-2 p-4 bg-gray-50 rounded-lg">
                  {uniqueClasses.length === 0 ? (
                    <div className="col-span-2 text-sm text-gray-500">
                      No detections available for the current filters.
                    </div>
                  ) : (
                    uniqueClasses.map(className => (
                      <div key={className} className="flex items-center space-x-2">
                        <Checkbox 
                          id={className}
                          checked={selectedClasses.includes(className)}
                          onCheckedChange={() => toggleClass(className)}
                        />
                        <Label 
                          htmlFor={className} 
                          className="text-sm cursor-pointer"
                        >
                          {className}
                        </Label>
                      </div>
                    ))
                  )}
                </div>
              </div>

              {/* Export Format */}
              <div className="space-y-2">
                <Label>Export Format</Label>
                <div className="grid grid-cols-3 gap-4">
                  <div
                    className={`p-4 border-2 rounded-lg cursor-pointer transition-colors ${
                      exportFormat === 'csv'
                        ? 'border-green-500 bg-green-50'
                        : 'border-gray-200 hover:border-gray-300'
                    }`}
                    onClick={() => setExportFormat('csv')}
                  >
                    <div className="flex items-center space-x-3">
                      <FileText className="w-8 h-8 text-green-600" />
                      <div>
                        <h4 className="font-semibold">CSV Format</h4>
                        <p className="text-sm text-gray-600">
                          Spreadsheet compatible, ideal for data analysis
                        </p>
                      </div>
                    </div>
                  </div>
                  <div
                    className={`p-4 border-2 rounded-lg cursor-pointer transition-colors ${
                      exportFormat === 'kml'
                        ? 'border-blue-500 bg-blue-50'
                        : 'border-gray-200 hover:border-gray-300'
                    }`}
                    onClick={() => setExportFormat('kml')}
                  >
                    <div className="flex items-center space-x-3">
                      <Map className="w-8 h-8 text-blue-600" />
                      <div>
                        <h4 className="font-semibold">KML Format</h4>
                        <p className="text-sm text-gray-600">
                          Map visualization, works with Google Earth
                        </p>
                      </div>
                    </div>
                  </div>
                  <div
                    className={`p-4 border-2 rounded-lg cursor-pointer transition-colors ${
                      exportFormat === 'shapefile'
                        ? 'border-purple-500 bg-purple-50'
                        : 'border-gray-200 hover:border-gray-300'
                    }`}
                    onClick={() => setExportFormat('shapefile')}
                  >
                    <div className="flex items-center space-x-3">
                      <Database className="w-8 h-8 text-purple-600" />
                      <div>
                        <h4 className="font-semibold">Shapefile</h4>
                        <p className="text-sm text-gray-600">
                          GIS compatible, for DJI spray drones
                        </p>
                      </div>
                    </div>
                  </div>
                </div>
              </div>

              {/* Data Source Options */}
              <div className="space-y-2">
                <Label>Data Sources</Label>
                <div className="space-y-2">
                  <div className="flex items-center space-x-2">
                    <Checkbox 
                      id="includeAI"
                      checked={includeAI}
                      onCheckedChange={(checked) => setIncludeAI(checked as boolean)}
                    />
                    <Label htmlFor="includeAI" className="cursor-pointer">
                      Include AI Detections
                    </Label>
                  </div>
                  <div className="flex items-center space-x-2">
                    <Checkbox 
                      id="includeManual"
                      checked={includeManual}
                      onCheckedChange={(checked) => setIncludeManual(checked as boolean)}
                    />
                    <Label htmlFor="includeManual" className="cursor-pointer">
                      Include Manual Annotations
                    </Label>
                  </div>
                  <div className="flex items-center space-x-2">
                    <Checkbox 
                      id="includeSam3"
                      checked={includeSam3}
                      disabled
                      onCheckedChange={(checked) => setIncludeSam3(checked as boolean)}
                    />
                    <Label htmlFor="includeSam3" className="cursor-not-allowed text-gray-400">
                      Include SAM3 Pending Annotations (disabled)
                    </Label>
                  </div>
                </div>
              </div>

              {/* Export Options */}
              <div className="space-y-2">
                <Label>Export Options</Label>
                <div className="space-y-2">
                  <div className="flex items-center space-x-2">
                    <Checkbox 
                      id="metadata"
                      checked={includeMetadata}
                      onCheckedChange={(checked) => setIncludeMetadata(checked as boolean)}
                    />
                    <Label htmlFor="metadata" className="cursor-pointer">
                      Include metadata (confidence, altitude, image file, etc.)
                    </Label>
                  </div>
                </div>
              </div>

              {/* Export Summary */}
              <div className="p-4 bg-blue-50 rounded-lg border border-blue-200">
                <h4 className="font-semibold text-blue-900 mb-2">Export Summary</h4>
                <div className="space-y-1 text-sm text-blue-800">
                  <p>• {filteredDetections.length} detections will be exported</p>
                  <p>• AI Detections: {filteredDetections.filter(d => d.type === 'ai').length}</p>
                  <p>• Manual Annotations: {filteredDetections.filter(d => d.type === 'manual').length}</p>
                  {sam3Count > 0 && <p>• SAM3 Pending: {sam3Count}</p>}
                  <p>• Format: {exportFormat.toUpperCase()}</p>
                  <p>• Weed types: {selectedClasses.join(', ') || 'None selected'}</p>
                  {includeMetadata && <p>• Metadata included</p>}
                </div>
              </div>

              {/* Large Dataset Warning */}
              {filteredDetections.length > LARGE_DATASET_THRESHOLD && (
                <div className="p-4 bg-yellow-50 rounded-lg border border-yellow-200 flex items-start space-x-3">
                  <AlertTriangle className="w-5 h-5 text-yellow-600 flex-shrink-0 mt-0.5" />
                  <div>
                    <h4 className="font-semibold text-yellow-900">Large Dataset Detected</h4>
                    <p className="text-sm text-yellow-800 mt-1">
                      With {filteredDetections.length.toLocaleString()} detections, server-side streaming export will be used
                      automatically to prevent browser memory issues.
                    </p>
                  </div>
                </div>
              )}

              {/* Export Button */}
              <div className="flex justify-end space-x-4">
                <Button
                  onClick={handleExport}
                  disabled={filteredDetections.length === 0 || loading}
                  className="bg-violet-600 hover:bg-violet-700"
                >
                  {loading ? (
                    <>
                      <div className="w-4 h-4 mr-2 border-2 border-white border-t-transparent rounded-full animate-spin" />
                      Exporting...
                    </>
                  ) : (
                    <>
                      <Download className="w-4 h-4 mr-2" />
                      Export {filteredDetections.length} Detections
                    </>
                  )}
                </Button>
              </div>
            </CardContent>
          </Card>

          {/* Usage Instructions */}
          <Card>
            <CardHeader>
              <CardTitle className="text-lg">How to Use Exported Data</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4 text-sm text-gray-600">
              <div>
                <h4 className="font-semibold text-gray-900 mb-1">CSV Format:</h4>
                <ul className="space-y-1 list-disc list-inside">
                  <li>Open in Excel, Google Sheets, or any spreadsheet application</li>
                  <li>Import directly into spray drone mission planning software</li>
                  <li>Use for data analysis and reporting</li>
                  <li>Compatible with most agricultural management systems</li>
                </ul>
              </div>
              <div>
                <h4 className="font-semibold text-gray-900 mb-1">KML Format:</h4>
                <ul className="space-y-1 list-disc list-inside">
                  <li>View in Google Earth or Google Maps</li>
                  <li>Import into GIS software (QGIS, ArcGIS)</li>
                  <li>Visualize detection patterns and distribution</li>
                  <li>Share visual reports with stakeholders</li>
                </ul>
              </div>
              <div>
                <h4 className="font-semibold text-gray-900 mb-1">Shapefile Format:</h4>
                <ul className="space-y-1 list-disc list-inside">
                  <li>Direct import into DJI Terra and spray drone mission planners</li>
                  <li>Compatible with QGIS, ArcGIS, and professional GIS software</li>
                  <li>Includes WGS84 projection (.prj) for accurate positioning</li>
                  <li>Industry standard format for agricultural operations</li>
                </ul>
              </div>
            </CardContent>
          </Card>
        </div>
    </div>
  );
}
