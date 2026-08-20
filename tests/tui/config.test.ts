import { describe, expect, it } from 'vitest';

import { createConfig } from '../../src/tui/config.js';

describe('createConfig', () => {
  it('defaults verbose off and the runs directory', () => {
    const config = createConfig();
    expect(config.verbose).toBe(false);
    expect(config.runsBaseDir).toBe('runs');
  });

  it('applies overrides over defaults', () => {
    const config = createConfig({ verbose: true, runsBaseDir: '/tmp/runs' });
    expect(config.verbose).toBe(true);
    expect(config.runsBaseDir).toBe('/tmp/runs');
  });
});
