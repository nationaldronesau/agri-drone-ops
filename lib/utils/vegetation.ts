import sharp from 'sharp';

export type VegetationBox =
  | [number, number, number, number]
  | { x1: number; y1: number; x2: number; y2: number };

export interface GreenFractionOptions {
  threshold?: number;
  maxSampleDimension?: number;
}

interface SampledRegion {
  data: Buffer;
  sampleWidth: number;
  sampleHeight: number;
  left: number;
  top: number;
  width: number;
  height: number;
}

interface PreparedImage {
  data: Buffer;
  channels: number;
  width: number;
  height: number;
  originalWidth: number;
  originalHeight: number;
}

const DEFAULT_EXG_THRESHOLD = 0.12;
const DEFAULT_MAX_SAMPLE_DIMENSION = 256;
const BLOB_SAMPLE_DIMENSION = 64;
const MAX_PREPARED_IMAGE_DIMENSION = 4096;
const preparedImageCache = new WeakMap<Buffer, Promise<PreparedImage | null>>();

function unpackBox(box: VegetationBox): [number, number, number, number] {
  return Array.isArray(box)
    ? box
    : [box.x1, box.y1, box.x2, box.y2];
}

async function prepareImage(buffer: Buffer): Promise<PreparedImage | null> {
  const image = sharp(buffer);
  const metadata = await image.metadata();
  const originalWidth = metadata.width ?? 0;
  const originalHeight = metadata.height ?? 0;
  if (originalWidth <= 0 || originalHeight <= 0) return null;

  const scale = Math.min(
    1,
    MAX_PREPARED_IMAGE_DIMENSION / Math.max(originalWidth, originalHeight)
  );
  const width = Math.max(1, Math.round(originalWidth * scale));
  const height = Math.max(1, Math.round(originalHeight * scale));
  let pipeline = image.toColourspace('srgb').removeAlpha();
  if (scale < 1) {
    pipeline = pipeline.resize({
      width,
      height,
      fit: 'fill',
      kernel: sharp.kernel.nearest,
    });
  }
  const { data, info } = await pipeline.raw().toBuffer({ resolveWithObject: true });
  return {
    data,
    channels: info.channels,
    width: info.width,
    height: info.height,
    originalWidth,
    originalHeight,
  };
}

function getPreparedImage(buffer: Buffer): Promise<PreparedImage | null> {
  const cached = preparedImageCache.get(buffer);
  if (cached) return cached;
  const prepared = prepareImage(buffer);
  preparedImageCache.set(buffer, prepared);
  return prepared;
}

async function sampleRegion(
  buffer: Buffer,
  box: VegetationBox | undefined,
  maxSampleDimension: number
): Promise<SampledRegion | null> {
  const image = await getPreparedImage(buffer);
  if (!image) return null;

  const requested = box
    ? unpackBox(box)
    : [0, 0, image.originalWidth, image.originalHeight];
  const left = Math.max(0, Math.min(image.originalWidth, Math.floor(requested[0])));
  const top = Math.max(0, Math.min(image.originalHeight, Math.floor(requested[1])));
  const right = Math.max(left, Math.min(image.originalWidth, Math.ceil(requested[2])));
  const bottom = Math.max(top, Math.min(image.originalHeight, Math.ceil(requested[3])));
  const width = right - left;
  const height = bottom - top;
  if (width <= 0 || height <= 0) return null;

  const sampleLimit = Math.max(1, Math.floor(maxSampleDimension));
  const scale = Math.min(1, sampleLimit / Math.max(width, height));
  const sampleWidth = Math.max(1, Math.round(width * scale));
  const sampleHeight = Math.max(1, Math.round(height * scale));
  const data = Buffer.allocUnsafe(sampleWidth * sampleHeight * 3);
  for (let sampleY = 0; sampleY < sampleHeight; sampleY += 1) {
    const originalY = top + ((sampleY + 0.5) * height) / sampleHeight;
    const sourceY = Math.min(
      image.height - 1,
      Math.floor((originalY / image.originalHeight) * image.height)
    );
    for (let sampleX = 0; sampleX < sampleWidth; sampleX += 1) {
      const originalX = left + ((sampleX + 0.5) * width) / sampleWidth;
      const sourceX = Math.min(
        image.width - 1,
        Math.floor((originalX / image.originalWidth) * image.width)
      );
      const sourceOffset = (sourceY * image.width + sourceX) * image.channels;
      const targetOffset = (sampleY * sampleWidth + sampleX) * 3;
      data[targetOffset] = image.data[sourceOffset];
      data[targetOffset + 1] = image.data[sourceOffset + 1];
      data[targetOffset + 2] = image.data[sourceOffset + 2];
    }
  }

  return {
    data,
    sampleWidth,
    sampleHeight,
    left,
    top,
    width,
    height,
  };
}

function isGreen(data: Buffer, offset: number, threshold: number): boolean {
  const red = data[offset];
  const green = data[offset + 1];
  const blue = data[offset + 2];
  return (2 * green - red - blue) / 255 > threshold;
}

function pointOnSegment(
  x: number,
  y: number,
  first: [number, number],
  second: [number, number]
): boolean {
  const cross = (x - first[0]) * (second[1] - first[1]) -
    (y - first[1]) * (second[0] - first[0]);
  if (Math.abs(cross) > 1e-9) return false;
  return x >= Math.min(first[0], second[0]) &&
    x <= Math.max(first[0], second[0]) &&
    y >= Math.min(first[1], second[1]) &&
    y <= Math.max(first[1], second[1]);
}

export function pointInPolygon(
  x: number,
  y: number,
  polygon: [number, number][]
): boolean {
  let inside = false;
  for (let index = 0, previous = polygon.length - 1; index < polygon.length; previous = index++) {
    const first = polygon[previous];
    const second = polygon[index];
    if (pointOnSegment(x, y, first, second)) return true;

    const crosses = (second[1] > y) !== (first[1] > y) &&
      x < ((first[0] - second[0]) * (y - second[1])) / (first[1] - second[1]) + second[0];
    if (crosses) inside = !inside;
  }
  return inside;
}

export async function greenFraction(
  buffer: Buffer,
  box?: VegetationBox,
  opts: GreenFractionOptions = {}
): Promise<number> {
  const threshold = opts.threshold ?? DEFAULT_EXG_THRESHOLD;
  const sampled = await sampleRegion(
    buffer,
    box,
    opts.maxSampleDimension ?? DEFAULT_MAX_SAMPLE_DIMENSION
  );
  if (!sampled) return 0;

  let greenPixels = 0;
  const pixelCount = sampled.sampleWidth * sampled.sampleHeight;
  for (let index = 0; index < pixelCount; index += 1) {
    if (isGreen(sampled.data, index * 3, threshold)) {
      greenPixels += 1;
    }
  }

  return pixelCount > 0 ? greenPixels / pixelCount : 0;
}

export async function greenFractionInPolygon(
  buffer: Buffer,
  polygon: [number, number][],
  imageWidth: number,
  imageHeight: number
): Promise<number> {
  if (polygon.length < 3 || imageWidth <= 0 || imageHeight <= 0) return 0;

  const xs = polygon.map((point) => point[0]);
  const ys = polygon.map((point) => point[1]);
  const bbox: VegetationBox = [
    Math.max(0, Math.min(...xs)),
    Math.max(0, Math.min(...ys)),
    Math.min(imageWidth, Math.max(...xs)),
    Math.min(imageHeight, Math.max(...ys)),
  ];
  const sampled = await sampleRegion(buffer, bbox, DEFAULT_MAX_SAMPLE_DIMENSION);
  if (!sampled) return 0;

  let insidePixels = 0;
  let greenPixels = 0;
  for (let y = 0; y < sampled.sampleHeight; y += 1) {
    const imageY = sampled.top + ((y + 0.5) * sampled.height) / sampled.sampleHeight;
    for (let x = 0; x < sampled.sampleWidth; x += 1) {
      const imageX = sampled.left + ((x + 0.5) * sampled.width) / sampled.sampleWidth;
      if (!pointInPolygon(imageX, imageY, polygon)) continue;

      insidePixels += 1;
      const offset = (y * sampled.sampleWidth + x) * 3;
      if (isGreen(sampled.data, offset, DEFAULT_EXG_THRESHOLD)) {
        greenPixels += 1;
      }
    }
  }

  return insidePixels > 0 ? greenPixels / insidePixels : 0;
}

export async function greenestBlobCentre(
  buffer: Buffer,
  box: VegetationBox
): Promise<[number, number] | null> {
  const sampled = await sampleRegion(buffer, box, BLOB_SAMPLE_DIMENSION);
  if (!sampled) return null;

  const pixelCount = sampled.sampleWidth * sampled.sampleHeight;
  const green = new Uint8Array(pixelCount);
  for (let index = 0; index < pixelCount; index += 1) {
    green[index] = isGreen(
      sampled.data,
      index * 3,
      DEFAULT_EXG_THRESHOLD
    ) ? 1 : 0;
  }

  const visited = new Uint8Array(pixelCount);
  const queue = new Int32Array(pixelCount);
  let largestCount = 0;
  let largestSumX = 0;
  let largestSumY = 0;

  for (let start = 0; start < pixelCount; start += 1) {
    if (!green[start] || visited[start]) continue;

    let head = 0;
    let tail = 0;
    let count = 0;
    let sumX = 0;
    let sumY = 0;
    queue[tail++] = start;
    visited[start] = 1;

    while (head < tail) {
      const current = queue[head++];
      const x = current % sampled.sampleWidth;
      const y = Math.floor(current / sampled.sampleWidth);
      count += 1;
      sumX += x;
      sumY += y;

      const neighbours = [
        x > 0 ? current - 1 : -1,
        x + 1 < sampled.sampleWidth ? current + 1 : -1,
        y > 0 ? current - sampled.sampleWidth : -1,
        y + 1 < sampled.sampleHeight ? current + sampled.sampleWidth : -1,
      ];
      for (const neighbour of neighbours) {
        if (neighbour >= 0 && green[neighbour] && !visited[neighbour]) {
          visited[neighbour] = 1;
          queue[tail++] = neighbour;
        }
      }
    }

    if (count > largestCount) {
      largestCount = count;
      largestSumX = sumX;
      largestSumY = sumY;
    }
  }

  const minimumBlobSize = Math.max(3, Math.ceil(pixelCount * 0.005));
  if (largestCount < minimumBlobSize) return null;

  const centreX = sampled.left +
    ((largestSumX / largestCount + 0.5) * sampled.width) / sampled.sampleWidth;
  const centreY = sampled.top +
    ((largestSumY / largestCount + 0.5) * sampled.height) / sampled.sampleHeight;
  return [centreX, centreY];
}
