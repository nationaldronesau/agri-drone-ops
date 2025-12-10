"use client";

import { Trash2, Check, X, Upload, Loader2, CheckCheck, ArrowRight } from "lucide-react";
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
  onVerify?: (id: string) => void;
  onVerifyAll?: () => void;
  onPushToRoboflow?: () => void;
  isPushing?: boolean;
  className?: string;
}

export function AnnotationList({
  annotations,
  selectedId,
  onSelect,
  onDelete,
  onVerify,
  onVerifyAll,
  onPushToRoboflow,
  isPushing,
  className,
}: AnnotationListProps) {
  const unverifiedCount = annotations.filter(a => !a.verified).length;
  const verifiedCount = annotations.filter(a => a.verified && !a.pushedToTraining).length;
  const pushedCount = annotations.filter(a => a.pushedToTraining).length;
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

              {/* Status indicators and actions */}
              {annotation.pushedToTraining ? (
                <span className="text-[9px] bg-purple-100 text-purple-600 px-1 rounded flex items-center gap-0.5">
                  <Upload className="h-2 w-2" />
                  Pushed
                </span>
              ) : annotation.verified ? (
                <span className="text-[9px] bg-green-100 text-green-600 px-1 rounded flex items-center gap-0.5">
                  <Check className="h-2 w-2" />
                  OK
                </span>
              ) : onVerify ? (
                <div className="flex items-center gap-0.5">
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-5 w-5 p-0 text-green-500 hover:text-green-700 hover:bg-green-50"
                    onClick={(e) => {
                      e.stopPropagation();
                      onVerify(annotation.id);
                    }}
                    title="Accept annotation"
                  >
                    <Check className="h-3 w-3" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-5 w-5 p-0 text-red-500 hover:text-red-700 hover:bg-red-50"
                    onClick={(e) => {
                      e.stopPropagation();
                      onDelete(annotation.id);
                    }}
                    title="Reject annotation"
                  >
                    <X className="h-3 w-3" />
                  </Button>
                </div>
              ) : (
                <span className="text-[9px] bg-amber-100 text-amber-600 px-1 rounded">
                  Pending
                </span>
              )}

              {/* Delete button (only show on hover for verified/pushed) */}
              {(annotation.verified || annotation.pushedToTraining) && (
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
              )}
            </div>
          );
        })}
      </div>

      {/* Summary and Actions */}
      <div className="mt-2 pt-2 border-t border-gray-200 px-2 space-y-2">
        {/* Status summary */}
        <div className="flex items-center gap-2 text-[10px] text-gray-500">
          {unverifiedCount > 0 && (
            <span className="flex items-center gap-1">
              <span className="w-2 h-2 rounded-full bg-amber-400" />
              {unverifiedCount} pending
            </span>
          )}
          {verifiedCount > 0 && (
            <span className="flex items-center gap-1">
              <span className="w-2 h-2 rounded-full bg-green-400" />
              {verifiedCount} ready
            </span>
          )}
          {pushedCount > 0 && (
            <span className="flex items-center gap-1">
              <span className="w-2 h-2 rounded-full bg-purple-400" />
              {pushedCount} pushed
            </span>
          )}
        </div>

        {/* Workflow hint when there are pending annotations */}
        {unverifiedCount > 0 && verifiedCount === 0 && (
          <div className="bg-amber-50 border border-amber-200 rounded-md p-2">
            <p className="text-[10px] text-amber-700 leading-relaxed">
              <strong>Next step:</strong> Review each annotation using{" "}
              <Check className="inline h-3 w-3 text-green-600" /> to approve or{" "}
              <X className="inline h-3 w-3 text-red-500" /> to reject.
            </p>
          </div>
        )}

        {/* Verify All button - show when there are pending annotations */}
        {onVerifyAll && unverifiedCount > 0 && (
          <Button
            onClick={onVerifyAll}
            size="sm"
            variant="outline"
            className="w-full h-7 text-xs border-green-300 text-green-700 hover:bg-green-50 hover:border-green-400"
          >
            <CheckCheck className="h-3 w-3 mr-1" />
            Approve All {unverifiedCount} Annotations
          </Button>
        )}

        {/* Push to Roboflow button */}
        {onPushToRoboflow && verifiedCount > 0 && (
          <Button
            onClick={onPushToRoboflow}
            disabled={isPushing}
            size="sm"
            className="w-full h-7 text-xs bg-gradient-to-r from-purple-500 to-blue-500 hover:from-purple-600 hover:to-blue-600 text-white"
          >
            {isPushing ? (
              <>
                <Loader2 className="h-3 w-3 mr-1 animate-spin" />
                Pushing...
              </>
            ) : (
              <>
                <Upload className="h-3 w-3 mr-1" />
                Push {verifiedCount} to Roboflow
                <ArrowRight className="h-3 w-3 ml-1" />
              </>
            )}
          </Button>
        )}

        {/* Workflow complete message */}
        {pushedCount > 0 && unverifiedCount === 0 && verifiedCount === 0 && (
          <div className="bg-purple-50 border border-purple-200 rounded-md p-2">
            <p className="text-[10px] text-purple-700 leading-relaxed">
              <strong>Done!</strong> All annotations pushed to Roboflow for model training.
            </p>
          </div>
        )}

        {/* Legend */}
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
