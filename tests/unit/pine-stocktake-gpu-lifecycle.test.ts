import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8');

describe('Pine Stocktake shared GPU lifecycle', () => {
  it('releases Pine SAM3 before YOLO takes the GPU', () => {
    const core = source('services/sam3-service/app/pine_stocktake.py');
    const yolo = source('services/sam3-service/app/routers/yolo.py');

    expect(core).toContain('def unload(self) -> dict[str, Any]:');
    expect(core).toContain('torch.cuda.empty_cache()');
    expect(yolo).toContain('pine_sam3.unload()');
  });

  it('releases competing models before a Pine inference job', () => {
    const router = source('services/sam3-service/app/routers/pine_stocktake.py');

    expect(router).toContain('get_predictor().unload_model()');
    expect(router).toContain('unload_segment_model()');
    expect(router).toContain('unload_current_model()');
  });

  it('includes Pine SAM3 in the service-wide unload endpoint', () => {
    const health = source('services/sam3-service/app/routers/health.py');

    expect(health).toContain('pine_result = pine_sam3.unload()');
    expect(health).toContain('"pine": pine_result');
  });
});
