'use client';

import { useEffect, useMemo, useState } from 'react';
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

export type YOLOTrainingIntent = 'update_existing' | 'new_class';

export interface YOLOTrainingConfig {
  trainingIntent: YOLOTrainingIntent;
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
  minConfidence?: number;
  pendingOnly?: boolean;
  onPendingOnlyChange?: (value: boolean) => void;
  onConfirm: (config: YOLOTrainingConfig) => void;
}

export function YOLOConfigModal({
  open,
  onClose,
  availableClasses,
  minConfidence,
  pendingOnly,
  onPendingOnlyChange,
  onConfirm,
}: YOLOConfigModalProps) {
  const [datasetName, setDatasetName] = useState('review-session');
  const [trainingIntent, setTrainingIntent] = useState<YOLOTrainingIntent>('update_existing');
  const [confidenceThreshold, setConfidenceThreshold] = useState(0.5);
  const [splitRatio, setSplitRatio] = useState({ train: 0.7, val: 0.2, test: 0.1 });
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const confidenceLocked = typeof minConfidence === 'number' && Number.isFinite(minConfidence);

  useEffect(() => {
    if (typeof minConfidence === 'number' && Number.isFinite(minConfidence)) {
      setConfidenceThreshold(Math.min(1, Math.max(0, minConfidence)));
    }
  }, [minConfidence]);

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
      trainingIntent,
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
          <DialogTitle>Send accepted labels to YOLO</DialogTitle>
          <DialogDescription>
            Choose whether this is a model update or a new class/model. Only accepted and corrected
            labels are eligible; pending and rejected review items stay out.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="grid gap-2 md:grid-cols-2">
            {[
              {
                value: 'update_existing' as const,
                title: 'Update existing model',
                body:
                  'Create a new YOLO dataset/version from the accepted labels. Keep the current active model until the new checkpoint is reviewed.',
              },
              {
                value: 'new_class' as const,
                title: 'Create new label/class',
                body:
                  'Bootstrap a new class or separate model path from this review session. Use this when the species is not already in the model.',
              },
            ].map((option) => (
              <button
                key={option.value}
                type="button"
                onClick={() => setTrainingIntent(option.value)}
                className={`rounded-lg border px-3 py-3 text-left transition ${
                  trainingIntent === option.value
                    ? 'border-green-500 bg-green-50 text-green-900'
                    : 'border-gray-200 bg-white text-gray-700 hover:bg-gray-50'
                }`}
              >
                <div className="text-sm font-semibold">{option.title}</div>
                <p className="mt-1 text-xs leading-5">{option.body}</p>
              </button>
            ))}
          </div>

          {typeof pendingOnly === 'boolean' && onPendingOnlyChange && (
            <div className="flex items-center justify-between rounded-md border border-gray-200 px-3 py-2 text-sm">
              <div className="flex flex-col">
                <span className="font-medium text-gray-700">Review filter</span>
                <span className="text-xs text-gray-500">
                  Adjust what you see before creating training data.
                </span>
              </div>
              <label className="flex items-center gap-2">
                <Checkbox
                  checked={pendingOnly}
                  onCheckedChange={(value) => onPendingOnlyChange(Boolean(value))}
                />
                <span className="text-sm text-gray-700">Pending only</span>
              </label>
            </div>
          )}
          <div className="space-y-1">
            <label className="text-sm font-medium text-gray-700">Dataset Name</label>
            <Input value={datasetName} onChange={(e) => setDatasetName(e.target.value)} />
            <p className="text-xs text-gray-500">
              This creates a new dataset/checkpoint. Activation remains a separate step so the
              previous production model can be rolled back if metrics or field QA worsen.
            </p>
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
              <label className="text-xs font-medium text-gray-600">Train ratio</label>
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
              <label className="text-xs font-medium text-gray-600">Val ratio</label>
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
              <label className="text-xs font-medium text-gray-600">Test ratio</label>
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
            <label className="text-sm font-medium text-gray-700">
              Min Confidence{confidenceLocked ? ' (from review filter)' : ''}
            </label>
            {confidenceLocked ? (
              <div className="rounded-md border border-gray-200 bg-gray-50 px-3 py-2 text-sm text-gray-700">
                {Math.round(confidenceThreshold * 100)}%
              </div>
            ) : (
              <Input
                type="number"
                min={0}
                max={1}
                step={0.05}
                value={confidenceThreshold}
                onChange={(e) => setConfidenceThreshold(Number(e.target.value))}
              />
            )}
            <p className="text-xs text-gray-500">
              Current threshold is applied to accepted SAM3 and reviewed AI labels in this training
              dataset. Lower thresholds increase recall but require stronger human QA first.
            </p>
          </div>

          <div className="rounded-md border border-blue-200 bg-blue-50 px-3 py-2 text-xs leading-5 text-blue-800">
            Recommended workflow: accept or correct the SAM3 labels in review, create the YOLO
            checkpoint, compare it against the active model, then activate only if it improves.
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
            Create YOLO training run
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
