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
  } = options;

  if (!boxes.length) return [];

  const image = sharp(imageBuffer);
  const metadata = await image.metadata();
  const width = metadata.width ?? 0;
  const height = metadata.height ?? 0;
  if (!width || !height) return [];

  const crops: string[] = [];
  for (const box of boxes.slice(0, maxCrops)) {
    const minX = Math.min(box.x1, box.x2);
    const minY = Math.min(box.y1, box.y2);
    const maxX = Math.max(box.x1, box.x2);
    const maxY = Math.max(box.y1, box.y2);

    const left = Math.max(0, Math.min(width - 1, Math.round(minX)));
    const top = Math.max(0, Math.min(height - 1, Math.round(minY)));
    const right = Math.max(left + 1, Math.min(width, Math.round(maxX)));
    const bottom = Math.max(top + 1, Math.min(height, Math.round(maxY)));

    const cropWidth = right - left;
    const cropHeight = bottom - top;
    if (cropWidth <= 1 || cropHeight <= 1) continue;

    try {
      const cropBuffer = await image
        .clone()
        .extract({ left, top, width: cropWidth, height: cropHeight })
        .resize({
          width: maxDimension,
          height: maxDimension,
          fit: 'inside',
          withoutEnlargement: true,
        })
        .jpeg({ quality: jpegQuality })
        .toBuffer();

      crops.push(cropBuffer.toString('base64'));
    } catch (error) {
      console.warn('[Exemplar Crops] Failed to build crop:', error);
    }
  }

  return crops;
}
