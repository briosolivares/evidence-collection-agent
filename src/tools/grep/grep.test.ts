import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { initManifest } from '../../run/artifacts.js';
import { executeToolCall } from '../pipeline.js';
import { createRegistry } from '../registry.js';
import { grepTool } from './grep.js';

// A temp dir with an initialized manifest stands in for the run directory;
// the suite stays hermetic.
let runDir: string;

beforeEach(() => {
  runDir = mkdtempSync(join(tmpdir(), 'grep-test-'));
  initManifest(runDir, 'test task');
});

afterEach(() => {
  rmSync(runDir, { recursive: true, force: true });
});

const registry = createRegistry([grepTool]);

/** Run one call through the full pipeline against the test run dir — the
 * tool is exercised exactly as the model would reach it. */
function call(input: unknown) {
  return executeToolCall(registry, { id: 'call-grep', name: 'grep', input }, { runDir });
}

describe('grep', () => {
  beforeEach(() => {
    mkdirSync(join(runDir, 'notes'));
    writeFileSync(
      join(runDir, 'notes/a.txt'),
      'first line\nsecond needle line\nthird line\nneedle at four\n',
    );
    writeFileSync(join(runDir, 'b.txt'), 'nothing to see here\n');
  });

  it('rejects traversal and absolute paths with a structured error', async () => {
    for (const path of ['../escape.txt', '/etc/passwd']) {
      const result = await call({ pattern: 'x', path });
      expect(result).toMatchObject({ isError: true, errorKind: 'execution_error' });
      // The message must name the offending path so the model can correct it.
      expect(result.content).toContain(path);
    }
  });

  it('reports matches as path:line: match with correct line numbers', async () => {
    const result = await call({ pattern: 'needle' });

    expect(result.isError).toBe(false);
    expect(result.content).toBe(
      'notes/a.txt:2: second needle line\nnotes/a.txt:4: needle at four',
    );
  });

  it('treats the pattern as a regular expression', async () => {
    const result = await call({ pattern: '^needle' });

    expect(result.isError).toBe(false);
    expect(result.content).toBe('notes/a.txt:4: needle at four');
  });

  it('returns an empty result, not an error, when nothing matches', async () => {
    const result = await call({ pattern: 'zzz-not-present' });

    expect(result).toMatchObject({ isError: false, content: '' });
  });

  it('confines the search to the given path', async () => {
    const result = await call({ pattern: 'needle', path: 'b.txt' });

    expect(result).toMatchObject({ isError: false, content: '' });
  });

  it('rejects an invalid regular expression with a structured error', async () => {
    const result = await call({ pattern: '(unclosed' });

    expect(result).toMatchObject({ isError: true, errorKind: 'execution_error' });
    expect(result.content).toMatch(/regular expression/i);
  });
});
