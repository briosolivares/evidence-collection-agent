import { mkdirSync, mkdtempSync, rmSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { initManifest, writeArtifact } from '../../../src/run/artifacts.js';
import { executeToolCall } from '../../../src/tools/pipeline.js';
import { createRegistry, type ToolCtx } from '../../../src/tools/registry.js';
import { FILE_TOOL_MAX_BYTES } from '../../../src/tools/fileAccess.js';
import { readFileTool } from '../../../src/tools/readFile/readFile.js';

let runDir: string;

beforeEach(() => {
  runDir = mkdtempSync(join(tmpdir(), 'sherlock-file-tools-'));
  initManifest(runDir, 'exercise the private file tools');
});

afterEach(() => {
  rmSync(runDir, { recursive: true, force: true });
});

const registry = createRegistry([readFileTool]);

function call(name: 'read_file', input: unknown, ctx: Partial<ToolCtx> = {}) {
  return executeToolCall(registry, { id: `call-${name}`, name, input }, { runDir, ...ctx });
}

function writeRaw(relativePath: string, bytes: string | Buffer): string {
  const absolutePath = join(runDir, relativePath);
  mkdirSync(join(absolutePath, '..'), { recursive: true });
  writeFileSync(absolutePath, bytes);
  return absolutePath;
}

describe('read_file', () => {
  it('reads only artifacts/ and scratch/ with familiar line windows', async () => {
    writeArtifact(runDir, 'artifacts/report.txt', Buffer.from('first\nsecond\nthird\n', 'utf8'), {
      roles: ['requested_output'],
    });
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
    symlinkSync(join(runDir, 'artifacts/real.txt'), join(runDir, 'scratch/link.txt'));
    mkdirSync(join(runDir, 'scratch/directory'));
    writeRaw('scratch/image.bin', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
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
    truncateSync(large, FILE_TOOL_MAX_BYTES + 1);

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
