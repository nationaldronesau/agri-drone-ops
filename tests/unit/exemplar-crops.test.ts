import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { buildExemplarCropsFromDetections } from '@/lib/utils/exemplar-crops';

describe('exemplar crops', () => {
  it('builds visual crops from high-confidence SAM detections only', async () => {
    const imageBuffer = await sharp({
      create: {
        width: 120,
        height: 120,
        channels: 3,
        background: '#f8fafc',
      },
    })
      .composite([
        {
          input: Buffer.from(
            '<svg width="120" height="120" xmlns="http://www.w3.org/2000/svg"><circle cx="32" cy="32" r="18" fill="#16a34a"/><circle cx="88" cy="88" r="18" fill="#16a34a"/></svg>'
          ),
          top: 0,
          left: 0,
        },
      ])
      .jpeg()
      .toBuffer();

    const crops = await buildExemplarCropsFromDetections({
      imageBuffer,
      detections: [
        {
          bbox: [14, 14, 50, 50],
          confidence: 0.92,
          polygon: [
            [32, 14],
            [50, 32],
            [32, 50],
            [14, 32],
          ],
        },
        {
          bbox: [70, 70, 106, 106],
          confidence: 0.42,
          polygon: [
            [88, 70],
            [106, 88],
            [88, 106],
            [70, 88],
          ],
        },
      ],
      maxCrops: 10,
      minConfidence: 0.6,
      paddingRatio: 0.08,
    });

    expect(crops).toHaveLength(1);

    const cropBuffer = Buffer.from(crops[0], 'base64');
    const metadata = await sharp(cropBuffer).metadata();
    expect(metadata.format).toBe('jpeg');
    expect(Math.max(metadata.width ?? 0, metadata.height ?? 0)).toBeLessThanOrEqual(512);
  });
});
