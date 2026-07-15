export interface Sam3ReviewDetection {
  bbox: [number, number, number, number];
  polygon: [number, number][];
  confidence: number;
  similarity?: number;
}

export interface Sam3ReviewExemplarBox {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export interface Sam3ReviewQualityOptions {
  detections: Sam3ReviewDetection[];
  exemplars: Sam3ReviewExemplarBox[];
  sourceWidth?: number | null;
  sourceHeight?: number | null;
  targetWidth?: number | null;
  targetHeight?: number | null;
  dedupeIouThreshold?: number;
  containmentThreshold?: number;
  maxDimensionRatio?: number;
  maxAreaRatio?: number;
}

export interface Sam3ReviewQualityStats {
  inputCount: number;
  duplicateSuppressedCount: number;
  geometryFilteredCount: number;
  outputCount: number;
}

export interface Sam3ReviewQualityResult {
  detections: Sam3ReviewDetection[];
  stats: Sam3ReviewQualityStats;
}

const DEFAULT_DEDUPE_IOU_THRESHOLD = 0.5;
const DEFAULT_CONTAINMENT_THRESHOLD = 0.82;
const DEFAULT_MAX_DIMENSION_RATIO = 2.5;
const DEFAULT_MAX_AREA_RATIO = 5;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function boxArea(box: [number, number, number, number]): number {
  return Math.max(0, box[2] - box[0]) * Math.max(0, box[3] - box[1]);
}

function intersectionArea(
  first: [number, number, number, number],
  second: [number, number, number, number]
): number {
  return boxArea([
    Math.max(first[0], second[0]),
    Math.max(first[1], second[1]),
    Math.min(first[2], second[2]),
    Math.min(first[3], second[3]),
  ]);
}

function boxIou(
  first: [number, number, number, number],
  second: [number, number, number, number]
): number {
  const intersection = intersectionArea(first, second);
  const union = boxArea(first) + boxArea(second) - intersection;
  return union > 0 ? intersection / union : 0;
}

function boxContainment(
  first: [number, number, number, number],
  second: [number, number, number, number]
): number {
  const smallerArea = Math.min(boxArea(first), boxArea(second));
  return smallerArea > 0 ? intersectionArea(first, second) / smallerArea : 0;
}

function detectionScore(detection: Sam3ReviewDetection): number {
  return typeof detection.similarity === 'number' && Number.isFinite(detection.similarity)
    ? detection.similarity
    : Number.isFinite(detection.confidence)
      ? detection.confidence
      : 0;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const midpoint = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[midpoint - 1] + sorted[midpoint]) / 2
    : sorted[midpoint];
}

function isPositiveFinite(value: number | null | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function normalizeDetection(
  detection: Sam3ReviewDetection,
  targetWidth?: number | null,
  targetHeight?: number | null
): Sam3ReviewDetection | null {
  const [rawX1, rawY1, rawX2, rawY2] = detection.bbox;
  if (![rawX1, rawY1, rawX2, rawY2].every(Number.isFinite)) return null;

  const x1 = isPositiveFinite(targetWidth) ? clamp(rawX1, 0, targetWidth) : rawX1;
  const y1 = isPositiveFinite(targetHeight) ? clamp(rawY1, 0, targetHeight) : rawY1;
  const x2 = isPositiveFinite(targetWidth) ? clamp(rawX2, 0, targetWidth) : rawX2;
  const y2 = isPositiveFinite(targetHeight) ? clamp(rawY2, 0, targetHeight) : rawY2;
  const bbox: [number, number, number, number] = [x1, y1, x2, y2];

  if (boxArea(bbox) <= 0) return null;

  return {
    ...detection,
    bbox,
    polygon: detection.polygon.map(([x, y]) => [
      isPositiveFinite(targetWidth) ? clamp(x, 0, targetWidth) : x,
      isPositiveFinite(targetHeight) ? clamp(y, 0, targetHeight) : y,
    ]),
  };
}

function buildExpectedGeometry(options: Sam3ReviewQualityOptions): {
  width: number;
  height: number;
  area: number;
} | null {
  if (
    !isPositiveFinite(options.sourceWidth) ||
    !isPositiveFinite(options.sourceHeight) ||
    !isPositiveFinite(options.targetWidth) ||
    !isPositiveFinite(options.targetHeight)
  ) {
    return null;
  }

  const sourceWidth = options.sourceWidth;
  const sourceHeight = options.sourceHeight;
  const targetWidth = options.targetWidth;
  const targetHeight = options.targetHeight;
  const scaledBoxes = options.exemplars.flatMap((box) => {
    const width = Math.abs(box.x2 - box.x1) * (targetWidth / sourceWidth);
    const height = Math.abs(box.y2 - box.y1) * (targetHeight / sourceHeight);
    if (!isPositiveFinite(width) || !isPositiveFinite(height)) return [];
    return [{ width, height, area: width * height }];
  });
  const scaledWidths = scaledBoxes.map((box) => box.width);
  const scaledHeights = scaledBoxes.map((box) => box.height);
  const scaledAreas = scaledBoxes.map((box) => box.area);

  const width = median(scaledWidths);
  const height = median(scaledHeights);
  const area = median(scaledAreas);
  if (!isPositiveFinite(width) || !isPositiveFinite(height) || !isPositiveFinite(area)) {
    return null;
  }

  return { width, height, area };
}

export function filterSam3ReviewDetections(
  options: Sam3ReviewQualityOptions
): Sam3ReviewQualityResult {
  const stats: Sam3ReviewQualityStats = {
    inputCount: options.detections.length,
    duplicateSuppressedCount: 0,
    geometryFilteredCount: 0,
    outputCount: 0,
  };
  const expected = buildExpectedGeometry(options);
  const maxDimensionRatio = options.maxDimensionRatio ?? DEFAULT_MAX_DIMENSION_RATIO;
  const maxAreaRatio = options.maxAreaRatio ?? DEFAULT_MAX_AREA_RATIO;

  const geometrySafe = options.detections.flatMap((detection) => {
    const normalized = normalizeDetection(detection, options.targetWidth, options.targetHeight);
    if (!normalized) {
      stats.geometryFilteredCount += 1;
      return [];
    }

    if (expected) {
      const width = normalized.bbox[2] - normalized.bbox[0];
      const height = normalized.bbox[3] - normalized.bbox[1];
      const area = boxArea(normalized.bbox);
      if (
        width > expected.width * maxDimensionRatio ||
        height > expected.height * maxDimensionRatio ||
        area > expected.area * maxAreaRatio
      ) {
        stats.geometryFilteredCount += 1;
        return [];
      }
    }

    return [normalized];
  });

  const dedupeIouThreshold = options.dedupeIouThreshold ?? DEFAULT_DEDUPE_IOU_THRESHOLD;
  const containmentThreshold = options.containmentThreshold ?? DEFAULT_CONTAINMENT_THRESHOLD;
  const selected: Sam3ReviewDetection[] = [];

  for (const detection of geometrySafe
    .map((candidate, index) => ({ candidate, index }))
    .sort((left, right) =>
      detectionScore(right.candidate) - detectionScore(left.candidate) || left.index - right.index
    )
    .map(({ candidate }) => candidate)) {
    const duplicate = selected.some((existing) =>
      boxIou(existing.bbox, detection.bbox) >= dedupeIouThreshold ||
      boxContainment(existing.bbox, detection.bbox) >= containmentThreshold
    );
    if (duplicate) {
      stats.duplicateSuppressedCount += 1;
      continue;
    }
    selected.push(detection);
  }

  stats.outputCount = selected.length;
  return { detections: selected, stats };
}
