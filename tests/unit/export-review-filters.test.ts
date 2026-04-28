import { describe, expect, it } from 'vitest';
import {
  buildDetectionReviewFilter,
  buildManualAnnotationReviewFilter,
  buildPendingAnnotationReviewFilter,
  shouldIncludePendingAnnotations,
} from '@/lib/utils/export-review-filters';

describe('export review filters', () => {
  it('exports accepted AI detections by default', () => {
    expect(buildDetectionReviewFilter(false)).toEqual({
      rejected: false,
      OR: [{ verified: true }, { userCorrected: true }],
    });
  });

  it('excludes rejected and pending AI detections from default operational exports', () => {
    const filter = buildDetectionReviewFilter(false);

    expect(filter).not.toMatchObject({ rejected: true });
    expect(filter).not.toMatchObject({ verified: false, userCorrected: false });
  });

  it('exports pending AI detections only for explicit review QA exports', () => {
    expect(buildDetectionReviewFilter(true)).toEqual({
      rejected: false,
      verified: false,
      userCorrected: false,
    });
  });

  it('requires an explicit includePending=true flag for pending annotation tables', () => {
    expect(shouldIncludePendingAnnotations(null)).toBe(false);
    expect(shouldIncludePendingAnnotations('false')).toBe(false);
    expect(shouldIncludePendingAnnotations('true')).toBe(true);
  });

  it('exports only verified manual annotations by default', () => {
    expect(buildManualAnnotationReviewFilter(false)).toEqual({ verified: true });
  });

  it('excludes rejected manual annotations from default exports', () => {
    expect(buildManualAnnotationReviewFilter(false)).not.toMatchObject({
      verified: false,
    });
  });

  it('exports accepted SAM3 pending annotations when that table is included', () => {
    expect(buildPendingAnnotationReviewFilter(false)).toEqual({ status: 'ACCEPTED' });
  });

  it('exports unreviewed SAM3 pending annotations only for explicit review QA exports', () => {
    expect(buildPendingAnnotationReviewFilter(true)).toEqual({ status: 'PENDING' });
  });
});
