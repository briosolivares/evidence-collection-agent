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
} from '../../../src/run/artifacts.js';
import { executeToolCall } from '../../../src/tools/pipeline.js';
import { createRegistry, type ToolCtx } from '../../../src/tools/registry.js';
import { FILE_TOOL_MAX_BYTES } from '../../../src/tools/fileAccess.js';
import { writeFileTool } from '../../../src/tools/writeFile/writeFile.js';

let runDir: string;

beforeEach(() => {
  runDir = mkdtempSync(join(tmpdir(), 'sherlock-file-tools-'));
  initManifest(runDir, 'exercise the private file tools');
});

afterEach(() => {
  rmSync(runDir, { recursive: true, force: true });
});

const registry = createRegistry([writeFileTool]);

function call(name: 'write_file', input: unknown, ctx: Partial<ToolCtx> = {}) {
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

describe('write_file', () => {
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
    expect(created.content).toBe(
      JSON.stringify({ path: 'scratch/notes.txt', bytes: 7 }),
    );
    expect(appended.content).toBe(
      JSON.stringify({ path: 'scratch/notes.txt', bytes: bytes.length }),
    );
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
    expect(result.content).toBe(
      JSON.stringify({ path: 'scratch/blob.bin', bytes: expected.length }),
    );
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
    truncateSync(large, FILE_TOOL_MAX_BYTES);

    const result = await call('write_file', {
      file_path: 'scratch/large.txt',
      content: 'x',
      append: true,
    });

    expect(result).toMatchObject({ isError: true, errorKind: 'execution_error' });
    expect(result.content).toMatch(/64 MiB/);
    expect(statSync(large).size).toBe(FILE_TOOL_MAX_BYTES);
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
