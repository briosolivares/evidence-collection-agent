import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { initManifest, MANIFEST_FILENAME, type Manifest } from '../run/artifacts.js';
import { type OffloadedResult } from './capResult.js';
import { fileTools, readFileTool } from './fileTools.js';
import { executeToolCall } from './pipeline.js';
import { createRegistry } from './registry.js';

// A temp dir with an initialized manifest stands in for the run directory;
// the suite stays hermetic.
let runDir: string;

beforeEach(() => {
  runDir = mkdtempSync(join(tmpdir(), 'file-tools-test-'));
  initManifest(runDir, 'test task');
});

afterEach(() => {
  rmSync(runDir, { recursive: true, force: true });
});

const registry = createRegistry(fileTools);

/** Run one call through the full pipeline against the test run dir — the
 * tools are exercised exactly as the model would reach them. */
function call(name: string, input: unknown) {
  return executeToolCall(registry, { id: `call-${name}`, name, input }, { runDir });
}

function readManifestFile(): Manifest {
  return JSON.parse(readFileSync(join(runDir, MANIFEST_FILENAME), 'utf8')) as Manifest;
}

describe('run-directory confinement through each tool', () => {
  // Confinement is tested per tool at the tool interface: resolveRunPath has
  // its own tests, but the likely break is a tool forgetting to route its
  // path parameter through it.
  const escapeAttempts: Array<{ tool: string; input: (path: string) => unknown }> = [
    { tool: 'read_file', input: (path) => ({ file_path: path }) },
    { tool: 'write_file', input: (path) => ({ file_path: path, content: 'x' }) },
    { tool: 'grep', input: (path) => ({ pattern: 'x', path }) },
  ];

  it.each(escapeAttempts)(
    '$tool rejects traversal and absolute paths with a structured error',
    async ({ tool, input }) => {
      for (const path of ['../escape.txt', '/etc/passwd']) {
        const result = await call(tool, input(path));
        expect(result).toMatchObject({ isError: true, errorKind: 'execution_error' });
        // The message must name the offending path so the model can correct it.
        expect(result.content).toContain(path);
      }
    },
  );

  it('a rejected write_file writes nothing outside the run directory', async () => {
    const outside = join(runDir, '..', 'file-tools-test-escape.txt');
    rmSync(outside, { force: true });

    const result = await call('write_file', {
      file_path: '../file-tools-test-escape.txt',
      content: 'leaked',
    });

    expect(result.isError).toBe(true);
    expect(existsSync(outside)).toBe(false);
  });
});

describe('read_file', () => {
  it('returns a structured error, not a throw, for a missing file', async () => {
    const result = await call('read_file', { file_path: 'nope.txt' });

    expect(result).toMatchObject({ isError: true, errorKind: 'execution_error' });
    expect(result.content).toContain('nope.txt');
    expect(result.content).toMatch(/does not exist/i);
  });

  it('returns cat -n style line-numbered content', async () => {
    writeFileSync(join(runDir, 'poem.txt'), 'first\nsecond\nthird\n');

    const result = await call('read_file', { file_path: 'poem.txt' });

    expect(result.isError).toBe(false);
    expect(result.content).toBe('     1→first\n     2→second\n     3→third');
  });

  it('windows the file with offset and limit, keeping true line numbers', async () => {
    const lines = Array.from({ length: 9 }, (_, i) => `line ${i + 1}`);
    writeFileSync(join(runDir, 'long.txt'), `${lines.join('\n')}\n`);

    const result = await call('read_file', { file_path: 'long.txt', offset: 4, limit: 2 });

    expect(result.isError).toBe(false);
    // Numbering continues from the offset — off-by-one here would silently
    // corrupt every follow-up read the model makes.
    expect(result.content).toBe('     4→line 4\n     5→line 5');
  });

  it('warns instead of erroring on an empty file and on an offset past the end', async () => {
    writeFileSync(join(runDir, 'empty.txt'), '');
    writeFileSync(join(runDir, 'short.txt'), 'only\n');

    const empty = await call('read_file', { file_path: 'empty.txt' });
    expect(empty.isError).toBe(false);
    expect(empty.content).toMatch(/empty/i);

    const short = await call('read_file', { file_path: 'short.txt', offset: 5 });
    expect(short.isError).toBe(false);
    expect(short.content).toMatch(/shorter than the provided offset/i);
    expect(short.content).toContain('1 lines');
  });
});

describe('write_file → read_file round trip', () => {
  it('preserves content exactly and records the write in the manifest with a correct hash', async () => {
    const content = 'title,url,points\nA story,https://a.example,10\nB story,https://b.example,20\n';

    const written = await call('write_file', { file_path: 'data/stories.csv', content });
    expect(written.isError).toBe(false);
    expect(written.content).toContain('data/stories.csv');

    // The bytes on disk are exactly the content — including the trailing
    // newline a numbered rendering could silently lose.
    expect(readFileSync(join(runDir, 'data/stories.csv'), 'utf8')).toBe(content);

    // The invisible-plumbing rule: the write must appear in the manifest.
    const entry = readManifestFile().artifacts.find((a) => a.filename === 'data/stories.csv');
    expect(entry).toBeDefined();
    expect(entry?.sha256).toBe(createHash('sha256').update(content, 'utf8').digest('hex'));

    const readBack = await call('read_file', { file_path: 'data/stories.csv' });
    expect(readBack.isError).toBe(false);
    expect(readBack.content).toBe(
      '     1→title,url,points\n' +
        '     2→A story,https://a.example,10\n' +
        '     3→B story,https://b.example,20',
    );
  });

  it('overwriting a path reports an update and re-hashes the single manifest entry', async () => {
    await call('write_file', { file_path: 'answer.md', content: 'draft' });
    const second = await call('write_file', { file_path: 'answer.md', content: 'final' });

    expect(second.isError).toBe(false);
    expect(second.content).toMatch(/updated/i);

    const entries = readManifestFile().artifacts.filter((a) => a.filename === 'answer.md');
    expect(entries).toHaveLength(1);
    expect(entries[0]?.sha256).toBe(createHash('sha256').update('final', 'utf8').digest('hex'));
  });
});

describe('grep', () => {
  beforeEach(() => {
    mkdirSync(join(runDir, 'notes'));
    writeFileSync(
      join(runDir, 'notes/a.txt'),
      'first line\nsecond needle line\nthird line\nneedle at four\n',
    );
    writeFileSync(join(runDir, 'b.txt'), 'nothing to see here\n');
  });

  it('reports matches as path:line: match with correct line numbers', async () => {
    const result = await call('grep', { pattern: 'needle' });

    expect(result.isError).toBe(false);
    expect(result.content).toBe(
      'notes/a.txt:2: second needle line\nnotes/a.txt:4: needle at four',
    );
  });

  it('treats the pattern as a regular expression', async () => {
    const result = await call('grep', { pattern: '^needle' });

    expect(result.isError).toBe(false);
    expect(result.content).toBe('notes/a.txt:4: needle at four');
  });

  it('returns an empty result, not an error, when nothing matches', async () => {
    const result = await call('grep', { pattern: 'zzz-not-present' });

    expect(result).toMatchObject({ isError: false, content: '' });
  });

  it('confines the search to the given path', async () => {
    const result = await call('grep', { pattern: 'needle', path: 'b.txt' });

    expect(result).toMatchObject({ isError: false, content: '' });
  });

  it('rejects an invalid regular expression with a structured error', async () => {
    const result = await call('grep', { pattern: '(unclosed' });

    expect(result).toMatchObject({ isError: true, errorKind: 'execution_error' });
    expect(result.content).toMatch(/regular expression/i);
  });
});

describe('size cap integration (T5)', () => {
  it('offloads an oversize read_file result to disk, complete, with a preview for the model', async () => {
    const lines = Array.from({ length: 40 }, (_, i) => `payload line ${i + 1}`);
    writeFileSync(join(runDir, 'big.txt'), `${lines.join('\n')}\n`);

    // Same tool, small cap: the capping stage is what's under test, not the
    // exact size of the default budget.
    const smallCapRegistry = createRegistry([{ ...readFileTool, maxBytes: 200 }]);
    const result = await executeToolCall(
      smallCapRegistry,
      { id: 'call-big', name: 'read_file', input: { file_path: 'big.txt' } },
      { runDir },
    );

    expect(result.isError).toBe(false);
    const replacement = JSON.parse(result.content) as OffloadedResult;
    expect(replacement.offloadedTo).toMatch(/^tool-output\//);
    expect(replacement.note).toContain(replacement.offloadedTo);

    // The complete numbered output — down to the last line — is on disk.
    const offloaded = readFileSync(join(runDir, replacement.offloadedTo), 'utf8');
    expect(offloaded.startsWith('     1→payload line 1\n')).toBe(true);
    expect(offloaded.endsWith('    40→payload line 40')).toBe(true);
    expect(offloaded.startsWith(replacement.preview)).toBe(true);
  });
});
