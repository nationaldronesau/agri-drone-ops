import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import {
  greenFraction,
  greenFractionInPolygon,
  greenestBlobCentre,
} from '@/lib/utils/vegetation';

const BROWN: [number, number, number] = [140, 90, 40];
const GREEN: [number, number, number] = [20, 180, 20];

async function syntheticImage(
  width: number,
  height: number,
  rectangles: Array<{ left: number; top: number; width: number; height: number }>
): Promise<Buffer> {
  const pixels = Buffer.alloc(width * height * 3);
  for (let index = 0; index < width * height; index += 1) {
    pixels[index * 3] = BROWN[0];
    pixels[index * 3 + 1] = BROWN[1];
    pixels[index * 3 + 2] = BROWN[2];
  }

  for (const rectangle of rectangles) {
    for (let y = rectangle.top; y < rectangle.top + rectangle.height; y += 1) {
      for (let x = rectangle.left; x < rectangle.left + rectangle.width; x += 1) {
        const offset = (y * width + x) * 3;
        pixels[offset] = GREEN[0];
        pixels[offset + 1] = GREEN[1];
        pixels[offset + 2] = GREEN[2];
      }
    }
  }

  return sharp(pixels, { raw: { width, height, channels: 3 } }).png().toBuffer();
}

describe('vegetation utilities', () => {
  it('measures ExG green fractions in an image and a box', async () => {
    const image = await syntheticImage(100, 100, [
      { left: 20, top: 30, width: 40, height: 40 },
    ]);

    await expect(greenFraction(image)).resolves.toBeCloseTo(0.16, 4);
    await expect(greenFraction(image, [20, 30, 60, 70])).resolves.toBeCloseTo(1, 4);
    await expect(greenFraction(image, [0, 0, 20, 20])).resolves.toBe(0);
  });

  it('measures green fraction only inside the polygon', async () => {
    const image = await syntheticImage(100, 100, [
      { left: 20, top: 20, width: 40, height: 40 },
    ]);
    const polygon: [number, number][] = [
      [20, 20],
      [60, 20],
      [60, 60],
      [20, 60],
    ];

    await expect(greenFractionInPolygon(image, polygon, 100, 100)).resolves.toBeCloseTo(1, 4);
  });

  it('finds the centre of the largest green blob within a box', async () => {
    const image = await syntheticImage(100, 100, [
      { left: 14, top: 70, width: 5, height: 5 },
      { left: 50, top: 20, width: 20, height: 30 },
    ]);

    const centre = await greenestBlobCentre(image, [10, 10, 90, 90]);

    expect(centre).not.toBeNull();
    expect(centre?.[0]).toBeCloseTo(60, 0);
    expect(centre?.[1]).toBeCloseTo(35, 0);
  });

  it('returns null when no minimum-sized green blob exists', async () => {
    const image = await syntheticImage(100, 100, []);

    await expect(greenestBlobCentre(image, [10, 10, 90, 90])).resolves.toBeNull();
  });

  it('is deterministic when regular-grid downsampling is required', async () => {
    const image = await syntheticImage(600, 400, [
      { left: 0, top: 0, width: 300, height: 400 },
    ]);

    const results = await Promise.all([
      greenFraction(image),
      greenFraction(image),
      greenFraction(image),
    ]);

    expect(results[0]).toBeCloseTo(0.5, 2);
    expect(results[1]).toBe(results[0]);
    expect(results[2]).toBe(results[0]);
  });
});
