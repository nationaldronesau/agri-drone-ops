"use client";

import { Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { getClassColor } from "./ClassSelector";

interface Annotation {
  id: string;
  weedType: string;
  confidence: string;
  notes?: string;
  verified?: boolean;
  pushedToTraining?: boolean;
}

interface AnnotationListProps {
  annotations: Annotation[];
  selectedId?: string | null;
  onSelect: (id: string | null) => void;
  onDelete: (id: string) => void;
  className?: string;
}

export function AnnotationList({
  annotations,
  selectedId,
  onSelect,
  onDelete,
  className,
}: AnnotationListProps) {
  if (annotations.length === 0) {
    return (
      <div className={cn("bg-gray-100 rounded-lg p-3", className)}>
        <div className="text-xs font-medium text-gray-500 mb-2">
          Annotations
        </div>
        <p className="text-xs text-gray-400 text-center py-4">
          No annotations yet.
          <br />
          Click on the image to start.
        </p>
      </div>
    );
  }

  return (
    <div className={cn("bg-gray-100 rounded-lg p-2", className)}>
      <div className="text-xs font-medium text-gray-500 px-2 pb-2">
        Annotations
        <span className="text-gray-400 ml-1">({annotations.length})</span>
      </div>
      <div className="space-y-0.5 max-h-64 overflow-y-auto">
        {annotations.map((annotation, index) => {
          const isSelected = selectedId === annotation.id;
          const color = getClassColor(annotation.weedType);

          return (
            <div
              key={annotation.id}
              className={cn(
                "group flex items-center gap-2 px-2 py-1.5 rounded cursor-pointer transition-all",
                isSelected
                  ? "bg-blue-100 ring-1 ring-blue-300"
                  : "hover:bg-gray-200"
              )}
              onClick={() => onSelect(isSelected ? null : annotation.id)}
            >
              {/* Index and color */}
              <div className="flex items-center gap-1.5 flex-shrink-0">
                <span className="text-[10px] text-gray-400 w-3 text-right">
                  {index + 1}
                </span>
                <div
                  className="w-2.5 h-2.5 rounded"
                  style={{ backgroundColor: color }}
                />
              </div>

              {/* Class name */}
              <span className="flex-1 text-sm truncate">
                {annotation.weedType.replace("Suspected ", "")}
              </span>

              {/* Confidence badge */}
              <span className={cn(
                "text-[10px] px-1 py-0.5 rounded",
                annotation.confidence === "CERTAIN" && "bg-green-100 text-green-700",
                annotation.confidence === "LIKELY" && "bg-yellow-100 text-yellow-700",
                annotation.confidence === "UNCERTAIN" && "bg-gray-200 text-gray-600"
              )}>
                {annotation.confidence.slice(0, 1)}
              </span>

              {/* Status indicators */}
              {annotation.pushedToTraining && (
                <span className="text-[9px] bg-purple-100 text-purple-600 px-1 rounded">
                  T
                </span>
              )}
              {annotation.verified && !annotation.pushedToTraining && (
                <span className="text-[9px] bg-blue-100 text-blue-600 px-1 rounded">
                  V
                </span>
              )}

              {/* Delete button */}
              <Button
                variant="ghost"
                size="sm"
                className="h-5 w-5 p-0 opacity-0 group-hover:opacity-100 transition-opacity text-red-500 hover:text-red-700 hover:bg-red-50"
                onClick={(e) => {
                  e.stopPropagation();
                  onDelete(annotation.id);
                }}
              >
                <Trash2 className="h-3 w-3" />
              </Button>
            </div>
          );
        })}
      </div>

      {/* Legend */}
      <div className="mt-2 pt-2 border-t border-gray-200 px-2">
        <div className="flex items-center gap-3 text-[10px] text-gray-400">
          <span className="flex items-center gap-1">
            <span className="px-1 bg-green-100 text-green-700 rounded">C</span>
            Certain
          </span>
          <span className="flex items-center gap-1">
            <span className="px-1 bg-yellow-100 text-yellow-700 rounded">L</span>
            Likely
          </span>
          <span className="flex items-center gap-1">
            <span className="px-1 bg-gray-200 text-gray-600 rounded">U</span>
            Unsure
          </span>
        </div>
      </div>
    </div>
  );
}
