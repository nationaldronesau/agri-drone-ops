"use client";

import { Sparkles, Loader2, CheckCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface LabelAssistProps {
  onRun: () => void;
  onAcceptAll: () => void;
  isRunning: boolean;
  error: string | null;
  confidenceThreshold: number;
  onThresholdChange: (value: number) => void;
  suggestionsAboveThreshold: number;
  hasActiveModel: boolean;
  className?: string;
}

export function LabelAssist({
  onRun,
  onAcceptAll,
  isRunning,
  error,
  confidenceThreshold,
  onThresholdChange,
  suggestionsAboveThreshold,
  hasActiveModel,
  className,
}: LabelAssistProps) {
  return (
    <div className={cn("bg-gradient-to-r from-blue-50 to-indigo-50 border border-blue-200 rounded-lg p-3", className)}>
      <div className="text-xs font-medium text-blue-700 mb-2 flex items-center gap-1">
        <Sparkles className="h-3.5 w-3.5" />
        Label Assist
      </div>

      {!hasActiveModel ? (
        <p className="text-xs text-blue-600">
          No active model set for this project. Go to Project Settings to select a model.
        </p>
      ) : (
        <>
          <Button
            onClick={onRun}
            disabled={isRunning}
            size="sm"
            className="w-full bg-blue-500 hover:bg-blue-600 text-white text-xs h-8 mb-2"
          >
            {isRunning ? (
              <Loader2 className="w-3 h-3 mr-1 animate-spin" />
            ) : (
              <Sparkles className="w-3 h-3 mr-1" />
            )}
            {isRunning ? "Running..." : "Run Label Assist"}
          </Button>

          {/* Confidence threshold slider */}
          <div className="mb-2">
            <div className="flex items-center justify-between text-[11px] text-blue-700 mb-1">
              <span>Confidence threshold</span>
              <span className="font-mono">{(confidenceThreshold * 100).toFixed(0)}%</span>
            </div>
            <input
              type="range"
              min="10"
              max="90"
              value={confidenceThreshold * 100}
              onChange={(e) => onThresholdChange(parseInt(e.target.value) / 100)}
              className="w-full h-1.5 bg-blue-200 rounded-lg appearance-none cursor-pointer accent-blue-500"
            />
          </div>

          {/* Accept all above threshold */}
          {suggestionsAboveThreshold > 0 && (
            <Button
              onClick={onAcceptAll}
              disabled={isRunning}
              size="sm"
              variant="outline"
              className="w-full border-blue-300 text-blue-700 hover:bg-blue-50 text-xs h-7"
            >
              <CheckCheck className="w-3 h-3 mr-1" />
              Accept {suggestionsAboveThreshold} Above {(confidenceThreshold * 100).toFixed(0)}%
            </Button>
          )}

          {error && (
            <p className="text-xs text-red-600 mt-1">{error}</p>
          )}
        </>
      )}
    </div>
  );
}
