import { describe, expect, it } from 'vitest';

import { createConfig, DEFAULT_WORKING_WORDS } from '../../src/tui/config.js';

describe('createConfig', () => {
  it('defaults the completion verb to Brewed', () => {
    expect(createConfig().completionVerb).toBe('Brewed');
  });

  it('makes the completion verb configurable (R6)', () => {
    expect(createConfig({ completionVerb: 'Distilled' }).completionVerb).toBe(
      'Distilled',
    );
  });

  it('defaults to a non-empty working-word list (R4)', () => {
    const config = createConfig();
    expect(config.workingWords.length).toBeGreaterThan(0);
    expect(config.workingWords).toEqual(DEFAULT_WORKING_WORDS);
  });

  it('defaults verbose off, runs dir, and positive motion cadences', () => {
    const config = createConfig();
    expect(config.verbose).toBe(false);
    expect(config.runsBaseDir).toBe('runs');
    expect(config.wordCycleMs).toBeGreaterThan(0);
    expect(config.glyphFps).toBeGreaterThan(0);
  });

  it('applies overrides over defaults', () => {
    const config = createConfig({ verbose: true, runsBaseDir: '/tmp/runs' });
    expect(config.verbose).toBe(true);
    expect(config.runsBaseDir).toBe('/tmp/runs');
    expect(config.completionVerb).toBe('Brewed');
  });
});
