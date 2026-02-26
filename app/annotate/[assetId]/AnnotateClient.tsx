"use client";

import { useState, useEffect, useMemo, useRef, useCallback } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Image from "next/image";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { ArrowLeft, Check, ZoomIn, ZoomOut, RotateCcw, Loader2, ChevronLeft, ChevronRight, Sparkles, Images, Upload } from "lucide-react";
import Link from "next/link";
import { Filmstrip } from "@/components/annotation/Filmstrip";
import { Toolbar } from "@/components/annotation/Toolbar";
import { ClassSelector, DEFAULT_WEED_CLASSES, getClassByHotkey, getClassColor } from "@/components/annotation/ClassSelector";
import { AnnotationList } from "@/components/annotation/AnnotationList";
import { HotkeyReference } from "@/components/annotation/HotkeyReference";
import { useAnnotationHotkeys, type AnnotationMode } from "@/lib/hooks/useAnnotationHotkeys";
import { useUndoRedo } from "@/lib/hooks/useUndoRedo";
import { useAnnotationEditing } from "@/lib/hooks/useAnnotationEditing";
import { useLabelAssist } from "@/lib/hooks/useLabelAssist";
import { LabelAssist } from "@/components/annotation/LabelAssist";
import { BatchProgress } from "@/components/review/BatchProgress";

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

interface SAM3ConceptStatusResponse {
  configured: boolean;
  ready: boolean;
  sam3Loaded: boolean;
  dinoLoaded: boolean;
  error?: string;
}

interface SAM3Point {
  x: number;
  y: number;
  label: 0 | 1;
}

const MAX_VISUAL_EXEMPLAR_CROPS = 10;
const MAX_VISUAL_EXEMPLAR_DIMENSION = 512;
const VISUAL_EXEMPLAR_JPEG_QUALITY = 0.85;

function hexToRgba(hex: string, alpha: number): string {
  const normalized = hex.replace("#", "");
  if (normalized.length !== 6) return `rgba(14,165,233,${alpha})`;
  const r = parseInt(normalized.slice(0, 2), 16);
  const g = parseInt(normalized.slice(2, 4), 16);
  const b = parseInt(normalized.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

// Check if a point is inside a polygon using ray casting algorithm
function isPointInPolygon(x: number, y: number, polygon: [number, number][]): boolean {
  if (polygon.length < 3) return false;

  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = polygon[i][0], yi = polygon[i][1];
    const xj = polygon[j][0], yj = polygon[j][1];

    if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) {
      inside = !inside;
    }
  }
  return inside;
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
  createdAt?: string;
  updatedAt?: string;
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
  sourceWidth?: number;
  sourceHeight?: number;
}

interface DrawingBox {
  startX: number;
  startY: number;
  endX: number;
  endY: number;
}

type ReviewSource = "manual" | "pending" | "detection";

interface HighlightOverlay {
  type: "bbox" | "polygon";
  bbox?: [number, number, number, number];
  polygon?: [number, number][];
}

interface EditContext {
  sessionId: string;
  source: ReviewSource;
  originalItemId: string;
  returnTo?: string | null;
}

const CONFIDENCE_LEVELS = ["CERTAIN", "LIKELY", "UNCERTAIN"] as const;

interface AnnotateClientProps {
  assetId: string;
}

export function AnnotateClient({ assetId }: AnnotateClientProps) {
  const router = useRouter();
  const searchParams = useSearchParams();

  const reviewSessionId = searchParams.get("reviewSessionId");
  const highlightId = searchParams.get("highlightId");
  const highlightSource = searchParams.get("source");
  const returnToParam = searchParams.get("returnTo");
  const returnTo = useMemo(() => {
    if (!returnToParam) return null;
    let decoded = returnToParam;
    try {
      decoded = decodeURIComponent(returnToParam);
    } catch {
      decoded = returnToParam;
    }
    if (!decoded.startsWith("/") || decoded.startsWith("//")) {
      return null;
    }
    return decoded;
  }, [returnToParam]);

  const fallbackHref = returnTo || "/images";
  const backLabel = returnTo?.startsWith("/review") ? "Back to Review" : "Return to Images";

  const editContext = useMemo<EditContext | null>(() => {
    if (!reviewSessionId || !highlightId) return null;
    if (highlightSource !== "manual" && highlightSource !== "pending" && highlightSource !== "detection") {
      return null;
    }
    return {
      sessionId: reviewSessionId,
      source: highlightSource,
      originalItemId: highlightId,
      returnTo,
    };
  }, [highlightId, highlightSource, reviewSessionId, returnTo]);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const canvasContainerRef = useRef<HTMLDivElement>(null);
  const imageRef = useRef<HTMLImageElement>(null);

  const [session, setSession] = useState<AnnotationSession | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reviewSessionMeta, setReviewSessionMeta] = useState<{ workflowType?: string; createdAt?: string } | null>(null);
  const [reviewSessionLoaded, setReviewSessionLoaded] = useState(true);

  // Project assets for filmstrip navigation
  const [projectAssets, setProjectAssets] = useState<Asset[]>([]);
  const [currentAssetIndex, setCurrentAssetIndex] = useState(0);
  const [annotationCounts, setAnnotationCounts] = useState<Record<string, number>>({});

  // Drawing state
  const [isDrawing, setIsDrawing] = useState(false);
  const [currentPolygon, setCurrentPolygon] = useState<DrawingPolygon>({ points: [], isComplete: false });
  const [annotations, setAnnotations] = useState<ManualAnnotation[]>([]);
  const [selectedAnnotation, setSelectedAnnotation] = useState<string | null>(null);
  const [highlightOverlay, setHighlightOverlay] = useState<HighlightOverlay | null>(null);
  const [pendingHighlightId, setPendingHighlightId] = useState<string | null>(null);
  const [aiSuggestions, setAiSuggestions] = useState<AiSuggestion[]>([]);
  const [showAiSuggestions] = useState(true);

  // SAM3 state
  const [annotationMode, setAnnotationMode] = useState<AnnotationMode>('sam3');
  const [sam3Health, setSam3Health] = useState<SAM3HealthResponse | null>(null);
  const [sam3ConceptStatus, setSam3ConceptStatus] = useState<SAM3ConceptStatusResponse | null>(null);
  const conceptWarmupTriggeredRef = useRef(false);
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
  const [useVisualCrops, setUseVisualCrops] = useState(true);

  // Annotation form state
  const [selectedClass, setSelectedClass] = useState(DEFAULT_WEED_CLASSES[0].name);
  const [confidence, setConfidence] = useState<typeof CONFIDENCE_LEVELS[number]>("LIKELY");

  const isNewSpeciesWorkflow = reviewSessionMeta?.workflowType === 'new_species';
  const reviewSessionCutoff = reviewSessionMeta?.createdAt
    ? new Date(reviewSessionMeta.createdAt).getTime()
    : null;

  useEffect(() => {
    if (!reviewSessionId) {
      setReviewSessionMeta(null);
      setReviewSessionLoaded(true);
      return;
    }

    let cancelled = false;
    const loadReviewSession = async () => {
      setReviewSessionLoaded(false);
      try {
        const response = await fetch(`/api/review/${reviewSessionId}`);
        if (!response.ok) {
          return;
        }
        const data = await response.json();
        if (!cancelled) {
          setReviewSessionMeta({
            workflowType: data?.workflowType,
            createdAt: data?.createdAt,
          });
        }
      } catch (err) {
        console.warn('[Annotate] Failed to load review session context:', err);
      } finally {
        if (!cancelled) {
          setReviewSessionLoaded(true);
        }
      }
    };

    loadReviewSession();
    return () => {
      cancelled = true;
    };
  }, [reviewSessionId]);

  // Canvas scaling and viewport
  const [scale, setScale] = useState(1);
  const [zoomLevel, setZoomLevel] = useState(1);
  const [panOffset, setPanOffset] = useState({ x: 0, y: 0 });
  const [imageLoaded, setImageLoaded] = useState(false);
  const [isPanning, setIsPanning] = useState(false);
  const [lastPanPoint, setLastPanPoint] = useState({ x: 0, y: 0 });

  // UI state
  const [showHotkeyHelp, setShowHotkeyHelp] = useState(false);
  const [hoveredAnnotation, setHoveredAnnotation] = useState<string | null>(null);
  const [deleteIconPosition, setDeleteIconPosition] = useState<{ x: number; y: number } | null>(null);

  // Batch processing state
  const [batchProcessing, setBatchProcessing] = useState(false);
  const [batchJobId, setBatchJobId] = useState<string | null>(null);
  const [batchJobStatus, setBatchJobStatus] = useState<{
    status: string;
    processedImages: number;
    totalImages: number;
  } | null>(null);
  const [batchJobError, setBatchJobError] = useState<string | null>(null);
  const [batchSummary, setBatchSummary] = useState<{
    total: number;
    pending: number;
    accepted: number;
    rejected: number;
  } | null>(null);

  // Undo/Redo stack
  const {
    pushAction: pushUndoAction,
    popUndo,
    popRedo,
    clearStacks: clearUndoStacks,
    canUndo: canUndoAction,
    canRedo: canRedoAction,
    isProcessing: isUndoProcessing,
    setProcessing: setUndoProcessing,
  } = useUndoRedo();

  // Annotation editing (vertex drag)
  const {
    startEdit,
    clearEdit,
    findVertexAt,
    startDrag,
    updateDrag,
    endDrag,
    editingAnnotationId,
    editedCoordinates,
    draggingVertexIndex,
  } = useAnnotationEditing();

  // Label Assist
  const {
    isRunning: labelAssistRunning,
    error: labelAssistError,
    confidenceThreshold,
    setConfidenceThreshold,
    runLabelAssist,
    bboxToPolygon,
    mapConfidence,
  } = useLabelAssist(assetId, session?.asset?.project?.id);

  const handleRunLabelAssist = useCallback(async () => {
    const newSuggestions = await runLabelAssist();
    if (newSuggestions.length > 0) {
      setAiSuggestions(newSuggestions);
    }
  }, [runLabelAssist]);

  // Convert a single AI suggestion to a manual annotation
  const convertSuggestionToAnnotation = useCallback(async (suggestion: AiSuggestion) => {
    if (!session || !suggestion.boundingBox) return;

    const coordinates = bboxToPolygon(suggestion.boundingBox);
    const confidenceLevel = mapConfidence(suggestion.confidence);

    try {
      const response = await fetch('/api/annotations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId: session.id,
          weedType: suggestion.className,
          confidence: confidenceLevel,
          coordinates,
        }),
      });

      if (response.ok) {
        const newAnnotation = await response.json();
        setAnnotations(prev => [...prev, newAnnotation]);
        pushUndoAction({
          type: 'CREATE_ANNOTATION',
          annotationId: newAnnotation.id,
          annotationData: {
            sessionId: session.id,
            weedType: suggestion.className,
            confidence: confidenceLevel,
            coordinates,
          },
        });
        // Mark suggestion as verified
        setAiSuggestions(prev => prev.map(s =>
          s.id === suggestion.id ? { ...s, verified: true } : s
        ));
      }
    } catch (err) {
      console.error('Failed to convert suggestion:', err);
    }
  }, [session, bboxToPolygon, mapConfidence, pushUndoAction]);

  // Accept all suggestions above threshold
  const acceptAllSuggestions = useCallback(async () => {
    const aboveThreshold = aiSuggestions.filter(s =>
      s.boundingBox &&
      !s.verified &&
      !s.rejected &&
      s.confidence !== null &&
      s.confidence >= confidenceThreshold
    );

    for (const suggestion of aboveThreshold) {
      await convertSuggestionToAnnotation(suggestion);
    }
  }, [aiSuggestions, confidenceThreshold, convertSuggestionToAnnotation]);

  // Load project assets for filmstrip
  useEffect(() => {
    const loadProjectAssets = async () => {
      if (!session?.asset?.project?.id) return;
      if (reviewSessionId && !reviewSessionLoaded) return;

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
                const scopedSessions = isNewSpeciesWorkflow && reviewSessionCutoff
                  ? sessions.filter((s: { createdAt?: string }) => {
                      if (!s?.createdAt) return false;
                      const createdAt = Date.parse(s.createdAt);
                      return Number.isFinite(createdAt) && createdAt >= reviewSessionCutoff;
                    })
                  : sessions;
                const total = scopedSessions.reduce(
                  (sum: number, s: { annotations?: unknown[] }) => sum + (s.annotations?.length || 0),
                  0
                );
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
  }, [
    session?.asset?.project?.id,
    assetId,
    isNewSpeciesWorkflow,
    reviewSessionCutoff,
    reviewSessionId,
    reviewSessionLoaded,
  ]);

  // Load annotation session
  useEffect(() => {
    const loadSession = async () => {
      if (reviewSessionId && !reviewSessionLoaded) {
        return;
      }

      try {
        setLoading(true);
        const getResponse = await fetch(`/api/annotations/sessions?assetId=${assetId}`);
        if (!getResponse.ok) {
          const errorData = await getResponse.json().catch(() => ({}));
          throw new Error(errorData.error || 'Failed to fetch annotation sessions');
        }

        const sessions = await getResponse.json();
        let currentSession: AnnotationSession | null = null;
        if (Array.isArray(sessions)) {
          if (isNewSpeciesWorkflow && reviewSessionCutoff) {
            const candidates = sessions.filter((s: { createdAt?: string }) => {
              if (!s?.createdAt) return false;
              const createdAt = Date.parse(s.createdAt);
              return Number.isFinite(createdAt) && createdAt >= reviewSessionCutoff;
            });
            currentSession =
              candidates.find((s: { status: string }) => s.status === 'IN_PROGRESS') ||
              candidates[0] ||
              null;
          } else {
            currentSession = sessions.find((s: { status: string }) => s.status === 'IN_PROGRESS') || null;
          }
        }

        if (!currentSession) {
          const postResponse = await fetch('/api/annotations/sessions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              assetId,
              forceNewSession: Boolean(isNewSpeciesWorkflow && reviewSessionCutoff),
            }),
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
  }, [assetId, isNewSpeciesWorkflow, reviewSessionCutoff, reviewSessionId, reviewSessionLoaded]);

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

        if (useVisualCrops) {
          setSam3ConceptStatus(null);
          return;
        }

        try {
          const conceptResponse = await fetch('/api/sam3/concept/status');
          const conceptStatus: SAM3ConceptStatusResponse | null = await conceptResponse
            .json()
            .catch(() => null);
          if (conceptStatus) {
            setSam3ConceptStatus(conceptStatus);
            if (
              conceptStatus.configured &&
              !conceptStatus.ready &&
              !conceptWarmupTriggeredRef.current
            ) {
              conceptWarmupTriggeredRef.current = true;
              fetch('/api/sam3/concept/warmup', { method: 'POST' }).catch((warmupError) => {
                console.warn('[Annotate] Concept warmup request failed:', warmupError);
              });
            }
          } else {
            setSam3ConceptStatus({
              configured: false,
              ready: false,
              sam3Loaded: false,
              dinoLoaded: false,
            });
          }
        } catch {
          setSam3ConceptStatus({
            configured: false,
            ready: false,
            sam3Loaded: false,
            dinoLoaded: false,
          });
        }
      } catch {
        setSam3Health({ available: false, mode: 'unavailable', device: null, latencyMs: null });
        setSam3ConceptStatus(null);
        setAnnotationMode('manual');
      }
    };

    checkSam3Status();
    const interval = setInterval(checkSam3Status, 10000);
    return () => clearInterval(interval);
  }, [useVisualCrops]);

  // Fetch AI detections
  useEffect(() => {
    const fetchAiDetections = async () => {
      if (!assetId) return;
      try {
        // Use all=true to get all detections for this asset (typically small number per image)
        const response = await fetch(`/api/detections?assetId=${assetId}&all=true`);
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

  // Highlight review item when editing from unified review
  useEffect(() => {
    if (!editContext || !assetId) {
      setHighlightOverlay(null);
      return;
    }

    const fetchHighlight = async () => {
      try {
        const response = await fetch(`/api/review/${editContext.sessionId}/items?assetId=${assetId}`);
        if (!response.ok) return;
        const data = await response.json();
        const matched = (data.items || []).find(
          (item: { sourceId: string; id: string }) =>
            item.sourceId === editContext.originalItemId || item.id === editContext.originalItemId
        );

        if (!matched) return;

        if (matched.source === "manual") {
          setPendingHighlightId(matched.sourceId);
          setHighlightOverlay(null);
        } else if (matched.geometry?.bbox) {
          setHighlightOverlay({ type: "bbox", bbox: matched.geometry.bbox });
        } else if (matched.geometry?.polygon) {
          setHighlightOverlay({ type: "polygon", polygon: matched.geometry.polygon });
        }

        setAnnotationMode("manual");
      } catch (err) {
        console.error("Failed to load highlight item:", err);
      }
    };

    fetchHighlight();
  }, [assetId, editContext]);

  useEffect(() => {
    if (!pendingHighlightId) return;
    const found = annotations.find((annotation) => annotation.id === pendingHighlightId);
    if (found) {
      setSelectedAnnotation(pendingHighlightId);
      setPendingHighlightId(null);
    }
  }, [annotations, pendingHighlightId]);

  // SAM3 prediction
  const runSam3Prediction = useCallback(async (points: SAM3Point[]) => {
    if (!session?.asset?.id || points.length === 0) return;

    try {
      setSam3Loading(true);
      setSam3Error(null);

      const response = await fetch('/api/sam3/predict', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          assetId: session.asset.id,
          points,
          textPrompt: selectedClass,
        }),
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
      console.log('[SAM3] Prediction result:', result);
      if (result.backend) setSam3Backend(result.backend);

      if (result.success && result.polygon && result.polygon.length >= 3) {
        setSam3PreviewPolygon(result.polygon);
        setSam3Score(result.score);
        setSam3Error(null);
      } else if (result.success && (!result.polygon || result.polygon.length < 3)) {
        // API succeeded but no polygon returned - likely nothing detected at that point
        setSam3PreviewPolygon(null);
        setSam3Score(null);
        setSam3Error(`No object detected at that point. Try clicking on a different area. (Backend: ${result.backend || 'unknown'})`);
        setTimeout(() => setSam3Error(null), 4000);
      } else {
        // API returned an error
        setSam3PreviewPolygon(null);
        setSam3Score(null);
        setSam3Error(result.error || 'SAM3 prediction failed');
      }
    } catch (err) {
      console.error('[SAM3] Connection error:', err);
      setSam3Error('Connection error. Please check your network.');
    } finally {
      setSam3Loading(false);
    }
  }, [session?.asset?.id, selectedClass]);

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
      clearUndoStacks();
      const params = new URLSearchParams();
      if (reviewSessionId) {
        params.set("reviewSessionId", reviewSessionId);
      }
      if (returnTo) {
        params.set("returnTo", returnTo);
      }
      const suffix = params.toString() ? `?${params.toString()}` : "";
      router.push(`/annotate/${asset.id}${suffix}`);
    }
  }, [projectAssets, reviewSessionId, returnTo, router, clearUndoStacks]);

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
    if (mode !== 'box-exemplar' && mode !== 'bbox') clearBoxExemplars();
    if (mode !== 'manual') cancelDrawing();
    if (mode !== 'edit') {
      clearEdit();
      setSelectedAnnotation(null);
    }
  }, [clearSam3, clearBoxExemplars, cancelDrawing, clearEdit]);

  // Class selection via hotkey
  const handleClassHotkey = useCallback((hotkeyNum: number) => {
    const weedClass = getClassByHotkey(hotkeyNum);
    if (weedClass) setSelectedClass(weedClass.name);
  }, []);

  const handleEditWriteBack = useCallback(async (newAnnotationId: string) => {
    if (!editContext) return false;

    try {
      const response = await fetch(`/api/review/${editContext.sessionId}/action`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "edit",
          source: editContext.source,
          originalItemId: editContext.originalItemId,
          newAnnotationId,
        }),
      });

      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || "Failed to apply edit");
      }

      if (editContext.returnTo) {
        router.push(editContext.returnTo);
      } else {
        router.push(`/review?sessionId=${editContext.sessionId}`);
      }
      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to apply edit";
      setSam3Error(message);
      setTimeout(() => setSam3Error(null), 4000);
      return false;
    }
  }, [editContext, router]);

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
          if (await handleEditWriteBack(newAnnotation.id)) {
            return;
          }
          setAnnotations(prev => [...prev, newAnnotation]);
          pushUndoAction({
            type: 'CREATE_ANNOTATION',
            annotationId: newAnnotation.id,
            annotationData: { sessionId: session.id, weedType: selectedClass, confidence, coordinates: sam3PreviewPolygon },
          });
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
          if (await handleEditWriteBack(newAnnotation.id)) {
            return;
          }
          setAnnotations(prev => [...prev, newAnnotation]);
          pushUndoAction({
            type: 'CREATE_ANNOTATION',
            annotationId: newAnnotation.id,
            annotationData: { sessionId: session.id, weedType: selectedClass, confidence, coordinates: currentPolygon.points },
          });
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
          const coordinates: [number, number][] = [
            [x1, y1], [x2, y1], [x2, y2], [x1, y2],
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
            if (await handleEditWriteBack(newAnnotation.id)) {
              return;
            }
            newAnnotations.push(newAnnotation);
            pushUndoAction({
              type: 'CREATE_ANNOTATION',
              annotationId: newAnnotation.id,
              annotationData: { sessionId: session.id, weedType: exemplar.weedType, confidence, coordinates },
            });
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
  }, [session, annotationMode, sam3PreviewPolygon, currentPolygon, boxExemplars, selectedClass, confidence, clearSam3, cancelDrawing, clearBoxExemplars, handleEditWriteBack, pushUndoAction]);

  // Cancel current action
  const handleCancel = useCallback(() => {
    if (annotationMode === 'sam3') clearSam3();
    else if (annotationMode === 'manual') cancelDrawing();
    else if (annotationMode === 'box-exemplar') clearBoxExemplars();
    setSelectedAnnotation(null);
  }, [annotationMode, clearSam3, cancelDrawing, clearBoxExemplars]);

  // Delete annotation
  const deleteAnnotation = useCallback(async (id?: string, skipUndo?: boolean) => {
    const targetId = id || selectedAnnotation;
    if (!targetId || !session) return;

    // Capture annotation data before deleting (for undo)
    const deletedAnnotation = annotations.find(a => a.id === targetId);

    try {
      const response = await fetch(`/api/annotations/${targetId}`, { method: 'DELETE' });
      if (response.ok || response.status === 404) {
        setAnnotations(prev => prev.filter(a => a.id !== targetId));
        if (selectedAnnotation === targetId) setSelectedAnnotation(null);
        // Push to undo stack so we can recreate it
        if (!skipUndo && deletedAnnotation) {
          pushUndoAction({
            type: 'DELETE_ANNOTATION',
            annotationId: targetId,
            annotationData: {
              sessionId: session.id,
              weedType: deletedAnnotation.weedType,
              confidence: deletedAnnotation.confidence,
              coordinates: deletedAnnotation.coordinates,
            },
          });
        }
      }
    } catch (err) {
      console.error('Failed to delete annotation:', err);
    }
  }, [selectedAnnotation, session, annotations, pushUndoAction]);

  // Verify annotation (mark as accepted)
  const verifyAnnotation = useCallback(async (id: string) => {
    try {
      const response = await fetch(`/api/annotations/${id}/verify`, { method: 'POST' });
      if (response.ok) {
        const updated = await response.json();
        setAnnotations(prev => prev.map(a => a.id === id ? { ...a, verified: true, verifiedAt: updated.verifiedAt } : a));
      } else {
        const error = await response.json().catch(() => ({ error: 'Unknown error' }));
        console.error('Verify failed:', error);
        setSam3Error(`Failed to verify: ${error.error || 'Server error'}`);
        setTimeout(() => setSam3Error(null), 3000);
      }
    } catch (err) {
      console.error('Failed to verify annotation:', err);
      setSam3Error('Failed to verify annotation. Check console for details.');
      setTimeout(() => setSam3Error(null), 3000);
    }
  }, []);

  // Verify all unverified annotations at once
  const verifyAllAnnotations = useCallback(async () => {
    const unverified = annotations.filter(a => !a.verified);
    if (unverified.length === 0) return;

    // Verify all in parallel
    const results = await Promise.allSettled(
      unverified.map(a => fetch(`/api/annotations/${a.id}/verify`, { method: 'POST' }))
    );

    // Update state for successful verifications
    const successIds = new Set<string>();
    results.forEach((result, index) => {
      if (result.status === 'fulfilled' && result.value.ok) {
        successIds.add(unverified[index].id);
      }
    });

    if (successIds.size > 0) {
      setAnnotations(prev => prev.map(a =>
        successIds.has(a.id) ? { ...a, verified: true, verifiedAt: new Date().toISOString() } : a
      ));
    }
  }, [annotations]);

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
        const result = await response.json().catch(() => null);
        if (!result) {
          setSam3Error('Upload succeeded but returned an invalid response');
          return;
        }
        // Update local state to mark annotations as pushed
        setAnnotations(prev => prev.map(a =>
          a.verified && !a.pushedToTraining
            ? { ...a, pushedToTraining: true, pushedAt: new Date().toISOString() }
            : a
        ));
        setSam3Error(null);
        const remaining = typeof result.remaining === 'number' ? result.remaining : 0;
        const pushedCount = result.pushed || 0;
        const successMessage = remaining > 0
          ? `Uploaded ${pushedCount} annotations. ${remaining} remaining - click Upload again to continue.`
          : `Successfully uploaded ${pushedCount} annotations for training!`;
        // Show success message briefly
        setSam3Error(successMessage);
        setTimeout(() => setSam3Error(null), 3000);
      } else {
        let errorMessage = 'Failed to upload for training';
        try {
          const error = await response.json();
          errorMessage = error.error || errorMessage;
        } catch {
          if (response.statusText) errorMessage = response.statusText;
        }
        setSam3Error(errorMessage);
      }
    } catch (err) {
      console.error('Failed to upload for training:', err);
      setSam3Error('Failed to upload for training');
    } finally {
      setIsPushing(false);
    }
  }, [session]);

  // Undo: first check local drawing state, then fall back to action stack
  const handleUndo = useCallback(async () => {
    // Local undo: SAM3 points
    if (annotationMode === 'sam3' && sam3Points.length > 0) {
      const newPoints = sam3Points.slice(0, -1);
      setSam3Points(newPoints);
      if (newPoints.length > 0) runSam3Prediction(newPoints);
      else { setSam3PreviewPolygon(null); setSam3Score(null); }
      return;
    }
    // Local undo: manual polygon points
    if (annotationMode === 'manual' && currentPolygon.points.length > 0 && !currentPolygon.isComplete) {
      setCurrentPolygon(prev => ({
        ...prev,
        points: prev.points.slice(0, -1),
      }));
      return;
    }

    // Action stack undo
    if (isUndoProcessing) return;
    const action = popUndo();
    if (!action || !session) return;

    setUndoProcessing(true);
    try {
      if (action.type === 'CREATE_ANNOTATION') {
        // Undo create = delete
        await fetch(`/api/annotations/${action.annotationId}`, { method: 'DELETE' });
        setAnnotations(prev => prev.filter(a => a.id !== action.annotationId));
      } else if (action.type === 'DELETE_ANNOTATION' && action.annotationData) {
        // Undo delete = recreate
        const response = await fetch('/api/annotations', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(action.annotationData),
        });
        if (response.ok) {
          const recreated = await response.json();
          // Update the action's annotationId in the redo stack to point to the new ID
          action.annotationId = recreated.id;
          setAnnotations(prev => [...prev, recreated]);
        }
      } else if (action.type === 'MODIFY_ANNOTATION' && action.previousCoordinates) {
        // Undo modify = restore previous coordinates
        const response = await fetch(`/api/annotations/${action.annotationId}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ coordinates: action.previousCoordinates }),
        });
        if (response.ok) {
          const updated = await response.json();
          setAnnotations(prev => prev.map(a => a.id === action.annotationId ? { ...a, coordinates: updated.coordinates } : a));
        }
      }
    } catch (err) {
      console.error('Undo failed:', err);
    } finally {
      setUndoProcessing(false);
    }
  }, [annotationMode, sam3Points, runSam3Prediction, currentPolygon, isUndoProcessing, popUndo, session, setUndoProcessing]);

  // Redo
  const handleRedo = useCallback(async () => {
    if (isUndoProcessing) return;
    const action = popRedo();
    if (!action || !session) return;

    setUndoProcessing(true);
    try {
      if (action.type === 'CREATE_ANNOTATION' && action.annotationData) {
        // Redo create = recreate
        const response = await fetch('/api/annotations', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(action.annotationData),
        });
        if (response.ok) {
          const recreated = await response.json();
          action.annotationId = recreated.id;
          setAnnotations(prev => [...prev, recreated]);
        }
      } else if (action.type === 'DELETE_ANNOTATION') {
        // Redo delete = delete again
        await fetch(`/api/annotations/${action.annotationId}`, { method: 'DELETE' });
        setAnnotations(prev => prev.filter(a => a.id !== action.annotationId));
      } else if (action.type === 'MODIFY_ANNOTATION' && action.newCoordinates) {
        // Redo modify = apply new coordinates
        const response = await fetch(`/api/annotations/${action.annotationId}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ coordinates: action.newCoordinates }),
        });
        if (response.ok) {
          const updated = await response.json();
          setAnnotations(prev => prev.map(a => a.id === action.annotationId ? { ...a, coordinates: updated.coordinates } : a));
        }
      }
    } catch (err) {
      console.error('Redo failed:', err);
    } finally {
      setUndoProcessing(false);
    }
  }, [isUndoProcessing, popRedo, session, setUndoProcessing]);

  // Apply exemplars to current image using SAM3 (direct, no Redis needed)
  const applyToCurrentImage = useCallback(async () => {
    if (!session?.asset?.id || boxExemplars.length === 0) return;

    const exemplarAssetIds = Array.from(new Set(boxExemplars.map(e => e.assetId)));
    if (exemplarAssetIds.length !== 1) {
      setSam3Error('Exemplars must come from a single image before applying.');
      setTimeout(() => setSam3Error(null), 3000);
      return;
    }

    if (exemplarAssetIds[0] !== session.asset.id) {
      setSam3Error('Exemplars were drawn on a different image. Return to that image or clear exemplars.');
      setTimeout(() => setSam3Error(null), 4000);
      return;
    }

    const exemplarsToProcess = [...boxExemplars];

    setBatchProcessing(true);
    setBatchSummary(null);
    setSam3Error(null);
    try {
      // Use direct SAM3 predict endpoint with box prompts
      const response = await fetch('/api/sam3/predict', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          assetId: session.asset.id,
          boxes: exemplarsToProcess.map(e => e.box),
          textPrompt: selectedClass,
        }),
      });

      if (response.ok) {
        const data = await response.json();
        if (data.backend) setSam3Backend(data.backend);

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

  const buildVisualExemplarCrops = useCallback((): string[] => {
    const image = imageRef.current;
    if (!image || !image.complete || image.naturalWidth <= 0 || image.naturalHeight <= 0) {
      return [];
    }

    const crops: string[] = [];
    for (const exemplar of boxExemplars.slice(0, MAX_VISUAL_EXEMPLAR_CROPS)) {
      const minX = Math.min(exemplar.box.x1, exemplar.box.x2);
      const minY = Math.min(exemplar.box.y1, exemplar.box.y2);
      const maxX = Math.max(exemplar.box.x1, exemplar.box.x2);
      const maxY = Math.max(exemplar.box.y1, exemplar.box.y2);

      const left = Math.max(0, Math.min(image.naturalWidth - 1, Math.round(minX)));
      const top = Math.max(0, Math.min(image.naturalHeight - 1, Math.round(minY)));
      const right = Math.max(left + 1, Math.min(image.naturalWidth, Math.round(maxX)));
      const bottom = Math.max(top + 1, Math.min(image.naturalHeight, Math.round(maxY)));

      const width = right - left;
      const height = bottom - top;
      if (width <= 1 || height <= 1) {
        continue;
      }

      const scale = Math.min(1, MAX_VISUAL_EXEMPLAR_DIMENSION / Math.max(width, height));
      const outputWidth = Math.max(1, Math.round(width * scale));
      const outputHeight = Math.max(1, Math.round(height * scale));

      const canvas = document.createElement('canvas');
      canvas.width = outputWidth;
      canvas.height = outputHeight;
      const context = canvas.getContext('2d');
      if (!context) {
        continue;
      }

      context.imageSmoothingEnabled = true;
      context.imageSmoothingQuality = 'high';
      context.drawImage(
        image,
        left,
        top,
        width,
        height,
        0,
        0,
        outputWidth,
        outputHeight
      );

      const dataUrl = canvas.toDataURL('image/jpeg', VISUAL_EXEMPLAR_JPEG_QUALITY);
      const base64 = dataUrl.split(',')[1];
      if (base64) {
        crops.push(base64);
      }
    }

    return crops;
  }, [boxExemplars]);

  // Apply exemplars to all project images (requires Redis for batch queue)
  const applyToAllImages = useCallback(async () => {
    if (!session?.asset?.project?.id || boxExemplars.length === 0) return;

    const exemplarAssetIds = Array.from(new Set(boxExemplars.map(e => e.assetId)));
    if (exemplarAssetIds.length !== 1) {
      setSam3Error('Exemplars must come from a single image before applying to a batch.');
      setTimeout(() => setSam3Error(null), 3000);
      return;
    }

    const sourceAssetId = exemplarAssetIds[0];
    let visualExemplarCrops: string[] | undefined;

    if (useVisualCrops) {
      if (sourceAssetId !== session.asset.id) {
        setSam3Error('Visual crop mode requires running from the source image where exemplars were drawn.');
        setTimeout(() => setSam3Error(null), 5000);
        return;
      }

      visualExemplarCrops = buildVisualExemplarCrops();
      if (visualExemplarCrops.length === 0) {
        setSam3Error('Could not extract visual exemplar crops. Reload the source image, redraw exemplars, then retry.');
        setTimeout(() => setSam3Error(null), 5000);
        return;
      }

      console.log('[Batch] Built visual exemplar crops on client', {
        sourceAssetId,
        exemplarCount: boxExemplars.length,
        cropCount: visualExemplarCrops.length,
      });
    }

    setBatchProcessing(true);
    setSam3Error(null);
    try {
      // Check if source image has dimensions for proper scaling
      if (sourceAssetId === session.asset.id && (!session.asset.imageWidth || !session.asset.imageHeight)) {
        console.warn('[Batch] Source image missing dimensions - scaling may be inaccurate');
      }

      const fallbackWidth = sourceAssetId === session.asset.id ? imageRef.current?.naturalWidth : undefined;
      const fallbackHeight = sourceAssetId === session.asset.id ? imageRef.current?.naturalHeight : undefined;
      const exemplarSourceWidth = boxExemplars[0]?.sourceWidth;
      const exemplarSourceHeight = boxExemplars[0]?.sourceHeight;
      const sourceWidth = exemplarSourceWidth || (sourceAssetId === session.asset.id ? session.asset.imageWidth || fallbackWidth : undefined);
      const sourceHeight = exemplarSourceHeight || (sourceAssetId === session.asset.id ? session.asset.imageHeight || fallbackHeight : undefined);

      // Only send dimensions if both are valid (API requires both or neither)
      const sourceDimensions =
        sourceWidth && sourceHeight
          ? {
              exemplarSourceWidth: sourceWidth,
              exemplarSourceHeight: sourceHeight,
            }
          : {};

      const response = await fetch('/api/sam3/batch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectId: session.asset.project.id,
          weedType: selectedClass,
          exemplars: boxExemplars.map(e => e.box),
          ...sourceDimensions,
          sourceAssetId,
          // No assetIds = process all images in project
          textPrompt: selectedClass,
          useVisualCrops,
          exemplarCrops: visualExemplarCrops,
        }),
      });

      if (response.ok) {
        const data = await response.json();
        setBatchJobId(data.batchJobId);
        setBatchJobStatus({
          status: data.status || 'QUEUED',
          processedImages: data.processedImages || 0,
          totalImages: data.totalImages || 0,
        });
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
  }, [session, boxExemplars, selectedClass, useVisualCrops, buildVisualExemplarCrops]);

  useEffect(() => {
    if (!batchJobId) return;

    const MAX_STATUS_ERRORS = 5;
    let cancelled = false;
    const intervalIdRef = { current: undefined as ReturnType<typeof setInterval> | undefined };
    let failureCount = 0;

    const stopPolling = (message: string) => {
      if (intervalIdRef.current) clearInterval(intervalIdRef.current);
      if (!cancelled) {
        setSam3Error(message);
      }
    };

    const fetchStatus = async () => {
      try {
        const response = await fetch(`/api/sam3/batch/${batchJobId}?includeAnnotations=false`);
        if (!response.ok) {
          failureCount += 1;
          if (failureCount >= MAX_STATUS_ERRORS) {
            stopPolling('Stopped polling batch status after repeated failures.');
          }
          return;
        }
        const data = await response.json();
        if (!data?.batchJob || cancelled) return;

        failureCount = 0;
        setBatchJobStatus({
          status: data.batchJob.status,
          processedImages: data.batchJob.processedImages,
          totalImages: data.batchJob.totalImages,
        });
        setBatchJobError(data.batchJob.errorMessage || null);
        setBatchSummary(data.summary || null);

        if (["COMPLETED", "FAILED", "CANCELLED"].includes(data.batchJob.status)) {
          if (intervalIdRef.current) clearInterval(intervalIdRef.current);
        }
      } catch (err) {
        console.error("Failed to fetch batch job status:", err);
        failureCount += 1;
        if (failureCount >= MAX_STATUS_ERRORS) {
          stopPolling('Stopped polling batch status after repeated failures.');
        }
      }
    };

    fetchStatus();
    intervalIdRef.current = setInterval(fetchStatus, 3000);

    return () => {
      cancelled = true;
      if (intervalIdRef.current) clearInterval(intervalIdRef.current);
    };
  }, [batchJobId]);

  const handleReviewBatch = useCallback(async () => {
    if (!batchJobId || !session?.asset?.project?.id) return;

    try {
      const response = await fetch("/api/review", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId: session.asset.project.id,
          workflowType: "batch_review",
          targetType: "both",
          batchJobIds: [batchJobId],
        }),
      });

      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        const message = data?.details ? `${data.error}: ${data.details}` : data?.error;
        throw new Error(message || "Failed to create review session");
      }

      if (data?.session?.id) {
        router.push(`/review?sessionId=${data.session.id}`);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to create review session";
      setSam3Error(message);
      setTimeout(() => setSam3Error(null), 4000);
    }
  }, [batchJobId, router, session?.asset?.project?.id]);

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
    onRedo: handleRedo,
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

    if (highlightOverlay) {
      ctx.save();
      ctx.setLineDash([6, 4]);
      ctx.strokeStyle = '#f59e0b';
      ctx.lineWidth = 3 / zoomLevel;

      if (highlightOverlay.type === 'bbox' && highlightOverlay.bbox) {
        const [x1, y1, x2, y2] = highlightOverlay.bbox;
        const width = (x2 - x1) * scale;
        const height = (y2 - y1) * scale;
        ctx.strokeRect(x1 * scale, y1 * scale, width, height);
      }

      if (highlightOverlay.type === 'polygon' && highlightOverlay.polygon) {
        ctx.beginPath();
        const [startX, startY] = highlightOverlay.polygon[0];
        ctx.moveTo(startX * scale, startY * scale);
        highlightOverlay.polygon.forEach(([x, y]) => ctx.lineTo(x * scale, y * scale));
        ctx.closePath();
        ctx.stroke();
      }

      ctx.restore();
      ctx.setLineDash([]);
    }

    // Existing annotations
    annotations.forEach((annotation) => {
      const isSelected = selectedAnnotation === annotation.id;
      const isHovered = hoveredAnnotation === annotation.id;
      const color = getClassColor(annotation.weedType);

      ctx.strokeStyle = isSelected ? '#FF0000' : isHovered ? '#EF4444' : color;
      ctx.fillStyle = hexToRgba(isSelected ? '#FF0000' : isHovered ? '#EF4444' : color, isHovered ? 0.35 : 0.2);
      ctx.lineWidth = (isSelected || isHovered ? 3 : 2) / zoomLevel;

      if (annotation.coordinates.length > 2) {
        ctx.beginPath();
        const [startX, startY] = annotation.coordinates[0];
        ctx.moveTo(startX * scale, startY * scale);
        annotation.coordinates.forEach(([x, y]) => ctx.lineTo(x * scale, y * scale));
        ctx.closePath();
        ctx.fill();
        ctx.stroke();

        // Draw delete icon on hovered annotation
        if (isHovered) {
          // Calculate centroid of polygon for icon placement (in image coordinates)
          const sumX = annotation.coordinates.reduce((sum, [x]) => sum + x, 0);
          const sumY = annotation.coordinates.reduce((sum, [, y]) => sum + y, 0);
          const iconX = sumX / annotation.coordinates.length;
          const iconY = sumY / annotation.coordinates.length;
          const centerX = iconX * scale;
          const centerY = iconY * scale;

          // Store icon position for click detection (in image coordinates)
          setDeleteIconPosition({ x: iconX, y: iconY });

          // Draw delete circle background
          const iconRadius = 14 / zoomLevel;
          ctx.beginPath();
          ctx.arc(centerX, centerY, iconRadius, 0, 2 * Math.PI);
          ctx.fillStyle = '#EF4444';
          ctx.fill();
          ctx.strokeStyle = '#FFFFFF';
          ctx.lineWidth = 2 / zoomLevel;
          ctx.stroke();

          // Draw X icon
          const xSize = 6 / zoomLevel;
          ctx.beginPath();
          ctx.moveTo(centerX - xSize, centerY - xSize);
          ctx.lineTo(centerX + xSize, centerY + xSize);
          ctx.moveTo(centerX + xSize, centerY - xSize);
          ctx.lineTo(centerX - xSize, centerY + xSize);
          ctx.strokeStyle = '#FFFFFF';
          ctx.lineWidth = 2.5 / zoomLevel;
          ctx.stroke();
        }
      }
    });

    // Edit mode: draw vertex handles for the selected annotation
    if (annotationMode === 'edit' && editingAnnotationId && editedCoordinates) {
      // Draw the edited polygon with dashed outline
      ctx.save();
      ctx.setLineDash([4, 4]);
      ctx.strokeStyle = '#3B82F6';
      ctx.fillStyle = 'rgba(59, 130, 246, 0.15)';
      ctx.lineWidth = 2 / zoomLevel;

      if (editedCoordinates.length >= 3) {
        ctx.beginPath();
        const [sx, sy] = editedCoordinates[0];
        ctx.moveTo(sx * scale, sy * scale);
        editedCoordinates.forEach(([ex, ey]) => ctx.lineTo(ex * scale, ey * scale));
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
      }
      ctx.restore();

      // Draw vertex handles
      editedCoordinates.forEach(([vx, vy], idx) => {
        const handleRadius = 5 / zoomLevel;
        const isActive = draggingVertexIndex === idx;
        ctx.beginPath();
        ctx.arc(vx * scale, vy * scale, handleRadius, 0, 2 * Math.PI);
        ctx.fillStyle = isActive ? '#3B82F6' : '#FFFFFF';
        ctx.fill();
        ctx.strokeStyle = '#3B82F6';
        ctx.lineWidth = 2 / zoomLevel;
        ctx.stroke();
      });
    }

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

    // Current box (bbox mode = green, box-exemplar mode = purple)
    if ((annotationMode === 'box-exemplar' || annotationMode === 'bbox') && currentBox) {
      const { startX, startY, endX, endY } = currentBox;
      const x1 = Math.min(startX, endX);
      const y1 = Math.min(startY, endY);
      const isBboxMode = annotationMode === 'bbox';
      ctx.save();
      ctx.setLineDash([6, 3]);
      ctx.strokeStyle = isBboxMode ? '#10B981' : '#A855F7';
      ctx.fillStyle = isBboxMode ? 'rgba(16, 185, 129, 0.2)' : 'rgba(168, 85, 247, 0.2)';
      ctx.lineWidth = 2 / zoomLevel;
      ctx.strokeRect(x1 * scale, y1 * scale, Math.abs(endX - startX) * scale, Math.abs(endY - startY) * scale);
      ctx.fillRect(x1 * scale, y1 * scale, Math.abs(endX - startX) * scale, Math.abs(endY - startY) * scale);
      ctx.restore();
    }

    ctx.restore();
  }, [annotations, currentPolygon, selectedAnnotation, hoveredAnnotation, scale, imageLoaded, zoomLevel, panOffset, aiSuggestions, showAiSuggestions, highlightOverlay, annotationMode, sam3Points, sam3PreviewPolygon, boxExemplars, currentBox, editingAnnotationId, editedCoordinates, draggingVertexIndex]);

  useEffect(() => { redrawCanvas(); }, [redrawCanvas]);

  // Mouse handlers
  const getCanvasCoords = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0 };
    const rect = canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return { x: 0, y: 0 };
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    return {
      x: (e.clientX - rect.left) * scaleX,
      y: (e.clientY - rect.top) * scaleY,
    };
  }, []);

  const getImageCoords = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const { x: canvasX, y: canvasY } = getCanvasCoords(e);
    return {
      x: (canvasX - panOffset.x) / (scale * zoomLevel),
      y: (canvasY - panOffset.y) / (scale * zoomLevel),
    };
  }, [getCanvasCoords, panOffset, scale, zoomLevel]);

  const handleMouseDown = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    if (e.button === 1 || e.shiftKey) {
      e.preventDefault();
      setIsPanning(true);
      const { x, y } = getCanvasCoords(e);
      setLastPanPoint({ x, y });
      return;
    }

    if ((annotationMode === 'box-exemplar' || annotationMode === 'bbox') && e.button === 0) {
      const { x, y } = getImageCoords(e);
      setCurrentBox({ startX: x, startY: y, endX: x, endY: y });
      setIsDrawingBox(true);
    }

    // Edit mode: check if clicking on a vertex handle
    if (annotationMode === 'edit' && e.button === 0 && editingAnnotationId && editedCoordinates) {
      const { x, y } = getImageCoords(e);
      const hitRadius = 8 / (scale * zoomLevel);
      const vertexIdx = findVertexAt(x, y, editedCoordinates, hitRadius);
      if (vertexIdx >= 0) {
        startDrag(vertexIdx);
        return;
      }
    }
  }, [annotationMode, getCanvasCoords, getImageCoords, editingAnnotationId, editedCoordinates, findVertexAt, startDrag, scale, zoomLevel]);

  const handleMouseMove = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    if (isPanning) {
      const { x: currentX, y: currentY } = getCanvasCoords(e);
      setPanOffset(prev => ({
        x: prev.x + (currentX - lastPanPoint.x),
        y: prev.y + (currentY - lastPanPoint.y),
      }));
      setLastPanPoint({ x: currentX, y: currentY });
      return;
    }

    if (isDrawingBox && (annotationMode === 'box-exemplar' || annotationMode === 'bbox')) {
      const { x, y } = getImageCoords(e);
      setCurrentBox(prev => prev ? { ...prev, endX: x, endY: y } : null);
    }

    // Edit mode: drag vertex
    if (annotationMode === 'edit' && draggingVertexIndex !== null) {
      const { x, y } = getImageCoords(e);
      updateDrag(x, y);
      return;
    }

    // Check if hovering over an annotation (for delete on hover)
    const { x, y } = getImageCoords(e);

    // In edit mode, update cursor for vertex proximity
    if (annotationMode === 'edit' && editingAnnotationId && editedCoordinates) {
      const hitRadius = 8 / (scale * zoomLevel);
      const vertexIdx = findVertexAt(x, y, editedCoordinates, hitRadius);
      const canvas = canvasRef.current;
      if (canvas) {
        canvas.style.cursor = vertexIdx >= 0 ? 'grab' : (hoveredAnnotation ? 'pointer' : 'default');
      }
    }

    let foundHovered: string | null = null;
    // Check in reverse order so topmost annotation is found first
    for (let i = annotations.length - 1; i >= 0; i--) {
      const annotation = annotations[i];
      if (annotation.coordinates.length >= 3 && isPointInPolygon(x, y, annotation.coordinates)) {
        foundHovered = annotation.id;
        break;
      }
    }
    setHoveredAnnotation(foundHovered);
  }, [isPanning, lastPanPoint, isDrawingBox, annotationMode, getCanvasCoords, getImageCoords, annotations, draggingVertexIndex, updateDrag, editingAnnotationId, editedCoordinates, findVertexAt, scale, zoomLevel, hoveredAnnotation]);

  // Save a bounding box directly as a 4-point polygon annotation
  const saveBboxAnnotation = useCallback(async (x1: number, y1: number, x2: number, y2: number) => {
    if (!session) return;
    const coordinates: [number, number][] = [
      [x1, y1], [x2, y1], [x2, y2], [x1, y2],
    ];
    try {
      const response = await fetch('/api/annotations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId: session.id,
          weedType: selectedClass,
          confidence,
          coordinates,
        }),
      });
      if (response.ok) {
        const newAnnotation = await response.json();
        setAnnotations(prev => [...prev, newAnnotation]);
        pushUndoAction({
          type: 'CREATE_ANNOTATION',
          annotationId: newAnnotation.id,
          annotationData: { sessionId: session.id, weedType: selectedClass, confidence, coordinates },
        });
      }
    } catch (err) {
      console.error('Failed to save bbox annotation:', err);
    }
  }, [session, selectedClass, confidence, pushUndoAction]);

  const handleMouseUp = useCallback(async () => {
    if (isPanning) { setIsPanning(false); return; }

    // Edit mode: finish vertex drag
    if (annotationMode === 'edit' && draggingVertexIndex !== null) {
      const result = endDrag();
      if (result) {
        try {
          const response = await fetch(`/api/annotations/${result.annotationId}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ coordinates: result.newCoordinates }),
          });
          if (response.ok) {
            const updated = await response.json();
            setAnnotations(prev => prev.map(a =>
              a.id === result.annotationId ? { ...a, coordinates: updated.coordinates } : a
            ));
            pushUndoAction({
              type: 'MODIFY_ANNOTATION',
              annotationId: result.annotationId,
              previousCoordinates: result.previousCoordinates,
              newCoordinates: result.newCoordinates,
            });
          }
        } catch (err) {
          console.error('Failed to update annotation:', err);
        }
      }
      return;
    }

    if (isDrawingBox && currentBox && session?.asset?.id) {
      const { startX, startY, endX, endY } = currentBox;
      const x1 = Math.min(startX, endX);
      const y1 = Math.min(startY, endY);
      const x2 = Math.max(startX, endX);
      const y2 = Math.max(startY, endY);

      if (Math.abs(x2 - x1) >= 10 && Math.abs(y2 - y1) >= 10) {
        if (annotationMode === 'bbox') {
          // Save bbox directly as annotation
          saveBboxAnnotation(x1, y1, x2, y2);
        } else if (annotationMode === 'box-exemplar') {
          // Add as exemplar for SAM3 few-shot
          const sourceWidth = session?.asset?.imageWidth || imageRef.current?.naturalWidth;
          const sourceHeight = session?.asset?.imageHeight || imageRef.current?.naturalHeight;
          setBoxExemplars(prev => [...prev, {
            id: `exemplar-${Date.now()}`,
            weedType: selectedClass,
            box: { x1, y1, x2, y2 },
            assetId: session.asset.id,
            sourceWidth: sourceWidth || undefined,
            sourceHeight: sourceHeight || undefined,
          }]);
        }
      }
      setCurrentBox(null);
      setIsDrawingBox(false);
    }
  }, [isPanning, isDrawingBox, annotationMode, currentBox, session?.asset?.id, session?.asset?.imageWidth, session?.asset?.imageHeight, selectedClass, saveBboxAnnotation, draggingVertexIndex, endDrag, pushUndoAction]);

  const handleCanvasClick = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    if (isPanning || e.shiftKey) return;
    const { x, y } = getImageCoords(e);

    // Edit mode: select annotation for editing or deselect
    if (annotationMode === 'edit') {
      if (hoveredAnnotation) {
        const annotation = annotations.find(a => a.id === hoveredAnnotation);
        if (annotation) {
          startEdit(hoveredAnnotation, annotation.coordinates);
          setSelectedAnnotation(hoveredAnnotation);
        }
      } else {
        clearEdit();
        setSelectedAnnotation(null);
      }
      return;
    }

    // In SAM3 or manual mode, prioritize placing points over selecting annotations
    // Only handle delete icon clicks, not general annotation selection
    if (hoveredAnnotation && deleteIconPosition) {
      const iconClickRadius = 20 / (scale * zoomLevel); // Icon hit area in image coordinates
      const distToIcon = Math.sqrt(
        Math.pow(x - deleteIconPosition.x, 2) + Math.pow(y - deleteIconPosition.y, 2)
      );
      if (distToIcon <= iconClickRadius) {
        deleteAnnotation(hoveredAnnotation);
        setHoveredAnnotation(null);
        setDeleteIconPosition(null);
        return;
      }
      // In drawing modes (sam3, manual), don't select annotation - let the drawing continue
      // Only select annotation if we're not actively drawing
      if (annotationMode !== 'sam3' && annotationMode !== 'manual') {
        setSelectedAnnotation(hoveredAnnotation);
        return;
      }
    }

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
  }, [isPanning, getImageCoords, annotationMode, sam3Points, runSam3Prediction, currentPolygon, scale, zoomLevel, isDrawing, hoveredAnnotation, deleteAnnotation, deleteIconPosition, annotations, startEdit, clearEdit]);

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
      router.push(fallbackHref);
    } catch (err) {
      console.error('Failed to complete session:', err);
    }
  };

  // Determine action states
  const canAccept = (annotationMode === 'sam3' && sam3PreviewPolygon && sam3PreviewPolygon.length >= 3) ||
    (annotationMode === 'manual' && currentPolygon.isComplete && currentPolygon.points.length >= 3) ||
    (annotationMode === 'box-exemplar' && boxExemplars.length > 0);
  const canUndo = (annotationMode === 'sam3' && sam3Points.length > 0) ||
    (annotationMode === 'manual' && currentPolygon.points.length > 0 && !currentPolygon.isComplete) ||
    canUndoAction;
  const canRedo = canRedoAction;
  const canDelete = !!selectedAnnotation;
  const batchInProgress =
    batchJobStatus &&
    !["COMPLETED", "FAILED", "CANCELLED"].includes(batchJobStatus.status);
  const readyToPushCount = annotations.filter(a => a.verified && !a.pushedToTraining).length;

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
          <Link href={fallbackHref}>
            <Button>{backLabel}</Button>
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
          <Link href={fallbackHref}>
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
              {sam3Health.available
                ? (sam3Backend || sam3Health.backend) === 'aws'
                  ? 'SAM3 AWS'
                  : (sam3Backend || sam3Health.backend) === 'roboflow'
                    ? 'SAM3 RF'
                    : 'SAM3'
                : 'SAM3 Unavailable'}
            </Badge>
          )}
          {!useVisualCrops && sam3ConceptStatus && (
            <Badge variant={sam3ConceptStatus.ready ? "default" : "secondary"} className="text-xs">
              {sam3ConceptStatus.configured
                ? (sam3ConceptStatus.ready ? 'Concept Ready' : 'Concept Warming')
                : 'Concept Off'}
            </Badge>
          )}

          {readyToPushCount > 0 && (
            <Button
              size="sm"
              onClick={pushToRoboflow}
              disabled={isPushing}
              className="h-8 bg-gradient-to-r from-purple-500 to-blue-500 hover:from-purple-600 hover:to-blue-600"
            >
              {isPushing ? (
                <Loader2 className="w-4 h-4 mr-1 animate-spin" />
              ) : (
                <Upload className="w-4 h-4 mr-1" />
              )}
              Upload {readyToPushCount}
            </Button>
          )}

          <Button
            size="sm"
            onClick={completeSession}
            variant="outline"
            className="h-8"
          >
            <Check className="w-4 h-4 mr-1" />
            Finish & Exit
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
            <Image
              ref={imageRef}
              src={session.asset.storageUrl}
              alt={session.asset.fileName}
              onLoad={handleImageLoad}
              className="hidden"
              width={session.asset.imageWidth ?? 1}
              height={session.asset.imageHeight ?? 1}
              unoptimized
            />
            <canvas
              ref={canvasRef}
              onClick={handleCanvasClick}
              onContextMenu={handleCanvasContextMenu}
              onMouseDown={handleMouseDown}
              onMouseMove={handleMouseMove}
              onMouseUp={handleMouseUp}
              onMouseLeave={handleMouseUp}
              className={`max-w-full max-h-full ${isPanning ? 'cursor-grabbing' : annotationMode === 'edit' ? (hoveredAnnotation ? 'cursor-pointer' : 'cursor-default') : hoveredAnnotation ? 'cursor-pointer' : 'cursor-crosshair'}`}
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
            onRedo={handleRedo}
            onDelete={() => deleteAnnotation()}
            onAccept={acceptAnnotation}
            onShowHelp={() => setShowHotkeyHelp(true)}
            canUndo={canUndo}
            canRedo={canRedo}
            canDelete={canDelete}
            canAccept={canAccept}
          />

          {/* Label Assist */}
          <LabelAssist
            onRun={handleRunLabelAssist}
            onAcceptAll={acceptAllSuggestions}
            isRunning={labelAssistRunning}
            error={labelAssistError}
            confidenceThreshold={confidenceThreshold}
            onThresholdChange={setConfidenceThreshold}
            suggestionsAboveThreshold={
              aiSuggestions.filter(s =>
                s.boundingBox && !s.verified && !s.rejected &&
                s.confidence !== null && s.confidence >= confidenceThreshold
              ).length
            }
            hasActiveModel={true}
            className="mt-3"
          />

          {/* Class Selector */}
          <ClassSelector
            projectId={session.asset.project?.id}
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
            onVerifyAll={verifyAllAnnotations}
            onPushToRoboflow={pushToRoboflow}
            isPushing={isPushing}
            className="mt-3"
          />

          {batchJobStatus && (
            <div className="mt-3">
              <BatchProgress
                processed={batchJobStatus.processedImages}
                total={batchJobStatus.totalImages}
                status={batchJobStatus.status}
                errorMessage={batchJobError}
                onReview={
                  batchJobStatus.status === "COMPLETED" ? handleReviewBatch : undefined
                }
              />
              {batchSummary && (
                <div className="mt-2 text-xs text-gray-500">
                  {batchSummary.pending} pending · {batchSummary.accepted} accepted ·{" "}
                  {batchSummary.rejected} rejected
                </div>
              )}
            </div>
          )}

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
                  disabled={batchProcessing || Boolean(batchInProgress)}
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
                <div className="flex items-center gap-2 text-[11px] text-purple-700">
                  <Checkbox
                    id="use-visual-crops"
                    checked={useVisualCrops}
                    onCheckedChange={(checked) => setUseVisualCrops(checked === true)}
                  />
                  <label htmlFor="use-visual-crops" className="cursor-pointer">
                    Use visual crops only (skip concept propagation)
                  </label>
                </div>
              </div>
              <p className="text-[10px] text-purple-600 mt-2">
                {useVisualCrops
                  ? 'Visual crop matching only (skips concept propagation)'
                  : 'SAM3 will find similar objects in your images'}
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
