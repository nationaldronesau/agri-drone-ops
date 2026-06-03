export type YoloBBox = [number, number, number, number];

export interface YoloTile {
  index: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface YoloTileOptions {
  tileSize: number;
  overlap: number;
}

export interface YoloDetectionLike {
  class: string;
  confidence: number;
  bbox: YoloBBox;
}

function axisStarts(length: number, tileSize: number, stride: number): number[] {
  if (!Number.isFinite(length) || length <= 0) return [];
  if (length <= tileSize) return [0];

  const starts: number[] = [];
  for (let start = 0; start + tileSize < length; start += stride) {
    starts.push(start);
  }

  const finalStart = Math.max(0, length - tileSize);
  if (starts[starts.length - 1] !== finalStart) {
    starts.push(finalStart);
  }

  return starts;
}

export function buildYoloTilePlan(
  imageWidth: number,
  imageHeight: number,
  options: YoloTileOptions
): YoloTile[] {
  const tileSize = Math.max(1, Math.floor(options.tileSize));
  const overlap = Math.max(0, Math.floor(options.overlap));
  const stride = Math.max(1, tileSize - Math.min(overlap, tileSize - 1));
  const xStarts = axisStarts(Math.floor(imageWidth), tileSize, stride);
  const yStarts = axisStarts(Math.floor(imageHeight), tileSize, stride);
  const tiles: YoloTile[] = [];

  for (const y of yStarts) {
    for (const x of xStarts) {
      tiles.push({
        index: tiles.length,
        x,
        y,
        width: Math.min(tileSize, Math.floor(imageWidth) - x),
        height: Math.min(tileSize, Math.floor(imageHeight) - y),
      });
    }
  }

  return tiles;
}

export function shouldTileYoloImage(
  imageWidth: number,
  imageHeight: number,
  options: { enabled: boolean; minDimension: number; tileSize: number }
): boolean {
  if (!options.enabled) return false;
  if (!Number.isFinite(imageWidth) || !Number.isFinite(imageHeight)) return false;
  if (imageWidth <= 0 || imageHeight <= 0) return false;
  return Math.max(imageWidth, imageHeight) >= Math.max(options.minDimension, options.tileSize + 1);
}

export function offsetDetectionToImage(
  detection: YoloDetectionLike,
  tile: YoloTile,
  imageWidth: number,
  imageHeight: number
): YoloDetectionLike | null {
  const [x1, y1, x2, y2] = detection.bbox;
  if ([x1, y1, x2, y2].some((value) => !Number.isFinite(value))) {
    return null;
  }

  const clipped: YoloBBox = [
    Math.max(0, Math.min(imageWidth, x1 + tile.x)),
    Math.max(0, Math.min(imageHeight, y1 + tile.y)),
    Math.max(0, Math.min(imageWidth, x2 + tile.x)),
    Math.max(0, Math.min(imageHeight, y2 + tile.y)),
  ];

  if (clipped[2] <= clipped[0] || clipped[3] <= clipped[1]) {
    return null;
  }

  return {
    class: detection.class,
    confidence: detection.confidence,
    bbox: clipped,
  };
}

export function calculateBBoxIoU(a: YoloBBox, b: YoloBBox): number {
  const x1 = Math.max(a[0], b[0]);
  const y1 = Math.max(a[1], b[1]);
  const x2 = Math.min(a[2], b[2]);
  const y2 = Math.min(a[3], b[3]);
  const intersectionWidth = Math.max(0, x2 - x1);
  const intersectionHeight = Math.max(0, y2 - y1);
  const intersectionArea = intersectionWidth * intersectionHeight;
  if (intersectionArea <= 0) return 0;

  const areaA = Math.max(0, a[2] - a[0]) * Math.max(0, a[3] - a[1]);
  const areaB = Math.max(0, b[2] - b[0]) * Math.max(0, b[3] - b[1]);
  const unionArea = areaA + areaB - intersectionArea;
  return unionArea > 0 ? intersectionArea / unionArea : 0;
}

export function mergeYoloDetectionsWithNms<T extends YoloDetectionLike>(
  detections: T[],
  iouThreshold: number
): T[] {
  const threshold = Math.max(0, Math.min(1, iouThreshold));
  const sorted = [...detections]
    .filter((detection) => {
      const [x1, y1, x2, y2] = detection.bbox;
      return (
        Number.isFinite(detection.confidence) &&
        [x1, y1, x2, y2].every(Number.isFinite) &&
        x2 > x1 &&
        y2 > y1
      );
    })
    .sort((a, b) => b.confidence - a.confidence);

  const kept: T[] = [];
  for (const candidate of sorted) {
    const overlapsExisting = kept.some((existing) => (
      existing.class === candidate.class &&
      calculateBBoxIoU(existing.bbox, candidate.bbox) >= threshold
    ));
    if (!overlapsExisting) {
      kept.push(candidate);
    }
  }

  return kept;
}
