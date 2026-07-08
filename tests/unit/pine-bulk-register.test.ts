import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/db', () => ({
  default: {
    $disconnect: vi.fn(),
  },
}));

import { planBulkRegistration } from '@/scripts/pine-bulk-register';

describe('pine bulk register planning', () => {
  it('skips already-registered filename stems and duplicate input stems', () => {
    const plan = planBulkRegistration(
      [
        { fileName: 'PINE_001.JPG', filePath: '/images/PINE_001.JPG' },
        { fileName: 'PINE_002.jpg', filePath: '/images/PINE_002.jpg' },
        { fileName: 'PINE_002.jpeg', filePath: '/images/PINE_002.jpeg' },
        { fileName: 'PINE_003.JPG', filePath: '/images/PINE_003.JPG' },
      ],
      [
        { id: 'asset-1', fileName: 'PINE_001.jpg' },
        { id: 'asset-9', fileName: 'other.jpg' },
      ]
    );

    expect(plan.toRegister).toEqual([
      { fileName: 'PINE_002.jpg', filePath: '/images/PINE_002.jpg' },
      { fileName: 'PINE_003.JPG', filePath: '/images/PINE_003.JPG' },
    ]);
    expect(plan.skipped).toEqual([
      {
        fileName: 'PINE_001.JPG',
        assetId: 'asset-1',
        reason: 'filename_stem_already_registered',
      },
      {
        fileName: 'PINE_002.jpeg',
        assetId: '',
        reason: 'duplicate_input_filename_stem',
      },
    ]);
  });
});
