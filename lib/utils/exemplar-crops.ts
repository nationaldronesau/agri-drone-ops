import sharp from 'sharp';
import type { BoxCoordinate } from './exemplar-scaling';

const DATA_URL_PREFIX = /^data:image\/[a-zA-Z0-9.+-]+;base64,/;
const BASE64_REGEX = /^[A-Za-z0-9+/]+={0,2}$/;

export function normalizeBase64Image(input: string): string | null {
  if (!input) return null;
  const trimmed = input.trim();
  if (!trimmed) return null;

  if (DATA_URL_PREFIX.test(trimmed)) {
    const [, data] = trimmed.split('base64,');
    return data ? data.trim() : null;
  }

  if (BASE64_REGEX.test(trimmed)) {
    return trimmed;
  }

  return null;
}

export function normalizeExemplarCrops(crops?: string[]): string[] {
  if (!Array.isArray(crops)) return [];
  const normalized: string[] = [];
  for (const crop of crops) {
    const cleaned = normalizeBase64Image(crop);
    if (cleaned) normalized.push(cleaned);
  }
  return normalized;
}

export interface BuildExemplarCropsOptions {
  imageBuffer: Buffer;
  boxes: BoxCoordinate[];
  maxCrops?: number;
  maxDimension?: number;
  jpegQuality?: number;
  paddingRatio?: number;
}

export async function buildExemplarCrops(
  options: BuildExemplarCropsOptions
): Promise<string[]> {
  const {
    imageBuffer,
    boxes,
    maxCrops = 10,
    maxDimension = 512,
    jpegQuality = 85,
    paddingRatio = 0,
  } = options;

  if (!boxes.length) return [];

  const image = sharp(imageBuffer);
  const metadata = await image.metadata();
  const width = metadata.width ?? 0;
  const height = metadata.height ?? 0;
  if (!width || !height) return [];

  const crops: string[] = [];
  for (const box of boxes.slice(0, maxCrops)) {
    try {
      const cropBuffer = await cropImageFromBox({
        image,
        imageWidth: width,
        imageHeight: height,
        box,
        maxDimension,
        jpegQuality,
        paddingRatio,
      });
      if (!cropBuffer) continue;
      crops.push(cropBuffer.toString('base64'));
    } catch (error) {
      console.warn('[Exemplar Crops] Failed to build crop:', error);
    }
  }

  return crops;
}

export interface ExemplarCropDetection {
  bbox: [number, number, number, number];
  confidence?: number;
  polygon?: [number, number][];
}

export interface BuildExemplarCropsFromDetectionsOptions {
  imageBuffer: Buffer;
  detections: ExemplarCropDetection[];
  maxCrops?: number;
  maxDimension?: number;
  jpegQuality?: number;
  minConfidence?: number;
  paddingRatio?: number;
  maskPolygons?: boolean;
}

export async function buildExemplarCropsFromDetections(
  options: BuildExemplarCropsFromDetectionsOptions
): Promise<string[]> {
  const {
    imageBuffer,
    detections,
    maxCrops = 30,
    maxDimension = 512,
    jpegQuality = 85,
    minConfidence = 0.6,
    paddingRatio = 0.08,
    maskPolygons = true,
  } = options;

  if (!detections.length) return [];

  const image = sharp(imageBuffer);
  const metadata = await image.metadata();
  const width = metadata.width ?? 0;
  const height = metadata.height ?? 0;
  if (!width || !height) return [];

  const selected = detections
    .filter((detection) => (detection.confidence ?? 0) >= minConfidence)
    .sort((left, right) => (right.confidence ?? 0) - (left.confidence ?? 0))
    .slice(0, maxCrops);

  const crops: string[] = [];
  for (const detection of selected) {
    try {
      const box = bboxToBox(detection.bbox);
      const cropBuffer = await cropImageFromBox({
        image,
        imageWidth: width,
        imageHeight: height,
        box,
        polygon: maskPolygons ? detection.polygon : undefined,
        maxDimension,
        jpegQuality,
        paddingRatio,
      });
      if (!cropBuffer) continue;
      crops.push(cropBuffer.toString('base64'));
    } catch (error) {
      console.warn('[Exemplar Crops] Failed to build detection crop:', error);
    }
  }

  return crops;
}

function bboxToBox(bbox: [number, number, number, number]): BoxCoordinate {
  return {
    x1: bbox[0],
    y1: bbox[1],
    x2: bbox[2],
    y2: bbox[3],
  };
}

async function cropImageFromBox({
  image,
  imageWidth,
  imageHeight,
  box,
  polygon,
  maxDimension,
  jpegQuality,
  paddingRatio,
}: {
  image: sharp.Sharp;
  imageWidth: number;
  imageHeight: number;
  box: BoxCoordinate;
  polygon?: [number, number][];
  maxDimension: number;
  jpegQuality: number;
  paddingRatio: number;
}): Promise<Buffer | null> {
  const crop = clampCropBounds(expandBox(box, paddingRatio), imageWidth, imageHeight);
  if (!crop) return null;

  let cropImage = image.clone().extract({
    left: crop.left,
    top: crop.top,
    width: crop.width,
    height: crop.height,
  });

  if (polygon && polygon.length >= 3) {
    const mask = polygonToMask(polygon, crop.left, crop.top, crop.width, crop.height);
    cropImage = sharp({
      create: {
        width: crop.width,
        height: crop.height,
        channels: 3,
        background: '#ffffff',
      },
    }).composite([
      {
        input: await cropImage.png().toBuffer(),
        blend: 'over',
      },
      {
        input: mask,
        blend: 'dest-in',
      },
    ]);
  }

  return cropImage
    .resize({
      width: maxDimension,
      height: maxDimension,
      fit: 'inside',
      withoutEnlargement: true,
    })
    .flatten({ background: '#ffffff' })
    .jpeg({ quality: jpegQuality })
    .toBuffer();
}

function expandBox(box: BoxCoordinate, paddingRatio: number): BoxCoordinate {
  const minX = Math.min(box.x1, box.x2);
  const minY = Math.min(box.y1, box.y2);
  const maxX = Math.max(box.x1, box.x2);
  const maxY = Math.max(box.y1, box.y2);
  const padX = (maxX - minX) * paddingRatio;
  const padY = (maxY - minY) * paddingRatio;

  return {
    x1: minX - padX,
    y1: minY - padY,
    x2: maxX + padX,
    y2: maxY + padY,
  };
}

function clampCropBounds(
  box: BoxCoordinate,
  imageWidth: number,
  imageHeight: number
): { left: number; top: number; width: number; height: number } | null {
  const left = Math.max(0, Math.min(imageWidth - 1, Math.round(Math.min(box.x1, box.x2))));
  const top = Math.max(0, Math.min(imageHeight - 1, Math.round(Math.min(box.y1, box.y2))));
  const right = Math.max(left + 1, Math.min(imageWidth, Math.round(Math.max(box.x1, box.x2))));
  const bottom = Math.max(top + 1, Math.min(imageHeight, Math.round(Math.max(box.y1, box.y2))));
  const width = right - left;
  const height = bottom - top;

  return width > 1 && height > 1 ? { left, top, width, height } : null;
}

function polygonToMask(
  polygon: [number, number][],
  left: number,
  top: number,
  width: number,
  height: number
): Buffer {
  const points = polygon
    .map(([x, y]) => `${Math.round(x - left)},${Math.round(y - top)}`)
    .join(' ');

  return Buffer.from(
    `<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg"><polygon points="${points}" fill="#ffffff"/></svg>`
  );
}
