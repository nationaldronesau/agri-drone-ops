"use client";

import { useState, useEffect, useCallback } from "react";
import { Plus, X } from "lucide-react";
import { cn } from "@/lib/utils";

export interface WeedClass {
  id: string;
  name: string;
  color: string;
  hotkey?: number;
}

// Default classes - used when no custom classes exist for the project
export const DEFAULT_WEED_CLASSES: WeedClass[] = [
  { id: "lantana", name: "Lantana", color: "#22c55e", hotkey: 1 },
  { id: "wattle", name: "Wattle", color: "#eab308", hotkey: 2 },
  { id: "bellyache", name: "Bellyache Bush", color: "#ef4444", hotkey: 3 },
  { id: "calitropis", name: "Calitropis", color: "#3b82f6", hotkey: 4 },
  { id: "pine", name: "Pine Sapling", color: "#a855f7", hotkey: 5 },
  { id: "unknown", name: "Unknown Weed", color: "#9ca3af", hotkey: 0 },
];

const PREDEFINED_COLORS = [
  "#22c55e", "#eab308", "#ef4444", "#3b82f6",
  "#a855f7", "#f97316", "#06b6d4", "#ec4899",
  "#14b8a6", "#6366f1",
];

interface ClassButtonProps {
  weedClass: WeedClass;
  active?: boolean;
  onClick: () => void;
}

function ClassButton({ weedClass, active, onClick }: ClassButtonProps) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "w-full flex items-center gap-2 px-2 py-1.5 rounded text-sm transition-all",
        "hover:bg-gray-200",
        active && "bg-gray-200 ring-2 ring-blue-500 ring-offset-1"
      )}
      title={`${weedClass.name}${weedClass.hotkey !== undefined ? ` (Press ${weedClass.hotkey})` : ""}`}
    >
      {/* Color indicator */}
      <div
        className="w-3 h-3 rounded flex-shrink-0"
        style={{ backgroundColor: weedClass.color }}
      />

      {/* Class name */}
      <span className="flex-1 text-left truncate">{weedClass.name}</span>

      {/* Hotkey badge */}
      {weedClass.hotkey !== undefined && (
        <kbd className={cn(
          "px-1.5 py-0.5 text-[10px] font-mono rounded min-w-[18px] text-center",
          active ? "bg-blue-500 text-white" : "bg-gray-100 text-gray-500"
        )}>
          {weedClass.hotkey}
        </kbd>
      )}
    </button>
  );
}

interface ClassSelectorProps {
  classes?: WeedClass[];
  projectId?: string;
  selectedClass: string;
  onClassSelect: (classId: string) => void;
  onClassesLoaded?: (classes: WeedClass[]) => void;
  className?: string;
}

export function ClassSelector({
  classes: externalClasses,
  projectId,
  selectedClass,
  onClassSelect,
  onClassesLoaded,
  className,
}: ClassSelectorProps) {
  const [loadedClasses, setLoadedClasses] = useState<WeedClass[] | null>(null);
  const [showAddForm, setShowAddForm] = useState(false);
  const [newClassName, setNewClassName] = useState("");
  const [newClassColor, setNewClassColor] = useState(PREDEFINED_COLORS[0]);
  const [isAdding, setIsAdding] = useState(false);
  const [classesError, setClassesError] = useState<string | null>(null);
  const [classesReloadKey, setClassesReloadKey] = useState(0);

  // Load classes from API when projectId is provided
  useEffect(() => {
    if (!projectId) return;
    let cancelled = false;

    const loadClasses = async () => {
      try {
        const response = await fetch(`/api/annotation-classes?projectId=${projectId}`);
        if (!response.ok) {
          const errorBody = await response.json().catch(() => null) as { error?: string; code?: string } | null;
          if (!cancelled) {
            setLoadedClasses(null);
            if (errorBody?.code?.includes('UNAVAILABLE')) {
              setClassesError('Project classes are temporarily unavailable. Using defaults for now.');
            } else {
              setClassesError(errorBody?.error || 'Failed to load project classes. Using defaults for now.');
            }
          }
          return;
        }

        const data = await response.json();
        if (!cancelled && Array.isArray(data) && data.length > 0) {
          const mapped: WeedClass[] = data.map((c: { id: string; name: string; color: string; sortOrder: number }, idx: number) => ({
            id: c.id,
            name: c.name,
            color: c.color,
            hotkey: idx < 9 ? idx + 1 : (idx === data.length - 1 && data.length <= 10 ? 0 : undefined),
          }));
          setLoadedClasses(mapped);
          setClassesError(null);
          onClassesLoaded?.(mapped);
        } else if (!cancelled) {
          setLoadedClasses(null);
          setClassesError(null);
        }
      } catch {
        if (!cancelled) {
          setLoadedClasses(null);
          setClassesError('Could not reach annotation classes service. Using defaults for now.');
        }
      }
    };

    loadClasses();
    return () => { cancelled = true; };
  }, [projectId, onClassesLoaded, classesReloadKey]);

  const classes = externalClasses || loadedClasses || DEFAULT_WEED_CLASSES;

  const handleAddClass = useCallback(async () => {
    if (!projectId || !newClassName.trim() || isAdding) return;

    setIsAdding(true);
    try {
      const response = await fetch('/api/annotation-classes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectId,
          name: newClassName.trim(),
          color: newClassColor,
        }),
      });

      if (response.ok) {
        const created = await response.json();
        setLoadedClasses(prev => {
          const currentClasses = prev || [];
          const newClass: WeedClass = {
            id: created.id,
            name: created.name,
            color: created.color,
            hotkey: currentClasses.length < 9 ? currentClasses.length + 1 : undefined,
          };
          return [...currentClasses, newClass];
        });
        setNewClassName("");
        setShowAddForm(false);
        setClassesError(null);
        onClassSelect(created.name);
      } else {
        const errorBody = await response.json().catch(() => null) as { error?: string } | null;
        setClassesError(errorBody?.error || 'Failed to add class. Please retry.');
      }
    } catch (err) {
      console.error('Failed to add class:', err);
      setClassesError('Failed to add class. Please retry.');
    } finally {
      setIsAdding(false);
    }
  }, [projectId, newClassName, newClassColor, isAdding, onClassSelect]);

  return (
    <div className={cn("bg-gray-100 rounded-lg p-2", className)}>
      <div className="flex items-center justify-between px-2 pb-2">
        <div className="text-xs font-medium text-gray-500">
          Classes
          <span className="text-gray-400 ml-1">(1-9 to select)</span>
        </div>
        {projectId && (
          <button
            onClick={() => setShowAddForm(!showAddForm)}
            className="text-gray-400 hover:text-blue-500 transition-colors"
            title="Add class"
          >
            {showAddForm ? <X className="h-3.5 w-3.5" /> : <Plus className="h-3.5 w-3.5" />}
          </button>
        )}
      </div>

      {/* Inline add form */}
      {showAddForm && projectId && (
        <div className="mx-1 mb-2 p-2 bg-white rounded border border-gray-200">
          <input
            type="text"
            value={newClassName}
            onChange={(e) => setNewClassName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleAddClass();
              if (e.key === 'Escape') setShowAddForm(false);
            }}
            placeholder="Class name..."
            className="w-full text-sm px-2 py-1 border border-gray-200 rounded mb-2 focus:outline-none focus:ring-1 focus:ring-blue-500"
            autoFocus
          />
          <div className="flex flex-wrap gap-1 mb-2">
            {PREDEFINED_COLORS.map((color) => (
              <button
                key={color}
                onClick={() => setNewClassColor(color)}
                className={cn(
                  "w-5 h-5 rounded-full border-2 transition-all",
                  newClassColor === color ? "border-blue-500 scale-110" : "border-transparent"
                )}
                style={{ backgroundColor: color }}
              />
            ))}
          </div>
          <button
            onClick={handleAddClass}
            disabled={!newClassName.trim() || isAdding}
            className="w-full text-xs py-1 bg-blue-500 text-white rounded hover:bg-blue-600 disabled:opacity-50"
          >
            {isAdding ? "Adding..." : "Add Class"}
          </button>
        </div>
      )}

      {classesError && projectId && (
        <div className="mx-1 mb-2 rounded border border-amber-200 bg-amber-50 p-2 text-[11px] text-amber-800">
          <div>{classesError}</div>
          <button
            type="button"
            onClick={() => setClassesReloadKey((prev) => prev + 1)}
            className="mt-1 text-amber-900 underline underline-offset-2"
          >
            Retry loading classes
          </button>
        </div>
      )}

      <div className="space-y-0.5">
        {classes.map((weedClass) => (
          <ClassButton
            key={weedClass.id}
            weedClass={weedClass}
            active={selectedClass === weedClass.id || selectedClass === weedClass.name}
            onClick={() => onClassSelect(weedClass.name)}
          />
        ))}
      </div>
    </div>
  );
}

/**
 * Get class by hotkey number
 */
export function getClassByHotkey(
  hotkey: number,
  classes: WeedClass[] = DEFAULT_WEED_CLASSES
): WeedClass | undefined {
  return classes.find((c) => c.hotkey === hotkey);
}

/**
 * Get color for a class name
 */
export function getClassColor(
  className: string,
  classes: WeedClass[] = DEFAULT_WEED_CLASSES
): string {
  const found = classes.find(
    (c) => c.name.toLowerCase() === className.toLowerCase() || c.id === className
  );
  return found?.color || "#9ca3af";
}
