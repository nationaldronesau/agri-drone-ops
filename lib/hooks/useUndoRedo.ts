"use client";

import { useState, useCallback, useRef } from "react";

export type UndoActionType = "CREATE_ANNOTATION" | "DELETE_ANNOTATION" | "MODIFY_ANNOTATION";

export interface UndoAction {
  type: UndoActionType;
  annotationId: string;
  /** For CREATE: full annotation data so we can delete it on undo */
  annotationData?: {
    sessionId: string;
    weedType: string;
    confidence: string;
    coordinates: [number, number][];
    notes?: string;
  };
  /** For MODIFY: coordinates before the edit */
  previousCoordinates?: [number, number][];
  /** For MODIFY: coordinates after the edit */
  newCoordinates?: [number, number][];
}

const MAX_STACK_SIZE = 50;

export function useUndoRedo() {
  const [undoStack, setUndoStack] = useState<UndoAction[]>([]);
  const [redoStack, setRedoStack] = useState<UndoAction[]>([]);
  const [isProcessing, setIsProcessing] = useState(false);
  // Increment on every push/pop to trigger dependent re-renders
  const [stackVersion, setStackVersion] = useState(0);
  const processingRef = useRef(false);

  const pushAction = useCallback((action: UndoAction) => {
    setUndoStack(prev => {
      const next = [...prev, action];
      return next.length > MAX_STACK_SIZE ? next.slice(-MAX_STACK_SIZE) : next;
    });
    // Clear redo stack on new action (standard undo/redo behavior)
    setRedoStack([]);
    setStackVersion(v => v + 1);
  }, []);

  const popUndo = useCallback((): UndoAction | null => {
    if (processingRef.current) return null;
    let action: UndoAction | null = null;
    setUndoStack(prev => {
      if (prev.length === 0) return prev;
      action = prev[prev.length - 1];
      return prev.slice(0, -1);
    });
    if (action) {
      setRedoStack(prev => [...prev, action!]);
      setStackVersion(v => v + 1);
    }
    return action;
  }, []);

  const popRedo = useCallback((): UndoAction | null => {
    if (processingRef.current) return null;
    let action: UndoAction | null = null;
    setRedoStack(prev => {
      if (prev.length === 0) return prev;
      action = prev[prev.length - 1];
      return prev.slice(0, -1);
    });
    if (action) {
      setUndoStack(prev => [...prev, action!]);
      setStackVersion(v => v + 1);
    }
    return action;
  }, []);

  const clearStacks = useCallback(() => {
    setUndoStack([]);
    setRedoStack([]);
    setStackVersion(v => v + 1);
  }, []);

  const setProcessing = useCallback((val: boolean) => {
    processingRef.current = val;
    setIsProcessing(val);
  }, []);

  return {
    pushAction,
    popUndo,
    popRedo,
    clearStacks,
    canUndo: undoStack.length > 0 && !isProcessing,
    canRedo: redoStack.length > 0 && !isProcessing,
    isProcessing,
    setProcessing,
    stackVersion,
  };
}
