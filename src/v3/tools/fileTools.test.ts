import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
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
} from '../../run/artifacts.js';
import { executeToolCall } from '../../tools/pipeline.js';
import {
  createRegistry,
  type ToolCtx,
} from '../../tools/registry.js';
import {
  V3_FILE_TOOLS,
  V3_FILE_TOOL_MAX_BYTES,
  type EditFileResult,
} from './fileTools.js';

let runDir: string;

beforeEach(() => {
  runDir = mkdtempSync(join(tmpdir(), 'sherlock-v3-file-tools-'));
  initManifest(runDir, 'exercise the v3 private file tools');
});

afterEach(() => {
  rmSync(runDir, { recursive: true, force: true });
});

const registry = createRegistry(V3_FILE_TOOLS);

function call(
  name: 'read_file' | 'write_file' | 'edit_file',
  input: unknown,
  ctx: Partial<ToolCtx> = {},
) {
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

describe('v3 read_file', () => {
  it('reads only artifacts/ and scratch/ with familiar line windows', async () => {
    writeArtifact(
      runDir,
      'artifacts/report.txt',
      Buffer.from('first\nsecond\nthird\n', 'utf8'),
      { roles: ['requested_output'] },
    );
    writeArtifact(runDir, 'scratch/workspace/notes.txt', Buffer.from('private\n'));

    const published = await call('read_file', {
      file_path: 'artifacts/report.txt',
      offset: 2,
      limit: 2,
    });
    const privateFile = await call('read_file', {
      file_path: 'scratch/workspace/notes.txt',
    });

    expect(published).toMatchObject({ isError: false });
    expect(published.content).toBe('     2→second\n     3→third');
    expect(privateFile).toMatchObject({ isError: false });
    expect(privateFile.content).toBe('     1→private');
  });

  it('rejects run metadata, harness state, loose roots, escapes, and absolute paths', async () => {
    writeRaw('transcript.jsonl', 'TRANSCRIPT_SECRET');
    writeRaw('metrics.json', 'METRICS_SECRET');
    writeRaw('harness.json', 'HARNESS_SECRET');
    writeRaw('harness/checkpoint.json', 'CHECKPOINT_SECRET');
    writeRaw('internal/state.json', 'INTERNAL_SECRET');

    for (const filePath of [
      'manifest.json',
      'transcript.jsonl',
      'metrics.json',
      'harness.json',
      'harness/checkpoint.json',
      'internal/state.json',
      '../outside.txt',
      '/etc/passwd',
    ]) {
      const result = await call('read_file', { file_path: filePath });
      expect(result).toMatchObject({ isError: true, errorKind: 'execution_error' });
      expect(result.content).toContain(filePath);
      expect(result.content).not.toMatch(/SECRET/);
    }
  });

  it('refuses symlink components, directories, binary bytes, and invalid UTF-8', async () => {
    writeRaw('artifacts/real.txt', 'do not leak\n');
    symlinkSync(
      join(runDir, 'artifacts/real.txt'),
      join(runDir, 'scratch/link.txt'),
    );
    mkdirSync(join(runDir, 'scratch/directory'));
    writeRaw(
      'scratch/image.bin',
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );
    writeRaw('scratch/invalid.txt', Buffer.from([0x68, 0x69, 0xff]));

    for (const [filePath, message] of [
      ['scratch/link.txt', /symbolic link/i],
      ['scratch/directory', /regular file/i],
      ['scratch/image.bin', /image/i],
      ['scratch/invalid.txt', /valid UTF-8/i],
    ] as const) {
      const result = await call('read_file', { file_path: filePath });
      expect(result).toMatchObject({ isError: true, errorKind: 'execution_error' });
      expect(result.content).toMatch(message);
    }
  });

  it('checks the source size before reading it into memory', async () => {
    const large = writeRaw('scratch/large.txt', '');
    truncateSync(large, V3_FILE_TOOL_MAX_BYTES + 1);

    const result = await call('read_file', { file_path: 'scratch/large.txt' });

    expect(result).toMatchObject({ isError: true, errorKind: 'execution_error' });
    expect(result.content).toMatch(/64 MiB/);
  });

  it('uses a strict learned-prior schema', async () => {
    const unknown = await call('read_file', {
      file_path: 'scratch/nope.txt',
      path: 'scratch/nope.txt',
    });
    const badOffset = await call('read_file', {
      file_path: 'scratch/nope.txt',
      offset: 0,
    });

    expect(unknown).toMatchObject({ isError: true, errorKind: 'invalid_input' });
    expect(badOffset).toMatchObject({ isError: true, errorKind: 'invalid_input' });
  });
});

describe('v3 write_file', () => {
  it('writes and appends only scratch files through manifest provenance', async () => {
    const created = await call('write_file', {
      file_path: 'scratch/workspace/../notes.txt',
      content: 'alpha\r\n',
    });
    const appended = await call('write_file', {
      file_path: 'scratch/notes.txt',
      content: 'beta\n',
      append: true,
    });

    const bytes = Buffer.from('alpha\r\nbeta\n', 'utf8');
    expect(created).toMatchObject({ isError: false });
    expect(appended).toMatchObject({ isError: false });
    expect(readFileSync(join(runDir, 'scratch/notes.txt'))).toEqual(bytes);

    const entries = readManifest(runDir).artifacts.filter(
      (entry) => entry.filename === 'scratch/notes.txt',
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]).not.toHaveProperty('roles');
    expect(entries[0]?.sha256).toBe(
      createHash('sha256').update(bytes).digest('hex'),
    );
  });

  it('appends UTF-8 content without decoding or changing existing bytes', async () => {
    const original = Buffer.from([0xef, 0xbb, 0xbf, 0xff, 0x00]);
    writeRaw('scratch/blob.bin', original);

    const result = await call('write_file', {
      file_path: 'scratch/blob.bin',
      content: 'λ',
      append: true,
    });

    const expected = Buffer.concat([original, Buffer.from('λ', 'utf8')]);
    expect(result).toMatchObject({ isError: false });
    expect(readFileSync(join(runDir, 'scratch/blob.bin'))).toEqual(expected);
    expect(
      readManifest(runDir).artifacts.find(
        (entry) => entry.filename === 'scratch/blob.bin',
      )?.sha256,
    ).toBe(createHash('sha256').update(expected).digest('hex'));
  });

  it('rejects artifacts, metadata, loose roots, traversal, roles, and directories', async () => {
    mkdirSync(join(runDir, 'scratch/directory'));

    for (const filePath of [
      'artifacts/report.txt',
      'manifest.json',
      'harness/checkpoint.json',
      'loose.txt',
      '../outside.txt',
      '/tmp/outside.txt',
      'scratch/directory',
    ]) {
      const result = await call('write_file', {
        file_path: filePath,
        content: 'must not be written',
      });
      expect(result).toMatchObject({ isError: true, errorKind: 'execution_error' });
    }

    const roles = await call('write_file', {
      file_path: 'scratch/private.txt',
      content: 'x',
      roles: ['requested_output'],
    });
    expect(roles).toMatchObject({ isError: true, errorKind: 'invalid_input' });
    expect(existsSync(join(runDir, 'scratch/private.txt'))).toBe(false);
    expect(existsSync(join(runDir, 'artifacts/report.txt'))).toBe(false);
  });

  it('does not follow a target or parent-directory symlink', async () => {
    const target = writeRaw('artifacts/target.txt', 'original');
    symlinkSync(target, join(runDir, 'scratch/target-link.txt'));
    symlinkSync(join(runDir, 'artifacts'), join(runDir, 'scratch/dir-link'));

    const direct = await call('write_file', {
      file_path: 'scratch/target-link.txt',
      content: 'changed',
    });
    const parent = await call('write_file', {
      file_path: 'scratch/dir-link/escaped.txt',
      content: 'escaped',
    });

    expect(direct).toMatchObject({ isError: true, errorKind: 'execution_error' });
    expect(parent).toMatchObject({ isError: true, errorKind: 'execution_error' });
    expect(readFileSync(target, 'utf8')).toBe('original');
    expect(existsSync(join(runDir, 'artifacts/escaped.txt'))).toBe(false);
  });

  it('rejects an append whose resulting file would exceed the size bound', async () => {
    const large = writeRaw('scratch/large.txt', '');
    truncateSync(large, V3_FILE_TOOL_MAX_BYTES);

    const result = await call('write_file', {
      file_path: 'scratch/large.txt',
      content: 'x',
      append: true,
    });

    expect(result).toMatchObject({ isError: true, errorKind: 'execution_error' });
    expect(result.content).toMatch(/64 MiB/);
    expect(statSync(large).size).toBe(V3_FILE_TOOL_MAX_BYTES);
  });

  it('refuses an already-cancelled mutation without touching disk or manifest', async () => {
    const controller = new AbortController();
    controller.abort();
    const before = readFileSync(join(runDir, 'manifest.json'));

    const result = await call(
      'write_file',
      { file_path: 'scratch/cancelled.txt', content: 'nope' },
      { abortSignal: controller.signal },
    );

    expect(result).toMatchObject({ isError: true, errorKind: 'execution_error' });
    expect(result.content).toMatch(/cancelled/i);
    expect(existsSync(join(runDir, 'scratch/cancelled.txt'))).toBe(false);
    expect(readFileSync(join(runDir, 'manifest.json'))).toEqual(before);
  });
});

describe('v3 edit_file', () => {
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
    truncateSync(large, V3_FILE_TOOL_MAX_BYTES + 1);
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
