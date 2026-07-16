'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import {
  AlertTriangle,
  CheckCircle2,
  XCircle,
  Pencil,
  ZoomIn,
  ZoomOut,
  RotateCcw,
  Image as ImageIcon,
  MapPinned,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { InteractiveDetectionOverlay } from '@/components/training/InteractiveDetectionOverlay';
import {
  calculatePolygonBoxIoU,
  GEOMETRY_MISMATCH_IOU_THRESHOLD,
  getValidPolygon,
} from '@/lib/utils/detection-geometry';
import { isReviewMaskOverlayEnabled } from '@/lib/utils/feature-flags';

type ReviewStatus = 'pending' | 'accepted' | 'rejected';

const ReviewGeoMap = dynamic(() => import('@/components/review/ReviewGeoMap'), {
  ssr: false,
  loading: () => (
    <div className="flex h-[600px] items-center justify-center rounded-lg border text-sm text-gray-500">
      Loading satellite map...
    </div>
  ),
});

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
  centerLat?: number | null;
  centerLon?: number | null;
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
  assets?: ReviewItemAsset[];
  onAction: (item: ReviewItem, action: 'accept' | 'reject' | 'correct' | 'restore', correctedClass?: string) => Promise<void>;
  onEdit: (item: ReviewItem) => void;
}

export function ReviewViewer({ items, assets = [], onAction, onEdit }: ReviewViewerProps) {
  const maskOverlayEnabled = isReviewMaskOverlayEnabled();
  const groupedAssets = useMemo(() => {
    const map = new Map<string, { asset: ReviewItemAsset; items: ReviewItem[] }>();
    for (const asset of assets) {
      map.set(asset.id, { asset, items: [] });
    }
    for (const item of items) {
      if (!map.has(item.assetId)) {
        map.set(item.assetId, { asset: item.asset, items: [] });
      }
      map.get(item.assetId)!.items.push(item);
    }
    return Array.from(map.values());
  }, [assets, items]);

  const [currentIndex, setCurrentIndex] = useState(0);
  const [corrections, setCorrections] = useState<Record<string, string>>({});
  const [zoomLevel, setZoomLevel] = useState(1);
  const [panOffset, setPanOffset] = useState({ x: 0, y: 0 });
  const [viewMode, setViewMode] = useState<'image' | 'map'>('image');
  const [selectedItemId, setSelectedItemId] = useState<string | null>(null);
  const reviewItemRefs = useRef<Record<string, HTMLDivElement | null>>({});

  useEffect(() => {
    if (currentIndex >= groupedAssets.length) {
      setCurrentIndex(0);
    }
  }, [currentIndex, groupedAssets.length]);

  const currentGroup = groupedAssets[currentIndex];
  const currentItems = useMemo(() => currentGroup?.items || [], [currentGroup]);

  useEffect(() => {
    setZoomLevel(1);
    setPanOffset({ x: 0, y: 0 });
    setSelectedItemId(null);
  }, [currentGroup?.asset.id]);

  useEffect(() => {
    if (!selectedItemId) return;
    reviewItemRefs.current[selectedItemId]?.scrollIntoView({
      behavior: 'smooth',
      block: 'center',
    });
  }, [selectedItemId]);

  const handleZoomIn = () => setZoomLevel((prev) => Math.min(prev * 1.2, 5));
  const handleZoomOut = () => setZoomLevel((prev) => Math.max(prev / 1.2, 0.1));
  const handleResetView = () => {
    setZoomLevel(1);
    setPanOffset({ x: 0, y: 0 });
  };

  const classOptions = useMemo(() => {
    const unique = new Set(items.map((item) => item.className));
    return Array.from(unique.values()).sort();
  }, [items]);

  const geometryInsights = useMemo(() => {
    const insights = new Map<
      string,
      { polygon: [number, number][] | null; bboxPolygonIou: number | null }
    >();
    if (!maskOverlayEnabled) return insights;

    for (const item of currentItems) {
      const polygon = getValidPolygon(item.geometry.polygon);
      insights.set(item.id, {
        polygon,
        bboxPolygonIou: polygon
          ? calculatePolygonBoxIoU(item.geometry.bbox, polygon)
          : null,
      });
    }

    return insights;
  }, [currentItems, maskOverlayEnabled]);

  const overlayItems = currentItems
    .filter((item) => item.geometry.bbox || geometryInsights.get(item.id)?.polygon)
    .map((item) => {
      const geometry = geometryInsights.get(item.id);
      return {
        id: item.id,
        status: item.status.toUpperCase() as 'PENDING' | 'ACCEPTED' | 'REJECTED',
        confidence: item.confidence,
        weedType: item.className,
        bbox: item.geometry.bbox,
        polygon: geometry?.polygon ?? undefined,
        bboxPolygonIou: geometry?.bboxPolygonIou ?? null,
      };
    });

  const currentAssetGeoCount = currentItems.filter(
    (item) =>
      typeof item.centerLat === 'number' &&
      typeof item.centerLon === 'number' &&
      Number.isFinite(item.centerLat) &&
      Number.isFinite(item.centerLon)
  ).length;

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-[220px_minmax(0,1fr)_360px] xl:grid-cols-[260px_minmax(0,1fr)_420px] 2xl:grid-cols-[280px_minmax(0,1fr)_480px]">
      <div className="space-y-3 lg:sticky lg:top-4 lg:max-h-[calc(100vh-2rem)] lg:overflow-y-auto lg:pr-1">
        <div className="text-sm font-semibold text-gray-700">Assets</div>
        <div className="space-y-2">
          {groupedAssets.map((group, index) => (
            <button
              key={group.asset.id}
              onClick={() => setCurrentIndex(index)}
              className={`w-full rounded-lg border px-3 py-2 text-left text-sm transition ${
                index === currentIndex ? 'border-blue-500 bg-blue-50' : 'border-gray-200 hover:bg-gray-50'
              }`}
              title={group.asset.fileName}
            >
              <div className="truncate font-medium text-gray-900">{group.asset.fileName}</div>
              <div className="text-xs text-gray-500">{group.items.length} items</div>
            </button>
          ))}
        </div>
      </div>

      <div className="space-y-4">
        <div className="flex items-center justify-between rounded-lg border border-gray-200 bg-white px-3 py-2">
          <div className="text-sm font-semibold text-gray-700">Visual Review</div>
          <div className="flex items-center gap-2">
            <Button
              variant={viewMode === 'image' ? 'default' : 'outline'}
              size="sm"
              onClick={() => setViewMode('image')}
              className="h-8 gap-1"
            >
              <ImageIcon className="h-3.5 w-3.5" />
              Image
            </Button>
            <Button
              variant={viewMode === 'map' ? 'default' : 'outline'}
              size="sm"
              onClick={() => setViewMode('map')}
              className="h-8 gap-1"
            >
              <MapPinned className="h-3.5 w-3.5" />
              Map
            </Button>
          </div>
        </div>

        {currentGroup ? (
          viewMode === 'image' ? (
            <InteractiveDetectionOverlay
              imageUrl={currentGroup.asset.storageUrl}
              detections={overlayItems}
              selectedDetectionId={selectedItemId}
              onSelectDetection={setSelectedItemId}
              imageWidth={currentGroup.asset.imageWidth || undefined}
              imageHeight={currentGroup.asset.imageHeight || undefined}
              zoomLevel={zoomLevel}
              panOffset={panOffset}
              onPanOffsetChange={setPanOffset}
              showMaskOverlay={maskOverlayEnabled}
            />
          ) : (
            <ReviewGeoMap items={items} selectedAssetId={currentGroup.asset.id} />
          )
        ) : (
          <div className="rounded-lg border border-dashed p-6 text-center text-sm text-gray-500">
            No assets in this review session.
          </div>
        )}
        <div className="flex items-center justify-between rounded-lg border border-gray-200 bg-white px-4 py-2 text-sm text-gray-500">
          {viewMode === 'image' ? (
            <div className="flex items-center gap-2">
              <Button variant="ghost" size="sm" onClick={handleZoomOut} className="h-8 w-8 p-0">
                <ZoomOut className="h-4 w-4" />
              </Button>
              <span className="text-xs text-gray-500 w-12 text-center">
                {Math.round(zoomLevel * 100)}%
              </span>
              <Button variant="ghost" size="sm" onClick={handleZoomIn} className="h-8 w-8 p-0">
                <ZoomIn className="h-4 w-4" />
              </Button>
              <Button variant="ghost" size="sm" onClick={handleResetView} className="h-8 px-2">
                <RotateCcw className="h-4 w-4 mr-1" />
                <span className="text-xs">Fit</span>
              </Button>
            </div>
          ) : (
            <span className="text-xs text-gray-500">
              {currentAssetGeoCount} of {currentItems.length} items geolocated for this asset
            </span>
          )}
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

      <div className="space-y-3 lg:sticky lg:top-4 lg:max-h-[calc(100vh-2rem)] lg:overflow-y-auto lg:pr-1">
        <div className="flex items-center justify-between gap-3">
          <div className="text-sm font-semibold text-gray-700">Review Items</div>
          <div className="rounded-full bg-gray-100 px-2 py-0.5 text-xs text-gray-500">
            {currentItems.length} on image
          </div>
        </div>
        {currentItems.length === 0 ? (
          <div className="rounded-lg border border-dashed p-4 text-sm text-gray-500">
            No items for this asset.
          </div>
        ) : (
          <div className="space-y-2">
            {currentItems.map((item) => {
              const warningText = item.warnings.join('; ');
              const isSelected = selectedItemId === item.id;
              const geometry = geometryInsights.get(item.id);
              const isBoxOnly =
                maskOverlayEnabled && Boolean(item.geometry.bbox) && !geometry?.polygon;
              const hasGeometryMismatch =
                maskOverlayEnabled &&
                geometry?.bboxPolygonIou != null &&
                geometry.bboxPolygonIou < GEOMETRY_MISMATCH_IOU_THRESHOLD;
              return (
                <div
                  key={item.id}
                  ref={(element) => {
                    reviewItemRefs.current[item.id] = element;
                  }}
                  onClick={() => setSelectedItemId(item.id)}
                  className={`rounded-lg border bg-white p-3 transition ${
                    isSelected ? 'border-blue-500 shadow-sm ring-2 ring-blue-100' : 'border-gray-200'
                  }`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <div className="truncate text-sm font-semibold text-gray-900" title={item.className}>
                          {item.className}
                        </div>
                        {isSelected && (
                          <span className="rounded-full bg-blue-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-blue-700">
                            Selected
                          </span>
                        )}
                      </div>
                      <div className="truncate text-xs text-gray-500" title={`${Math.round(item.confidence * 100)}% confidence · ${item.source}`}>
                        {Math.round(item.confidence * 100)}% confidence · {item.source}
                      </div>
                      {maskOverlayEnabled && (isBoxOnly || hasGeometryMismatch) && (
                        <div className="mt-2 flex flex-wrap gap-1.5">
                          {isBoxOnly && (
                            <span
                              className="rounded-full border border-gray-300 bg-gray-50 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-gray-600"
                              title="No stored polygon is available for this suggestion."
                            >
                              Box-only
                            </span>
                          )}
                          {hasGeometryMismatch && geometry?.bboxPolygonIou != null && (
                            <span
                              className="inline-flex items-center gap-1 rounded-full border border-amber-300 bg-amber-50 px-2 py-0.5 text-[10px] font-semibold text-amber-800"
                              title={`Stored bbox vs polygon bounding rect IoU: ${geometry.bboxPolygonIou.toFixed(3)}`}
                            >
                              <AlertTriangle className="h-3 w-3" />
                              Geometry mismatch · IoU {geometry.bboxPolygonIou.toFixed(2)}
                            </span>
                          )}
                        </div>
                      )}
                    </div>
                    <div className="flex flex-shrink-0 items-center gap-2">
                      {item.status === 'accepted' && <CheckCircle2 className="h-4 w-4 text-green-500" />}
                      {item.status === 'rejected' && <XCircle className="h-4 w-4 text-red-500" />}
                      {item.warnings.length > 0 && (
                        <span title={warningText}>
                          <AlertTriangle className="h-4 w-4 text-amber-500" />
                        </span>
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

                    <div className="grid grid-cols-2 gap-2 xl:grid-cols-4">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => onAction(item, 'accept')}
                        className="h-8 px-2 text-xs"
                      >
                        Accept
                      </Button>
                      {item.status === 'rejected' ? (
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => onAction(item, 'restore')}
                          className="h-8 px-2 text-xs"
                        >
                          Restore
                        </Button>
                      ) : (
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => onAction(item, 'reject')}
                          className="h-8 px-2 text-xs"
                        >
                          Reject
                        </Button>
                      )}
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => onAction(item, 'correct', corrections[item.id])}
                        disabled={!corrections[item.id]}
                        className="h-8 px-2 text-xs"
                      >
                        Correct
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => onEdit(item)}
                        className="h-8 px-2 text-xs"
                      >
                        <Pencil className="mr-1 h-3 w-3" />
                        Edit
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
