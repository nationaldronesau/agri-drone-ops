'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Image from 'next/image';
import {
  GEOMETRY_MISMATCH_IOU_THRESHOLD,
  getPolygonBoundingRect,
  getValidPolygon,
} from '@/lib/utils/detection-geometry';

interface Detection {
  id: string;
  status: 'PENDING' | 'ACCEPTED' | 'REJECTED';
  confidence: number;
  weedType: string;
  bbox?: number[]; // [x1, y1, x2, y2] in pixels
  polygon?: number[][]; // [[x, y], ...] in pixels
  bboxPolygonIou?: number | null;
}

interface InteractiveDetectionOverlayProps {
  imageUrl: string;
  detections: Detection[];
  selectedDetectionId?: string | null;
  onSelectDetection?: (id: string) => void;
  imageWidth?: number;
  imageHeight?: number;
  zoomLevel?: number;
  panOffset?: { x: number; y: number };
  onPanOffsetChange?: (offset: { x: number; y: number }) => void;
  showMaskOverlay?: boolean;
}

export function InteractiveDetectionOverlay({
  imageUrl,
  detections,
  selectedDetectionId,
  onSelectDetection,
  imageWidth = 4000, // Default DJI image width
  imageHeight = 3000, // Default DJI image height
  zoomLevel = 1,
  panOffset,
  onPanOffsetChange,
  showMaskOverlay = false,
}: InteractiveDetectionOverlayProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [containerSize, setContainerSize] = useState({ width: 0, height: 0 });
  const [imageLoaded, setImageLoaded] = useState(false);
  const [actualImageSize, setActualImageSize] = useState({ width: imageWidth, height: imageHeight });
  const [isPanning, setIsPanning] = useState(false);
  const [lastPanPoint, setLastPanPoint] = useState({ x: 0, y: 0 });
  const [internalPanOffset, setInternalPanOffset] = useState({ x: 0, y: 0 });

  const currentPanOffset = panOffset ?? internalPanOffset;
  const setPanOffset = onPanOffsetChange ?? setInternalPanOffset;

  // Update container size on resize or when image dimensions change
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const updateSize = () => {
      const rect = el.getBoundingClientRect();
      setContainerSize({ width: rect.width, height: rect.height });
    };

    updateSize();

    // Use ResizeObserver to catch all container size changes
    // (aspect ratio changes, parent layout shifts, sidebar toggles)
    const observer = new ResizeObserver(() => updateSize());
    observer.observe(el);

    return () => observer.disconnect();
  }, [imageLoaded, actualImageSize.width, actualImageSize.height]);

  const scale = containerSize.width > 0 ? containerSize.width / actualImageSize.width : 1;
  const scaledWidth = actualImageSize.width * scale;
  const scaledHeight = actualImageSize.height * scale;
  const renderWidth = Math.max(1, Math.round(scaledWidth));
  const renderHeight = Math.max(1, Math.round(scaledHeight));
  const denseDetectionMode = detections.length >= 60;
  const badgeWidth = denseDetectionMode ? 34 : 40;
  const badgeHeight = denseDetectionMode ? 16 : 18;
  const badgeFontSize = denseDetectionMode ? 10 : 11;

  // Convert pixel coordinates to scaled coordinates
  const scaleBox = (bbox: number[]) => {
    const [x1, y1, x2, y2] = bbox;
    return {
      x: x1 * scale,
      y: y1 * scale,
      width: (x2 - x1) * scale,
      height: (y2 - y1) * scale,
    };
  };

  const scalePolygon = (polygon: [number, number][]) =>
    polygon.map(([x, y]) => `${x * scale},${y * scale}`).join(' ');

  const getStatusColor = (status: string, isHovered: boolean, isSelected: boolean) => {
    if (isSelected) {
      return {
        stroke: '#2563eb',
        fill: 'rgba(37, 99, 235, 0.18)',
        maskFill: 'rgba(37, 99, 235, 0.25)',
      };
    }
    switch (status) {
      case 'ACCEPTED':
        return {
          stroke: '#22c55e',
          fill: 'rgba(34, 197, 94, 0.2)',
          maskFill: 'rgba(34, 197, 94, 0.25)',
        };
      case 'REJECTED':
        return {
          stroke: '#ef4444',
          fill: 'rgba(239, 68, 68, 0.15)',
          maskFill: 'rgba(239, 68, 68, 0.25)',
        };
      default:
        return isHovered
          ? {
              stroke: '#f59e0b',
              fill: 'rgba(245, 158, 11, 0.25)',
              maskFill: 'rgba(245, 158, 11, 0.3)',
            }
          : {
              stroke: '#f59e0b',
              fill: 'rgba(245, 158, 11, 0.1)',
              maskFill: 'rgba(245, 158, 11, 0.25)',
            };
    }
  };

  const handleImageLoad = (e: React.SyntheticEvent<HTMLImageElement>) => {
    const img = e.currentTarget;
    setActualImageSize({ width: img.naturalWidth, height: img.naturalHeight });
    setImageLoaded(true);
  };

  const getContainerCoords = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return { x: 0, y: 0 };
    return {
      x: e.clientX - rect.left,
      y: e.clientY - rect.top,
    };
  }, []);

  const handleMouseDown = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (e.button === 1 || e.shiftKey) {
      e.preventDefault();
      setIsPanning(true);
      setHoveredId(null);
      setLastPanPoint(getContainerCoords(e));
    }
  }, [getContainerCoords]);

  const handleMouseMove = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (!isPanning) return;
    const { x, y } = getContainerCoords(e);
    const deltaX = x - lastPanPoint.x;
    const deltaY = y - lastPanPoint.y;
    setPanOffset({ x: currentPanOffset.x + deltaX, y: currentPanOffset.y + deltaY });
    setLastPanPoint({ x, y });
  }, [currentPanOffset.x, currentPanOffset.y, getContainerCoords, isPanning, lastPanPoint.x, lastPanPoint.y, setPanOffset]);

  const stopPanning = useCallback(() => {
    if (!isPanning) return;
    setIsPanning(false);
  }, [isPanning]);

  return (
    <div
      ref={containerRef}
      className={`relative w-full min-h-[360px] sm:min-h-[420px] lg:min-h-[520px] bg-gray-900 rounded-lg overflow-hidden ${
        isPanning ? 'cursor-grabbing' : 'cursor-default'
      }`}
      style={{ aspectRatio: `${actualImageSize.width} / ${actualImageSize.height}` }}
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={stopPanning}
      onMouseLeave={stopPanning}
    >
      <div
        className="absolute inset-0"
        style={{
          transform: `translate(${currentPanOffset.x}px, ${currentPanOffset.y}px) scale(${zoomLevel})`,
          transformOrigin: '0 0',
        }}
      >
        {/* Base Image */}
        <Image
          src={imageUrl}
          alt="Detection preview"
          width={renderWidth}
          height={renderHeight}
          className="block"
          style={{ width: renderWidth, height: renderHeight }}
          onLoad={handleImageLoad}
          draggable={false}
          unoptimized
        />

        {/* SVG Overlay for Detections */}
        {imageLoaded && containerSize.width > 0 && (
          <svg
            className={`absolute top-0 left-0 ${isPanning ? 'pointer-events-none' : 'pointer-events-auto'}`}
            width={renderWidth}
            height={renderHeight}
            viewBox={`0 0 ${renderWidth} ${renderHeight}`}
          >
            {detections.map((detection) => {
              const polygon = showMaskOverlay ? getValidPolygon(detection.polygon) : null;
              const polygonRect = polygon ? getPolygonBoundingRect(polygon) : null;
              const sourceBounds = detection.bbox ?? polygonRect;
              if (!sourceBounds) return null;

              const box = scaleBox(sourceBounds);
              const storedBox = detection.bbox ? scaleBox(detection.bbox) : null;
              const isHovered = hoveredId === detection.id;
              const isSelected = selectedDetectionId === detection.id;
              const colors = getStatusColor(detection.status, isHovered, isSelected);
              const isBoxOnly = showMaskOverlay && !polygon;
              const hasGeometryMismatch =
                showMaskOverlay &&
                detection.bboxPolygonIou != null &&
                detection.bboxPolygonIou < GEOMETRY_MISMATCH_IOU_THRESHOLD;
              const hoverLabel = hasGeometryMismatch
                ? `${detection.weedType} · mismatch IoU ${detection.bboxPolygonIou?.toFixed(2)}`
                : detection.weedType;

              return (
                <g
                  key={detection.id}
                  onMouseEnter={() => setHoveredId(detection.id)}
                  onMouseLeave={() => setHoveredId(null)}
                  onClick={() => onSelectDetection?.(detection.id)}
                  className="pointer-events-auto cursor-pointer"
                >
                  <title>{hoverLabel}</title>
                  {polygon ? (
                    <polygon
                      points={scalePolygon(polygon)}
                      fill={colors.maskFill}
                      stroke={colors.stroke}
                      strokeWidth={isSelected ? 3 : 2}
                      strokeLinejoin="round"
                      className="transition-all"
                      style={{
                        opacity: detection.status === 'REJECTED' ? 0.55 : 1,
                      }}
                    />
                  ) : (
                    <rect
                      x={box.x}
                      y={box.y}
                      width={box.width}
                      height={box.height}
                      fill={colors.fill}
                      stroke={colors.stroke}
                      strokeWidth={isSelected ? 4 : isHovered ? 3 : 2}
                      className="transition-all"
                      style={{
                        opacity: detection.status === 'REJECTED' ? 0.5 : 1,
                      }}
                    />
                  )}
                  {!polygon && isSelected && (
                    <rect
                      x={Math.max(0, box.x - 3)}
                      y={Math.max(0, box.y - 3)}
                      width={box.width + 6}
                      height={box.height + 6}
                      fill="none"
                      stroke="#2563eb"
                      strokeWidth="2"
                      strokeDasharray="6 4"
                      className="pointer-events-none"
                    />
                  )}
                  {polygon && storedBox && (isHovered || isSelected) && (
                    <rect
                      x={storedBox.x}
                      y={storedBox.y}
                      width={storedBox.width}
                      height={storedBox.height}
                      fill="none"
                      stroke={colors.stroke}
                      strokeWidth="1.5"
                      strokeDasharray="5 4"
                      className="pointer-events-none"
                    />
                  )}

                  {/* Status Icon for accepted/rejected */}
                  {detection.status === 'ACCEPTED' && (
                    <g transform={`translate(${box.x + box.width - 20}, ${box.y + 4})`}>
                      <circle cx="8" cy="8" r="10" fill="#22c55e" />
                      <path d="M5 8 L7 10 L11 6" stroke="white" strokeWidth="2" fill="none" />
                    </g>
                  )}
                  {detection.status === 'REJECTED' && (
                    <g transform={`translate(${box.x + box.width - 20}, ${box.y + 4})`}>
                      <circle cx="8" cy="8" r="10" fill="#ef4444" />
                      <path d="M5 5 L11 11 M11 5 L5 11" stroke="white" strokeWidth="2" fill="none" />
                    </g>
                  )}

                  {/* Confidence Badge */}
                  <g transform={`translate(${box.x + 4}, ${box.y + 4})`}>
                    <rect
                      width={badgeWidth}
                      height={badgeHeight}
                      rx="4"
                      fill={detection.confidence >= 0.8 ? '#22c55e' : detection.confidence >= 0.5 ? '#f59e0b' : '#ef4444'}
                      opacity={denseDetectionMode && !isHovered ? 0.9 : 1}
                    />
                    <text
                      x={badgeWidth / 2}
                      y={denseDetectionMode ? 12 : 13}
                      textAnchor="middle"
                      fill="white"
                      fontSize={badgeFontSize}
                      fontWeight="bold"
                    >
                      {Math.round(detection.confidence * 100)}%
                    </text>
                  </g>

                  {isBoxOnly && (
                    <g transform={`translate(${box.x + badgeWidth + 8}, ${box.y + 5})`}>
                      <rect width="52" height="14" rx="4" fill="rgba(31, 41, 55, 0.9)" />
                      <text
                        x="26"
                        y="10"
                        textAnchor="middle"
                        fill="white"
                        fontSize="8"
                        fontWeight="bold"
                      >
                        BOX ONLY
                      </text>
                    </g>
                  )}

                  {/* Weed Type Label on Hover */}
                  {(isHovered || isSelected) && (
                    <g transform={`translate(${box.x}, ${box.y - 24})`}>
                      <rect
                        width={Math.max(hoverLabel.length * 7 + 16, 80)}
                        height="20"
                        rx="4"
                        fill="rgba(0,0,0,0.8)"
                      />
                      <text
                        x="8"
                        y="14"
                        fill="white"
                        fontSize="12"
                      >
                        {hoverLabel}
                      </text>
                    </g>
                  )}
                </g>
              );
            })}
          </svg>
        )}
      </div>

      {/* Keyboard Shortcut Hint */}
      {selectedDetectionId ? (
        <div className="absolute bottom-2 left-2 bg-black/70 text-white text-xs px-2 py-1 rounded">
          Selected detection. Use the Review Items panel to accept, reject, correct, or restore it.
        </div>
      ) : hoveredId ? (
        <div className="absolute bottom-2 left-2 bg-black/70 text-white text-xs px-2 py-1 rounded">
          Click a {showMaskOverlay ? 'mask' : 'box'} to select it. Review actions are in the side panel.
        </div>
      ) : null}
    </div>
  );
}
