import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createRunDir, resolveRunPath } from './runDir.js';

// Every test works inside its own temp root so the suite stays hermetic.
let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'run-dir-test-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('createRunDir', () => {
  it('creates the run directory (and a missing baseDir) and returns its absolute path', () => {
    // baseDir does not exist yet — the common first-run case.
    const baseDir = join(root, 'runs');
    const runDir = createRunDir(baseDir, 'run-1');

    expect(isAbsolute(runDir)).toBe(true);
    expect(basename(runDir)).toBe('run-1');
    expect(statSync(runDir).isDirectory()).toBe(true);
  });

  it('throws if the run directory already exists (id collision)', () => {
    createRunDir(root, 'run-1');
    expect(() => createRunDir(root, 'run-1')).toThrow();
  });

  it('rejects run ids that are not a single path segment', () => {
    for (const badId of ['../evil', 'a/b', '', '.', '..']) {
      expect(() => createRunDir(root, badId)).toThrow();
    }
    // The traversal attempt must not have created anything next to root.
    expect(existsSync(join(dirname(root), 'evil'))).toBe(false);
  });
});

describe('resolveRunPath', () => {
  let runDir: string;

  beforeEach(() => {
    runDir = createRunDir(root, 'run-1');
  });

  it('resolves plain and nested relative paths to absolute paths inside the run dir', () => {
    expect(resolveRunPath(runDir, 'file.txt')).toBe(join(runDir, 'file.txt'));
    expect(resolveRunPath(runDir, 'sub/file.csv')).toBe(join(runDir, 'sub', 'file.csv'));
  });

  it('allows traversal that stays inside the run dir', () => {
    expect(resolveRunPath(runDir, 'a/../b')).toBe(join(runDir, 'b'));
  });

  it('rejects ../ escape', () => {
    expect(() => resolveRunPath(runDir, '../escape.txt')).toThrow();
  });

  it('rejects absolute paths', () => {
    expect(() => resolveRunPath(runDir, '/etc/passwd')).toThrow();
  });

  it('rejects nested traversal that escapes (a/../../b)', () => {
    expect(() => resolveRunPath(runDir, 'a/../../b')).toThrow();
  });

  it('rejects escape into a sibling directory sharing the run dir name as a prefix', () => {
    // The classic prefix-check bug: <runDir>-evil starts with the runDir string.
    const sibling = `../${basename(runDir)}-evil/file.txt`;
    expect(() => resolveRunPath(runDir, sibling)).toThrow();
  });

  it('rejects paths that name the run dir itself rather than something inside it', () => {
    expect(() => resolveRunPath(runDir, '')).toThrow();
    expect(() => resolveRunPath(runDir, '.')).toThrow();
    expect(() => resolveRunPath(runDir, 'a/..')).toThrow();
  });
});
