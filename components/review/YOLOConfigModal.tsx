'use client';

import { useMemo, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { sanitizeClassName } from '@/lib/services/dataset-preparation';

export interface YOLOTrainingConfig {
  datasetName: string;
  classes: string[];
  classMapping: Record<string, string>;
  splitRatio: { train: number; val: number; test: number };
  confidenceThreshold: number;
}

interface AvailableClass {
  name: string;
  count: number;
}

interface YOLOConfigModalProps {
  open: boolean;
  onClose: () => void;
  availableClasses: AvailableClass[];
  onConfirm: (config: YOLOTrainingConfig) => void;
}

export function YOLOConfigModal({
  open,
  onClose,
  availableClasses,
  onConfirm,
}: YOLOConfigModalProps) {
  const [datasetName, setDatasetName] = useState('review-session');
  const [confidenceThreshold, setConfidenceThreshold] = useState(0.5);
  const [splitRatio, setSplitRatio] = useState({ train: 0.7, val: 0.2, test: 0.1 });
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const classOptions = useMemo(() => {
    const map = new Map<string, string[]>();
    return availableClasses.map((cls) => {
      const sanitized = sanitizeClassName(cls.name);
      const existing = map.get(sanitized) || [];
      map.set(sanitized, [...existing, cls.name]);
      return {
        raw: cls.name,
        sanitized,
        count: cls.count,
        hasCollision: (map.get(sanitized) || []).length > 1,
      };
    });
  }, [availableClasses]);

  const selectedOptions = classOptions.filter((opt) => selected.has(opt.raw));
  const selectedSanitized = selectedOptions.map((opt) => opt.sanitized);
  const hasCollision = new Set(selectedSanitized).size !== selectedSanitized.length;

  const handleToggle = (raw: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(raw)) next.delete(raw);
      else next.add(raw);
      return next;
    });
  };

  const handleConfirm = () => {
    const classMapping: Record<string, string> = {};
    for (const option of selectedOptions) {
      classMapping[option.sanitized] = option.raw;
    }

    onConfirm({
      datasetName: datasetName.trim(),
      classes: selectedSanitized,
      classMapping,
      splitRatio,
      confidenceThreshold,
    });
  };

  return (
    <Dialog open={open} onOpenChange={(value) => !value && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>YOLO Training Configuration</DialogTitle>
          <DialogDescription>
            Select classes and split ratios for the YOLO dataset export.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1">
            <label className="text-sm font-medium text-gray-700">Dataset Name</label>
            <Input value={datasetName} onChange={(e) => setDatasetName(e.target.value)} />
          </div>

          <div className="space-y-2">
            <div className="text-sm font-medium text-gray-700">Classes</div>
            <div className="grid gap-2 md:grid-cols-2">
              {classOptions.map((option) => (
                <label
                  key={option.raw}
                  className="flex items-center gap-2 rounded-md border border-gray-200 px-3 py-2 text-sm"
                >
                  <Checkbox
                    checked={selected.has(option.raw)}
                    onCheckedChange={() => handleToggle(option.raw)}
                  />
                  <div className="flex flex-col">
                    <span>{option.raw}</span>
                    <span className="text-xs text-gray-500">
                      {option.count} annotations · {option.sanitized}
                    </span>
                  </div>
                </label>
              ))}
            </div>
            {hasCollision && (
              <div className="flex items-center gap-2 text-xs text-amber-600">
                <AlertTriangle className="h-3 w-3" />
                Resolve class name collisions before continuing.
              </div>
            )}
          </div>

          <div className="grid gap-3 md:grid-cols-3">
            <div className="space-y-1">
              <label className="text-xs font-medium text-gray-600">Train %</label>
              <Input
                type="number"
                min={0}
                max={1}
                step={0.05}
                value={splitRatio.train}
                onChange={(e) =>
                  setSplitRatio((prev) => ({
                    ...prev,
                    train: Number(e.target.value),
                  }))
                }
              />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium text-gray-600">Val %</label>
              <Input
                type="number"
                min={0}
                max={1}
                step={0.05}
                value={splitRatio.val}
                onChange={(e) =>
                  setSplitRatio((prev) => ({
                    ...prev,
                    val: Number(e.target.value),
                  }))
                }
              />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium text-gray-600">Test %</label>
              <Input
                type="number"
                min={0}
                max={1}
                step={0.05}
                value={splitRatio.test}
                onChange={(e) =>
                  setSplitRatio((prev) => ({
                    ...prev,
                    test: Number(e.target.value),
                  }))
                }
              />
            </div>
          </div>

          <div className="space-y-1">
            <label className="text-sm font-medium text-gray-700">Min Confidence</label>
            <Input
              type="number"
              min={0}
              max={1}
              step={0.05}
              value={confidenceThreshold}
              onChange={(e) => setConfidenceThreshold(Number(e.target.value))}
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            onClick={handleConfirm}
            disabled={!datasetName.trim() || selected.size === 0 || hasCollision}
          >
            Start Training
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
