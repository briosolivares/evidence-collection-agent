import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { initManifest, writeArtifact } from '../../../../src/run/artifacts.js';
import { grade } from './grader.js';

const ORACLE = { expectedFile: 'answer.md' };

// A temp dir stands in for the run directory; the suite stays hermetic.
let runDir: string;

beforeEach(() => {
  runDir = mkdtempSync(join(tmpdir(), 'stub-grader-test-'));
  initManifest(runDir, 'stub grader test');
});

afterEach(() => {
  rmSync(runDir, { recursive: true, force: true });
});

describe('stub grader', () => {
  it('passes both assertions on a run whose manifest and deliverable agree', async () => {
    writeArtifact(runDir, 'answer.md', Buffer.from('# Answer\n'));

    const results = await grade(runDir, ORACLE);

    expect(results).toHaveLength(2);
    expect(results.every((r) => r.passed)).toBe(true);
  });

  it('fails both assertions with detail when the deliverable is missing', async () => {
    const results = await grade(runDir, ORACLE);

    expect(results.map((r) => r.passed)).toEqual([false, false]);
    for (const r of results) {
      expect(r.detail).not.toBe('');
    }
  });

  it('fails the hash assertion when the artifact was tampered with after capture', async () => {
    writeArtifact(runDir, 'answer.md', Buffer.from('original evidence'));
    // Tamper behind the manifest's back — bytes change, recorded hash does not.
    writeFileSync(join(runDir, 'answer.md'), 'doctored evidence');

    const results = await grade(runDir, ORACLE);

    expect(results[0]!.passed).toBe(true); // the file does exist
    expect(results[1]!.passed).toBe(false);
    expect(results[1]!.detail).toMatch(/mismatch/);
  });

  it('throws on malformed oracle data — a harness bug, not a failed trial', async () => {
    await expect(async () => grade(runDir, { wrong: 'shape' })).rejects.toThrow(/oracle/);
  });
});
