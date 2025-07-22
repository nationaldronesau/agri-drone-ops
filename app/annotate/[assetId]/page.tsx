"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { useParams, useRouter } from "next/navigation";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { ArrowLeft, Save, Trash2, Undo, Check, Edit3, X } from "lucide-react";
import Link from "next/link";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";

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
  
  // Annotation form state
  const [weedType, setWeedType] = useState(WEED_TYPES[0]);
  const [confidence, setConfidence] = useState("LIKELY");
  const [notes, setNotes] = useState("");
  
  // Canvas scaling
  const [scale, setScale] = useState(1);
  const [imageLoaded, setImageLoaded] = useState(false);

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
    
    // Draw existing annotations
    annotations.forEach((annotation, index) => {
      const isSelected = selectedAnnotation === annotation.id;
      
      ctx.strokeStyle = isSelected ? '#FF0000' : '#00FF00';
      ctx.fillStyle = isSelected ? 'rgba(255, 0, 0, 0.1)' : 'rgba(0, 255, 0, 0.1)';
      ctx.lineWidth = isSelected ? 3 : 2;
      
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
        ctx.font = '12px Arial';
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
      ctx.lineWidth = 2;
      
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
      
      // Draw points
      currentPolygon.points.forEach(([x, y]) => {
        ctx.fillStyle = '#0080FF';
        ctx.beginPath();
        ctx.arc(x * scale, y * scale, 4, 0, 2 * Math.PI);
        ctx.fill();
      });
    }
  }, [annotations, currentPolygon, selectedAnnotation, scale, imageLoaded]);

  // Redraw when dependencies change
  useEffect(() => {
    redrawCanvas();
  }, [redrawCanvas]);

  // Handle canvas clicks
  const handleCanvasClick = useCallback((event: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas || currentPolygon.isComplete) return;
    
    const rect = canvas.getBoundingClientRect();
    const x = (event.clientX - rect.left) / scale;
    const y = (event.clientY - rect.top) / scale;
    
    // Check if clicking close to first point to close polygon
    if (currentPolygon.points.length > 2) {
      const [firstX, firstY] = currentPolygon.points[0];
      const distance = Math.sqrt((x - firstX) ** 2 + (y - firstY) ** 2);
      
      if (distance < 10 / scale) {
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
  }, [currentPolygon.points, currentPolygon.isComplete, isDrawing, scale]);

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
                <div className="relative">
                  <img
                    ref={imageRef}
                    src={session.asset.storageUrl}
                    alt={session.asset.fileName}
                    onLoad={handleImageLoad}
                    className="hidden"
                  />
                  <canvas
                    ref={canvasRef}
                    onClick={handleCanvasClick}
                    className="border border-gray-300 rounded cursor-crosshair max-w-full"
                    style={{ display: imageLoaded ? 'block' : 'none' }}
                  />
                  {!imageLoaded && (
                    <div className="flex items-center justify-center h-64 bg-gray-100 rounded">
                      <p>Loading image...</p>
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