"use client";

import { Wand2, Pencil, Square, Undo2, Redo2, Trash2, Check, HelpCircle, RectangleHorizontal, MousePointer2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { AnnotationMode } from "@/lib/hooks/useAnnotationHotkeys";

interface ToolButtonProps {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  hotkey?: string;
  active?: boolean;
  disabled?: boolean;
  onClick: () => void;
}

function ToolButton({
  icon: Icon,
  label,
  hotkey,
  active,
  disabled,
  onClick,
}: ToolButtonProps) {
  return (
    <Button
      variant={active ? "default" : "ghost"}
      size="sm"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "w-full justify-start gap-2 h-9",
        active && "bg-blue-500 hover:bg-blue-600 text-white"
      )}
      title={`${label}${hotkey ? ` (${hotkey})` : ""}`}
    >
      <Icon className="h-4 w-4" />
      <span className="flex-1 text-left text-sm">{label}</span>
      {hotkey && (
        <kbd className={cn(
          "px-1.5 py-0.5 text-[10px] font-mono rounded",
          active ? "bg-blue-600 text-blue-100" : "bg-gray-200 text-gray-600"
        )}>
          {hotkey}
        </kbd>
      )}
    </Button>
  );
}

interface ActionButtonProps {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  hotkey?: string;
  variant?: "default" | "destructive" | "success";
  disabled?: boolean;
  onClick: () => void;
}

function ActionButton({
  icon: Icon,
  label,
  hotkey,
  variant = "default",
  disabled,
  onClick,
}: ActionButtonProps) {
  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "w-full justify-start gap-2 h-8",
        variant === "destructive" && "text-red-600 hover:text-red-700 hover:bg-red-50",
        variant === "success" && "text-green-600 hover:text-green-700 hover:bg-green-50"
      )}
      title={`${label}${hotkey ? ` (${hotkey})` : ""}`}
    >
      <Icon className="h-4 w-4" />
      <span className="flex-1 text-left text-xs">{label}</span>
      {hotkey && (
        <kbd className="px-1 py-0.5 text-[9px] font-mono bg-gray-100 text-gray-500 rounded">
          {hotkey}
        </kbd>
      )}
    </Button>
  );
}

interface ToolbarProps {
  mode: AnnotationMode;
  onModeChange: (mode: AnnotationMode) => void;
  sam3Available?: boolean;
  sam3Loading?: boolean;
  onUndo?: () => void;
  onRedo?: () => void;
  onDelete?: () => void;
  onAccept?: () => void;
  onShowHelp?: () => void;
  canUndo?: boolean;
  canRedo?: boolean;
  canDelete?: boolean;
  canAccept?: boolean;
  className?: string;
}

export function Toolbar({
  mode,
  onModeChange,
  sam3Available = true,
  sam3Loading = false,
  onUndo,
  onRedo,
  onDelete,
  onAccept,
  onShowHelp,
  canUndo = false,
  canRedo = false,
  canDelete = false,
  canAccept = false,
  className,
}: ToolbarProps) {
  return (
    <div className={cn("w-48 flex flex-col gap-3", className)}>
      {/* Tool Mode Selection */}
      <div className="bg-gray-100 rounded-lg p-2 space-y-1">
        <div className="text-xs font-medium text-gray-500 px-2 pb-1">Tools</div>
        <ToolButton
          icon={Wand2}
          label="AI Segment"
          hotkey="S"
          active={mode === "sam3"}
          disabled={!sam3Available || sam3Loading}
          onClick={() => onModeChange("sam3")}
        />
        <ToolButton
          icon={Pencil}
          label="Manual"
          hotkey="P"
          active={mode === "manual"}
          onClick={() => onModeChange("manual")}
        />
        <ToolButton
          icon={RectangleHorizontal}
          label="Bbox"
          hotkey="R"
          active={mode === "bbox"}
          onClick={() => onModeChange("bbox")}
        />
        <ToolButton
          icon={MousePointer2}
          label="Select/Edit"
          hotkey="D"
          active={mode === "edit"}
          onClick={() => onModeChange("edit")}
        />
        <ToolButton
          icon={Square}
          label="Few-Shot"
          hotkey="B"
          active={mode === "box-exemplar"}
          disabled={!sam3Available || sam3Loading}
          onClick={() => onModeChange("box-exemplar")}
        />
      </div>

      {/* Quick Actions */}
      <div className="bg-gray-100 rounded-lg p-2 space-y-0.5">
        <div className="text-xs font-medium text-gray-500 px-2 pb-1">Actions</div>
        <ActionButton
          icon={Check}
          label="Accept"
          hotkey="Enter"
          variant="success"
          disabled={!canAccept}
          onClick={() => onAccept?.()}
        />
        <ActionButton
          icon={Undo2}
          label="Undo"
          hotkey="Ctrl+Z"
          disabled={!canUndo}
          onClick={() => onUndo?.()}
        />
        <ActionButton
          icon={Redo2}
          label="Redo"
          hotkey="Ctrl+Shift+Z"
          disabled={!canRedo}
          onClick={() => onRedo?.()}
        />
        <ActionButton
          icon={Trash2}
          label="Delete"
          hotkey="Del"
          variant="destructive"
          disabled={!canDelete}
          onClick={() => onDelete?.()}
        />
      </div>

      {/* Help */}
      <Button
        variant="ghost"
        size="sm"
        onClick={onShowHelp}
        className="w-full justify-start gap-2 h-8 text-gray-500 hover:text-gray-700"
      >
        <HelpCircle className="h-4 w-4" />
        <span className="flex-1 text-left text-xs">Shortcuts</span>
        <kbd className="px-1 py-0.5 text-[9px] font-mono bg-gray-100 text-gray-500 rounded">
          H
        </kbd>
      </Button>
    </div>
  );
}
