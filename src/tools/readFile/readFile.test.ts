import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { initManifest } from '../../run/artifacts.js';
import { type OffloadedResult } from '../capResult.js';
import { executeToolCall } from '../pipeline.js';
import { createRegistry } from '../registry.js';
import { readFileTool } from './readFile.js';

// A temp dir with an initialized manifest stands in for the run directory;
// the suite stays hermetic.
let runDir: string;

beforeEach(() => {
  runDir = mkdtempSync(join(tmpdir(), 'read-file-test-'));
  initManifest(runDir, 'test task');
});

afterEach(() => {
  rmSync(runDir, { recursive: true, force: true });
});

const registry = createRegistry([readFileTool]);

/** Run one call through the full pipeline against the test run dir — the
 * tool is exercised exactly as the model would reach it. */
function call(input: unknown) {
  return executeToolCall(registry, { id: 'call-read_file', name: 'read_file', input }, { runDir });
}

describe('read_file', () => {
  it('rejects traversal and absolute paths with a structured error', async () => {
    // Confinement is tested at the tool interface: resolveRunPath has its
    // own tests, but the likely break is a tool forgetting to route its
    // path parameter through it.
    for (const path of ['../escape.txt', '/etc/passwd']) {
      const result = await call({ file_path: path });
      expect(result).toMatchObject({ isError: true, errorKind: 'execution_error' });
      // The message must name the offending path so the model can correct it.
      expect(result.content).toContain(path);
    }
  });

  it('returns a structured error, not a throw, for a missing file', async () => {
    const result = await call({ file_path: 'nope.txt' });

    expect(result).toMatchObject({ isError: true, errorKind: 'execution_error' });
    expect(result.content).toContain('nope.txt');
    expect(result.content).toMatch(/does not exist/i);
  });

  it('returns cat -n style line-numbered content', async () => {
    writeFileSync(join(runDir, 'poem.txt'), 'first\nsecond\nthird\n');

    const result = await call({ file_path: 'poem.txt' });

    expect(result.isError).toBe(false);
    expect(result.content).toBe('     1→first\n     2→second\n     3→third');
  });

  it('windows the file with offset and limit, keeping true line numbers', async () => {
    const lines = Array.from({ length: 9 }, (_, i) => `line ${i + 1}`);
    writeFileSync(join(runDir, 'long.txt'), `${lines.join('\n')}\n`);

    const result = await call({ file_path: 'long.txt', offset: 4, limit: 2 });

    expect(result.isError).toBe(false);
    // Numbering continues from the offset — off-by-one here would silently
    // corrupt every follow-up read the model makes.
    expect(result.content).toBe('     4→line 4\n     5→line 5');
  });

  it('warns instead of erroring on an empty file and on an offset past the end', async () => {
    writeFileSync(join(runDir, 'empty.txt'), '');
    writeFileSync(join(runDir, 'short.txt'), 'only\n');

    const empty = await call({ file_path: 'empty.txt' });
    expect(empty.isError).toBe(false);
    expect(empty.content).toMatch(/empty/i);

    const short = await call({ file_path: 'short.txt', offset: 5 });
    expect(short.isError).toBe(false);
    expect(short.content).toMatch(/shorter than the provided offset/i);
    expect(short.content).toContain('1 lines');
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
    expect(replacement.offloadedTo).toMatch(/^scratch\/tool-output\//);
    expect(replacement.note).toContain(replacement.offloadedTo);

    // The complete numbered output — down to the last line — is on disk.
    const offloaded = readFileSync(join(runDir, replacement.offloadedTo), 'utf8');
    expect(offloaded.startsWith('     1→payload line 1\n')).toBe(true);
    expect(offloaded.endsWith('    40→payload line 40')).toBe(true);
    expect(offloaded.startsWith(replacement.preview)).toBe(true);
  });
});

describe('binary files are refused, not silently mangled', () => {
  // Node's lenient utf8 decode turns arbitrary bytes into U+FFFD instead of
  // throwing, so before this guard a PNG read "succeeded" and the model
  // reasoned over replacement characters as if they were content. Detection is
  // by magic number, never by extension: a deliverable's filename is
  // model-supplied and proves nothing about its bytes.
  it.each([
    ['a PDF', 'report.pdf', Buffer.from('%PDF-1.7\n%\xe2\xe3\xcf\xd3\n', 'latin1'), 'is a PDF'],
    [
      'an XLSX',
      'book.xlsx',
      // ZIP local-file header plus an `xl/` entry, which is what separates a
      // spreadsheet from any other ZIP.
      Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from('....xl/workbook.xml')]),
      'is a spreadsheet',
    ],
    [
      'a PNG',
      'shot.png',
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]),
      'is an image',
    ],
  ])('refuses %s and names the tool that can read it', async (_label, name, bytes, expected) => {
    writeFileSync(join(runDir, name), bytes);
    const result = await call({ file_path: name });
    expect(result.isError).toBe(true);
    expect(result.content).toContain(expected);
    expect(result.content).toContain('inspect_document');
  });

  it('refuses text-shaped bytes that are not valid UTF-8', async () => {
    // No magic number matches, so this is caught by the strict decode rather
    // than by format detection — the other half of the guard.
    writeFileSync(join(runDir, 'mojibake.txt'), Buffer.from([0x68, 0x69, 0xff, 0xfe, 0x0a]));
    const result = await call({ file_path: 'mojibake.txt' });
    expect(result.isError).toBe(true);
    expect(result.content).toContain('not valid UTF-8');
  });

  it('still reads text whose bytes are multi-byte UTF-8', async () => {
    // The guard must not reject legitimate non-ASCII content.
    writeFileSync(join(runDir, 'utf8.txt'), 'Ünïcödé — 日本語\n', 'utf8');
    const result = await call({ file_path: 'utf8.txt' });
    expect(result.isError).toBe(false);
    expect(result.content).toContain('Ünïcödé — 日本語');
  });
});
