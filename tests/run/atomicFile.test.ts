import {
  closeSync,
  existsSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { writeFileDurablyAtomic } from '../../src/run/atomicFile.js';

let testDir: string;

beforeEach(() => {
  testDir = mkdtempSync(join(tmpdir(), 'atomic-file-test-'));
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
});

describe('writeFileDurablyAtomic', () => {
  it('replaces the destination inode only after the complete temp file is ready', () => {
    const path = join(testDir, 'state.json');
    writeFileSync(path, '{"revision":1}\n');
    const oldFd = openSync(path, 'r');
    let stagedPath: string | undefined;

    try {
      writeFileDurablyAtomic(path, '{"revision":2}\n', {
        afterTempFileSync: (tempPath) => {
          stagedPath = tempPath;
          expect(dirname(tempPath)).toBe(testDir);
          expect(readFileSync(path, 'utf8')).toBe('{"revision":1}\n');
          expect(readFileSync(tempPath, 'utf8')).toBe('{"revision":2}\n');
        },
      });

      expect(readFileSync(path, 'utf8')).toBe('{"revision":2}\n');
      // An already-open descriptor still sees the old complete inode. A
      // truncating in-place rewrite would make this assertion fail.
      expect(readFileSync(oldFd, 'utf8')).toBe('{"revision":1}\n');
      expect(stagedPath).toBeDefined();
      expect(existsSync(stagedPath!)).toBe(false);
    } finally {
      closeSync(oldFd);
    }
  });

  it('keeps the previous file intact and cleans the temp after a pre-publication failure', () => {
    const path = join(testDir, 'state.json');
    writeFileSync(path, '{"revision":1}\n');
    let stagedPath: string | undefined;

    expect(() =>
      writeFileDurablyAtomic(path, '{"revision":2}\n', {
        afterTempFileSync: (tempPath) => {
          stagedPath = tempPath;
          throw new Error('injected failure after temp fsync');
        },
      }),
    ).toThrow(/injected failure/);

    expect(readFileSync(path, 'utf8')).toBe('{"revision":1}\n');
    expect(stagedPath).toBeDefined();
    expect(existsSync(stagedPath!)).toBe(false);
  });

  it('creates exclusively without clobbering a destination that already exists', () => {
    const path = join(testDir, 'manifest.json');
    writeFileDurablyAtomic(path, 'first\n', { mode: 'create' });
    let stagedPath: string | undefined;

    expect(() =>
      writeFileDurablyAtomic(path, 'second\n', {
        mode: 'create',
        afterTempFileSync: (tempPath) => {
          stagedPath = tempPath;
        },
      }),
    ).toThrow(/EEXIST|exist/i);

    expect(readFileSync(path, 'utf8')).toBe('first\n');
    expect(stagedPath).toBeDefined();
    expect(existsSync(stagedPath!)).toBe(false);
  });

  it('applies an explicitly requested file mode exactly', () => {
    const path = join(testDir, 'checkpoint.json');

    writeFileDurablyAtomic(path, '{"revision":1}\n', { fileMode: 0o600 });

    expect(statSync(path).mode & 0o777).toBe(0o600);
  });
});
