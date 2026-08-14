/**
 * Pins how `npm run evals` gets its credentials.
 *
 * This exists because nothing failed when it was wrong. The `evals` script
 * shipped without any `--env-file`, so oracles ran unauthenticated at
 * GitHub's 60/hour limit and a k=3 batch on 2026-08-14 reported three
 * correct runs as 33.3% accuracy — the runs succeeded and the *grader* died
 * on HTTP 403. Nothing in the suite noticed. This test is the thing that
 * would have.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

function evalsScript(): string {
  const manifest = JSON.parse(readFileSync(resolve(REPO_ROOT, 'package.json'), 'utf8')) as {
    scripts?: Record<string, string>;
  };
  const script = manifest.scripts?.evals;
  if (script === undefined) throw new Error('package.json has no "evals" script');
  return script;
}

describe('the evals npm script', () => {
  it('loads .env, so GITHUB_TOKEN reaches the oracles', () => {
    expect(evalsScript()).toMatch(/--env-file(-if-exists)?=\.env/);
  });

  it('tolerates a missing .env rather than refusing to start', () => {
    // `--env-file=.env` makes Node exit when the file is absent, which would
    // break every contributor running on ambient environment variables.
    // `--env-file-if-exists` warns and continues.
    const script = evalsScript();
    if (script.includes('--env-file=')) {
      expect.fail(
        `use --env-file-if-exists=.env, not --env-file=.env, in: ${script}\n` +
          '(--env-file hard-fails when .env is absent)',
      );
    }
    expect(script).toContain('--env-file-if-exists=.env');
  });

  it('still points at the eval runner entry point', () => {
    expect(evalsScript()).toContain('evals/runners/cli.ts');
  });
});
