"use client";

import { useState, useEffect } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { ArrowLeft, Download, FileText, Map, Filter, CheckCircle, AlertTriangle } from "lucide-react";
import Link from "next/link";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";

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
  type?: 'ai' | 'manual';
  metadata: any;
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
  const [exportFormat, setExportFormat] = useState<"csv" | "kml">("csv");
  const [includeMetadata, setIncludeMetadata] = useState(true);
  const [includeAI, setIncludeAI] = useState(true);
  const [includeManual, setIncludeManual] = useState(true);
  const [loading, setLoading] = useState(false);
  const [useStreaming, setUseStreaming] = useState(false);

  // Threshold for when to recommend/require streaming export
  const LARGE_DATASET_THRESHOLD = 1000;

  // Helper function to escape CSV fields (RFC 4180 compliant)
  const escapeCSV = (field: any): string => {
    const str = String(field ?? '');
    if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
      return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
  };

  // Helper function to escape XML special characters
  const escapeXML = (str: any): string => {
    return String(str ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  };

  // Helper function to validate coordinates
  const isValidCoordinate = (lat: number | null | undefined, lon: number | null | undefined): boolean => {
    if (lat == null || lon == null) return false;
    return Number.isFinite(lat) && Number.isFinite(lon) &&
           lat >= -90 && lat <= 90 &&
           lon >= -180 && lon <= 180;
  };

  // Helper function to validate polygon coordinate arrays
  // Returns true if all coordinates in the polygon are valid
  const isValidPolygon = (coords: Array<[number, number]> | undefined): boolean => {
    if (!coords || !Array.isArray(coords) || coords.length < 3) return false;
    return coords.every(coord =>
      Array.isArray(coord) &&
      coord.length >= 2 &&
      isValidCoordinate(coord[1], coord[0]) // coords are [lon, lat]
    );
  };

  // Helper to filter only valid detections for export
  const getValidDetectionsForExport = (detections: Detection[]): Detection[] => {
    return detections.filter(d => {
      // Must have valid center coordinates for points
      if (!isValidCoordinate(d.centerLat, d.centerLon)) {
        console.warn(`Skipping detection ${d.id} - invalid center coordinates`);
        return false;
      }
      // If manual annotation with polygon, validate polygon too
      if (d.type === 'manual' && d.metadata?.polygonCoordinates) {
        if (!isValidPolygon(d.metadata.polygonCoordinates)) {
          console.warn(`Skipping detection ${d.id} - invalid polygon coordinates`);
          return false;
        }
      }
      return true;
    });
  };

  useEffect(() => {
    fetchProjects();
    fetchAllDetections();
  }, []);

  useEffect(() => {
    fetchAllDetections();
  }, [selectedProject, includeAI, includeManual]);

  const fetchProjects = async () => {
    try {
      const response = await fetch('/api/projects');
      if (response.ok) {
        const data = await response.json();
        setProjects(data.projects || []);
      }
    } catch (error) {
      console.error('Failed to fetch projects:', error);
    }
  };

  const fetchAllDetections = async () => {
    try {
      const allDetections: Detection[] = [];

      // Fetch AI detections if enabled (use all=true to bypass pagination for export)
      if (includeAI) {
        const aiUrl = selectedProject !== "all"
          ? `/api/detections?projectId=${selectedProject}&all=true`
          : '/api/detections?all=true';
        const aiResponse = await fetch(aiUrl);
        if (aiResponse.ok) {
          const aiData = await aiResponse.json();
          const aiDetections = aiData.map((d: any) => ({ ...d, type: 'ai' }));
          allDetections.push(...aiDetections);
        }
      }

      // Fetch manual annotations if enabled (use all=true to bypass pagination for export)
      if (includeManual) {
        const manualUrl = selectedProject !== "all"
          ? `/api/annotations/export?projectId=${selectedProject}&all=true`
          : '/api/annotations/export?all=true';
        const manualResponse = await fetch(manualUrl);
        if (manualResponse.ok) {
          const manualData = await manualResponse.json();
          allDetections.push(...manualData);
        }
      }
      
      setDetections(allDetections);
      
      // Extract unique classes
      const classes = [...new Set(allDetections.map((d: Detection) => d.className))];
      setSelectedClasses(classes);
    } catch (error) {
      console.error('Failed to fetch detections:', error);
    }
  };

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

  const exportAsCSV = () => {
    // Filter out detections with invalid coordinates
    const validDetections = getValidDetectionsForExport(filteredDetections);

    const headers = includeMetadata
      ? ['ID', 'Weed Type', 'Latitude', 'Longitude', 'Confidence', 'Type', 'Altitude (m)', 'Image File', 'Project', 'Location', 'Detection Date']
      : ['Weed Type', 'Latitude', 'Longitude'];

    const rows = validDetections.map(d => {
      const baseData = [
        escapeCSV(d.className),
        escapeCSV(d.centerLat?.toFixed(8)),
        escapeCSV(d.centerLon?.toFixed(8))
      ];

      if (includeMetadata) {
        return [
          escapeCSV(d.id),
          ...baseData,
          escapeCSV((d.confidence * 100).toFixed(1) + '%'),
          escapeCSV(d.type === 'manual' ? 'Manual' : 'AI'),
          escapeCSV(d.asset.altitude?.toFixed(1) || 'N/A'),
          escapeCSV(d.asset.fileName),
          escapeCSV(d.asset.project.name),
          escapeCSV(d.asset.project.location || 'N/A'),
          escapeCSV(new Date(d.createdAt).toLocaleDateString())
        ];
      }
      return baseData;
    });

    const csv = [headers.map(escapeCSV), ...rows].map(row => row.join(',')).join('\n');

    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `weed-detections-${new Date().toISOString().split('T')[0]}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const exportAsKML = () => {
    // Filter out detections with invalid coordinates
    const validDetections = getValidDetectionsForExport(filteredDetections);

    const kml = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Document>
    <name>${escapeXML('Weed Detections - ' + new Date().toLocaleDateString())}</name>
    <description>${escapeXML('Exported from AgriDrone Ops')}</description>
    ${[...new Set(validDetections.map(d => d.className))].map(className => {
      const color = validDetections.find(d => d.className === className)?.metadata?.color || '#FF0000';
      return `
    <Style id="${escapeXML(className)}">
      <IconStyle>
        <color>${kmlColor(color)}</color>
        <scale>1.0</scale>
        <Icon>
          <href>http://maps.google.com/mapfiles/kml/shapes/placemark_circle.png</href>
        </Icon>
      </IconStyle>
      <PolyStyle>
        <color>7F${kmlColor(color).substring(2)}</color>
        <fill>1</fill>
        <outline>1</outline>
      </PolyStyle>
      <LineStyle>
        <color>${kmlColor(color)}</color>
        <width>2</width>
      </LineStyle>
    </Style>`;
    }).join('')}
    ${validDetections.map(d => `
    <Placemark>
      <name>${escapeXML(d.className + ' (' + (d.type === 'manual' ? 'Manual' : 'AI') + ')')}</name>
      <description>
        ${escapeXML('Type: ' + (d.type === 'manual' ? 'Manual Annotation' : 'AI Detection'))}
        ${escapeXML('Confidence: ' + (d.confidence * 100).toFixed(1) + '%')}
        ${escapeXML('Image: ' + d.asset.fileName)}
        ${escapeXML('Project: ' + d.asset.project.name)}
        ${d.asset.altitude ? escapeXML('Altitude: ' + d.asset.altitude.toFixed(1) + 'm') : ''}
        ${d.metadata?.notes ? escapeXML('Notes: ' + d.metadata.notes) : ''}
      </description>
      <styleUrl>#${escapeXML(d.className)}</styleUrl>
      ${d.type === 'manual' && d.metadata?.polygonCoordinates && d.metadata.polygonCoordinates.length > 0 ? `
      <Polygon>
        <outerBoundaryIs>
          <LinearRing>
            <coordinates>
              ${d.metadata.polygonCoordinates.map(coord => `${coord[0]},${coord[1]},0`).join(' ')}
              ${d.metadata.polygonCoordinates[0][0]},${d.metadata.polygonCoordinates[0][1]},0
            </coordinates>
          </LinearRing>
        </outerBoundaryIs>
      </Polygon>` : `
      <Point>
        <coordinates>${d.centerLon},${d.centerLat},0</coordinates>
      </Point>`}
    </Placemark>`).join('')}
  </Document>
</kml>`;

    const blob = new Blob([kml], { type: 'application/vnd.google-earth.kml+xml' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `weed-detections-${new Date().toISOString().split('T')[0]}.kml`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const kmlColor = (hexColor: string): string => {
    // Convert hex to KML color format (aabbggrr)
    const hex = hexColor.replace('#', '');
    const r = hex.substring(0, 2);
    const g = hex.substring(2, 4);
    const b = hex.substring(4, 6);
    return `ff${b}${g}${r}`;
  };

  const handleExport = async () => {
    // Use streaming for large datasets to avoid memory issues
    const isLargeDataset = filteredDetections.length > LARGE_DATASET_THRESHOLD;

    if (useStreaming || isLargeDataset) {
      await exportWithStreaming();
    } else if (exportFormat === 'csv') {
      exportAsCSV();
    } else {
      exportAsKML();
    }
  };

  const exportWithStreaming = async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({
        format: exportFormat,
        includeAI: includeAI.toString(),
        includeManual: includeManual.toString(),
      });

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
      a.download = `weed-detections-${new Date().toISOString().split("T")[0]}.${exportFormat}`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (error) {
      console.error("Streaming export failed:", error);
      alert("Export failed. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  const uniqueClasses = [...new Set(detections.map(d => d.className))];

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
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="container mx-auto px-4 py-8">
        <div className="max-w-4xl mx-auto space-y-6">
          <Card>
            <CardHeader>
              <CardTitle className="text-2xl">Export Detection Data</CardTitle>
              <CardDescription>
                Export weed detection coordinates for spray drone operations. 
                Choose your format and filter the data as needed.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
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
                  {uniqueClasses.map(className => (
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
                  ))}
                </div>
              </div>

              {/* Export Format */}
              <div className="space-y-2">
                <Label>Export Format</Label>
                <div className="grid grid-cols-2 gap-4">
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
                  className="bg-gradient-to-r from-green-500 to-blue-500 hover:from-green-600 hover:to-blue-600"
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
            </CardContent>
          </Card>
        </div>
      </main>
    </div>
  );
}