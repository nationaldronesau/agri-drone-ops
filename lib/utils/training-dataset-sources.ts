export interface TrainingDatasetSourceFlags {
  includeAIDetections: boolean;
  includeManualAnnotations: boolean;
  includeSAM3: boolean;
}

export function normalizeTrainingDatasetSourceFlags(input: {
  includeAIDetections?: unknown;
  includeManualAnnotations?: unknown;
  includeSAM3?: unknown;
}): TrainingDatasetSourceFlags {
  return {
    includeAIDetections:
      typeof input.includeAIDetections === 'boolean' ? input.includeAIDetections : true,
    includeManualAnnotations:
      typeof input.includeManualAnnotations === 'boolean'
        ? input.includeManualAnnotations
        : true,
    includeSAM3: typeof input.includeSAM3 === 'boolean' ? input.includeSAM3 : true,
  };
}
