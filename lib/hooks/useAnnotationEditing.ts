"use client";

import { useState, useCallback, useRef } from "react";

interface EditState {
  annotationId: string | null;
  draggingVertexIndex: number | null;
  editedCoordinates: [number, number][] | null;
  originalCoordinates: [number, number][] | null;
}

/**
 * Check if 4 vertices form an axis-aligned bounding box
 */
function isBboxAnnotation(coords: [number, number][]): boolean {
  if (coords.length !== 4) return false;
  const xs = coords.map(c => c[0]);
  const ys = coords.map(c => c[1]);
  const uniqueX = new Set(xs.map(x => Math.round(x * 100) / 100));
  const uniqueY = new Set(ys.map(y => Math.round(y * 100) / 100));
  return uniqueX.size === 2 && uniqueY.size === 2;
}

export function useAnnotationEditing() {
  const [editState, setEditState] = useState<EditState>({
    annotationId: null,
    draggingVertexIndex: null,
    editedCoordinates: null,
    originalCoordinates: null,
  });
  const isDraggingRef = useRef(false);

  const startEdit = useCallback((annotationId: string, coordinates: [number, number][]) => {
    setEditState({
      annotationId,
      draggingVertexIndex: null,
      editedCoordinates: coordinates.map(c => [...c] as [number, number]),
      originalCoordinates: coordinates.map(c => [...c] as [number, number]),
    });
  }, []);

  const clearEdit = useCallback(() => {
    isDraggingRef.current = false;
    setEditState({
      annotationId: null,
      draggingVertexIndex: null,
      editedCoordinates: null,
      originalCoordinates: null,
    });
  }, []);

  /**
   * Find vertex near a point. Returns vertex index or -1.
   */
  const findVertexAt = useCallback((
    x: number,
    y: number,
    coordinates: [number, number][],
    hitRadius: number,
  ): number => {
    for (let i = 0; i < coordinates.length; i++) {
      const [vx, vy] = coordinates[i];
      const dist = Math.sqrt((x - vx) ** 2 + (y - vy) ** 2);
      if (dist <= hitRadius) return i;
    }
    return -1;
  }, []);

  const startDrag = useCallback((vertexIndex: number) => {
    isDraggingRef.current = true;
    setEditState(prev => ({ ...prev, draggingVertexIndex: vertexIndex }));
  }, []);

  const updateDrag = useCallback((x: number, y: number) => {
    if (!isDraggingRef.current) return;
    setEditState(prev => {
      if (prev.draggingVertexIndex === null || !prev.editedCoordinates) return prev;
      const newCoords = prev.editedCoordinates.map(c => [...c] as [number, number]);
      const idx = prev.draggingVertexIndex;

      if (isBboxAnnotation(prev.editedCoordinates)) {
        // Maintain rectangle shape: when dragging corner idx,
        // adjust adjacent corners to maintain axis-alignment
        // Vertices are ordered: TL(0), TR(1), BR(2), BL(3)
        newCoords[idx] = [x, y];
        // Maintain rectangle shape: adjust adjacent corners
        // Vertices ordered: TL(0), TR(1), BR(2), BL(3)
        if (idx === 0) {
          newCoords[3][0] = x;
          newCoords[1][1] = y;
        } else if (idx === 1) {
          newCoords[0][1] = y;
          newCoords[2][0] = x;
        } else if (idx === 2) {
          newCoords[1][0] = x;
          newCoords[3][1] = y;
        } else if (idx === 3) {
          newCoords[2][1] = y;
          newCoords[0][0] = x;
        }
      } else {
        // Free-form polygon: just move the single vertex
        newCoords[idx] = [x, y];
      }

      return { ...prev, editedCoordinates: newCoords };
    });
  }, []);

  const endDrag = useCallback((): { annotationId: string; previousCoordinates: [number, number][]; newCoordinates: [number, number][] } | null => {
    isDraggingRef.current = false;
    let result: { annotationId: string; previousCoordinates: [number, number][]; newCoordinates: [number, number][] } | null = null;

    setEditState(prev => {
      if (prev.annotationId && prev.originalCoordinates && prev.editedCoordinates && prev.draggingVertexIndex !== null) {
        result = {
          annotationId: prev.annotationId,
          previousCoordinates: prev.originalCoordinates,
          newCoordinates: prev.editedCoordinates,
        };
        // Keep editing but commit the coordinates as the new original
        return {
          ...prev,
          draggingVertexIndex: null,
          originalCoordinates: prev.editedCoordinates.map(c => [...c] as [number, number]),
        };
      }
      return { ...prev, draggingVertexIndex: null };
    });

    return result;
  }, []);

  return {
    editState,
    startEdit,
    clearEdit,
    findVertexAt,
    startDrag,
    updateDrag,
    endDrag,
    isDragging: isDraggingRef.current,
    editingAnnotationId: editState.annotationId,
    editedCoordinates: editState.editedCoordinates,
    draggingVertexIndex: editState.draggingVertexIndex,
  };
}
