"use client";

import { useEffect, useCallback } from "react";

export type AnnotationMode = "sam3" | "manual" | "bbox" | "box-exemplar" | "edit";

export interface HotkeyHandlers {
  onNextImage?: () => void;
  onPrevImage?: () => void;
  onModeChange?: (mode: AnnotationMode) => void;
  onClassSelect?: (index: number) => void;
  onAccept?: () => void;
  onCancel?: () => void;
  onDelete?: () => void;
  onUndo?: () => void;
  onRedo?: () => void;
  onZoomIn?: () => void;
  onZoomOut?: () => void;
  onResetView?: () => void;
  onToggleHelp?: () => void;
  disabled?: boolean;
}

/**
 * Global keyboard shortcuts for annotation interface
 *
 * Shortcuts:
 * - Arrow Left/Right: Previous/Next image
 * - S: SAM3 mode
 * - P: Manual polygon mode
 * - B: Bounding box mode
 * - 1-9: Select class by index
 * - 0: Select "Unknown" class
 * - Enter: Accept/Save annotation
 * - Escape: Cancel current action
 * - Delete/Backspace: Delete selected annotation
 * - Ctrl+Z / Cmd+Z: Undo last action
 * - +/=: Zoom in
 * - -: Zoom out
 * - Space: Reset view (fit to screen)
 * - H or ?: Show/hide hotkey reference
 */
export function useAnnotationHotkeys({
  onNextImage,
  onPrevImage,
  onModeChange,
  onClassSelect,
  onAccept,
  onCancel,
  onDelete,
  onUndo,
  onRedo,
  onZoomIn,
  onZoomOut,
  onResetView,
  onToggleHelp,
  disabled = false,
}: HotkeyHandlers) {
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (disabled) return;

      // Don't trigger if typing in input, textarea, or contenteditable
      const target = e.target as HTMLElement;
      if (
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target.isContentEditable
      ) {
        return;
      }

      // Handle modifier keys
      const isMod = e.ctrlKey || e.metaKey;

      switch (e.key) {
        // Image navigation
        case "ArrowLeft":
          e.preventDefault();
          onPrevImage?.();
          break;
        case "ArrowRight":
          e.preventDefault();
          onNextImage?.();
          break;

        // Mode selection
        case "s":
        case "S":
          if (!isMod) {
            e.preventDefault();
            onModeChange?.("sam3");
          }
          break;
        case "p":
        case "P":
          if (!isMod) {
            e.preventDefault();
            onModeChange?.("manual");
          }
          break;
        case "b":
        case "B":
          if (!isMod) {
            e.preventDefault();
            onModeChange?.("box-exemplar");
          }
          break;
        case "r":
        case "R":
          if (!isMod) {
            e.preventDefault();
            onModeChange?.("bbox");
          }
          break;
        case "d":
        case "D":
          if (!isMod) {
            e.preventDefault();
            onModeChange?.("edit");
          }
          break;

        // Class selection (1-9 for classes, 0 for Unknown)
        case "1":
        case "2":
        case "3":
        case "4":
        case "5":
        case "6":
        case "7":
        case "8":
        case "9":
        case "0":
          if (!isMod) {
            e.preventDefault();
            onClassSelect?.(parseInt(e.key));
          }
          break;

        // Actions
        case "Enter":
          e.preventDefault();
          onAccept?.();
          break;
        case "Escape":
          e.preventDefault();
          onCancel?.();
          break;
        case "Delete":
        case "Backspace":
          // Only prevent default if not in an input
          if (!isMod) {
            e.preventDefault();
            onDelete?.();
          }
          break;

        // Undo/Redo (Ctrl+Z / Ctrl+Shift+Z)
        case "z":
        case "Z":
          if (isMod) {
            e.preventDefault();
            if (e.shiftKey) {
              onRedo?.();
            } else {
              onUndo?.();
            }
          }
          break;

        // Zoom controls
        case "+":
        case "=":
          e.preventDefault();
          onZoomIn?.();
          break;
        case "-":
          e.preventDefault();
          onZoomOut?.();
          break;
        case " ": // Space
          e.preventDefault();
          onResetView?.();
          break;

        // Help
        case "h":
        case "H":
        case "?":
          if (!isMod) {
            e.preventDefault();
            onToggleHelp?.();
          }
          break;
      }
    },
    [
      disabled,
      onNextImage,
      onPrevImage,
      onModeChange,
      onClassSelect,
      onAccept,
      onCancel,
      onDelete,
      onUndo,
      onRedo,
      onZoomIn,
      onZoomOut,
      onResetView,
      onToggleHelp,
    ]
  );

  useEffect(() => {
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [handleKeyDown]);
}

/**
 * Hotkey definitions for display in help modal
 */
export const HOTKEY_DEFINITIONS = [
  { category: "Navigation", shortcuts: [
    { key: "←", action: "Previous image" },
    { key: "→", action: "Next image" },
  ]},
  { category: "Tools", shortcuts: [
    { key: "S", action: "SAM3 AI Segment mode" },
    { key: "P", action: "Manual polygon mode" },
    { key: "R", action: "Bounding box mode" },
    { key: "D", action: "Select/Edit mode" },
    { key: "B", action: "Few-Shot box mode" },
  ]},
  { category: "Classes", shortcuts: [
    { key: "1-9", action: "Select class by number" },
    { key: "0", action: "Select Unknown class" },
  ]},
  { category: "Actions", shortcuts: [
    { key: "Enter", action: "Accept/Save annotation" },
    { key: "Escape", action: "Cancel current action" },
    { key: "Delete", action: "Delete selected annotation" },
    { key: "Ctrl+Z", action: "Undo last action" },
    { key: "Ctrl+Shift+Z", action: "Redo" },
  ]},
  { category: "View", shortcuts: [
    { key: "+", action: "Zoom in" },
    { key: "-", action: "Zoom out" },
    { key: "Space", action: "Reset view (fit to screen)" },
    { key: "H", action: "Show/hide shortcuts" },
  ]},
];
