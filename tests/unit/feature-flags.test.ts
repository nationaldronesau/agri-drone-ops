import { afterEach, describe, expect, it } from 'vitest';
import { isReviewMaskOverlayEnabled } from '@/lib/utils/feature-flags';

const originalReviewMaskOverlay = process.env.NEXT_PUBLIC_REVIEW_MASK_OVERLAY;

afterEach(() => {
  if (originalReviewMaskOverlay === undefined) {
    delete process.env.NEXT_PUBLIC_REVIEW_MASK_OVERLAY;
  } else {
    process.env.NEXT_PUBLIC_REVIEW_MASK_OVERLAY = originalReviewMaskOverlay;
  }
});

describe('review mask overlay feature flag', () => {
  it('is off by default', () => {
    delete process.env.NEXT_PUBLIC_REVIEW_MASK_OVERLAY;
    expect(isReviewMaskOverlayEnabled()).toBe(false);
  });

  it('is enabled only by the explicit public env override', () => {
    process.env.NEXT_PUBLIC_REVIEW_MASK_OVERLAY = 'true';
    expect(isReviewMaskOverlayEnabled()).toBe(true);

    process.env.NEXT_PUBLIC_REVIEW_MASK_OVERLAY = '1';
    expect(isReviewMaskOverlayEnabled()).toBe(false);
  });
});
