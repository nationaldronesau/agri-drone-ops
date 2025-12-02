"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { useParams, useRouter } from "next/navigation";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ArrowLeft, Save, Trash2, Check, X, ZoomIn, ZoomOut, RotateCcw } from "lucide-react";
import Link from "next/link";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";

function hexToRgba(hex: string, alpha: number): string {
  const normalized = hex.replace("#", "");
  if (normalized.length !== 6) return `rgba(14,165,233,${alpha})`;
  const r = parseInt(normalized.slice(0, 2), 16);
  const g = parseInt(normalized.slice(2, 4), 16);
  const b = parseInt(normalized.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

interface Asset {
  id: string;
  fileName: string;
  storageUrl: string;
  imageWidth: number;
  imageHeight: number;
  gpsLatitude: number;
  gpsLongitude: number;
  project: {
    name: string;
    location: string;
  };
}

interface AnnotationSession {
  id: string;
  status: string;
  asset: Asset;
  annotations: ManualAnnotation[];
}

interface ManualAnnotation {
  id: string;
  weedType: string;
  confidence: string;
  coordinates: [number, number][];
  notes?: string;
  verified: boolean;
  pushedToTraining?: boolean;
  pushedAt?: string | null;
  roboflowImageId?: string | null;
}

interface AiSuggestion {
  id: string;
  className: string;
  confidence: number | null;
  boundingBox?: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  verified: boolean;
  rejected: boolean;
  color?: string;
}

interface DrawingPolygon {
  points: [number, number][];
  isComplete: boolean;
}

const WEED_TYPES = [
  "Unknown Weed",
  "Suspected Lantana",
  "Suspected Wattle", 
  "Suspected Bellyache Bush",
  "Suspected Calitropis",
  "Suspected Pine Sapling",
  "Custom Weed Type"
];

const CONFIDENCE_LEVELS = [
  { value: "CERTAIN", label: "Certain" },
  { value: "LIKELY", label: "Likely" },
  { value: "UNCERTAIN", label: "Uncertain" }
];

export default function AnnotatePage() {
  const params = useParams();
  const router = useRouter();
  const assetId = params.assetId as string;
  
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const imageRef = useRef<HTMLImageElement>(null);
  
  const [session, setSession] = useState<AnnotationSession | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  
  // Drawing state
  const [isDrawing, setIsDrawing] = useState(false);
  const [currentPolygon, setCurrentPolygon] = useState<DrawingPolygon>({ points: [], isComplete: false });
  const [annotations, setAnnotations] = useState<ManualAnnotation[]>([]);
  const [selectedAnnotation, setSelectedAnnotation] = useState<string | null>(null);
  const [pushingId, setPushingId] = useState<string | null>(null);
  const [pushError, setPushError] = useState<string | null>(null);
  const [aiSuggestions, setAiSuggestions] = useState<AiSuggestion[]>([]);
  const [showAiSuggestions, setShowAiSuggestions] = useState(true);
  const [aiLoading, setAiLoading] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);
  const [bulkAction, setBulkAction] = useState<"accept" | "reject" | null>(null);
  
  // Annotation form state
  const [weedType, setWeedType] = useState(WEED_TYPES[0]);
  const [confidence, setConfidence] = useState("LIKELY");
  const [notes, setNotes] = useState("");
  
  // Canvas scaling and viewport
  const [scale, setScale] = useState(1);
  const [zoomLevel, setZoomLevel] = useState(1);
  const [panOffset, setPanOffset] = useState({ x: 0, y: 0 });
  const [imageLoaded, setImageLoaded] = useState(false);
  const [isPanning, setIsPanning] = useState(false);
  const [lastPanPoint, setLastPanPoint] = useState({ x: 0, y: 0 });

  // Load annotation session
  useEffect(() => {
    const loadSession = async () => {
      try {
        setLoading(true);
        
        // Try to get existing session
        let response = await fetch(`/api/annotations/sessions?assetId=${assetId}`);
        let sessions = await response.json();
        
        let currentSession = sessions.find((s: any) => s.status === 'IN_PROGRESS');
        
        // Create new session if none exists
        if (!currentSession) {
          response = await fetch('/api/annotations/sessions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ assetId }),
          });
          currentSession = await response.json();
        }
        
        if (!response.ok) {
          throw new Error('Failed to load annotation session');
        }
        
        setSession(currentSession);
        setAnnotations(currentSession.annotations || []);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load session');
      } finally {
        setLoading(false);
      }
    };
    
    if (assetId) {
      loadSession();
    }
  }, [assetId]);

  const fetchAiDetections = useCallback(async () => {
    if (!assetId) return;
    try {
      setAiLoading(true);
      setAiError(null);
      const response = await fetch(`/api/detections?assetId=${assetId}`);
      if (!response.ok) {
        throw new Error("Failed to load AI detections");
      }
      const data = await response.json();
      const mapped: AiSuggestion[] = (data || []).map((det: any) => ({
        id: det.id,
        className: det.className || "Unknown",
        confidence: typeof det.confidence === "number" ? det.confidence : null,
        boundingBox: det.boundingBox || det.bounding_box || undefined,
        verified: Boolean(det.verified),
        rejected: Boolean(det.rejected),
        color: det.metadata?.color,
      }));
      setAiSuggestions(mapped);
    } catch (err) {
      setAiError(err instanceof Error ? err.message : "Failed to load AI detections");
    } finally {
      setAiLoading(false);
    }
  }, [assetId]);

  useEffect(() => {
    fetchAiDetections();
  }, [fetchAiDetections]);

  // Setup canvas when image loads
  const handleImageLoad = useCallback(() => {
    const canvas = canvasRef.current;
    const image = imageRef.current;
    if (!canvas || !image) return;
    
    const containerWidth = canvas.parentElement?.clientWidth || 800;
    const maxWidth = Math.min(containerWidth - 40, 1200);
    
    const imageScale = Math.min(maxWidth / image.naturalWidth, 600 / image.naturalHeight);
    setScale(imageScale);
    
    canvas.width = image.naturalWidth * imageScale;
    canvas.height = image.naturalHeight * imageScale;
    
    setImageLoaded(true);
    redrawCanvas();
  }, []);

  // Redraw canvas with annotations
  const redrawCanvas = useCallback(() => {
    const canvas = canvasRef.current;
    const image = imageRef.current;
    if (!canvas || !image || !imageLoaded) return;
    
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    
    // Clear canvas
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    
    // Save context for transformations
    ctx.save();
    
    // Apply pan and zoom transformations
    ctx.translate(panOffset.x, panOffset.y);
    ctx.scale(zoomLevel, zoomLevel);
    
    // Draw the background image first - scale the image draw to match zoom
    ctx.drawImage(image, 0, 0, canvas.width, canvas.height);

    // Draw AI suggestions as dashed boxes
    if (showAiSuggestions) {
      aiSuggestions
        .filter(s => s.boundingBox && !s.rejected)
        .forEach((suggestion) => {
          const color = suggestion.color || '#0ea5e9';
          const bbox = suggestion.boundingBox!;
          const startX = (bbox.x - bbox.width / 2) * scale;
          const startY = (bbox.y - bbox.height / 2) * scale;
          const boxWidth = bbox.width * scale;
          const boxHeight = bbox.height * scale;

          ctx.save();
          ctx.setLineDash([6, 4]);
          ctx.lineWidth = 2 / zoomLevel;
          ctx.strokeStyle = color;
          ctx.fillStyle = hexToRgba(color, suggestion.verified ? 0.25 : 0.12);
          ctx.strokeRect(startX, startY, boxWidth, boxHeight);
          ctx.fillRect(startX, startY, boxWidth, boxHeight);
          ctx.font = `${12 / zoomLevel}px Arial`;
          ctx.fillStyle = '#0f172a';
          const label = `${suggestion.className} ${suggestion.confidence !== null ? `(${Math.round(suggestion.confidence * 100)}%)` : ''}`;
          ctx.fillText(label.trim(), startX + 4 / zoomLevel, startY + 14 / zoomLevel);
          ctx.restore();
        });
      ctx.setLineDash([]);
    }
    
    // Draw existing annotations
    annotations.forEach((annotation, index) => {
      const isSelected = selectedAnnotation === annotation.id;
      
      ctx.strokeStyle = isSelected ? '#FF0000' : '#00FF00';
      ctx.fillStyle = isSelected ? 'rgba(255, 0, 0, 0.1)' : 'rgba(0, 255, 0, 0.1)';
      ctx.lineWidth = (isSelected ? 3 : 2) / zoomLevel; // Adjust line width for zoom
      
      if (annotation.coordinates.length > 2) {
        ctx.beginPath();
        const [startX, startY] = annotation.coordinates[0];
        ctx.moveTo(startX * scale, startY * scale);
        
        annotation.coordinates.forEach(([x, y]) => {
          ctx.lineTo(x * scale, y * scale);
        });
        
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
        
        // Draw label
        const centerX = annotation.coordinates.reduce((sum, [x]) => sum + x, 0) / annotation.coordinates.length;
        const centerY = annotation.coordinates.reduce((sum, [, y]) => sum + y, 0) / annotation.coordinates.length;
        
        ctx.fillStyle = '#000';
        ctx.font = `${12 / zoomLevel}px Arial`; // Adjust font size for zoom
        ctx.fillText(
          `${annotation.weedType} (${annotation.confidence})`,
          centerX * scale,
          centerY * scale
        );
      }
    });
    
    // Draw current polygon being drawn
    if (currentPolygon.points.length > 0) {
      ctx.strokeStyle = '#0080FF';
      ctx.fillStyle = 'rgba(0, 128, 255, 0.1)';
      ctx.lineWidth = 2 / zoomLevel; // Adjust line width for zoom
      
      if (currentPolygon.points.length > 2) {
        ctx.beginPath();
        const [startX, startY] = currentPolygon.points[0];
        ctx.moveTo(startX * scale, startY * scale);
        
        currentPolygon.points.forEach(([x, y]) => {
          ctx.lineTo(x * scale, y * scale);
        });
        
        if (currentPolygon.isComplete) {
          ctx.closePath();
          ctx.fill();
        }
        ctx.stroke();
      }
      
      // Draw points - adjust size for zoom
      currentPolygon.points.forEach(([x, y]) => {
        ctx.fillStyle = '#0080FF';
        ctx.beginPath();
        ctx.arc(x * scale, y * scale, 4 / zoomLevel, 0, 2 * Math.PI);
        ctx.fill();
      });
    }
    
    // Restore context
    ctx.restore();
  }, [annotations, currentPolygon, selectedAnnotation, scale, imageLoaded, zoomLevel, panOffset, aiSuggestions, showAiSuggestions]);

  // Redraw when dependencies change
  useEffect(() => {
    redrawCanvas();
  }, [redrawCanvas]);

  // Zoom functions
  const handleZoomIn = () => {
    setZoomLevel(prev => {
      const newZoom = Math.min(prev * 1.2, 5);
      console.log('Zoom in:', prev, '->', newZoom);
      return newZoom;
    });
  };

  const handleZoomOut = () => {
    setZoomLevel(prev => {
      const newZoom = Math.max(prev / 1.2, 0.1);
      console.log('Zoom out:', prev, '->', newZoom);
      return newZoom;
    });
  };

  const handleResetView = () => {
    setZoomLevel(1);
    setPanOffset({ x: 0, y: 0 });
  };

  // Pan functions
  const handleMouseDown = useCallback((event: React.MouseEvent<HTMLCanvasElement>) => {
    if (event.button === 1 || event.shiftKey) { // Middle mouse or Shift+click for panning
      event.preventDefault();
      setIsPanning(true);
      const rect = event.currentTarget.getBoundingClientRect();
      setLastPanPoint({
        x: event.clientX - rect.left,
        y: event.clientY - rect.top,
      });
    }
  }, []);

  const handleMouseMove = useCallback((event: React.MouseEvent<HTMLCanvasElement>) => {
    if (isPanning) {
      const rect = event.currentTarget.getBoundingClientRect();
      const currentX = event.clientX - rect.left;
      const currentY = event.clientY - rect.top;
      
      setPanOffset(prev => ({
        x: prev.x + (currentX - lastPanPoint.x),
        y: prev.y + (currentY - lastPanPoint.y),
      }));
      
      setLastPanPoint({ x: currentX, y: currentY });
    }
  }, [isPanning, lastPanPoint]);

  const handleMouseUp = useCallback(() => {
    setIsPanning(false);
  }, []);

  // Handle canvas clicks
  const handleCanvasClick = useCallback((event: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas || currentPolygon.isComplete || isPanning) return;
    
    // Don't add points if shift is held (panning mode)
    if (event.shiftKey) return;
    
    const rect = canvas.getBoundingClientRect();
    
    // Get click position relative to canvas
    const canvasX = event.clientX - rect.left;
    const canvasY = event.clientY - rect.top;
    
    // Convert to image coordinates accounting for zoom and pan
    // Apply the inverse transformation that we apply in drawing
    const x = (canvasX - panOffset.x) / (scale * zoomLevel);
    const y = (canvasY - panOffset.y) / (scale * zoomLevel);
    
    // Check if clicking close to first point to close polygon
    if (currentPolygon.points.length > 2) {
      const [firstX, firstY] = currentPolygon.points[0];
      const distance = Math.sqrt((x - firstX) ** 2 + (y - firstY) ** 2);
      
      if (distance < 10 / (scale * zoomLevel)) {
        // Close polygon
        setCurrentPolygon(prev => ({ ...prev, isComplete: true }));
        return;
      }
    }
    
    // Add new point
    setCurrentPolygon(prev => ({
      ...prev,
      points: [...prev.points, [x, y]]
    }));
    
    if (!isDrawing) {
      setIsDrawing(true);
    }
  }, [currentPolygon.points, currentPolygon.isComplete, isDrawing, scale, zoomLevel, panOffset, isPanning]);

  // Save annotation
  const saveAnnotation = async () => {
    if (!session || !currentPolygon.isComplete || currentPolygon.points.length < 3) {
      alert('Please complete drawing a polygon first');
      return;
    }
    
    try {
      const response = await fetch('/api/annotations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId: session.id,
          weedType,
          confidence,
          coordinates: currentPolygon.points,
          notes: notes.trim() || undefined,
        }),
      });
      
      if (!response.ok) {
        throw new Error('Failed to save annotation');
      }
      
      const newAnnotation = await response.json();
      setAnnotations(prev => [...prev, newAnnotation]);
      
      // Reset drawing state
      setCurrentPolygon({ points: [], isComplete: false });
      setIsDrawing(false);
      setNotes("");
      setWeedType(WEED_TYPES[0]);
      setConfidence("LIKELY");
      
    } catch (err) {
      alert('Failed to save annotation: ' + (err instanceof Error ? err.message : 'Unknown error'));
    }
  };

  // Cancel current drawing
  const cancelDrawing = () => {
    setCurrentPolygon({ points: [], isComplete: false });
    setIsDrawing(false);
  };

  // Delete annotation
  const deleteAnnotation = async (id: string) => {
    if (!confirm('Are you sure you want to delete this annotation?')) return;
    
    try {
      const response = await fetch(`/api/annotations/${id}`, {
        method: 'DELETE',
      });
      
      if (!response.ok) {
        throw new Error('Failed to delete annotation');
      }
      
      setAnnotations(prev => prev.filter(a => a.id !== id));
      if (selectedAnnotation === id) {
        setSelectedAnnotation(null);
      }
    } catch (err) {
      alert('Failed to delete annotation: ' + (err instanceof Error ? err.message : 'Unknown error'));
    }
  };

  // Complete session
  const completeSession = async () => {
    if (!session) return;
    
    if (annotations.length === 0) {
      if (!confirm('No annotations have been created. Are you sure you want to complete this session?')) {
        return;
      }
    }
    
    try {
      await fetch(`/api/annotations/sessions/${session.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'COMPLETED' }),
      });
      
      alert(`Session completed! ${annotations.length} annotations saved.`);
      router.push('/images');
    } catch (err) {
      alert('Failed to complete session: ' + (err instanceof Error ? err.message : 'Unknown error'));
    }
  };

  const pushToTraining = async (annotationId: string) => {
    try {
      setPushingId(annotationId);
      setPushError(null);

      const response = await fetch("/api/roboflow/training/upload", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ annotationId }),
      });

      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body?.error || "Failed to push annotation to training");
      }

      setAnnotations((prev) =>
        prev.map((annotation) =>
          annotation.id === annotationId
            ? {
                ...annotation,
                pushedToTraining: true,
                pushedAt: new Date().toISOString(),
              }
            : annotation,
        ),
      );
    } catch (err) {
      setPushError(
        err instanceof Error ? err.message : "Failed to push to training",
      );
    } finally {
      setPushingId(null);
    }
  };

  const acceptDetection = async (detectionId: string) => {
    const detection = aiSuggestions.find((d) => d.id === detectionId);
    if (!detection) return;
    try {
      await fetch(`/api/detections/${detectionId}/verify`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          verified: true,
          className: detection.className,
          boundingBox: detection.boundingBox,
        }),
      });
      setAiSuggestions((prev) =>
        prev.map((item) =>
          item.id === detectionId
            ? { ...item, verified: true, rejected: false }
            : item,
        ),
      );
    } catch (error) {
      setAiError(
        error instanceof Error ? error.message : "Failed to accept detection",
      );
    }
  };

  const rejectDetection = async (detectionId: string) => {
    try {
      await fetch(`/api/detections/${detectionId}/reject`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      setAiSuggestions((prev) =>
        prev.map((item) =>
          item.id === detectionId ? { ...item, rejected: true } : item,
        ),
      );
    } catch (error) {
      setAiError(
        error instanceof Error ? error.message : "Failed to reject detection",
      );
    }
  };

  const acceptAllDetections = async () => {
    if (aiSuggestions.length === 0) return;
    setBulkAction("accept");
    try {
      await Promise.all(
        aiSuggestions
          .filter((d) => !d.rejected)
          .map((d) =>
            fetch(`/api/detections/${d.id}/verify`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                verified: true,
                className: d.className,
                boundingBox: d.boundingBox,
              }),
            }),
          ),
      );
      setAiSuggestions((prev) =>
        prev.map((item) =>
          item.rejected ? item : { ...item, verified: true, rejected: false },
        ),
      );
    } catch (error) {
      setAiError(
        error instanceof Error ? error.message : "Failed to accept all",
      );
    } finally {
      setBulkAction(null);
    }
  };

  const rejectAllDetections = async () => {
    if (aiSuggestions.length === 0) return;
    setBulkAction("reject");
    try {
      await Promise.all(
        aiSuggestions
          .filter((d) => !d.rejected)
          .map((d) =>
            fetch(`/api/detections/${d.id}/reject`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
            }),
          ),
      );
      setAiSuggestions((prev) =>
        prev.map((item) => ({ ...item, rejected: true, verified: false })),
      );
    } catch (error) {
      setAiError(
        error instanceof Error ? error.message : "Failed to reject all",
      );
    } finally {
      setBulkAction(null);
    }
  };

  const updateSuggestionClass = (detectionId: string, newClass: string) => {
    setAiSuggestions((prev) =>
      prev.map((item) =>
        item.id === detectionId ? { ...item, className: newClass } : item,
      ),
    );
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-green-500 mx-auto mb-4"></div>
          <p>Loading annotation session...</p>
        </div>
      </div>
    );
  }

  if (error || !session) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <Card className="w-full max-w-md">
          <CardHeader>
            <CardTitle className="text-red-600">Error</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="mb-4">{error || 'Session not found'}</p>
            <Link href="/images">
              <Button>Return to Images</Button>
            </Link>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <header className="bg-white border-b border-gray-200">
        <div className="container mx-auto px-4 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center space-x-4">
              <Link href="/images">
                <Button variant="ghost" size="sm">
                  <ArrowLeft className="w-4 h-4 mr-2" />
                  Back to Images
                </Button>
              </Link>
              <div className="flex items-center space-x-2">
                <div className="w-8 h-8 bg-gradient-to-r from-green-500 to-blue-500 rounded-lg"></div>
                <span className="text-xl font-bold bg-gradient-to-r from-green-600 to-blue-600 bg-clip-text text-transparent">
                  AgriDrone Ops
                </span>
              </div>
            </div>
            <div className="flex space-x-2">
              <Button
                onClick={completeSession}
                className="bg-gradient-to-r from-green-500 to-blue-500 hover:from-green-600 hover:to-blue-600"
              >
                <Check className="w-4 h-4 mr-2" />
                Complete Session
              </Button>
            </div>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="container mx-auto px-4 py-8">
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Image Canvas */}
          <div className="lg:col-span-2">
            <Card>
              <CardHeader>
                <CardTitle>Manual Annotation - {session.asset.fileName}</CardTitle>
                <CardDescription>
                  Click to draw polygon points. Close the polygon by clicking near the first point.
                </CardDescription>
              </CardHeader>
              <CardContent>
                {/* Zoom and Pan Controls */}
                <div className="flex items-center justify-between mb-4 p-3 bg-gray-50 rounded-lg border">
                  <div className="flex items-center space-x-2">
                    <span className="text-sm font-medium text-gray-700">View Controls:</span>
                    <Button size="sm" variant="outline" onClick={handleZoomIn} title="Zoom In">
                      <ZoomIn className="w-4 h-4" />
                    </Button>
                    <Button size="sm" variant="outline" onClick={handleZoomOut} title="Zoom Out">
                      <ZoomOut className="w-4 h-4" />
                    </Button>
                    <Button size="sm" variant="outline" onClick={handleResetView} title="Reset View">
                      <RotateCcw className="w-4 h-4" />
                    </Button>
                  </div>
                  <div className="text-xs text-gray-500">
                    Zoom: {Math.round(zoomLevel * 100)}% | Shift+Click to Pan
                  </div>
                </div>
                
                <div className="relative">
                  <img
                    ref={imageRef}
                    src={session.asset.storageUrl}
                    alt={session.asset.fileName}
                    onLoad={handleImageLoad}
                    onError={(e) => {
                      console.error('Image failed to load:', session.asset.storageUrl);
                      console.error('Error:', e);
                    }}
                    className="hidden"
                  />
                  <canvas
                    ref={canvasRef}
                    onClick={handleCanvasClick}
                    onMouseDown={handleMouseDown}
                    onMouseMove={handleMouseMove}
                    onMouseUp={handleMouseUp}
                    onMouseLeave={handleMouseUp}
                    className={`border border-gray-300 rounded max-w-full ${
                      isPanning ? 'cursor-grabbing' : 'cursor-crosshair'
                    }`}
                    style={{ display: imageLoaded ? 'block' : 'none' }}
                  />
                  {!imageLoaded && (
                    <div className="flex items-center justify-center h-64 bg-gray-100 rounded border border-gray-300">
                      <div className="text-center">
                        <p className="text-gray-600 mb-2">Loading image...</p>
                        <p className="text-xs text-gray-400">Image URL: {session.asset.storageUrl}</p>
                      </div>
                    </div>
                  )}
                </div>
                
                {/* Drawing Controls */}
                {isDrawing && (
                  <div className="mt-4 p-4 bg-blue-50 rounded-lg border border-blue-200">
                    <div className="flex items-center justify-between">
                      <p className="text-blue-800">
                        Drawing polygon... {currentPolygon.points.length} points
                        {currentPolygon.points.length > 2 && " (click first point to close)"}
                      </p>
                      <div className="space-x-2">
                        <Button size="sm" variant="outline" onClick={cancelDrawing}>
                          <X className="w-4 h-4 mr-1" />
                          Cancel
                        </Button>
                      </div>
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>
          </div>

          {/* Annotation Panel */}
          <div className="space-y-6">
            <Card>
              <CardHeader>
                <div className="flex items-center justify-between">
                  <div>
                    <CardTitle>AI Suggestions</CardTitle>
                    <CardDescription>
                      {aiLoading
                        ? "Loading detections..."
                        : `${aiSuggestions.filter((s) => !s.rejected).length} pending`}
                    </CardDescription>
                  </div>
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={fetchAiDetections}
                      disabled={aiLoading}
                    >
                      Refresh
                    </Button>
                    <Button
                      size="sm"
                      variant={showAiSuggestions ? "default" : "outline"}
                      onClick={() => setShowAiSuggestions((prev) => !prev)}
                    >
                      {showAiSuggestions ? "Hide" : "Show"}
                    </Button>
                  </div>
                </div>
              </CardHeader>
              <CardContent className="space-y-3">
                {aiError && (
                  <div className="rounded border border-red-200 bg-red-50 p-2 text-xs text-red-700">
                    {aiError}
                  </div>
                )}
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    className="flex-1"
                    onClick={acceptAllDetections}
                    disabled={bulkAction !== null || aiSuggestions.length === 0}
                  >
                    {bulkAction === "accept" ? "Accepting..." : "Accept All"}
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    className="flex-1"
                    onClick={rejectAllDetections}
                    disabled={bulkAction !== null || aiSuggestions.length === 0}
                  >
                    {bulkAction === "reject" ? "Rejecting..." : "Reject All"}
                  </Button>
                </div>

                {aiSuggestions.length === 0 ? (
                  <p className="text-sm text-gray-500">
                    No AI detections for this asset.
                  </p>
                ) : (
                  <div className="space-y-2">
                    {aiSuggestions.map((suggestion) => (
                      <div
                        key={suggestion.id}
                        className="rounded border border-gray-200 bg-gray-50 p-3"
                      >
                        <div className="flex items-center justify-between">
                          <div className="flex flex-col">
                            <Badge variant={suggestion.verified ? "default" : "secondary"}>
                              {suggestion.className}
                            </Badge>
                            <span className="text-xs text-gray-500">
                              {suggestion.confidence !== null
                                ? `${Math.round(suggestion.confidence * 100)}%`
                                : "No confidence"}
                            </span>
                          </div>
                          <div className="flex gap-2">
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => acceptDetection(suggestion.id)}
                              disabled={suggestion.verified || suggestion.rejected}
                            >
                              ✓ Accept
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              className="text-red-600"
                              onClick={() => rejectDetection(suggestion.id)}
                              disabled={suggestion.rejected}
                            >
                              ✗ Reject
                            </Button>
                          </div>
                        </div>
                        <div className="mt-2">
                          <Label className="text-xs">Edit class</Label>
                          <Select
                            value={suggestion.className}
                            onValueChange={(value) =>
                              updateSuggestionClass(suggestion.id, value)
                            }
                          >
                            <SelectTrigger>
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              {WEED_TYPES.map((type) => (
                                <SelectItem key={type} value={type}>
                                  {type}
                                </SelectItem>
                              ))}
                              {!WEED_TYPES.includes(suggestion.className) && (
                                <SelectItem value={suggestion.className}>
                                  {suggestion.className}
                                </SelectItem>
                              )}
                            </SelectContent>
                          </Select>
                        </div>
                        {suggestion.rejected && (
                          <p className="mt-2 text-xs text-red-600">
                            Rejected — hidden from canvas
                          </p>
                        )}
                        {suggestion.verified && !suggestion.rejected && (
                          <p className="mt-2 text-xs text-green-700">
                            Accepted — ready for training push
                          </p>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
            {/* Current Annotation Form */}
            <Card>
              <CardHeader>
                <CardTitle>New Annotation</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div>
                  <Label htmlFor="weedType">Weed Type</Label>
                  <Select value={weedType} onValueChange={setWeedType}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {WEED_TYPES.map(type => (
                        <SelectItem key={type} value={type}>{type}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                
                <div>
                  <Label htmlFor="confidence">Confidence Level</Label>
                  <Select value={confidence} onValueChange={setConfidence}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {CONFIDENCE_LEVELS.map(level => (
                        <SelectItem key={level.value} value={level.value}>
                          {level.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                
                <div>
                  <Label htmlFor="notes">Notes (Optional)</Label>
                  <Textarea
                    id="notes"
                    value={notes}
                    onChange={(e) => setNotes(e.target.value)}
                    placeholder="Additional observations..."
                    rows={2}
                  />
                </div>
                
                <Button
                  onClick={saveAnnotation}
                  disabled={!currentPolygon.isComplete || currentPolygon.points.length < 3}
                  className="w-full"
                >
                  <Save className="w-4 h-4 mr-2" />
                  Save Annotation
                </Button>
              </CardContent>
            </Card>

            {/* Existing Annotations */}
            <Card>
              <CardHeader>
              <CardTitle>Annotations ({annotations.length})</CardTitle>
            </CardHeader>
            <CardContent>
              {pushError && (
                <div className="mb-3 rounded border border-red-200 bg-red-50 p-2 text-xs text-red-700">
                  {pushError}
                </div>
              )}
              {annotations.length === 0 ? (
                <p className="text-gray-500 text-center py-4">No annotations yet</p>
              ) : (
                <div className="space-y-2">
                  {annotations.map((annotation, index) => (
                      <div
                        key={annotation.id}
                        className={`p-3 rounded border cursor-pointer transition-colors ${
                          selectedAnnotation === annotation.id
                            ? 'border-red-300 bg-red-50'
                            : 'border-gray-200 hover:border-green-300 hover:bg-green-50'
                        }`}
                        onClick={() => setSelectedAnnotation(
                          selectedAnnotation === annotation.id ? null : annotation.id
                        )}
                      >
                        <div className="flex justify-between items-start">
                          <div className="flex-1">
                            <p className="font-medium text-sm">{annotation.weedType}</p>
                            <p className="text-xs text-gray-500">{annotation.confidence}</p>
                            {annotation.notes && (
                              <p className="text-xs text-gray-600 mt-1">{annotation.notes}</p>
                            )}
                            <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-gray-500">
                              <Badge variant={annotation.verified ? "default" : "outline"}>
                                {annotation.verified ? "Verified" : "Unverified"}
                              </Badge>
                              {annotation.pushedToTraining ? (
                                <Badge variant="secondary">Sent to Training</Badge>
                              ) : annotation.verified ? (
                                <Button
                                  size="sm"
                                  variant="outline"
                                  className="text-xs"
                                  disabled={pushingId === annotation.id}
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    pushToTraining(annotation.id);
                                  }}
                                >
                                  {pushingId === annotation.id ? "Pushing..." : "Push to Training"}
                                </Button>
                              ) : null}
                            </div>
                          </div>
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={(e) => {
                              e.stopPropagation();
                              deleteAnnotation(annotation.id);
                            }}
                            className="text-red-500 hover:text-red-700 hover:bg-red-50"
                          >
                            <Trash2 className="w-4 h-4" />
                          </Button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>

            {/* Session Info */}
            <Card>
              <CardHeader>
                <CardTitle>Session Info</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-2 text-sm">
                  <p><span className="font-medium">Project:</span> {session.asset.project.name}</p>
                  <p><span className="font-medium">Location:</span> {session.asset.project.location}</p>
                  <p><span className="font-medium">Image:</span> {session.asset.fileName}</p>
                  <p><span className="font-medium">Dimensions:</span> {session.asset.imageWidth} × {session.asset.imageHeight}</p>
                  {session.asset.gpsLatitude && session.asset.gpsLongitude && (
                    <p><span className="font-medium">GPS:</span> {session.asset.gpsLatitude.toFixed(6)}, {session.asset.gpsLongitude.toFixed(6)}</p>
                  )}
                </div>
              </CardContent>
            </Card>
          </div>
        </div>
      </main>
    </div>
  );
}
