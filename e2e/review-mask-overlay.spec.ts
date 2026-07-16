import { expect, test } from '@playwright/test';
import { setupMockApi } from './helpers/mock-api';

test.describe('review mask overlay', () => {
  test.skip(
    process.env.NEXT_PUBLIC_REVIEW_MASK_OVERLAY !== 'true',
    'Mask overlay is intentionally off by default.'
  );

  test('renders masks, box-only fallbacks, and provenance warnings', async ({ page }) => {
    const asset = {
      id: 'asset-1',
      fileName: 'north-block-001.jpg',
      storageUrl: '/next.svg',
      imageWidth: 394,
      imageHeight: 80,
      gpsLatitude: -27.4665,
      gpsLongitude: 153.0237,
      altitude: 78,
      gimbalPitch: -88,
      gimbalRoll: 0.4,
      gimbalYaw: 182.4,
    };

    await setupMockApi(page, {
      reviewItemsBySession: {
        'review-1': [
          {
            id: 'mask-item',
            source: 'pending',
            sourceId: 'pending-mask',
            assetId: asset.id,
            asset,
            className: 'Pine sapling',
            confidence: 0.91,
            geometry: {
              type: 'polygon',
              bbox: [80, 5, 220, 70],
              polygon: [
                [100, 10],
                [180, 10],
                [180, 50],
                [100, 50],
              ],
            },
            status: 'pending',
            correctedClass: null,
            hasGeoData: true,
            warnings: [],
          },
          {
            id: 'box-item',
            source: 'pending',
            sourceId: 'pending-box',
            assetId: asset.id,
            asset,
            className: 'Pine sapling',
            confidence: 0.72,
            geometry: {
              type: 'bbox',
              bbox: [240, 10, 300, 60],
            },
            status: 'pending',
            correctedClass: null,
            hasGeoData: true,
            warnings: [],
          },
        ],
      },
    });

    await page.goto('/review?sessionId=review-1');

    await expect(page.getByText('Box-only', { exact: true })).toBeVisible();
    await expect(page.getByText('Geometry mismatch · IoU 0.35')).toBeVisible();

    const overlay = page.locator('div.bg-gray-900 svg');
    const mask = overlay.locator('polygon');
    await expect(mask).toHaveCount(1);
    await expect(mask).toHaveAttribute('fill', 'rgba(245, 158, 11, 0.25)');
    await expect(overlay.locator('text', { hasText: 'BOX ONLY' })).toHaveCount(1);
    await expect(overlay.locator('rect[stroke-dasharray="5 4"]')).toHaveCount(0);

    await mask.hover();
    await expect(overlay.locator('rect[stroke-dasharray="5 4"]')).toHaveCount(1);
  });
});
