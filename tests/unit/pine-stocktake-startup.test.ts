import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('Pine Stocktake production startup', () => {
  it('starts the restartable Pine Stocktake queue worker', () => {
    const ecosystem = readFileSync(resolve(process.cwd(), 'ecosystem.config.js'), 'utf8');

    expect(ecosystem).toContain('name: "pine-stocktake-worker"');
    expect(ecosystem).toContain('args: "run worker:pine-stocktake"');
  });
});
