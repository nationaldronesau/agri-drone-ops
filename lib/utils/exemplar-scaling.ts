/**
 * Exemplar Box Scaling Utility
 *
 * Provides coordinate scaling for SAM3 batch processing.
 * Normalizes exemplar boxes from source image dimensions and scales
 * them to target image dimensions for consistent detection locations.
 */

export interface BoxCoordinate {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export interface ScaleBoxesOptions {
  exemplars: BoxCoordinate[];
  sourceWidth?: number;
  sourceHeight?: number;
  targetWidth: number;
  targetHeight: number;
  maxBoxes?: number;
  jobId?: string;
  assetId?: string;
}

export interface ScaleBoxesResult {
  boxes: BoxCoordinate[];
  warnings: string[];
  usedScaling: boolean;
}

/**
 * Scale exemplar bounding boxes from source image dimensions to target image dimensions.
 *
 * When source dimensions are provided and valid (positive numbers), coordinates are:
 * 1. Normalized to 0-1 range using source dimensions
 * 2. Scaled to target dimensions
 * 3. Clamped to target bounds
 *
 * When source dimensions are not provided or invalid, falls back to using
 * absolute coordinates with boundary clamping.
 *
 * Degenerate boxes (zero or negative area after scaling) are filtered out.
 */
export function scaleExemplarBoxes(options: ScaleBoxesOptions): ScaleBoxesResult {
  const {
    exemplars,
    sourceWidth,
    sourceHeight,
    targetWidth,
    targetHeight,
    maxBoxes = 10,
    jobId,
    assetId,
  } = options;

  const warnings: string[] = [];

  // Only use scaling if both source dimensions are valid positive numbers
  const useScaling = !!(
    sourceWidth &&
    sourceHeight &&
    sourceWidth > 0 &&
    sourceHeight > 0 &&
    Number.isFinite(sourceWidth) &&
    Number.isFinite(sourceHeight)
  );

  // Warn if dimensions were provided but invalid
  if (!useScaling && (sourceWidth !== undefined || sourceHeight !== undefined)) {
    warnings.push(
      `Invalid source dimensions (${sourceWidth}x${sourceHeight}) - using absolute coordinates`
    );
  }

  const boxes = exemplars
    .slice(0, maxBoxes)
    .map((box, index) => {
      let scaledBox: BoxCoordinate;

      if (useScaling) {
        // Normalize to 0-1 range using source dimensions, then scale to target
        const normX1 = box.x1 / sourceWidth!;
        const normY1 = box.y1 / sourceHeight!;
        const normX2 = box.x2 / sourceWidth!;
        const normY2 = box.y2 / sourceHeight!;

        scaledBox = {
          x1: Math.max(0, Math.round(normX1 * targetWidth)),
          y1: Math.max(0, Math.round(normY1 * targetHeight)),
          x2: Math.min(targetWidth, Math.round(normX2 * targetWidth)),
          y2: Math.min(targetHeight, Math.round(normY2 * targetHeight)),
        };
      } else {
        // Fallback: absolute coordinates with full boundary clamping
        scaledBox = {
          x1: Math.max(0, Math.min(targetWidth, Math.round(box.x1))),
          y1: Math.max(0, Math.min(targetHeight, Math.round(box.y1))),
          x2: Math.max(0, Math.min(targetWidth, Math.round(box.x2))),
          y2: Math.max(0, Math.min(targetHeight, Math.round(box.y2))),
        };
      }

      return { scaledBox, index };
    })
    .filter(({ scaledBox, index }) => {
      // Filter degenerate boxes (zero or negative area)
      if (scaledBox.x2 <= scaledBox.x1 || scaledBox.y2 <= scaledBox.y1) {
        warnings.push(`Exemplar ${index} produced degenerate box after scaling - skipped`);
        return false;
      }
      return true;
    })
    .map(({ scaledBox }) => scaledBox);

  // Log warnings if any
  if (warnings.length > 0 && jobId) {
    const prefix = assetId ? `[Job ${jobId}, Asset ${assetId}]` : `[Job ${jobId}]`;
    warnings.forEach((w) => console.warn(`${prefix} ${w}`));
  }

  return { boxes, warnings, usedScaling: useScaling };
}
