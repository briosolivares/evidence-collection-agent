import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { OutputContract } from '../../contracts/outputContract.js';
import { createOutputContractStore, type OutputContractStore } from '../../contracts/outputContractStore.js';
import { initManifest, readManifest, writeArtifact } from '../../run/artifacts.js';
import { executeToolCall } from '../pipeline.js';
import { createRegistry, type ToolCtx, type ToolDef } from '../registry.js';
import { assertEditableSize, editFileTool, EDIT_FILE_MAX_BYTES, type EditFileResult } from './editFile.js';

// A temp dir with an initialized manifest stands in for the run directory,
// mirroring write_file.test.ts.
let runDir: string;

beforeEach(() => {
  runDir = mkdtempSync(join(tmpdir(), 'edit-file-test-'));
  initManifest(runDir, 'test task');
});

afterEach(() => {
  rmSync(runDir, { recursive: true, force: true });
});

const registry = createRegistry([editFileTool as ToolDef]);

function call(name: string, input: unknown, extraCtx: Partial<ToolCtx> = {}) {
  return executeToolCall(registry, { id: `call-${name}`, name, input }, { runDir, ...extraCtx });
}

/** Write a fixture file directly, bypassing writeArtifact and its manifest
 * bookkeeping. Scratch edits never require a pre-existing manifest entry;
 * for artifacts/ this also builds the "no manifest entry" failure fixture. */
function writeRaw(relPath: string, content: string | Buffer): string {
  const absPath = join(runDir, relPath);
  mkdirSync(join(absPath, '..'), { recursive: true });
  writeFileSync(absPath, content);
  return absPath;
}

/** Publish an artifact fixture through the real write path, so its manifest
 * entry (roles, optionally sourceUrl/completionStatus) is on record before
 * the edit under test. */
function writeArtifactFixture(
  relPath: string,
  content: string | Buffer,
  meta: Parameters<typeof writeArtifact>[3] = { roles: ['requested_output'] },
) {
  return writeArtifact(
    runDir,
    relPath,
    typeof content === 'string' ? Buffer.from(content, 'utf8') : content,
    meta,
  );
}

function manifest() {
  return readManifest(runDir);
}

/** A minimal valid table output contract, mirroring the fixture shape used
 * in outputContract.test.ts / outputContractStore.test.ts. */
function tableContract(filename: string): OutputContract {
  return {
    outputs: [
      {
        id: 'roster',
        kind: 'table',
        filename,
        format: 'csv',
        columns: [{ name: 'name', required: true, type: 'string' }],
        rules: [],
      },
    ],
  } as OutputContract;
}

describe('edit_file — path resolution and target validation', () => {
  it('rejects an absolute path and a traversal path through resolveRunPath', async () => {
    for (const filePath of ['/etc/passwd', '../escape.txt']) {
      const result = await call('edit_file', { file_path: filePath, old_string: 'a', new_string: 'b' });
      expect(result).toMatchObject({ isError: true, errorKind: 'execution_error' });
      expect(result.content).toContain(filePath);
    }
  });

  it('fails on a missing file, writing nothing', async () => {
    const result = await call('edit_file', {
      file_path: 'scratch/missing.txt',
      old_string: 'a',
      new_string: 'b',
    });
    expect(result).toMatchObject({ isError: true, errorKind: 'execution_error' });
    expect(result.content).toContain('scratch/missing.txt');
    expect(existsSync(join(runDir, 'scratch/missing.txt'))).toBe(false);
  });

  it('fails on a directory target, leaving the directory untouched', async () => {
    mkdirSync(join(runDir, 'scratch/adir'));
    const result = await call('edit_file', {
      file_path: 'scratch/adir',
      old_string: 'a',
      new_string: 'b',
    });
    expect(result).toMatchObject({ isError: true, errorKind: 'execution_error' });
    expect(result.content).toContain('scratch/adir');
    expect(lstatSync(join(runDir, 'scratch/adir')).isDirectory()).toBe(true);
  });

  it('fails on a symlink target, without following it or modifying the real file', async () => {
    const targetAbs = writeRaw('scratch/real.txt', 'original contents\n');
    symlinkSync(targetAbs, join(runDir, 'scratch/link.txt'));

    const result = await call('edit_file', {
      file_path: 'scratch/link.txt',
      old_string: 'original',
      new_string: 'changed',
    });

    expect(result).toMatchObject({ isError: true, errorKind: 'execution_error' });
    expect(result.content).toContain('scratch/link.txt');
    expect(lstatSync(join(runDir, 'scratch/link.txt')).isSymbolicLink()).toBe(true);
    expect(readFileSync(targetAbs, 'utf8')).toBe('original contents\n');
  });
});

describe('edit_file — match counting and replace_all', () => {
  it('fails with zero matches, naming the file and the no-normalization hint', async () => {
    writeRaw('scratch/notes.txt', 'hello world\n');
    const result = await call('edit_file', {
      file_path: 'scratch/notes.txt',
      old_string: 'goodbye',
      new_string: 'hi',
    });
    expect(result).toMatchObject({ isError: true, errorKind: 'execution_error' });
    expect(result.content).toContain('scratch/notes.txt');
    expect(result.content).toMatch(/no normalization/i);
  });

  it('replaces the single match when old_string is unique', async () => {
    writeRaw('scratch/notes.txt', 'alpha beta gamma\n');
    const result = await call('edit_file', {
      file_path: 'scratch/notes.txt',
      old_string: 'beta',
      new_string: 'BETA',
    });
    expect(result.isError).toBe(false);
    const parsed = JSON.parse(result.content) as EditFileResult;
    expect(parsed).toEqual({ file_path: 'scratch/notes.txt', replacement_count: 1 });
    expect(readFileSync(join(runDir, 'scratch/notes.txt'), 'utf8')).toBe('alpha BETA gamma\n');
  });

  it('fails on an ambiguous multiple match, reporting the count, writing nothing', async () => {
    writeRaw('scratch/notes.txt', 'dup dup dup\n');
    const result = await call('edit_file', {
      file_path: 'scratch/notes.txt',
      old_string: 'dup',
      new_string: 'x',
    });
    expect(result).toMatchObject({ isError: true, errorKind: 'execution_error' });
    expect(result.content).toContain('3');
    expect(result.content).toMatch(/replace_all/);
    expect(readFileSync(join(runDir, 'scratch/notes.txt'), 'utf8')).toBe('dup dup dup\n');
  });

  it('replace_all replaces every occurrence and reports the total count', async () => {
    writeRaw('scratch/notes.txt', 'dup dup dup\n');
    const result = await call('edit_file', {
      file_path: 'scratch/notes.txt',
      old_string: 'dup',
      new_string: 'x',
      replace_all: true,
    });
    expect(result.isError).toBe(false);
    expect(JSON.parse(result.content)).toEqual({
      file_path: 'scratch/notes.txt',
      replacement_count: 3,
    });
    expect(readFileSync(join(runDir, 'scratch/notes.txt'), 'utf8')).toBe('x x x\n');
  });
});

describe('edit_file — input rejections', () => {
  it('rejects an empty old_string, writing nothing', async () => {
    writeRaw('scratch/notes.txt', 'hello\n');
    const result = await call('edit_file', {
      file_path: 'scratch/notes.txt',
      old_string: '',
      new_string: 'x',
    });
    expect(result).toMatchObject({ isError: true, errorKind: 'execution_error' });
    expect(readFileSync(join(runDir, 'scratch/notes.txt'), 'utf8')).toBe('hello\n');
  });

  it('rejects identical old_string and new_string as a no-op, writing nothing', async () => {
    writeRaw('scratch/notes.txt', 'hello\n');
    const result = await call('edit_file', {
      file_path: 'scratch/notes.txt',
      old_string: 'hello',
      new_string: 'hello',
    });
    expect(result).toMatchObject({ isError: true, errorKind: 'execution_error' });
    expect(readFileSync(join(runDir, 'scratch/notes.txt'), 'utf8')).toBe('hello\n');
  });

  it('does not treat unknown keys as valid input (strict schema)', async () => {
    writeRaw('scratch/notes.txt', 'hello\n');
    const result = await call('edit_file', {
      file_path: 'scratch/notes.txt',
      old_string: 'hello',
      new_string: 'hi',
      extra: true,
    });
    expect(result).toMatchObject({ isError: true, errorKind: 'invalid_input' });
  });
});

describe('edit_file — literal replacement semantics', () => {
  it('writes replacement-token-like text ($&, $1, $\') verbatim, never as a regex substitution', async () => {
    writeRaw('scratch/notes.txt', 'before ANCHOR after\n');
    const result = await call('edit_file', {
      file_path: 'scratch/notes.txt',
      old_string: 'ANCHOR',
      new_string: "value $& and $1 and $' end",
    });
    expect(result.isError).toBe(false);
    expect(readFileSync(join(runDir, 'scratch/notes.txt'), 'utf8')).toBe(
      "before value $& and $1 and $' end after\n",
    );
  });

  it('straight quotes do not match curly quotes, and vice versa', async () => {
    writeRaw('scratch/straight.txt', 'He said "hello".\n');
    writeRaw('scratch/curly.txt', 'He said “hello”.\n');

    const straightMissesCurly = await call('edit_file', {
      file_path: 'scratch/curly.txt',
      old_string: '"hello"',
      new_string: '"goodbye"',
    });
    expect(straightMissesCurly).toMatchObject({ isError: true, errorKind: 'execution_error' });

    const curlyMissesStraight = await call('edit_file', {
      file_path: 'scratch/straight.txt',
      old_string: '“hello”',
      new_string: '“goodbye”',
    });
    expect(curlyMissesStraight).toMatchObject({ isError: true, errorKind: 'execution_error' });
  });
});

describe('edit_file — byte and encoding fidelity', () => {
  it('preserves LF line endings, tabs, and trailing spaces outside the edited substring', async () => {
    const original = 'line1\nline2\twith\ttabs\nold value   \nline4\n';
    writeRaw('scratch/mixed.txt', original);
    const result = await call('edit_file', {
      file_path: 'scratch/mixed.txt',
      old_string: 'old value',
      new_string: 'new value',
    });
    expect(result.isError).toBe(false);
    expect(readFileSync(join(runDir, 'scratch/mixed.txt'), 'utf8')).toBe(
      'line1\nline2\twith\ttabs\nnew value   \nline4\n',
    );
  });

  it('preserves CRLF and mixed line endings, and the absence of a final newline', async () => {
    const original = 'line1\r\nline2\nold\r\nline4';
    writeRaw('scratch/mixed-eol.txt', original);
    const result = await call('edit_file', {
      file_path: 'scratch/mixed-eol.txt',
      old_string: 'old',
      new_string: 'NEW',
    });
    expect(result.isError).toBe(false);
    expect(readFileSync(join(runDir, 'scratch/mixed-eol.txt'), 'utf8')).toBe(
      'line1\r\nline2\nNEW\r\nline4',
    );
  });

  it('preserves a trailing final newline when present', async () => {
    writeRaw('scratch/trailing.txt', 'old\n');
    const result = await call('edit_file', {
      file_path: 'scratch/trailing.txt',
      old_string: 'old',
      new_string: 'new',
    });
    expect(result.isError).toBe(false);
    expect(readFileSync(join(runDir, 'scratch/trailing.txt'), 'utf8')).toBe('new\n');
  });

  it('preserves a UTF-8 BOM exactly, matching only after it in old_string', async () => {
    const bomBytes = Buffer.from([0xef, 0xbb, 0xbf]);
    const original = Buffer.concat([bomBytes, Buffer.from('Hello old text\n', 'utf8')]);
    writeRaw('scratch/bom.txt', original);

    const result = await call('edit_file', {
      file_path: 'scratch/bom.txt',
      old_string: 'old text',
      new_string: 'new text',
    });
    expect(result.isError).toBe(false);

    const updated = readFileSync(join(runDir, 'scratch/bom.txt'));
    expect(updated.subarray(0, 3)).toEqual(bomBytes);
    expect(updated.toString('utf8')).toBe('﻿Hello new text\n');
  });

  it('round-trips multibyte characters exactly', async () => {
    const original = 'café ☕ 日本語 old 🚀 rocket\n';
    writeRaw('scratch/multibyte.txt', original);

    const result = await call('edit_file', {
      file_path: 'scratch/multibyte.txt',
      old_string: 'old',
      new_string: 'new',
    });
    expect(result.isError).toBe(false);
    expect(readFileSync(join(runDir, 'scratch/multibyte.txt'), 'utf8')).toBe(
      'café ☕ 日本語 new 🚀 rocket\n',
    );
  });

  it('fails on invalid UTF-8 without modifying the file', async () => {
    // Lone continuation byte (0x80) with no leading byte: not valid UTF-8
    // under any interpretation.
    const invalid = Buffer.from([0x68, 0x69, 0x80, 0x62, 0x79, 0x65]);
    writeRaw('scratch/invalid.txt', invalid);

    const result = await call('edit_file', {
      file_path: 'scratch/invalid.txt',
      old_string: 'hi',
      new_string: 'HI',
    });
    expect(result).toMatchObject({ isError: true, errorKind: 'execution_error' });
    expect(result.content).toMatch(/utf-8/i);
    expect(readFileSync(join(runDir, 'scratch/invalid.txt'))).toEqual(invalid);
  });
});

describe('edit_file — the 64 MiB size guard', () => {
  // A real 64 MiB fixture would make this suite slow; the guard is a pure
  // function of a byte count, injected directly rather than produced by an
  // actual oversized file on disk.
  it('rejects a size over the limit and accepts a size at or under it', () => {
    expect(() => assertEditableSize(EDIT_FILE_MAX_BYTES + 1, 'scratch/big.txt')).toThrow(
      /64 MiB/,
    );
    expect(() => assertEditableSize(EDIT_FILE_MAX_BYTES, 'scratch/big.txt')).not.toThrow();
    expect(() => assertEditableSize(0, 'scratch/empty.txt')).not.toThrow();
  });
});

describe('edit_file — manifest bookkeeping', () => {
  it('a scratch edit records no roles', async () => {
    writeRaw('scratch/working.csv', 'a,b\n1,2\n');
    const result = await call('edit_file', {
      file_path: 'scratch/working.csv',
      old_string: '1,2',
      new_string: '3,4',
    });
    expect(result.isError).toBe(false);

    const entry = manifest().artifacts.find((a) => a.filename === 'scratch/working.csv');
    expect(entry).toBeDefined();
    expect(entry).not.toHaveProperty('roles');
  });

  it('an artifact edit preserves roles, clears sourceUrl and completionStatus, and updates the hash', async () => {
    writeArtifactFixture('artifacts/report.csv', 'a,b\n1,2\n', {
      roles: ['requested_output', 'evidence'],
      sourceUrl: 'https://example.com/report',
      completionStatus: 'complete',
    });

    const result = await call('edit_file', {
      file_path: 'artifacts/report.csv',
      old_string: '1,2',
      new_string: '3,4',
    });
    expect(result.isError).toBe(false);

    const entry = manifest().artifacts.find((a) => a.filename === 'artifacts/report.csv');
    expect(entry).toBeDefined();
    expect(entry?.roles).toEqual(['requested_output', 'evidence']);
    expect(entry).not.toHaveProperty('sourceUrl');
    expect(entry?.completionStatus).toBeUndefined();
    expect(entry?.sha256).toBe(
      createHash('sha256').update('a,b\n3,4\n', 'utf8').digest('hex'),
    );
    expect(readFileSync(join(runDir, 'artifacts/report.csv'), 'utf8')).toBe('a,b\n3,4\n');
  });

  it('fails to edit a published artifact with no manifest entry, writing nothing', async () => {
    // Simulates a file that landed under artifacts/ without going through a
    // manifest-recording tool — edit_file must not invent roles for it.
    writeRaw('artifacts/orphan.txt', 'hello\n');
    const result = await call('edit_file', {
      file_path: 'artifacts/orphan.txt',
      old_string: 'hello',
      new_string: 'goodbye',
    });
    expect(result).toMatchObject({ isError: true, errorKind: 'execution_error' });
    expect(result.content).toContain('manifest entry');
    expect(readFileSync(join(runDir, 'artifacts/orphan.txt'), 'utf8')).toBe('hello\n');
  });
});

describe('edit_file — contract-bound refusal', () => {
  let store: OutputContractStore;

  beforeEach(() => {
    store = createOutputContractStore(runDir);
    writeArtifactFixture('artifacts/roster.csv', 'name\nAda\n');
    writeArtifactFixture('artifacts/notes.md', 'audit notes\n');
  });

  it('refuses to edit the published file of a contract-bound table output, naming upsert_output_rows', async () => {
    const accepted = store.setOutputContract({ contract: tableContract('roster.csv') });
    expect(accepted.ok).toBe(true);

    const result = await call(
      'edit_file',
      { file_path: 'artifacts/roster.csv', old_string: 'Ada', new_string: 'Grace' },
      { outputContracts: store },
    );
    expect(result).toMatchObject({ isError: true, errorKind: 'execution_error' });
    expect(result.content).toContain('upsert_output_rows');
    expect(readFileSync(join(runDir, 'artifacts/roster.csv'), 'utf8')).toBe('name\nAda\n');
  });

  it('allows editing an unrelated file the same contract does not claim', async () => {
    const accepted = store.setOutputContract({ contract: tableContract('roster.csv') });
    expect(accepted.ok).toBe(true);

    const result = await call(
      'edit_file',
      { file_path: 'artifacts/notes.md', old_string: 'audit', new_string: 'review' },
      { outputContracts: store },
    );
    expect(result.isError).toBe(false);
    expect(readFileSync(join(runDir, 'artifacts/notes.md'), 'utf8')).toBe('review notes\n');
  });

  it('proceeds normally when the run has no output-contract store at all', async () => {
    const result = await call('edit_file', {
      file_path: 'artifacts/roster.csv',
      old_string: 'Ada',
      new_string: 'Grace',
    });
    expect(result.isError).toBe(false);
    expect(readFileSync(join(runDir, 'artifacts/roster.csv'), 'utf8')).toBe('name\nGrace\n');
  });

  it('resolves the contract fresh per call: a revision changes the refusal outcome', async () => {
    // Revision 1 protects nothing named roster.csv.
    const first = store.setOutputContract({ contract: tableContract('unrelated.csv') });
    expect(first.ok).toBe(true);

    const beforeRevision = await call(
      'edit_file',
      { file_path: 'artifacts/roster.csv', old_string: 'Ada', new_string: 'Grace' },
      { outputContracts: store },
    );
    expect(beforeRevision.isError).toBe(false);

    // Revision 2 now claims roster.csv — the very next call must see it.
    const second = store.setOutputContract({
      contract: tableContract('roster.csv'),
      revisionBasis: { kind: 'assumption_correction', summary: 'roster.csv is the real filename.' },
    });
    expect(second.ok).toBe(true);

    const afterRevision = await call(
      'edit_file',
      { file_path: 'artifacts/roster.csv', old_string: 'Grace', new_string: 'Ada' },
      { outputContracts: store },
    );
    expect(afterRevision).toMatchObject({ isError: true, errorKind: 'execution_error' });
    expect(afterRevision.content).toContain('upsert_output_rows');
    // Still holds the value the (allowed) first edit produced.
    expect(readFileSync(join(runDir, 'artifacts/roster.csv'), 'utf8')).toBe('name\nGrace\n');
  });
});

describe('edit_file — tool pipeline integration', () => {
  it('returns a structured execution error for a rejected call', async () => {
    const result = await call('edit_file', {
      file_path: 'scratch/does-not-exist.txt',
      old_string: 'a',
      new_string: 'b',
    });
    expect(result.isError).toBe(true);
    if (!result.isError) throw new Error('unreachable');
    expect(result.errorKind).toBe('execution_error');
    expect(result.toolCallId).toBe('call-edit_file');
    expect(typeof result.content).toBe('string');
  });

  it('serializes a successful result as JSON through the pipeline', async () => {
    writeRaw('scratch/ok.txt', 'ping\n');
    const result = await call('edit_file', {
      file_path: 'scratch/ok.txt',
      old_string: 'ping',
      new_string: 'pong',
    });
    expect(result.isError).toBe(false);
    if (result.isError) throw new Error('unreachable');
    const parsed = JSON.parse(result.content) as EditFileResult;
    expect(parsed).toEqual({ file_path: 'scratch/ok.txt', replacement_count: 1 });
  });
});
