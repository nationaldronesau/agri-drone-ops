'use client';

import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, CheckCircle2, XCircle, Pencil } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { InteractiveDetectionOverlay } from '@/components/training/InteractiveDetectionOverlay';

type ReviewStatus = 'pending' | 'accepted' | 'rejected';

export interface ReviewItemAsset {
  id: string;
  fileName: string;
  storageUrl: string;
  imageWidth?: number | null;
  imageHeight?: number | null;
  gpsLatitude?: number | null;
  gpsLongitude?: number | null;
  altitude?: number | null;
  gimbalPitch?: number | null;
  gimbalRoll?: number | null;
  gimbalYaw?: number | null;
}

export interface ReviewItem {
  id: string;
  source: 'manual' | 'pending' | 'detection';
  sourceId: string;
  assetId: string;
  asset: ReviewItemAsset;
  className: string;
  confidence: number;
  geometry: {
    type: 'polygon' | 'bbox';
    polygon?: number[][];
    bbox?: [number, number, number, number];
    bboxCenter?: { x: number; y: number; width: number; height: number };
  };
  status: ReviewStatus;
  correctedClass?: string | null;
  hasGeoData: boolean;
  warnings: string[];
}

interface ReviewViewerProps {
  items: ReviewItem[];
  onAction: (item: ReviewItem, action: 'accept' | 'reject' | 'correct', correctedClass?: string) => Promise<void>;
  onEdit: (item: ReviewItem) => void;
}

export function ReviewViewer({ items, onAction, onEdit }: ReviewViewerProps) {
  const groupedAssets = useMemo(() => {
    const map = new Map<string, { asset: ReviewItemAsset; items: ReviewItem[] }>();
    for (const item of items) {
      if (!map.has(item.assetId)) {
        map.set(item.assetId, { asset: item.asset, items: [] });
      }
      map.get(item.assetId)!.items.push(item);
    }
    return Array.from(map.values());
  }, [items]);

  const [currentIndex, setCurrentIndex] = useState(0);
  const [corrections, setCorrections] = useState<Record<string, string>>({});

  useEffect(() => {
    if (currentIndex >= groupedAssets.length) {
      setCurrentIndex(0);
    }
  }, [currentIndex, groupedAssets.length]);

  const currentGroup = groupedAssets[currentIndex];
  const currentItems = currentGroup?.items || [];

  const classOptions = useMemo(() => {
    const unique = new Set(items.map((item) => item.className));
    return Array.from(unique.values()).sort();
  }, [items]);

  const overlayItems = currentItems
    .filter((item) => item.geometry.bbox)
    .map((item) => ({
      id: item.id,
      status: item.status.toUpperCase() as 'PENDING' | 'ACCEPTED' | 'REJECTED',
      confidence: item.confidence,
      weedType: item.className,
      bbox: item.geometry.bbox as number[],
    }));

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-[240px_minmax(0,1fr)_320px] xl:grid-cols-[280px_minmax(0,1fr)_360px]">
      <div className="space-y-3">
        <div className="text-sm font-semibold text-gray-700">Assets</div>
        <div className="space-y-2">
          {groupedAssets.map((group, index) => (
            <button
              key={group.asset.id}
              onClick={() => setCurrentIndex(index)}
              className={`w-full rounded-lg border px-3 py-2 text-left text-sm transition ${
                index === currentIndex ? 'border-blue-500 bg-blue-50' : 'border-gray-200 hover:bg-gray-50'
              }`}
            >
              <div className="font-medium text-gray-900">{group.asset.fileName}</div>
              <div className="text-xs text-gray-500">{group.items.length} items</div>
            </button>
          ))}
        </div>
      </div>

      <div className="space-y-4">
        {currentGroup ? (
          <InteractiveDetectionOverlay
            imageUrl={currentGroup.asset.storageUrl}
            detections={overlayItems}
            onAccept={(id) => {
              const item = currentItems.find((entry) => entry.id === id);
              if (item) onAction(item, 'accept');
            }}
            onReject={(id) => {
              const item = currentItems.find((entry) => entry.id === id);
              if (item) onAction(item, 'reject');
            }}
            imageWidth={currentGroup.asset.imageWidth || undefined}
            imageHeight={currentGroup.asset.imageHeight || undefined}
          />
        ) : (
          <div className="rounded-lg border border-dashed p-6 text-center text-sm text-gray-500">
            No assets in this review session.
          </div>
        )}
        <div className="flex items-center justify-between text-sm text-gray-500">
          <span>
            {currentIndex + 1} of {groupedAssets.length} assets
          </span>
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={currentIndex === 0}
              onClick={() => setCurrentIndex((prev) => Math.max(0, prev - 1))}
            >
              Previous
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={currentIndex >= groupedAssets.length - 1}
              onClick={() =>
                setCurrentIndex((prev) => Math.min(groupedAssets.length - 1, prev + 1))
              }
            >
              Next
            </Button>
          </div>
        </div>
      </div>

      <div className="space-y-4">
        <div className="text-sm font-semibold text-gray-700">Review Items</div>
        {currentItems.length === 0 ? (
          <div className="rounded-lg border border-dashed p-4 text-sm text-gray-500">
            No items for this asset.
          </div>
        ) : (
          <div className="space-y-3">
            {currentItems.map((item) => {
              const warningText = item.warnings.join('; ');
              return (
                <div key={item.id} className="rounded-lg border border-gray-200 p-3">
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <div className="text-sm font-semibold text-gray-900">{item.className}</div>
                      <div className="text-xs text-gray-500">
                        {Math.round(item.confidence * 100)}% confidence · {item.source}
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      {item.status === 'accepted' && <CheckCircle2 className="h-4 w-4 text-green-500" />}
                      {item.status === 'rejected' && <XCircle className="h-4 w-4 text-red-500" />}
                      {item.warnings.length > 0 && (
                        <AlertTriangle
                          className="h-4 w-4 text-amber-500"
                          title={warningText}
                        />
                      )}
                    </div>
                  </div>

                  <div className="mt-3 grid gap-2">
                    <Select
                      value={corrections[item.id] || ''}
                      onValueChange={(value) =>
                        setCorrections((prev) => ({ ...prev, [item.id]: value }))
                      }
                    >
                      <SelectTrigger className="h-8">
                        <SelectValue placeholder="Correct class" />
                      </SelectTrigger>
                      <SelectContent>
                        {classOptions.map((option) => (
                          <SelectItem key={option} value={option}>
                            {option}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>

                    <div className="flex flex-wrap gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => onAction(item, 'accept')}
                      >
                        Accept
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => onAction(item, 'reject')}
                      >
                        Reject
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => onAction(item, 'correct', corrections[item.id])}
                        disabled={!corrections[item.id]}
                      >
                        Correct
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => onEdit(item)}
                      >
                        <Pencil className="mr-1 h-3 w-3" />
                        Edit Geometry
                      </Button>
                    </div>

                    {!item.hasGeoData && (
                      <div className="text-xs text-amber-600">
                        Coordinates will be computed at export.
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
