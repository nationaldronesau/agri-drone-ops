'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Check, X } from 'lucide-react';

interface Detection {
  id: string;
  status: 'PENDING' | 'ACCEPTED' | 'REJECTED';
  confidence: number;
  weedType: string;
  bbox: number[]; // [x1, y1, x2, y2] in pixels
}

interface InteractiveDetectionOverlayProps {
  imageUrl: string;
  detections: Detection[];
  onAccept: (id: string) => void;
  onReject: (id: string) => void;
  imageWidth?: number;
  imageHeight?: number;
  zoomLevel?: number;
  panOffset?: { x: number; y: number };
  onPanOffsetChange?: (offset: { x: number; y: number }) => void;
}

export function InteractiveDetectionOverlay({
  imageUrl,
  detections,
  onAccept,
  onReject,
  imageWidth = 4000, // Default DJI image width
  imageHeight = 3000, // Default DJI image height
  zoomLevel = 1,
  panOffset,
  onPanOffsetChange,
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

  // Update container size on resize
  useEffect(() => {
    const updateSize = () => {
      if (containerRef.current) {
        const rect = containerRef.current.getBoundingClientRect();
        setContainerSize({ width: rect.width, height: rect.height });
      }
    };

    updateSize();
    window.addEventListener('resize', updateSize);
    return () => window.removeEventListener('resize', updateSize);
  }, [imageLoaded]);

  // Handle keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!hoveredId) return;

      if (e.key === 'a' || e.key === 'A') {
        e.preventDefault();
        onAccept(hoveredId);
      } else if (e.key === 'd' || e.key === 'D' || e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault();
        onReject(hoveredId);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [hoveredId, onAccept, onReject]);

  const scale = containerSize.width > 0 ? containerSize.width / actualImageSize.width : 1;
  const scaledWidth = actualImageSize.width * scale;
  const scaledHeight = actualImageSize.height * scale;

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

  const getStatusColor = (status: string, isHovered: boolean) => {
    switch (status) {
      case 'ACCEPTED':
        return { stroke: '#22c55e', fill: 'rgba(34, 197, 94, 0.2)' };
      case 'REJECTED':
        return { stroke: '#ef4444', fill: 'rgba(239, 68, 68, 0.15)' };
      default:
        return isHovered
          ? { stroke: '#f59e0b', fill: 'rgba(245, 158, 11, 0.25)' }
          : { stroke: '#f59e0b', fill: 'rgba(245, 158, 11, 0.1)' };
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
        <img
          src={imageUrl}
          alt="Detection preview"
          className="block"
          style={{ width: scaledWidth, height: scaledHeight }}
          onLoad={handleImageLoad}
          draggable={false}
        />

        {/* SVG Overlay for Detections */}
        {imageLoaded && containerSize.width > 0 && (
          <svg
            className={`absolute inset-0 w-full h-full ${isPanning ? 'pointer-events-none' : 'pointer-events-auto'}`}
            viewBox={`0 0 ${scaledWidth} ${scaledHeight}`}
            preserveAspectRatio="xMidYMid meet"
          >
            {detections.map((detection) => {
              const box = scaleBox(detection.bbox);
              const isHovered = hoveredId === detection.id;
              const colors = getStatusColor(detection.status, isHovered);
              const isPending = detection.status === 'PENDING';

              return (
                <g
                  key={detection.id}
                  onMouseEnter={() => setHoveredId(detection.id)}
                  onMouseLeave={() => setHoveredId(null)}
                  className="pointer-events-auto cursor-pointer"
                >
                  {/* Detection Box */}
                  <rect
                    x={box.x}
                    y={box.y}
                    width={box.width}
                    height={box.height}
                    fill={colors.fill}
                    stroke={colors.stroke}
                    strokeWidth={isHovered ? 3 : 2}
                    className="transition-all"
                    style={{
                      opacity: detection.status === 'REJECTED' ? 0.5 : 1,
                    }}
                  />

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
                      width="40"
                      height="18"
                      rx="4"
                      fill={detection.confidence >= 0.8 ? '#22c55e' : detection.confidence >= 0.5 ? '#f59e0b' : '#ef4444'}
                    />
                    <text
                      x="20"
                      y="13"
                      textAnchor="middle"
                      fill="white"
                      fontSize="11"
                      fontWeight="bold"
                    >
                      {Math.round(detection.confidence * 100)}%
                    </text>
                  </g>

                  {/* Hover Action Buttons - Only for pending */}
                  {isHovered && isPending && (
                    <foreignObject
                      x={box.x + box.width / 2 - 50}
                      y={box.y + box.height / 2 - 18}
                      width="100"
                      height="36"
                      className="pointer-events-auto"
                    >
                      <div className="flex items-center justify-center gap-2">
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            onAccept(detection.id);
                          }}
                          className="w-10 h-10 rounded-full bg-green-500 hover:bg-green-600 text-white flex items-center justify-center shadow-lg transition-transform hover:scale-110"
                          title="Accept (A)"
                        >
                          <Check className="w-5 h-5" />
                        </button>
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            onReject(detection.id);
                          }}
                          className="w-10 h-10 rounded-full bg-red-500 hover:bg-red-600 text-white flex items-center justify-center shadow-lg transition-transform hover:scale-110"
                          title="Reject (D)"
                        >
                          <X className="w-5 h-5" />
                        </button>
                      </div>
                    </foreignObject>
                  )}

                  {/* Weed Type Label on Hover */}
                  {isHovered && (
                    <g transform={`translate(${box.x}, ${box.y - 24})`}>
                      <rect
                        width={Math.max(detection.weedType.length * 8 + 16, 80)}
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
                        {detection.weedType}
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
      {hoveredId && (
        <div className="absolute bottom-2 left-2 bg-black/70 text-white text-xs px-2 py-1 rounded">
          Press <kbd className="bg-gray-600 px-1 rounded">A</kbd> to accept, <kbd className="bg-gray-600 px-1 rounded">D</kbd> to reject
        </div>
      )}
    </div>
  );
}
