import { describe, expect, it } from 'vitest';
import { summarizeSam3BatchExecution } from '@/lib/utils/sam3-batch-execution';

describe('summarizeSam3BatchExecution', () => {
  it('reports the direct SAM3 and DINO route without an external provider fallback', () => {
    const summary = summarizeSam3BatchExecution(
      [[
        {
          stage: 'run_sam3',
          status: 'completed',
          assetId: 'asset-1',
          modeUsed: 'concept_propagation',
          reviewProfile: 'high_recall',
          backendMode: 'concept_ensemble_refined',
        },
      ]],
      'concept_propagation'
    );

    expect(summary).toMatchObject({
      providerRoute: 'aws_sam3_v2_direct',
      providerLabel: 'AWS SAM3',
      pipeline: 'sam3_dino_concept',
      externalProviderFallback: false,
      runtimeConfirmed: true,
      reviewProfile: 'high_recall',
      backendModes: ['concept_ensemble_refined'],
      degradedAssets: 0,
    });
  });

  it('separates same-model candidate expansion from unrefined result fallback', () => {
    const summary = summarizeSam3BatchExecution(
      [[
        {
          stage: 'run_sam3',
          status: 'completed',
          assetId: 'asset-1',
          candidateExpansionUsed: true,
          backendMode: 'concept_ensemble_refined',
        },
        {
          stage: 'run_sam3',
          status: 'completed',
          assetId: 'asset-2',
          backendMode: 'concept_ensemble_candidates_unrefined',
          backendWarning: 'Box refinement failed; saved candidates for review.',
        },
      ]],
      'concept_propagation'
    );

    expect(summary).toMatchObject({
      externalProviderFallback: false,
      candidateExpansionAssets: 1,
      refinementFallbackAssets: 1,
      degradedAssets: 2,
      warnings: ['Box refinement failed; saved candidates for review.'],
    });
  });
});
