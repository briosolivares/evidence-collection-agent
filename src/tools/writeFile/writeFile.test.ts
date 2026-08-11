import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { initManifest, MANIFEST_FILENAME, type Manifest } from '../../run/artifacts.js';
import { executeToolCall } from '../pipeline.js';
import { createRegistry, type ToolDef } from '../registry.js';
import { readFileTool } from '../readFile/readFile.js';
import { writeFileTool } from './writeFile.js';

// A temp dir with an initialized manifest stands in for the run directory;
// the suite stays hermetic.
let runDir: string;

beforeEach(() => {
  runDir = mkdtempSync(join(tmpdir(), 'write-file-test-'));
  initManifest(runDir, 'test task');
});

afterEach(() => {
  rmSync(runDir, { recursive: true, force: true });
});

// read_file joins the registry so the round-trip test reads back through
// the same pipeline the model would use.
const registry = createRegistry([writeFileTool as ToolDef, readFileTool as ToolDef]);

function call(name: string, input: unknown) {
  return executeToolCall(registry, { id: `call-${name}`, name, input }, { runDir });
}

function readManifestFile(): Manifest {
  return JSON.parse(readFileSync(join(runDir, MANIFEST_FILENAME), 'utf8')) as Manifest;
}

describe('write_file', () => {
  it('rejects traversal and absolute paths with a structured error', async () => {
    for (const path of ['../escape.txt', '/etc/passwd']) {
      const result = await call('write_file', { file_path: path, content: 'x' });
      expect(result).toMatchObject({ isError: true, errorKind: 'execution_error' });
      // The message must name the offending path so the model can correct it.
      expect(result.content).toContain(path);
    }
  });

  it('a rejected write_file writes nothing outside the run directory', async () => {
    const outside = join(runDir, '..', 'write-file-test-escape.txt');
    rmSync(outside, { force: true });

    const result = await call('write_file', {
      file_path: '../write-file-test-escape.txt',
      content: 'leaked',
    });

    expect(result.isError).toBe(true);
    expect(existsSync(outside)).toBe(false);
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
