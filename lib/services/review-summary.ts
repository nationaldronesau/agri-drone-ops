import type { PrismaClient } from "@prisma/client";
import { resolveReviewSessionAssetIds } from "@/lib/services/review-session-assets";

type ReviewPrisma = Pick<
  PrismaClient,
  | "manualAnnotation"
  | "detection"
  | "pendingAnnotation"
  | "reviewSessionEdit"
  | "yOLOInferenceJob"
  | "processingJob"
>;

export interface ReviewSessionSummaryInput {
  id: string;
  projectId: string;
  workflowType: string;
  assetIds: unknown;
  inferenceJobIds?: unknown;
  batchJobIds?: unknown;
  createdAt: Date;
}

export interface ReviewItemSummary {
  pendingCount: number;
  acceptedCount: number;
  rejectedCount: number;
  exportReadyCount: number;
  totalItemCount: number;
}

export function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry) => typeof entry === "string") as string[];
}

async function resolveInferenceJobIds(
  prisma: ReviewPrisma,
  session: ReviewSessionSummaryInput
) {
  const requestedIds = toStringArray(session.inferenceJobIds);
  if (requestedIds.length === 0) {
    return { yoloInferenceJobIds: [], aiProcessingJobIds: [] };
  }

  const [yoloJobs, processingJobs] = await Promise.all([
    prisma.yOLOInferenceJob.findMany({
      where: { id: { in: requestedIds }, projectId: session.projectId },
      select: { id: true },
    }),
    prisma.processingJob.findMany({
      where: {
        id: { in: requestedIds },
        projectId: session.projectId,
        type: "AI_DETECTION",
      },
      select: { id: true },
    }),
  ]);

  return {
    yoloInferenceJobIds: yoloJobs.map((job) => job.id),
    aiProcessingJobIds: processingJobs.map((job) => job.id),
  };
}

type ReviewStatus = "pending" | "accepted" | "rejected";

function manualStatus(annotation: { verified: boolean; verifiedAt: Date | null }): ReviewStatus {
  if (annotation.verified) return "accepted";
  if (annotation.verifiedAt) return "rejected";
  return "pending";
}

function pendingStatus(annotation: { status: string }): ReviewStatus {
  if (annotation.status === "ACCEPTED") return "accepted";
  if (annotation.status === "REJECTED") return "rejected";
  return "pending";
}

function detectionStatus(detection: {
  verified: boolean;
  rejected: boolean;
  userCorrected: boolean;
}): ReviewStatus {
  if (detection.rejected) return "rejected";
  if (detection.verified || detection.userCorrected) return "accepted";
  return "pending";
}

export async function getReviewItemSummary(
  prisma: ReviewPrisma,
  session: ReviewSessionSummaryInput
): Promise<ReviewItemSummary> {
  const assetIds = await resolveReviewSessionAssetIds(prisma, session);
  if (assetIds.length === 0) {
    return {
      pendingCount: 0,
      acceptedCount: 0,
      rejectedCount: 0,
      exportReadyCount: 0,
      totalItemCount: 0,
    };
  }

  const isBatchReview = session.workflowType === "batch_review";
  const batchJobIds = toStringArray(session.batchJobIds);
  const { yoloInferenceJobIds, aiProcessingJobIds } = await resolveInferenceJobIds(
    prisma,
    session
  );

  const manualBaseWhere = {
    session: { assetId: { in: assetIds } },
    createdAt: { gte: session.createdAt },
  };
  const aiBaseWhere = {
    assetId: { in: assetIds },
    type: "AI" as const,
    ...(aiProcessingJobIds.length > 0
      ? { jobId: { in: aiProcessingJobIds } }
      : { createdAt: { gte: session.createdAt } }),
  };
  const yoloBaseWhere = {
    assetId: { in: assetIds },
    type: "YOLO_LOCAL" as const,
    inferenceJobId: { in: yoloInferenceJobIds },
  };
  const pendingBaseWhere = {
    assetId: { in: assetIds },
    batchJobId: { in: batchJobIds },
  };

  const [
    manualPending,
    manualAccepted,
    manualRejected,
    aiPending,
    aiAccepted,
    aiRejected,
    yoloPending,
    yoloAccepted,
    yoloRejected,
    samPending,
    samAccepted,
    samRejected,
  ] = await Promise.all([
    !isBatchReview
      ? prisma.manualAnnotation.count({
          where: { ...manualBaseWhere, verified: false, verifiedAt: null },
        })
      : Promise.resolve(0),
    !isBatchReview
      ? prisma.manualAnnotation.count({ where: { ...manualBaseWhere, verified: true } })
      : Promise.resolve(0),
    !isBatchReview
      ? prisma.manualAnnotation.count({
          where: { ...manualBaseWhere, verified: false, verifiedAt: { not: null } },
        })
      : Promise.resolve(0),
    !isBatchReview
      ? prisma.detection.count({
          where: {
            ...aiBaseWhere,
            verified: false,
            userCorrected: false,
            rejected: false,
          },
        })
      : Promise.resolve(0),
    !isBatchReview
      ? prisma.detection.count({
          where: {
            ...aiBaseWhere,
            rejected: false,
            OR: [{ verified: true }, { userCorrected: true }],
          },
        })
      : Promise.resolve(0),
    !isBatchReview
      ? prisma.detection.count({ where: { ...aiBaseWhere, rejected: true } })
      : Promise.resolve(0),
    !isBatchReview && yoloInferenceJobIds.length > 0
      ? prisma.detection.count({
          where: {
            ...yoloBaseWhere,
            verified: false,
            userCorrected: false,
            rejected: false,
          },
        })
      : Promise.resolve(0),
    !isBatchReview && yoloInferenceJobIds.length > 0
      ? prisma.detection.count({
          where: {
            ...yoloBaseWhere,
            rejected: false,
            OR: [{ verified: true }, { userCorrected: true }],
          },
        })
      : Promise.resolve(0),
    !isBatchReview && yoloInferenceJobIds.length > 0
      ? prisma.detection.count({ where: { ...yoloBaseWhere, rejected: true } })
      : Promise.resolve(0),
    batchJobIds.length > 0
      ? prisma.pendingAnnotation.count({
          where: { ...pendingBaseWhere, status: "PENDING" },
        })
      : Promise.resolve(0),
    batchJobIds.length > 0
      ? prisma.pendingAnnotation.count({
          where: { ...pendingBaseWhere, status: "ACCEPTED" },
        })
      : Promise.resolve(0),
    batchJobIds.length > 0
      ? prisma.pendingAnnotation.count({
          where: { ...pendingBaseWhere, status: "REJECTED" },
        })
      : Promise.resolve(0),
  ]);

  let pendingCount = manualPending + aiPending + yoloPending + samPending;
  let acceptedCount = manualAccepted + aiAccepted + yoloAccepted + samAccepted;
  let rejectedCount = manualRejected + aiRejected + yoloRejected + samRejected;

  const reviewEdits = await prisma.reviewSessionEdit.findMany({
    where: { reviewSessionId: session.id },
  });

  if (reviewEdits.length > 0) {
    const decrement = (status: ReviewStatus) => {
      if (status === "accepted") acceptedCount = Math.max(0, acceptedCount - 1);
      else if (status === "rejected") rejectedCount = Math.max(0, rejectedCount - 1);
      else pendingCount = Math.max(0, pendingCount - 1);
    };
    const increment = (status: ReviewStatus) => {
      if (status === "accepted") acceptedCount += 1;
      else if (status === "rejected") rejectedCount += 1;
      else pendingCount += 1;
    };

    const manualSourceIds = reviewEdits
      .filter((edit) => edit.sourceType === "manual")
      .map((edit) => edit.sourceId);
    const pendingSourceIds = reviewEdits
      .filter((edit) => edit.sourceType === "pending")
      .map((edit) => edit.sourceId);
    const detectionSourceIds = reviewEdits
      .filter((edit) => edit.sourceType === "detection")
      .map((edit) => edit.sourceId);
    const editedAnnotationIds = Array.from(
      new Set(reviewEdits.map((edit) => edit.newAnnotationId))
    );

    const [manualOriginals, pendingOriginals, detectionOriginals, editedReplacements] =
      await Promise.all([
        manualSourceIds.length > 0
          ? prisma.manualAnnotation.findMany({
              where: {
                id: { in: manualSourceIds },
                session: { assetId: { in: assetIds } },
              },
              select: { id: true, verified: true, verifiedAt: true },
            })
          : Promise.resolve([]),
        pendingSourceIds.length > 0
          ? prisma.pendingAnnotation.findMany({
              where: {
                id: { in: pendingSourceIds },
                assetId: { in: assetIds },
              },
              select: { id: true, status: true },
            })
          : Promise.resolve([]),
        detectionSourceIds.length > 0
          ? prisma.detection.findMany({
              where: {
                id: { in: detectionSourceIds },
                assetId: { in: assetIds },
              },
              select: { id: true, verified: true, rejected: true, userCorrected: true },
            })
          : Promise.resolve([]),
        isBatchReview && editedAnnotationIds.length > 0
          ? prisma.manualAnnotation.findMany({
              where: {
                id: { in: editedAnnotationIds },
                session: { assetId: { in: assetIds } },
              },
              select: { id: true, verified: true, verifiedAt: true },
            })
          : Promise.resolve([]),
      ]);

    const manualOriginalStatusById = new Map(
      manualOriginals.map((annotation) => [annotation.id, manualStatus(annotation)])
    );
    const pendingOriginalStatusById = new Map(
      pendingOriginals.map((annotation) => [annotation.id, pendingStatus(annotation)])
    );
    const detectionOriginalStatusById = new Map(
      detectionOriginals.map((detection) => [detection.id, detectionStatus(detection)])
    );

    for (const edit of reviewEdits) {
      const status =
        edit.sourceType === "manual"
          ? manualOriginalStatusById.get(edit.sourceId)
          : edit.sourceType === "pending"
            ? pendingOriginalStatusById.get(edit.sourceId)
            : edit.sourceType === "detection"
              ? detectionOriginalStatusById.get(edit.sourceId)
              : null;
      if (status) decrement(status);
    }

    for (const replacement of editedReplacements) {
      increment(manualStatus(replacement));
    }
  }

  return {
    pendingCount,
    acceptedCount,
    rejectedCount,
    exportReadyCount: acceptedCount,
    totalItemCount: pendingCount + acceptedCount + rejectedCount,
  };
}

export async function getReviewItemSummaries(
  prisma: ReviewPrisma,
  sessions: ReviewSessionSummaryInput[]
): Promise<Map<string, ReviewItemSummary>> {
  const entries = await Promise.all(
    sessions.map(async (session) => [session.id, await getReviewItemSummary(prisma, session)] as const)
  );
  return new Map(entries);
}
