export interface Sam3ExecutionStageEntry {
  stage?: string;
  status?: string;
  assetId?: string;
  modeUsed?: string;
  reviewProfile?: string;
  backendMode?: string;
  backendWarning?: string;
  candidateExpansionUsed?: boolean;
}

export interface Sam3BatchExecutionSummary {
  providerRoute: 'aws_sam3_v2_direct';
  providerLabel: 'AWS SAM3';
  pipeline: 'sam3_dino_concept' | 'sam3_visual_crops';
  pipelineLabel: string;
  externalProviderFallback: false;
  runtimeConfirmed: boolean;
  reviewProfile: string | null;
  backendModes: string[];
  candidateExpansionAssets: number;
  refinementFallbackAssets: number;
  degradedAssets: number;
  warnings: string[];
}

export function summarizeSam3BatchExecution(
  stageLogs: Sam3ExecutionStageEntry[][],
  mode: string | null | undefined
): Sam3BatchExecutionSummary {
  const entries = stageLogs.flat();
  const assetEntries = entries.filter((entry) => entry.stage === 'run_sam3' && entry.assetId);
  const backendModes = Array.from(
    new Set(assetEntries.map((entry) => entry.backendMode).filter((value): value is string => Boolean(value)))
  );
  const warnings = Array.from(
    new Set(assetEntries.map((entry) => entry.backendWarning).filter((value): value is string => Boolean(value)))
  );
  const candidateExpansionAssetIds = new Set(
    assetEntries.filter((entry) => entry.candidateExpansionUsed).map((entry) => entry.assetId as string)
  );
  const refinementFallbackAssetIds = new Set(
    assetEntries
      .filter((entry) => entry.backendMode?.includes('candidates_unrefined'))
      .map((entry) => entry.assetId as string)
  );
  const degradedAssetIds = new Set([
    ...candidateExpansionAssetIds,
    ...refinementFallbackAssetIds,
    ...assetEntries.filter((entry) => entry.backendWarning).map((entry) => entry.assetId as string),
  ]);
  const reviewProfile = [...assetEntries]
    .reverse()
    .find((entry) => entry.reviewProfile)?.reviewProfile || null;
  const conceptPipeline = mode === 'concept_propagation';

  return {
    providerRoute: 'aws_sam3_v2_direct',
    providerLabel: 'AWS SAM3',
    pipeline: conceptPipeline ? 'sam3_dino_concept' : 'sam3_visual_crops',
    pipelineLabel: conceptPipeline ? 'SAM3 + DINO concept propagation' : 'SAM3 visual crop matching',
    externalProviderFallback: false,
    runtimeConfirmed: assetEntries.some((entry) => entry.status === 'completed' || entry.status === 'failed'),
    reviewProfile,
    backendModes,
    candidateExpansionAssets: candidateExpansionAssetIds.size,
    refinementFallbackAssets: refinementFallbackAssetIds.size,
    degradedAssets: degradedAssetIds.size,
    warnings,
  };
}
