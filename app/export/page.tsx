"use client";

import { useState, useEffect } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { ArrowLeft, Download, FileText, Map, Filter, CheckCircle } from "lucide-react";
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
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    fetchProjects();
    fetchDetections();
  }, []);

  useEffect(() => {
    if (selectedProject !== "all") {
      fetchDetections(selectedProject);
    } else {
      fetchDetections();
    }
  }, [selectedProject]);

  const fetchProjects = async () => {
    try {
      const response = await fetch('/api/projects');
      if (response.ok) {
        const data = await response.json();
        setProjects(data);
      }
    } catch (error) {
      console.error('Failed to fetch projects:', error);
    }
  };

  const fetchDetections = async (projectId?: string) => {
    try {
      const url = projectId 
        ? `/api/detections?projectId=${projectId}`
        : '/api/detections';
      const response = await fetch(url);
      if (response.ok) {
        const data = await response.json();
        setDetections(data);
        
        // Extract unique classes
        const classes = [...new Set(data.map((d: Detection) => d.className))];
        setSelectedClasses(classes);
      }
    } catch (error) {
      console.error('Failed to fetch detections:', error);
    }
  };

  const filteredDetections = detections.filter(detection => {
    if (selectedClasses.length > 0 && !selectedClasses.includes(detection.className)) {
      return false;
    }
    return detection.centerLat !== null && detection.centerLon !== null;
  });

  const toggleClass = (className: string) => {
    setSelectedClasses(prev => 
      prev.includes(className) 
        ? prev.filter(c => c !== className)
        : [...prev, className]
    );
  };

  const exportAsCSV = () => {
    const headers = includeMetadata 
      ? ['ID', 'Weed Type', 'Latitude', 'Longitude', 'Confidence', 'Altitude (m)', 'Image File', 'Project', 'Location', 'Detection Date']
      : ['Weed Type', 'Latitude', 'Longitude'];
    
    const rows = filteredDetections.map(d => {
      const baseData = [
        d.className,
        d.centerLat?.toFixed(8),
        d.centerLon?.toFixed(8)
      ];
      
      if (includeMetadata) {
        return [
          d.id,
          ...baseData,
          (d.confidence * 100).toFixed(1) + '%',
          d.asset.altitude?.toFixed(1) || 'N/A',
          d.asset.fileName,
          d.asset.project.name,
          d.asset.project.location || 'N/A',
          new Date(d.createdAt).toLocaleDateString()
        ];
      }
      return baseData;
    });
    
    const csv = [headers, ...rows].map(row => row.join(',')).join('\n');
    
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `weed-detections-${new Date().toISOString().split('T')[0]}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const exportAsKML = () => {
    const kml = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Document>
    <name>Weed Detections - ${new Date().toLocaleDateString()}</name>
    <description>Exported from AgriDrone Ops</description>
    ${[...new Set(filteredDetections.map(d => d.className))].map(className => {
      const color = filteredDetections.find(d => d.className === className)?.metadata?.color || '#FF0000';
      return `
    <Style id="${className}">
      <IconStyle>
        <color>${kmlColor(color)}</color>
        <scale>1.0</scale>
        <Icon>
          <href>http://maps.google.com/mapfiles/kml/shapes/placemark_circle.png</href>
        </Icon>
      </IconStyle>
    </Style>`;
    }).join('')}
    ${filteredDetections.map(d => `
    <Placemark>
      <name>${d.className}</name>
      <description>
        Confidence: ${(d.confidence * 100).toFixed(1)}%
        Image: ${d.asset.fileName}
        Project: ${d.asset.project.name}
        ${d.asset.altitude ? `Altitude: ${d.asset.altitude.toFixed(1)}m` : ''}
      </description>
      <styleUrl>#${d.className}</styleUrl>
      <Point>
        <coordinates>${d.centerLon},${d.centerLat},0</coordinates>
      </Point>
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

  const handleExport = () => {
    if (exportFormat === 'csv') {
      exportAsCSV();
    } else {
      exportAsKML();
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
                  <p>• Format: {exportFormat.toUpperCase()}</p>
                  <p>• Weed types: {selectedClasses.join(', ') || 'None selected'}</p>
                  {includeMetadata && <p>• Metadata included</p>}
                </div>
              </div>

              {/* Export Button */}
              <div className="flex justify-end space-x-4">
                <Button
                  onClick={handleExport}
                  disabled={filteredDetections.length === 0}
                  className="bg-gradient-to-r from-green-500 to-blue-500 hover:from-green-600 hover:to-blue-600"
                >
                  <Download className="w-4 h-4 mr-2" />
                  Export {filteredDetections.length} Detections
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