import { describe, expect, it } from 'vitest';
import { resolveBatchV2ModeForAssetCount } from '@/app/api/sam3/v2/batch/route';

describe('sam3 batch v2 API mode resolution', () => {
  it('forces multi-image visual crop requests onto visual exemplar propagation', () => {
    expect(resolveBatchV2ModeForAssetCount('visual_crop_match', 2)).toBe('concept_propagation');
    expect(resolveBatchV2ModeForAssetCount('visual_crop_match', 10)).toBe('concept_propagation');
  });

  it('preserves single-image visual crop debug mode', () => {
    expect(resolveBatchV2ModeForAssetCount('visual_crop_match', 1)).toBe('visual_crop_match');
  });

  it('preserves explicit concept propagation requests', () => {
    expect(resolveBatchV2ModeForAssetCount('concept_propagation', 1)).toBe('concept_propagation');
    expect(resolveBatchV2ModeForAssetCount('concept_propagation', 10)).toBe('concept_propagation');
  });
});
