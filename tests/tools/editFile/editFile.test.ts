import { createHash } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  initManifest,
  readManifest,
  writeArtifact,
} from '../../../src/run/artifacts.js';
import { executeToolCall } from '../../../src/tools/pipeline.js';
import { createRegistry, type ToolCtx } from '../../../src/tools/registry.js';
import { FILE_TOOL_MAX_BYTES } from '../../../src/tools/fileAccess.js';
import { editFileTool, type EditFileResult } from '../../../src/tools/editFile/editFile.js';

let runDir: string;

beforeEach(() => {
  runDir = mkdtempSync(join(tmpdir(), 'sherlock-file-tools-'));
  initManifest(runDir, 'exercise the private file tools');
});

afterEach(() => {
  rmSync(runDir, { recursive: true, force: true });
});

const registry = createRegistry([editFileTool]);

function call(name: 'edit_file', input: unknown, ctx: Partial<ToolCtx> = {}) {
  return executeToolCall(
    registry,
    { id: `call-${name}`, name, input },
    { runDir, ...ctx },
  );
}

function writeRaw(relativePath: string, bytes: string | Buffer): string {
  const absolutePath = join(runDir, relativePath);
  mkdirSync(join(absolutePath, '..'), { recursive: true });
  writeFileSync(absolutePath, bytes);
  return absolutePath;
}

describe('edit_file', () => {
  it('preserves BOM, CRLF, trailing bytes, and manifest provenance', async () => {
    const bom = Buffer.from([0xef, 0xbb, 0xbf]);
    const original = Buffer.concat([
      bom,
      Buffer.from('alpha\r\nold value  \r\nomega', 'utf8'),
    ]);
    writeArtifact(runDir, 'scratch/workspace/report.txt', original);

    const result = await call('edit_file', {
      file_path: 'scratch/workspace/report.txt',
      old_string: 'old value',
      new_string: 'new $& $1 value',
    });

    expect(result).toMatchObject({ isError: false });
    expect(JSON.parse(result.content) as EditFileResult).toEqual({
      file_path: 'scratch/workspace/report.txt',
      replacement_count: 1,
    });
    const expected = Buffer.concat([
      bom,
      Buffer.from('alpha\r\nnew $& $1 value  \r\nomega', 'utf8'),
    ]);
    expect(readFileSync(join(runDir, 'scratch/workspace/report.txt'))).toEqual(expected);
    expect(
      readManifest(runDir).artifacts.find(
        (entry) => entry.filename === 'scratch/workspace/report.txt',
      )?.sha256,
    ).toBe(createHash('sha256').update(expected).digest('hex'));
  });

  it('requires a unique exact match unless replace_all is true', async () => {
    writeArtifact(runDir, 'scratch/notes.txt', Buffer.from('dup dup dup\n'));

    const ambiguous = await call('edit_file', {
      file_path: 'scratch/notes.txt',
      old_string: 'dup',
      new_string: 'x',
    });
    expect(ambiguous).toMatchObject({ isError: true, errorKind: 'execution_error' });
    expect(ambiguous.content).toContain('3');
    expect(readFileSync(join(runDir, 'scratch/notes.txt'), 'utf8')).toBe('dup dup dup\n');

    const replaced = await call('edit_file', {
      file_path: 'scratch/notes.txt',
      old_string: 'dup',
      new_string: 'x',
      replace_all: true,
    });
    expect(replaced).toMatchObject({ isError: false });
    expect(JSON.parse(replaced.content)).toEqual({
      file_path: 'scratch/notes.txt',
      replacement_count: 3,
    });
    expect(readFileSync(join(runDir, 'scratch/notes.txt'), 'utf8')).toBe('x x x\n');
  });

  it('rejects published artifacts, missing/invalid files, empty anchors, and no-ops', async () => {
    writeArtifact(
      runDir,
      'artifacts/published.txt',
      Buffer.from('published'),
      { roles: ['requested_output'] },
    );
    writeRaw('scratch/invalid.txt', Buffer.from([0x61, 0xff, 0x62]));
    writeArtifact(runDir, 'scratch/value.txt', Buffer.from('same'));

    const cases = [
      {
        file_path: 'artifacts/published.txt',
        old_string: 'published',
        new_string: 'changed',
      },
      {
        file_path: 'scratch/missing.txt',
        old_string: 'x',
        new_string: 'y',
      },
      {
        file_path: 'scratch/invalid.txt',
        old_string: 'a',
        new_string: 'b',
      },
      {
        file_path: 'scratch/value.txt',
        old_string: '',
        new_string: 'prefix',
      },
      {
        file_path: 'scratch/value.txt',
        old_string: 'same',
        new_string: 'same',
      },
    ];

    for (const input of cases) {
      const result = await call('edit_file', input);
      expect(result).toMatchObject({ isError: true, errorKind: 'execution_error' });
    }
    expect(readFileSync(join(runDir, 'artifacts/published.txt'), 'utf8')).toBe('published');
    expect(readFileSync(join(runDir, 'scratch/value.txt'), 'utf8')).toBe('same');
  });

  it('checks size and cancellation before modifying a file', async () => {
    const large = writeRaw('scratch/large.txt', '');
    truncateSync(large, FILE_TOOL_MAX_BYTES + 1);
    const oversized = await call('edit_file', {
      file_path: 'scratch/large.txt',
      old_string: 'x',
      new_string: 'y',
    });
    expect(oversized).toMatchObject({ isError: true, errorKind: 'execution_error' });
    expect(oversized.content).toMatch(/64 MiB/);

    writeArtifact(runDir, 'scratch/cancelled.txt', Buffer.from('old'));
    const before = readFileSync(join(runDir, 'manifest.json'));
    const controller = new AbortController();
    controller.abort();
    const cancelled = await call(
      'edit_file',
      {
        file_path: 'scratch/cancelled.txt',
        old_string: 'old',
        new_string: 'new',
      },
      { abortSignal: controller.signal },
    );
    expect(cancelled).toMatchObject({ isError: true, errorKind: 'execution_error' });
    expect(readFileSync(join(runDir, 'scratch/cancelled.txt'), 'utf8')).toBe('old');
    expect(readFileSync(join(runDir, 'manifest.json'))).toEqual(before);
  });

  it('has no output-contract owner or publication fields in its strict schema', async () => {
    writeArtifact(runDir, 'scratch/value.txt', Buffer.from('old'));

    const result = await call('edit_file', {
      file_path: 'scratch/value.txt',
      old_string: 'old',
      new_string: 'new',
      output_id: 'legacy-owner',
    });

    expect(result).toMatchObject({ isError: true, errorKind: 'invalid_input' });
    expect(readFileSync(join(runDir, 'scratch/value.txt'), 'utf8')).toBe('old');
  });
});
