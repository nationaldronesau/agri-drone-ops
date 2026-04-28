export function shouldIncludePendingAnnotations(
  includePendingParam: string | null
): boolean {
  return includePendingParam === "true";
}

export function buildDetectionReviewFilter(needsReview: boolean) {
  return {
    rejected: false,
    ...(needsReview
      ? { verified: false, userCorrected: false }
      : { OR: [{ verified: true }, { userCorrected: true }] }),
  };
}

export function buildManualAnnotationReviewFilter(needsReview: boolean) {
  return needsReview
    ? { verified: false, verifiedAt: null }
    : { verified: true };
}

export function buildPendingAnnotationReviewFilter(needsReview: boolean) {
  return needsReview
    ? { status: "PENDING" as const }
    : { status: "ACCEPTED" as const };
}
