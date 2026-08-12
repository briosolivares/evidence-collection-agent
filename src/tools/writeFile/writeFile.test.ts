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

  it('rejects paths outside artifacts/ and scratch/, steering toward both areas, writing nothing', async () => {
    const result = await call('write_file', { file_path: 'loose.csv', content: 'x' });

    expect(result).toMatchObject({ isError: true, errorKind: 'execution_error' });
    expect(result.content).toContain('artifacts/');
    expect(result.content).toContain('scratch/');
    expect(existsSync(join(runDir, 'loose.csv'))).toBe(false);
    expect(readManifestFile().artifacts).toHaveLength(0);
  });

  it('published files default to the requested_output role', async () => {
    await call('write_file', { file_path: 'artifacts/report.csv', content: 'a,b\n' });

    const entry = readManifestFile().artifacts.find((a) => a.filename === 'artifacts/report.csv');
    expect(entry?.roles).toEqual(['requested_output']);
  });

  it('records explicit roles on published files', async () => {
    await call('write_file', {
      file_path: 'artifacts/notes.md',
      content: 'audit notes',
      roles: ['requested_output', 'evidence'],
    });

    const entry = readManifestFile().artifacts.find((a) => a.filename === 'artifacts/notes.md');
    expect(entry?.roles).toEqual(['requested_output', 'evidence']);
  });

  it('scratch/ writes carry no roles field', async () => {
    await call('write_file', { file_path: 'scratch/working.csv', content: 'w' });

    const entry = readManifestFile().artifacts.find((a) => a.filename === 'scratch/working.csv');
    expect(entry).toBeDefined();
    expect(entry).not.toHaveProperty('roles');
  });

  it('rejects roles on scratch/ paths with a steering error, writing nothing', async () => {
    const result = await call('write_file', {
      file_path: 'scratch/private.csv',
      content: 'x',
      roles: ['requested_output'],
    });

    expect(result).toMatchObject({ isError: true, errorKind: 'execution_error' });
    expect(result.content).toMatch(/scratch/);
    expect(result.content).toContain('artifacts/');
    expect(existsSync(join(runDir, 'scratch/private.csv'))).toBe(false);
    expect(readManifestFile().artifacts).toHaveLength(0);
  });
});

describe('write_file → read_file round trip', () => {
  it('preserves content exactly and records the write in the manifest with a correct hash', async () => {
    const content = 'title,url,points\nA story,https://a.example,10\nB story,https://b.example,20\n';

    const written = await call('write_file', { file_path: 'artifacts/data/stories.csv', content });
    expect(written.isError).toBe(false);
    expect(written.content).toContain('artifacts/data/stories.csv');

    // The bytes on disk are exactly the content — including the trailing
    // newline a numbered rendering could silently lose.
    expect(readFileSync(join(runDir, 'artifacts/data/stories.csv'), 'utf8')).toBe(content);

    // The invisible-plumbing rule: the write must appear in the manifest.
    const entry = readManifestFile().artifacts.find((a) => a.filename === 'artifacts/data/stories.csv');
    expect(entry).toBeDefined();
    expect(entry?.sha256).toBe(createHash('sha256').update(content, 'utf8').digest('hex'));

    const readBack = await call('read_file', { file_path: 'artifacts/data/stories.csv' });
    expect(readBack.isError).toBe(false);
    expect(readBack.content).toBe(
      '     1→title,url,points\n' +
        '     2→A story,https://a.example,10\n' +
        '     3→B story,https://b.example,20',
    );
  });

  it('overwriting a path reports an update and re-hashes the single manifest entry', async () => {
    await call('write_file', { file_path: 'artifacts/answer.md', content: 'draft' });
    const second = await call('write_file', { file_path: 'artifacts/answer.md', content: 'final' });

    expect(second.isError).toBe(false);
    expect(second.content).toMatch(/updated/i);

    const entries = readManifestFile().artifacts.filter((a) => a.filename === 'artifacts/answer.md');
    expect(entries).toHaveLength(1);
    expect(entries[0]?.sha256).toBe(createHash('sha256').update('final', 'utf8').digest('hex'));
  });
});
