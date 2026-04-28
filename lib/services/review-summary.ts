import type { PrismaClient } from "@prisma/client";

type ReviewPrisma = Pick<
  PrismaClient,
  "manualAnnotation" | "detection" | "pendingAnnotation" | "yOLOInferenceJob" | "processingJob"
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

export async function getReviewItemSummary(
  prisma: ReviewPrisma,
  session: ReviewSessionSummaryInput
): Promise<ReviewItemSummary> {
  const assetIds = toStringArray(session.assetIds);
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

  const pendingCount = manualPending + aiPending + yoloPending + samPending;
  const acceptedCount = manualAccepted + aiAccepted + yoloAccepted + samAccepted;
  const rejectedCount = manualRejected + aiRejected + yoloRejected + samRejected;

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
