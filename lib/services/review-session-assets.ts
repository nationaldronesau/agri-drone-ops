interface ReviewSessionAssetPrisma {
  pendingAnnotation: {
    findMany(args: {
      where: {
        batchJobId: { in: string[] };
      };
      select: { assetId: true };
      distinct: ['assetId'];
    }): Promise<Array<{ assetId: string }>>;
  };
}

interface ReviewSessionAssetScope {
  workflowType: string;
  assetIds: unknown;
  batchJobIds?: unknown;
}

export function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry) => typeof entry === 'string') as string[];
}

export async function resolveReviewSessionAssetIds(
  prisma: ReviewSessionAssetPrisma,
  session: ReviewSessionAssetScope
): Promise<string[]> {
  const storedAssetIds = toStringArray(session.assetIds);

  if (session.workflowType !== 'batch_review') {
    return storedAssetIds;
  }

  if (storedAssetIds.length > 0) {
    return storedAssetIds;
  }

  const batchJobIds = toStringArray(session.batchJobIds);
  if (batchJobIds.length === 0) {
    return storedAssetIds;
  }

  const pendingAssets = await prisma.pendingAnnotation.findMany({
    where: {
      batchJobId: { in: batchJobIds },
    },
    select: { assetId: true },
    distinct: ['assetId'],
  });

  if (pendingAssets.length === 0) {
    return storedAssetIds;
  }

  const pendingAssetIds = Array.from(new Set(pendingAssets.map((entry) => entry.assetId)));
  const pendingAssetIdSet = new Set(pendingAssetIds);
  const storedAssetIdSet = new Set(storedAssetIds);

  return [
    ...storedAssetIds.filter((assetId) => pendingAssetIdSet.has(assetId)),
    ...pendingAssetIds
      .filter((assetId) => !storedAssetIdSet.has(assetId))
      .sort((left, right) => left.localeCompare(right)),
  ];
}
