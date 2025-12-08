"use client";

import { cn } from "@/lib/utils";

export interface WeedClass {
  id: string;
  name: string;
  color: string;
  hotkey?: number;
}

// Default classes - can be overridden with Roboflow-synced classes
export const DEFAULT_WEED_CLASSES: WeedClass[] = [
  { id: "lantana", name: "Lantana", color: "#22c55e", hotkey: 1 },
  { id: "wattle", name: "Wattle", color: "#eab308", hotkey: 2 },
  { id: "bellyache", name: "Bellyache Bush", color: "#ef4444", hotkey: 3 },
  { id: "calitropis", name: "Calitropis", color: "#3b82f6", hotkey: 4 },
  { id: "pine", name: "Pine Sapling", color: "#a855f7", hotkey: 5 },
  { id: "unknown", name: "Unknown Weed", color: "#9ca3af", hotkey: 0 },
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
  selectedClass: string;
  onClassSelect: (classId: string) => void;
  className?: string;
}

export function ClassSelector({
  classes = DEFAULT_WEED_CLASSES,
  selectedClass,
  onClassSelect,
  className,
}: ClassSelectorProps) {
  return (
    <div className={cn("bg-gray-100 rounded-lg p-2", className)}>
      <div className="text-xs font-medium text-gray-500 px-2 pb-2">
        Classes
        <span className="text-gray-400 ml-1">(1-9 to select)</span>
      </div>
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
