interface ReviewTrainingPrisma {
  pendingAnnotation: {
    findMany(args: {
      where: {
        assetId: { in: string[] };
        batchJobId: { in: string[] };
        status: 'PENDING';
      };
      select: { assetId: true };
      distinct: ['assetId'];
    }): Promise<Array<{ assetId: string }>>;
  };
}

interface ReviewTrainingSession {
  workflowType: string;
  batchJobIds?: unknown;
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry) => typeof entry === 'string') as string[];
}

export async function resolveTrainingReadyAssetIds(
  prisma: ReviewTrainingPrisma,
  session: ReviewTrainingSession,
  assetIds: string[]
): Promise<string[]> {
  if (session.workflowType !== 'batch_review') {
    return assetIds;
  }

  const batchJobIds = toStringArray(session.batchJobIds);
  if (assetIds.length === 0 || batchJobIds.length === 0) {
    return [];
  }

  const incompleteAssets = await prisma.pendingAnnotation.findMany({
    where: {
      assetId: { in: assetIds },
      batchJobId: { in: batchJobIds },
      status: 'PENDING',
    },
    select: { assetId: true },
    distinct: ['assetId'],
  });
  const incompleteAssetIds = new Set(incompleteAssets.map((entry) => entry.assetId));

  return assetIds.filter((assetId) => !incompleteAssetIds.has(assetId));
}
