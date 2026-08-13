import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  HARNESS_FILENAME,
  writeHarnessDiagnostics,
  type HarnessDiagnostics,
} from './harness.js';

// Pure I/O over a temp run directory — no model calls, no browser,
// matching the hermetic-suite convention used across this codebase's other
// run-dir helpers (artifacts.test.ts, transcript.test.ts). The old
// per-cycle metrics archival/rollup helpers are gone with the
// fresh-loop-per-cycle model: one persistent WorkerSession writes a single
// metrics.json with role totals (covered in workerSession.test.ts and
// runTask.test.ts).

let runDir: string;

beforeEach(() => {
  runDir = mkdtempSync(join(tmpdir(), 'harness-test-'));
});

afterEach(() => {
  rmSync(runDir, { recursive: true, force: true });
});

describe('writeHarnessDiagnostics', () => {
  it('writes harness.json with the given diagnostics, pretty-printed', () => {
    const diagnostics: HarnessDiagnostics = {
      initializer: { model: 'claude-sonnet-5' },
      cycles: [{ cycle: 1, workerStatus: 'completed', verdict: 'verified' }],
      outcome: { status: 'verified' },
    };

    writeHarnessDiagnostics(runDir, diagnostics);

    const path = join(runDir, HARNESS_FILENAME);
    expect(existsSync(path)).toBe(true);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(diagnostics);
  });

  it('overwrites a previous harness.json rather than appending', () => {
    writeHarnessDiagnostics(runDir, {
      initializer: { model: 'claude-sonnet-5' },
      cycles: [{ cycle: 1, workerStatus: 'budget_exceeded' }],
      outcome: {
        status: 'incomplete',
        reason: 'budget_exceeded',
        detail: "worker budget guard 'max_turns' tripped in cycle 1",
      },
    });
    const second: HarnessDiagnostics = {
      initializer: { model: 'claude-sonnet-5' },
      cycles: [
        { cycle: 1, workerStatus: 'completed', verdict: 'needs_correction', reason: 'missing a column' },
        { cycle: 2, workerStatus: 'completed', verdict: 'verified' },
      ],
      outcome: { status: 'verified' },
    };

    writeHarnessDiagnostics(runDir, second);

    expect(JSON.parse(readFileSync(join(runDir, HARNESS_FILENAME), 'utf8'))).toEqual(second);
  });

  it('records incomplete outcomes with their reason and detail verbatim', () => {
    const diagnostics: HarnessDiagnostics = {
      initializer: { model: 'claude-sonnet-5' },
      cycles: [
        { cycle: 1, workerStatus: 'completed', verifierError: 'API 500 from the judge request' },
      ],
      outcome: {
        status: 'incomplete',
        reason: 'verifier_unavailable',
        detail: 'judge failed in cycle 1: API 500 from the judge request',
      },
    };

    writeHarnessDiagnostics(runDir, diagnostics);

    const stored = JSON.parse(
      readFileSync(join(runDir, HARNESS_FILENAME), 'utf8'),
    ) as HarnessDiagnostics;
    expect(stored.outcome).toEqual(diagnostics.outcome);
    expect(stored.cycles[0]?.verifierError).toBe('API 500 from the judge request');
  });
});
