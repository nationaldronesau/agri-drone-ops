"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { useParams, useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ArrowLeft, Check, ZoomIn, ZoomOut, RotateCcw, Loader2, ChevronLeft, ChevronRight, Sparkles, Images } from "lucide-react";
import Link from "next/link";
import { Filmstrip } from "@/components/annotation/Filmstrip";
import { Toolbar } from "@/components/annotation/Toolbar";
import { ClassSelector, DEFAULT_WEED_CLASSES, getClassByHotkey, getClassColor } from "@/components/annotation/ClassSelector";
import { AnnotationList } from "@/components/annotation/AnnotationList";
import { HotkeyReference } from "@/components/annotation/HotkeyReference";
import { useAnnotationHotkeys, type AnnotationMode } from "@/lib/hooks/useAnnotationHotkeys";

// SAM3 types
interface SAM3StatusResponse {
  aws: {
    configured: boolean;
    state: string;
    ready: boolean;
    gpuAvailable?: boolean;
    modelLoaded?: boolean;
  };
  roboflow: {
    configured: boolean;
    ready: boolean;
  };
  preferredBackend: 'aws' | 'roboflow' | 'none';
  funMessage?: string;
}

interface SAM3HealthResponse {
  available: boolean;
  mode: 'realtime' | 'degraded' | 'loading' | 'unavailable';
  device: 'cuda' | 'mps' | 'cpu' | 'roboflow-cloud' | 'roboflow-serverless' | 'aws-gpu' | null;
  latencyMs: number | null;
  backend?: 'aws' | 'roboflow';
  funMessage?: string;
}

interface SAM3Point {
  x: number;
  y: number;
  label: 0 | 1;
}

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
    id: string;
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

interface BoxExemplar {
  id: string;
  weedType: string;
  box: { x1: number; y1: number; x2: number; y2: number };
  assetId: string;
}

interface DrawingBox {
  startX: number;
  startY: number;
  endX: number;
  endY: number;
}

const CONFIDENCE_LEVELS = ["CERTAIN", "LIKELY", "UNCERTAIN"] as const;

export default function AnnotatePage() {
  const params = useParams();
  const router = useRouter();
  const assetId = params.assetId as string;

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const canvasContainerRef = useRef<HTMLDivElement>(null);
  const imageRef = useRef<HTMLImageElement>(null);

  const [session, setSession] = useState<AnnotationSession | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Project assets for filmstrip navigation
  const [projectAssets, setProjectAssets] = useState<Asset[]>([]);
  const [currentAssetIndex, setCurrentAssetIndex] = useState(0);
  const [annotationCounts, setAnnotationCounts] = useState<Record<string, number>>({});

  // Drawing state
  const [isDrawing, setIsDrawing] = useState(false);
  const [currentPolygon, setCurrentPolygon] = useState<DrawingPolygon>({ points: [], isComplete: false });
  const [annotations, setAnnotations] = useState<ManualAnnotation[]>([]);
  const [selectedAnnotation, setSelectedAnnotation] = useState<string | null>(null);
  const [aiSuggestions, setAiSuggestions] = useState<AiSuggestion[]>([]);
  const [showAiSuggestions] = useState(true);

  // SAM3 state
  const [annotationMode, setAnnotationMode] = useState<AnnotationMode>('sam3');
  const [sam3Health, setSam3Health] = useState<SAM3HealthResponse | null>(null);
  const [sam3Points, setSam3Points] = useState<SAM3Point[]>([]);
  const [sam3PreviewPolygon, setSam3PreviewPolygon] = useState<[number, number][] | null>(null);
  const [sam3Loading, setSam3Loading] = useState(false);
  const [, setSam3Score] = useState<number | null>(null);
  const [sam3Error, setSam3Error] = useState<string | null>(null);
  const [sam3Backend, setSam3Backend] = useState<'aws' | 'roboflow' | null>(null);

  // Box exemplar state
  const [boxExemplars, setBoxExemplars] = useState<BoxExemplar[]>([]);
  const [currentBox, setCurrentBox] = useState<DrawingBox | null>(null);
  const [isDrawingBox, setIsDrawingBox] = useState(false);

  // Annotation form state
  const [selectedClass, setSelectedClass] = useState(DEFAULT_WEED_CLASSES[0].name);
  const [confidence, setConfidence] = useState<typeof CONFIDENCE_LEVELS[number]>("LIKELY");

  // Canvas scaling and viewport
  const [scale, setScale] = useState(1);
  const [zoomLevel, setZoomLevel] = useState(1);
  const [panOffset, setPanOffset] = useState({ x: 0, y: 0 });
  const [imageLoaded, setImageLoaded] = useState(false);
  const [isPanning, setIsPanning] = useState(false);
  const [lastPanPoint, setLastPanPoint] = useState({ x: 0, y: 0 });

  // UI state
  const [showHotkeyHelp, setShowHotkeyHelp] = useState(false);

  // Batch processing state
  const [batchProcessing, setBatchProcessing] = useState(false);
  const [batchJobId, setBatchJobId] = useState<string | null>(null);

  // Load project assets for filmstrip
  useEffect(() => {
    const loadProjectAssets = async () => {
      if (!session?.asset?.project?.id) return;

      try {
        const response = await fetch(`/api/assets?projectId=${session.asset.project.id}&limit=500`);
        if (response.ok) {
          const data = await response.json();
          setProjectAssets(data.assets || []);

          // Find current asset index
          const index = (data.assets || []).findIndex((a: Asset) => a.id === assetId);
          if (index >= 0) setCurrentAssetIndex(index);

          // Load annotation counts for each asset
          const counts: Record<string, number> = {};
          for (const asset of data.assets || []) {
            try {
              const sessionsRes = await fetch(`/api/annotations/sessions?assetId=${asset.id}`);
              if (sessionsRes.ok) {
                const sessions = await sessionsRes.json();
                const total = sessions.reduce((sum: number, s: { annotations?: unknown[] }) =>
                  sum + (s.annotations?.length || 0), 0);
                counts[asset.id] = total;
              }
            } catch {
              // Ignore individual failures
            }
          }
          setAnnotationCounts(counts);
        }
      } catch (err) {
        console.error("Failed to load project assets:", err);
      }
    };

    loadProjectAssets();
  }, [session?.asset?.project?.id, assetId]);

  // Load annotation session
  useEffect(() => {
    const loadSession = async () => {
      try {
        setLoading(true);
        const getResponse = await fetch(`/api/annotations/sessions?assetId=${assetId}`);
        if (!getResponse.ok) {
          const errorData = await getResponse.json().catch(() => ({}));
          throw new Error(errorData.error || 'Failed to fetch annotation sessions');
        }

        const sessions = await getResponse.json();
        let currentSession = Array.isArray(sessions)
          ? sessions.find((s: { status: string }) => s.status === 'IN_PROGRESS')
          : null;

        if (!currentSession) {
          const postResponse = await fetch('/api/annotations/sessions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ assetId }),
          });

          if (!postResponse.ok) {
            const errorData = await postResponse.json().catch(() => ({}));
            throw new Error(errorData.error || 'Failed to create annotation session');
          }
          currentSession = await postResponse.json();
        }

        if (!currentSession || !currentSession.asset) {
          throw new Error('Invalid session data received');
        }

        setSession(currentSession);
        setAnnotations(currentSession.annotations || []);
      } catch (err) {
        console.error('Annotation session error:', err);
        setError(err instanceof Error ? err.message : 'Failed to load session');
      } finally {
        setLoading(false);
      }
    };

    if (assetId) loadSession();
  }, [assetId]);

  // Check SAM3 service status
  useEffect(() => {
    const checkSam3Status = async () => {
      try {
        const response = await fetch('/api/sam3/status');
        const status: SAM3StatusResponse = await response.json();

        const isAvailable = status.preferredBackend !== 'none';
        const device = status.aws.ready ? 'aws-gpu' : status.roboflow.ready ? 'roboflow-serverless' : null;

        setSam3Health({
          available: isAvailable,
          mode: status.aws.ready ? 'realtime' : (isAvailable ? 'degraded' : 'unavailable'),
          device,
          latencyMs: null,
          backend: status.preferredBackend === 'none' ? undefined : status.preferredBackend,
          funMessage: status.funMessage,
        });

        if (!isAvailable) {
          setAnnotationMode('manual');
          setSam3Error('No SAM3 backend configured');
        }
      } catch {
        setSam3Health({ available: false, mode: 'unavailable', device: null, latencyMs: null });
        setAnnotationMode('manual');
      }
    };

    checkSam3Status();
    const interval = setInterval(checkSam3Status, 10000);
    return () => clearInterval(interval);
  }, []);

  // Fetch AI detections
  useEffect(() => {
    const fetchAiDetections = async () => {
      if (!assetId) return;
      try {
        const response = await fetch(`/api/detections?assetId=${assetId}`);
        if (response.ok) {
          const data = await response.json();
          const mapped: AiSuggestion[] = (data || []).map((det: {
            id: string;
            className?: string;
            confidence?: number;
            boundingBox?: { x: number; y: number; width: number; height: number };
            verified?: boolean;
            rejected?: boolean;
            metadata?: { color?: string };
          }) => ({
            id: det.id,
            className: det.className || "Unknown",
            confidence: typeof det.confidence === "number" ? det.confidence : null,
            boundingBox: det.boundingBox,
            verified: Boolean(det.verified),
            rejected: Boolean(det.rejected),
            color: det.metadata?.color,
          }));
          setAiSuggestions(mapped);
        }
      } catch (err) {
        console.error("Failed to load AI detections:", err);
      }
    };
    fetchAiDetections();
  }, [assetId]);

  // SAM3 prediction
  const runSam3Prediction = useCallback(async (points: SAM3Point[]) => {
    if (!session?.asset?.id || points.length === 0) return;

    try {
      setSam3Loading(true);
      setSam3Error(null);

      const response = await fetch('/api/sam3/predict', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ assetId: session.asset.id, points }),
      });

      if (response.status === 429) {
        const retryAfter = response.headers.get('Retry-After');
        setSam3Error(`Rate limit reached. Please wait ${retryAfter || 'a moment'} and try again.`);
        return;
      }

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        setSam3Error(errorData.error || 'SAM3 prediction failed');
        return;
      }

      const result = await response.json();
      if (result.backend) setSam3Backend(result.backend);

      if (result.success && result.polygon) {
        setSam3PreviewPolygon(result.polygon);
        setSam3Score(result.score);
        setSam3Error(null);
      } else {
        setSam3PreviewPolygon(null);
        setSam3Score(null);
      }
    } catch {
      setSam3Error('Connection error. Please check your network.');
    } finally {
      setSam3Loading(false);
    }
  }, [session?.asset?.id]);

  // Clear helpers
  const clearSam3 = useCallback(() => {
    setSam3Points([]);
    setSam3PreviewPolygon(null);
    setSam3Score(null);
    setSam3Error(null);
  }, []);

  const clearBoxExemplars = useCallback(() => {
    setBoxExemplars([]);
    setCurrentBox(null);
    setIsDrawingBox(false);
  }, []);

  const cancelDrawing = useCallback(() => {
    setCurrentPolygon({ points: [], isComplete: false });
    setIsDrawing(false);
  }, []);

  // Navigation
  const navigateToAsset = useCallback((index: number) => {
    if (index >= 0 && index < projectAssets.length) {
      const asset = projectAssets[index];
      router.push(`/annotate/${asset.id}`);
    }
  }, [projectAssets, router]);

  const goToPreviousImage = useCallback(() => {
    if (currentAssetIndex > 0) navigateToAsset(currentAssetIndex - 1);
  }, [currentAssetIndex, navigateToAsset]);

  const goToNextImage = useCallback(() => {
    if (currentAssetIndex < projectAssets.length - 1) navigateToAsset(currentAssetIndex + 1);
  }, [currentAssetIndex, projectAssets.length, navigateToAsset]);

  // Mode changes
  const handleModeChange = useCallback((mode: AnnotationMode) => {
    setAnnotationMode(mode);
    if (mode !== 'sam3') clearSam3();
    if (mode !== 'box-exemplar') clearBoxExemplars();
    if (mode !== 'manual') cancelDrawing();
  }, [clearSam3, clearBoxExemplars, cancelDrawing]);

  // Class selection via hotkey
  const handleClassHotkey = useCallback((hotkeyNum: number) => {
    const weedClass = getClassByHotkey(hotkeyNum);
    if (weedClass) setSelectedClass(weedClass.name);
  }, []);

  // Accept annotation
  const acceptAnnotation = useCallback(async () => {
    if (!session) return;

    // SAM3 mode
    if (annotationMode === 'sam3' && sam3PreviewPolygon && sam3PreviewPolygon.length >= 3) {
      try {
        const response = await fetch('/api/annotations', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            sessionId: session.id,
            weedType: selectedClass,
            confidence,
            coordinates: sam3PreviewPolygon,
          }),
        });

        if (response.ok) {
          const newAnnotation = await response.json();
          setAnnotations(prev => [...prev, newAnnotation]);
          clearSam3();
        }
      } catch (err) {
        console.error('Failed to save annotation:', err);
      }
      return;
    }

    // Manual mode
    if (annotationMode === 'manual' && currentPolygon.isComplete && currentPolygon.points.length >= 3) {
      try {
        const response = await fetch('/api/annotations', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            sessionId: session.id,
            weedType: selectedClass,
            confidence,
            coordinates: currentPolygon.points,
          }),
        });

        if (response.ok) {
          const newAnnotation = await response.json();
          setAnnotations(prev => [...prev, newAnnotation]);
          cancelDrawing();
        }
      } catch (err) {
        console.error('Failed to save annotation:', err);
      }
      return;
    }

    // Box exemplar (Few-Shot) mode - save all exemplars as annotations
    if (annotationMode === 'box-exemplar' && boxExemplars.length > 0) {
      try {
        const newAnnotations = [];
        for (const exemplar of boxExemplars) {
          const { x1, y1, x2, y2 } = exemplar.box;
          // Convert bounding box to polygon coordinates (4 corners)
          const coordinates: [number, number][] = [
            [x1, y1], // top-left
            [x2, y1], // top-right
            [x2, y2], // bottom-right
            [x1, y2], // bottom-left
          ];

          const response = await fetch('/api/annotations', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              sessionId: session.id,
              weedType: exemplar.weedType,
              confidence,
              coordinates,
            }),
          });

          if (response.ok) {
            const newAnnotation = await response.json();
            newAnnotations.push(newAnnotation);
          }
        }
        if (newAnnotations.length > 0) {
          setAnnotations(prev => [...prev, ...newAnnotations]);
          clearBoxExemplars();
        }
      } catch (err) {
        console.error('Failed to save box exemplar annotations:', err);
      }
    }
  }, [session, annotationMode, sam3PreviewPolygon, currentPolygon, boxExemplars, selectedClass, confidence, clearSam3, cancelDrawing, clearBoxExemplars]);

  // Cancel current action
  const handleCancel = useCallback(() => {
    if (annotationMode === 'sam3') clearSam3();
    else if (annotationMode === 'manual') cancelDrawing();
    else if (annotationMode === 'box-exemplar') clearBoxExemplars();
    setSelectedAnnotation(null);
  }, [annotationMode, clearSam3, cancelDrawing, clearBoxExemplars]);

  // Delete annotation
  const deleteAnnotation = useCallback(async (id?: string) => {
    const targetId = id || selectedAnnotation;
    if (!targetId) return;

    try {
      const response = await fetch(`/api/annotations/${targetId}`, { method: 'DELETE' });
      if (response.ok) {
        setAnnotations(prev => prev.filter(a => a.id !== targetId));
        if (selectedAnnotation === targetId) setSelectedAnnotation(null);
      }
    } catch (err) {
      console.error('Failed to delete annotation:', err);
    }
  }, [selectedAnnotation]);

  // Verify annotation (mark as accepted)
  const verifyAnnotation = useCallback(async (id: string) => {
    try {
      const response = await fetch(`/api/annotations/${id}/verify`, { method: 'POST' });
      if (response.ok) {
        const updated = await response.json();
        setAnnotations(prev => prev.map(a => a.id === id ? { ...a, verified: true, verifiedAt: updated.verifiedAt } : a));
      }
    } catch (err) {
      console.error('Failed to verify annotation:', err);
    }
  }, []);

  // Push verified annotations to Roboflow
  const [isPushing, setIsPushing] = useState(false);
  const pushToRoboflow = useCallback(async () => {
    if (!session?.id) return;

    setIsPushing(true);
    try {
      const response = await fetch('/api/roboflow/push-session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: session.id }),
      });

      if (response.ok) {
        const result = await response.json();
        // Update local state to mark annotations as pushed
        setAnnotations(prev => prev.map(a =>
          a.verified && !a.pushedToTraining
            ? { ...a, pushedToTraining: true, pushedAt: new Date().toISOString() }
            : a
        ));
        setSam3Error(null);
        // Show success message briefly
        setSam3Error(`Successfully pushed ${result.pushed || 0} annotations to Roboflow!`);
        setTimeout(() => setSam3Error(null), 3000);
      } else {
        const error = await response.json();
        setSam3Error(error.error || 'Failed to push to Roboflow');
      }
    } catch (err) {
      console.error('Failed to push to Roboflow:', err);
      setSam3Error('Failed to push to Roboflow');
    } finally {
      setIsPushing(false);
    }
  }, [session]);

  // Undo last SAM3 point
  const handleUndo = useCallback(() => {
    if (annotationMode === 'sam3' && sam3Points.length > 0) {
      const newPoints = sam3Points.slice(0, -1);
      setSam3Points(newPoints);
      if (newPoints.length > 0) runSam3Prediction(newPoints);
      else { setSam3PreviewPolygon(null); setSam3Score(null); }
    }
  }, [annotationMode, sam3Points, runSam3Prediction]);

  // Apply exemplars to current image using SAM3 (direct, no Redis needed)
  const applyToCurrentImage = useCallback(async () => {
    if (!session?.asset?.id || boxExemplars.length === 0) return;

    setBatchProcessing(true);
    setSam3Error(null);
    try {
      // Use direct SAM3 predict endpoint with box prompts
      const response = await fetch('/api/sam3/predict', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          assetId: session.asset.id,
          boxes: boxExemplars.map(e => e.box),
          textPrompt: selectedClass,
        }),
      });

      if (response.ok) {
        const data = await response.json();

        if (data.success && data.detections && data.detections.length > 0) {
          // Save each detection as an annotation
          const newAnnotations = [];
          for (const detection of data.detections) {
            if (detection.polygon && detection.polygon.length >= 3) {
              const annotationResponse = await fetch('/api/annotations', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  sessionId: session.id,
                  weedType: selectedClass,
                  confidence: 'LIKELY',
                  coordinates: detection.polygon,
                }),
              });

              if (annotationResponse.ok) {
                const newAnnotation = await annotationResponse.json();
                newAnnotations.push(newAnnotation);
              }
            }
          }

          if (newAnnotations.length > 0) {
            setAnnotations(prev => [...prev, ...newAnnotations]);
            clearBoxExemplars();
            setSam3Error(null);
          } else {
            setSam3Error(`Found ${data.detections.length} detections but none had valid polygons`);
          }
        } else {
          setSam3Error(data.error || 'No similar objects found in image');
        }
      } else {
        const errorData = await response.json();
        setSam3Error(errorData.error || 'Failed to process image');
      }
    } catch (err) {
      console.error('Failed to apply to current image:', err);
      setSam3Error('Failed to process image');
    } finally {
      setBatchProcessing(false);
    }
  }, [session, boxExemplars, selectedClass, clearBoxExemplars]);

  // Apply exemplars to all project images (requires Redis for batch queue)
  const applyToAllImages = useCallback(async () => {
    if (!session?.asset?.project?.id || boxExemplars.length === 0) return;

    setBatchProcessing(true);
    setSam3Error(null);
    try {
      const response = await fetch('/api/sam3/batch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectId: session.asset.project.id,
          weedType: selectedClass,
          exemplars: boxExemplars.map(e => e.box),
          // No assetIds = process all images in project
          textPrompt: selectedClass,
        }),
      });

      if (response.ok) {
        const data = await response.json();
        setBatchJobId(data.batchJobId);
        // Redirect to review page
        window.location.href = `/training-hub/review/${data.batchJobId}`;
      } else {
        const errorData = await response.json();
        // Provide clearer error for Redis unavailability
        if (errorData.error?.includes('Queue service unavailable')) {
          setSam3Error('Batch processing requires Redis. Use "Apply to This Image" for single-image processing, or contact support to enable batch processing.');
        } else {
          setSam3Error(errorData.error || 'Failed to start batch processing');
        }
      }
    } catch (err) {
      console.error('Failed to apply to all images:', err);
      setSam3Error('Failed to start batch processing');
    } finally {
      setBatchProcessing(false);
    }
  }, [session, boxExemplars, selectedClass]);

  // Zoom controls
  const handleZoomIn = useCallback(() => setZoomLevel(prev => Math.min(prev * 1.2, 5)), []);
  const handleZoomOut = useCallback(() => setZoomLevel(prev => Math.max(prev / 1.2, 0.1)), []);
  const handleResetView = useCallback(() => { setZoomLevel(1); setPanOffset({ x: 0, y: 0 }); }, []);

  // Register hotkeys
  useAnnotationHotkeys({
    onNextImage: goToNextImage,
    onPrevImage: goToPreviousImage,
    onModeChange: handleModeChange,
    onClassSelect: handleClassHotkey,
    onAccept: acceptAnnotation,
    onCancel: handleCancel,
    onDelete: () => deleteAnnotation(),
    onUndo: handleUndo,
    onZoomIn: handleZoomIn,
    onZoomOut: handleZoomOut,
    onResetView: handleResetView,
    onToggleHelp: () => setShowHotkeyHelp(prev => !prev),
    disabled: loading,
  });

  // Canvas setup
  const handleImageLoad = useCallback(() => {
    const canvas = canvasRef.current;
    const image = imageRef.current;
    const container = canvasContainerRef.current;
    if (!canvas || !image || !container) return;

    const containerWidth = container.clientWidth;
    const containerHeight = container.clientHeight;

    const imageScale = Math.min(
      containerWidth / image.naturalWidth,
      containerHeight / image.naturalHeight
    );
    setScale(imageScale);

    canvas.width = image.naturalWidth * imageScale;
    canvas.height = image.naturalHeight * imageScale;

    setImageLoaded(true);
  }, []);

  // Redraw canvas
  const redrawCanvas = useCallback(() => {
    const canvas = canvasRef.current;
    const image = imageRef.current;
    if (!canvas || !image || !imageLoaded) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.save();
    ctx.translate(panOffset.x, panOffset.y);
    ctx.scale(zoomLevel, zoomLevel);
    ctx.drawImage(image, 0, 0, canvas.width, canvas.height);

    // AI suggestions
    if (showAiSuggestions) {
      aiSuggestions.filter(s => s.boundingBox && !s.rejected).forEach((suggestion) => {
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
        ctx.restore();
      });
      ctx.setLineDash([]);
    }

    // Existing annotations
    annotations.forEach((annotation) => {
      const isSelected = selectedAnnotation === annotation.id;
      const color = getClassColor(annotation.weedType);

      ctx.strokeStyle = isSelected ? '#FF0000' : color;
      ctx.fillStyle = hexToRgba(isSelected ? '#FF0000' : color, 0.2);
      ctx.lineWidth = (isSelected ? 3 : 2) / zoomLevel;

      if (annotation.coordinates.length > 2) {
        ctx.beginPath();
        const [startX, startY] = annotation.coordinates[0];
        ctx.moveTo(startX * scale, startY * scale);
        annotation.coordinates.forEach(([x, y]) => ctx.lineTo(x * scale, y * scale));
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
      }
    });

    // Current polygon (manual mode)
    if (annotationMode === 'manual' && currentPolygon.points.length > 0) {
      ctx.strokeStyle = '#0080FF';
      ctx.fillStyle = 'rgba(0, 128, 255, 0.1)';
      ctx.lineWidth = 2 / zoomLevel;

      if (currentPolygon.points.length > 2) {
        ctx.beginPath();
        const [startX, startY] = currentPolygon.points[0];
        ctx.moveTo(startX * scale, startY * scale);
        currentPolygon.points.forEach(([x, y]) => ctx.lineTo(x * scale, y * scale));
        if (currentPolygon.isComplete) ctx.closePath();
        ctx.fill();
        ctx.stroke();
      }

      currentPolygon.points.forEach(([x, y]) => {
        ctx.fillStyle = '#0080FF';
        ctx.beginPath();
        ctx.arc(x * scale, y * scale, 4 / zoomLevel, 0, 2 * Math.PI);
        ctx.fill();
      });
    }

    // SAM3 preview
    if (annotationMode === 'sam3' && sam3PreviewPolygon && sam3PreviewPolygon.length > 2) {
      ctx.save();
      ctx.setLineDash([8, 4]);
      ctx.strokeStyle = '#3B82F6';
      ctx.fillStyle = 'rgba(59, 130, 246, 0.2)';
      ctx.lineWidth = 3 / zoomLevel;

      ctx.beginPath();
      const [firstX, firstY] = sam3PreviewPolygon[0];
      ctx.moveTo(firstX * scale, firstY * scale);
      sam3PreviewPolygon.forEach(([x, y]) => ctx.lineTo(x * scale, y * scale));
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      ctx.restore();
    }

    // SAM3 points
    if (annotationMode === 'sam3' && sam3Points.length > 0) {
      sam3Points.forEach((point) => {
        const color = point.label === 1 ? '#22C55E' : '#EF4444';
        ctx.beginPath();
        ctx.fillStyle = color;
        ctx.arc(point.x * scale, point.y * scale, 8 / zoomLevel, 0, 2 * Math.PI);
        ctx.fill();
        ctx.beginPath();
        ctx.fillStyle = '#FFFFFF';
        ctx.arc(point.x * scale, point.y * scale, 3 / zoomLevel, 0, 2 * Math.PI);
        ctx.fill();
      });
    }

    // Box exemplars
    boxExemplars.forEach((exemplar, index) => {
      const { x1, y1, x2, y2 } = exemplar.box;
      ctx.save();
      ctx.strokeStyle = '#8B5CF6';
      ctx.fillStyle = 'rgba(139, 92, 246, 0.15)';
      ctx.lineWidth = 2 / zoomLevel;
      ctx.strokeRect(x1 * scale, y1 * scale, (x2 - x1) * scale, (y2 - y1) * scale);
      ctx.fillRect(x1 * scale, y1 * scale, (x2 - x1) * scale, (y2 - y1) * scale);
      ctx.fillStyle = '#7C3AED';
      ctx.font = `bold ${12 / zoomLevel}px Arial`;
      ctx.fillText(`#${index + 1}`, x1 * scale + 4 / zoomLevel, y1 * scale + 14 / zoomLevel);
      ctx.restore();
    });

    // Current box
    if (annotationMode === 'box-exemplar' && currentBox) {
      const { startX, startY, endX, endY } = currentBox;
      const x1 = Math.min(startX, endX);
      const y1 = Math.min(startY, endY);
      ctx.save();
      ctx.setLineDash([6, 3]);
      ctx.strokeStyle = '#A855F7';
      ctx.fillStyle = 'rgba(168, 85, 247, 0.2)';
      ctx.lineWidth = 2 / zoomLevel;
      ctx.strokeRect(x1 * scale, y1 * scale, Math.abs(endX - startX) * scale, Math.abs(endY - startY) * scale);
      ctx.fillRect(x1 * scale, y1 * scale, Math.abs(endX - startX) * scale, Math.abs(endY - startY) * scale);
      ctx.restore();
    }

    ctx.restore();
  }, [annotations, currentPolygon, selectedAnnotation, scale, imageLoaded, zoomLevel, panOffset, aiSuggestions, showAiSuggestions, annotationMode, sam3Points, sam3PreviewPolygon, boxExemplars, currentBox]);

  useEffect(() => { redrawCanvas(); }, [redrawCanvas]);

  // Mouse handlers
  const getImageCoords = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0 };
    const rect = canvas.getBoundingClientRect();
    const canvasX = e.clientX - rect.left;
    const canvasY = e.clientY - rect.top;
    return {
      x: (canvasX - panOffset.x) / (scale * zoomLevel),
      y: (canvasY - panOffset.y) / (scale * zoomLevel),
    };
  }, [panOffset, scale, zoomLevel]);

  const handleMouseDown = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    if (e.button === 1 || e.shiftKey) {
      e.preventDefault();
      setIsPanning(true);
      const rect = e.currentTarget.getBoundingClientRect();
      setLastPanPoint({ x: e.clientX - rect.left, y: e.clientY - rect.top });
      return;
    }

    if (annotationMode === 'box-exemplar' && e.button === 0) {
      const { x, y } = getImageCoords(e);
      setCurrentBox({ startX: x, startY: y, endX: x, endY: y });
      setIsDrawingBox(true);
    }
  }, [annotationMode, getImageCoords]);

  const handleMouseMove = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    if (isPanning) {
      const rect = e.currentTarget.getBoundingClientRect();
      const currentX = e.clientX - rect.left;
      const currentY = e.clientY - rect.top;
      setPanOffset(prev => ({
        x: prev.x + (currentX - lastPanPoint.x),
        y: prev.y + (currentY - lastPanPoint.y),
      }));
      setLastPanPoint({ x: currentX, y: currentY });
      return;
    }

    if (isDrawingBox && annotationMode === 'box-exemplar') {
      const { x, y } = getImageCoords(e);
      setCurrentBox(prev => prev ? { ...prev, endX: x, endY: y } : null);
    }
  }, [isPanning, lastPanPoint, isDrawingBox, annotationMode, getImageCoords]);

  const handleMouseUp = useCallback(() => {
    if (isPanning) { setIsPanning(false); return; }

    if (isDrawingBox && annotationMode === 'box-exemplar' && currentBox && session?.asset?.id) {
      const { startX, startY, endX, endY } = currentBox;
      const x1 = Math.min(startX, endX);
      const y1 = Math.min(startY, endY);
      const x2 = Math.max(startX, endX);
      const y2 = Math.max(startY, endY);

      if (Math.abs(x2 - x1) >= 10 && Math.abs(y2 - y1) >= 10) {
        setBoxExemplars(prev => [...prev, {
          id: `exemplar-${Date.now()}`,
          weedType: selectedClass,
          box: { x1, y1, x2, y2 },
          assetId: session.asset.id,
        }]);
      }
      setCurrentBox(null);
      setIsDrawingBox(false);
    }
  }, [isPanning, isDrawingBox, annotationMode, currentBox, session?.asset?.id, selectedClass]);

  const handleCanvasClick = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    if (isPanning || e.shiftKey) return;
    const { x, y } = getImageCoords(e);

    if (annotationMode === 'sam3') {
      const newPoint: SAM3Point = { x: Math.round(x), y: Math.round(y), label: 1 };
      const newPoints = [...sam3Points, newPoint];
      setSam3Points(newPoints);
      runSam3Prediction(newPoints);
      return;
    }

    if (annotationMode === 'manual') {
      if (currentPolygon.isComplete) return;

      if (currentPolygon.points.length > 2) {
        const [firstX, firstY] = currentPolygon.points[0];
        const distance = Math.sqrt((x - firstX) ** 2 + (y - firstY) ** 2);
        if (distance < 10 / (scale * zoomLevel)) {
          setCurrentPolygon(prev => ({ ...prev, isComplete: true }));
          return;
        }
      }

      setCurrentPolygon(prev => ({ ...prev, points: [...prev.points, [x, y]] }));
      if (!isDrawing) setIsDrawing(true);
    }
  }, [isPanning, getImageCoords, annotationMode, sam3Points, runSam3Prediction, currentPolygon, scale, zoomLevel, isDrawing]);

  const handleCanvasContextMenu = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    if (annotationMode !== 'sam3' || isPanning) return;
    const { x, y } = getImageCoords(e);
    const newPoint: SAM3Point = { x: Math.round(x), y: Math.round(y), label: 0 };
    const newPoints = [...sam3Points, newPoint];
    setSam3Points(newPoints);
    runSam3Prediction(newPoints);
  }, [annotationMode, isPanning, getImageCoords, sam3Points, runSam3Prediction]);

  // Complete session
  const completeSession = async () => {
    if (!session) return;
    try {
      await fetch(`/api/annotations/sessions/${session.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'COMPLETED' }),
      });
      router.push('/images');
    } catch (err) {
      console.error('Failed to complete session:', err);
    }
  };

  // Determine action states
  const canAccept = (annotationMode === 'sam3' && sam3PreviewPolygon && sam3PreviewPolygon.length >= 3) ||
    (annotationMode === 'manual' && currentPolygon.isComplete && currentPolygon.points.length >= 3) ||
    (annotationMode === 'box-exemplar' && boxExemplars.length > 0);
  const canUndo = annotationMode === 'sam3' && sam3Points.length > 0;
  const canDelete = !!selectedAnnotation;

  if (loading) {
    return (
      <div className="h-screen flex items-center justify-center bg-gray-100">
        <div className="text-center">
          <Loader2 className="h-8 w-8 animate-spin mx-auto mb-2 text-blue-500" />
          <p className="text-gray-600">Loading annotation session...</p>
        </div>
      </div>
    );
  }

  if (error || !session) {
    return (
      <div className="h-screen flex items-center justify-center bg-gray-100">
        <div className="bg-white p-6 rounded-lg shadow-lg max-w-md text-center">
          <p className="text-red-600 mb-4">{error || 'Session not found'}</p>
          <Link href="/images">
            <Button>Return to Images</Button>
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="h-screen flex flex-col bg-gray-100 overflow-hidden">
      {/* Compact Header */}
      <header className="h-12 bg-white border-b border-gray-200 flex items-center justify-between px-4 flex-shrink-0">
        <div className="flex items-center gap-3">
          <Link href="/images">
            <Button variant="ghost" size="sm" className="h-8 px-2">
              <ArrowLeft className="w-4 h-4" />
            </Button>
          </Link>
          <div className="flex items-center gap-2">
            <span className="font-medium text-sm truncate max-w-[200px]">{session.asset.fileName}</span>
            <Badge variant="outline" className="text-xs">
              {currentAssetIndex + 1} / {projectAssets.length || 1}
            </Badge>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {/* SAM3 Status */}
          {sam3Health && (
            <Badge variant={sam3Health.available ? "default" : "secondary"} className="text-xs">
              {sam3Health.available ? (sam3Backend === 'aws' ? 'SAM3 AWS' : 'SAM3') : 'SAM3 Unavailable'}
            </Badge>
          )}

          <Button
            size="sm"
            onClick={completeSession}
            className="h-8 bg-gradient-to-r from-green-500 to-blue-500 hover:from-green-600 hover:to-blue-600"
          >
            <Check className="w-4 h-4 mr-1" />
            Done
          </Button>
        </div>
      </header>

      {/* Filmstrip */}
      {projectAssets.length > 1 && (
        <Filmstrip
          assets={projectAssets}
          currentIndex={currentAssetIndex}
          onSelect={navigateToAsset}
          annotationCounts={annotationCounts}
        />
      )}

      {/* Main Content */}
      <div className="flex-1 flex overflow-hidden">
        {/* Canvas Area - Takes most of the space */}
        <div className="flex-1 flex flex-col min-w-0">
          {/* Canvas Container */}
          <div
            ref={canvasContainerRef}
            className="flex-1 relative flex items-center justify-center bg-gray-800 overflow-hidden"
          >
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
              onContextMenu={handleCanvasContextMenu}
              onMouseDown={handleMouseDown}
              onMouseMove={handleMouseMove}
              onMouseUp={handleMouseUp}
              onMouseLeave={handleMouseUp}
              className={`max-w-full max-h-full ${isPanning ? 'cursor-grabbing' : 'cursor-crosshair'}`}
              style={{ display: imageLoaded ? 'block' : 'none' }}
            />
            {!imageLoaded && (
              <div className="text-white text-center">
                <Loader2 className="h-8 w-8 animate-spin mx-auto mb-2" />
                <p className="text-sm">Loading image...</p>
              </div>
            )}

            {/* SAM3 Loading Overlay */}
            {sam3Loading && (
              <div className="absolute inset-0 bg-black/20 flex items-center justify-center">
                <div className="bg-white rounded-lg px-4 py-2 flex items-center gap-2 shadow-lg">
                  <Loader2 className="h-4 w-4 animate-spin text-blue-500" />
                  <span className="text-sm">Processing...</span>
                </div>
              </div>
            )}
          </div>

          {/* Footer Bar */}
          <div className="h-12 bg-white border-t border-gray-200 flex items-center justify-between px-4 flex-shrink-0">
            {/* Zoom Controls */}
            <div className="flex items-center gap-2">
              <Button variant="ghost" size="sm" onClick={handleZoomOut} className="h-8 w-8 p-0">
                <ZoomOut className="h-4 w-4" />
              </Button>
              <span className="text-xs text-gray-500 w-12 text-center">{Math.round(zoomLevel * 100)}%</span>
              <Button variant="ghost" size="sm" onClick={handleZoomIn} className="h-8 w-8 p-0">
                <ZoomIn className="h-4 w-4" />
              </Button>
              <Button variant="ghost" size="sm" onClick={handleResetView} className="h-8 px-2">
                <RotateCcw className="h-4 w-4 mr-1" />
                <span className="text-xs">Fit</span>
              </Button>
            </div>

            {/* Navigation */}
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={goToPreviousImage}
                disabled={currentAssetIndex === 0}
                className="h-8"
              >
                <ChevronLeft className="h-4 w-4 mr-1" />
                Prev
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={goToNextImage}
                disabled={currentAssetIndex >= projectAssets.length - 1}
                className="h-8"
              >
                Next
                <ChevronRight className="h-4 w-4 ml-1" />
              </Button>
            </div>
          </div>
        </div>

        {/* Right Sidebar - Compact Tools */}
        <div className="w-52 bg-white border-l border-gray-200 p-3 overflow-y-auto flex-shrink-0">
          {/* Toolbar */}
          <Toolbar
            mode={annotationMode}
            onModeChange={handleModeChange}
            sam3Available={sam3Health?.available}
            sam3Loading={sam3Loading}
            onUndo={handleUndo}
            onDelete={() => deleteAnnotation()}
            onAccept={acceptAnnotation}
            onShowHelp={() => setShowHotkeyHelp(true)}
            canUndo={canUndo}
            canDelete={canDelete}
            canAccept={canAccept}
          />

          {/* Class Selector */}
          <ClassSelector
            selectedClass={selectedClass}
            onClassSelect={setSelectedClass}
            className="mt-3"
          />

          {/* Confidence */}
          <div className="mt-3 bg-gray-100 rounded-lg p-2">
            <div className="text-xs font-medium text-gray-500 px-2 pb-1">Confidence</div>
            <div className="flex gap-1">
              {CONFIDENCE_LEVELS.map((level) => (
                <button
                  key={level}
                  onClick={() => setConfidence(level)}
                  className={`flex-1 text-xs py-1.5 rounded transition-colors ${
                    confidence === level
                      ? 'bg-blue-500 text-white'
                      : 'bg-white hover:bg-gray-50 text-gray-600'
                  }`}
                >
                  {level.slice(0, 1)}
                </button>
              ))}
            </div>
          </div>

          {/* Annotation List */}
          <AnnotationList
            annotations={annotations}
            selectedId={selectedAnnotation}
            onSelect={setSelectedAnnotation}
            onDelete={deleteAnnotation}
            onVerify={verifyAnnotation}
            onPushToRoboflow={pushToRoboflow}
            isPushing={isPushing}
            className="mt-3"
          />

          {/* Few-Shot Batch Actions */}
          {annotationMode === 'box-exemplar' && boxExemplars.length > 0 && (
            <div className="mt-3 bg-gradient-to-r from-purple-50 to-blue-50 border border-purple-200 rounded-lg p-3">
              <div className="text-xs font-medium text-purple-700 mb-2">
                {boxExemplars.length} exemplar{boxExemplars.length !== 1 ? 's' : ''} drawn
              </div>
              <div className="space-y-2">
                <Button
                  onClick={applyToCurrentImage}
                  disabled={batchProcessing}
                  size="sm"
                  className="w-full bg-purple-500 hover:bg-purple-600 text-white text-xs h-8"
                >
                  {batchProcessing ? (
                    <Loader2 className="w-3 h-3 mr-1 animate-spin" />
                  ) : (
                    <Sparkles className="w-3 h-3 mr-1" />
                  )}
                  Apply to This Image
                </Button>
                <Button
                  onClick={applyToAllImages}
                  disabled={batchProcessing}
                  size="sm"
                  variant="outline"
                  className="w-full border-purple-300 text-purple-700 hover:bg-purple-50 text-xs h-8"
                >
                  {batchProcessing ? (
                    <Loader2 className="w-3 h-3 mr-1 animate-spin" />
                  ) : (
                    <Images className="w-3 h-3 mr-1" />
                  )}
                  Apply to All {projectAssets.length} Images
                </Button>
              </div>
              <p className="text-[10px] text-purple-600 mt-2">
                SAM3 will find similar objects in your images
              </p>
            </div>
          )}

          {/* SAM3 Error */}
          {sam3Error && (
            <div className="mt-3 p-2 bg-amber-50 border border-amber-200 rounded-lg">
              <p className="text-xs text-amber-800">{sam3Error}</p>
            </div>
          )}
        </div>
      </div>

      {/* Hotkey Reference Modal */}
      <HotkeyReference
        open={showHotkeyHelp}
        onClose={() => setShowHotkeyHelp(false)}
      />
    </div>
  );
}
