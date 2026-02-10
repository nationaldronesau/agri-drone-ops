"use client";

import { useState, useCallback } from "react";

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

interface LabelAssistState {
  isRunning: boolean;
  error: string | null;
  confidenceThreshold: number;
}

export function useLabelAssist(assetId: string, projectId: string | undefined) {
  const [state, setState] = useState<LabelAssistState>({
    isRunning: false,
    error: null,
    confidenceThreshold: 0.5,
  });

  const setConfidenceThreshold = useCallback((value: number) => {
    setState(prev => ({ ...prev, confidenceThreshold: value }));
  }, []);

  /**
   * Run inference on the current image using the project's active model
   */
  const runLabelAssist = useCallback(async (): Promise<AiSuggestion[]> => {
    if (!projectId) {
      setState(prev => ({ ...prev, error: 'No project ID available' }));
      return [];
    }

    setState(prev => ({ ...prev, isRunning: true, error: null }));
    try {
      const response = await fetch('/api/inference/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectId,
          assetIds: [assetId],
        }),
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        const errorMsg = errorData.error || 'Inference failed';
        setState(prev => ({ ...prev, error: errorMsg, isRunning: false }));
        return [];
      }

      await response.json();

      // Re-fetch detections for this asset
      const detectionsResponse = await fetch(`/api/detections?assetId=${assetId}&all=true`);
      if (!detectionsResponse.ok) {
        setState(prev => ({ ...prev, isRunning: false }));
        return [];
      }

      const detections = await detectionsResponse.json();
      const mapped: AiSuggestion[] = (detections || []).map((det: {
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

      setState(prev => ({ ...prev, isRunning: false, error: null }));
      return mapped;
    } catch (err) {
      console.error('Label assist error:', err);
      setState(prev => ({ ...prev, error: 'Failed to run inference', isRunning: false }));
      return [];
    }
  }, [assetId, projectId]);

  /**
   * Convert a detection's bounding box to 4-point polygon coordinates
   */
  const bboxToPolygon = useCallback((bbox: { x: number; y: number; width: number; height: number }): [number, number][] => {
    // Bounding box is center-format: (x, y) is center, width/height are full dimensions
    const x1 = bbox.x - bbox.width / 2;
    const y1 = bbox.y - bbox.height / 2;
    const x2 = bbox.x + bbox.width / 2;
    const y2 = bbox.y + bbox.height / 2;
    return [[x1, y1], [x2, y1], [x2, y2], [x1, y2]];
  }, []);

  /**
   * Map a confidence score (0-1) to a confidence level string
   */
  const mapConfidence = useCallback((score: number | null): string => {
    if (score === null) return 'UNCERTAIN';
    if (score >= 0.8) return 'CERTAIN';
    if (score >= 0.5) return 'LIKELY';
    return 'UNCERTAIN';
  }, []);

  return {
    ...state,
    setConfidenceThreshold,
    runLabelAssist,
    bboxToPolygon,
    mapConfidence,
  };
}
