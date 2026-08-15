import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { initManifest, MANIFEST_FILENAME, writeArtifact, type Manifest } from './artifacts.js';
import { SCRATCH_WORKSPACE_MAX_FILE_BYTES, syncScratchWorkspace } from './syncScratchWorkspace.js';

// A temp dir stands in for the run directory; the suite stays hermetic —
// same convention artifacts.test.ts uses.
let runDir: string;

beforeEach(() => {
  runDir = mkdtempSync(join(tmpdir(), 'sync-scratch-workspace-test-'));
  initManifest(runDir, 'workspace sync task');
});

afterEach(() => {
  rmSync(runDir, { recursive: true, force: true });
});

function readManifestFile(): Manifest {
  return JSON.parse(readFileSync(join(runDir, MANIFEST_FILENAME), 'utf8')) as Manifest;
}

/**
 * Write a file directly into scratch/workspace, bypassing writeArtifact.
 * This stands in for a shell command or script writing files on its own —
 * exactly the gap syncScratchWorkspace exists to reconcile after the fact.
 */
function writeWorkspaceFile(relPath: string, content: string | Buffer): void {
  const absPath = join(runDir, 'scratch', 'workspace', relPath);
  mkdirSync(dirname(absPath), { recursive: true });
  writeFileSync(absPath, content);
}

describe('syncScratchWorkspace', () => {
  it('yields an empty result when scratch/workspace does not exist, rather than throwing', () => {
    expect(syncScratchWorkspace(runDir)).toEqual([]);
  });

  it('classifies a brand-new file as created', () => {
    writeWorkspaceFile('a.txt', 'hello');

    expect(syncScratchWorkspace(runDir)).toEqual([
      { path: 'scratch/workspace/a.txt', change: 'created' },
    ]);
  });

  it('reports no changes for a file already synced and left untouched', () => {
    writeWorkspaceFile('a.txt', 'hello');
    syncScratchWorkspace(runDir);

    expect(syncScratchWorkspace(runDir)).toEqual([]);
  });

  it('propagates the exact active guard failure while streaming a file', () => {
    writeWorkspaceFile('large.bin', Buffer.alloc(2 * 1024 * 1024, 1));
    const stopped = new Error('resume inspection deadline');
    let checks = 0;

    expect(() =>
      syncScratchWorkspace(runDir, {
        checkActive: () => {
          checks += 1;
          if (checks >= 5) throw stopped;
        },
      }),
    ).toThrow(stopped);
    expect(checks).toBeGreaterThanOrEqual(5);
  });

  it('classifies a same-size rewrite as modified — comparing hashes, not size', () => {
    writeWorkspaceFile('a.txt', 'hello');
    syncScratchWorkspace(runDir);

    writeWorkspaceFile('a.txt', 'HELLO'); // same length, different bytes
    expect(syncScratchWorkspace(runDir)).toEqual([
      { path: 'scratch/workspace/a.txt', change: 'modified' },
    ]);
  });

  it('classifies a removed file as deleted, and drops its manifest entry', () => {
    writeWorkspaceFile('a.txt', 'hello');
    syncScratchWorkspace(runDir);

    rmSync(join(runDir, 'scratch/workspace/a.txt'));
    expect(syncScratchWorkspace(runDir)).toEqual([
      { path: 'scratch/workspace/a.txt', change: 'deleted' },
    ]);
    expect(
      readManifestFile().artifacts.some((entry) => entry.filename === 'scratch/workspace/a.txt'),
    ).toBe(false);
  });

  it('classifies created, modified, unchanged, and deleted files together in one pass', () => {
    writeWorkspaceFile('unchanged.txt', 'stays the same');
    writeWorkspaceFile('to-modify.txt', 'before');
    writeWorkspaceFile('to-delete.txt', 'bye');
    syncScratchWorkspace(runDir);

    writeWorkspaceFile('to-modify.txt', 'after');
    writeWorkspaceFile('brand-new.txt', 'new');
    rmSync(join(runDir, 'scratch/workspace/to-delete.txt'));

    expect(syncScratchWorkspace(runDir)).toEqual([
      { path: 'scratch/workspace/brand-new.txt', change: 'created' },
      { path: 'scratch/workspace/to-delete.txt', change: 'deleted' },
      { path: 'scratch/workspace/to-modify.txt', change: 'modified' },
    ]);
  });

  it('handles nested subdirectories with no required internal taxonomy', () => {
    writeWorkspaceFile('sub/dir/file.txt', 'nested content');

    expect(syncScratchWorkspace(runDir)).toEqual([
      { path: 'scratch/workspace/sub/dir/file.txt', change: 'created' },
    ]);
    expect(existsSync(join(runDir, 'scratch/workspace/sub/dir/file.txt'))).toBe(true);
  });

  it('preserves exact bytes and hashes through the round trip', () => {
    // Binary content (all 256 byte values) so text-mode mangling would be caught.
    const bytes = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
    writeWorkspaceFile('blob.bin', bytes);

    syncScratchWorkspace(runDir);

    const onDisk = readFileSync(join(runDir, 'scratch/workspace/blob.bin'));
    expect(onDisk.equals(bytes)).toBe(true);
    const entry = readManifestFile().artifacts.find(
      (candidate) => candidate.filename === 'scratch/workspace/blob.bin',
    );
    expect(entry?.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
  });

  it('returns results sorted by path', () => {
    writeWorkspaceFile('zeta.txt', '1');
    writeWorkspaceFile('alpha.txt', '2');
    writeWorkspaceFile('mid/beta.txt', '3');

    expect(syncScratchWorkspace(runDir).map((change) => change.path)).toEqual([
      'scratch/workspace/alpha.txt',
      'scratch/workspace/mid/beta.txt',
      'scratch/workspace/zeta.txt',
    ]);
  });

  it('leaves artifacts/ and other scratch/ files untouched', () => {
    writeArtifact(runDir, 'artifacts/published.csv', Buffer.from('published'), {
      roles: ['requested_output'],
    });
    writeArtifact(runDir, 'scratch/private-note.txt', Buffer.from('private'));
    writeWorkspaceFile('a.txt', 'hello');

    expect(syncScratchWorkspace(runDir)).toEqual([
      { path: 'scratch/workspace/a.txt', change: 'created' },
    ]);
    expect(readManifestFile().artifacts.map((entry) => entry.filename).sort()).toEqual([
      'artifacts/published.csv',
      'scratch/private-note.txt',
      'scratch/workspace/a.txt',
    ]);
  });

  it('rejects a symlink without following it or manifesting it', () => {
    const target = join(runDir, 'outside-target.txt');
    writeFileSync(target, 'outside content');
    mkdirSync(join(runDir, 'scratch', 'workspace'), { recursive: true });
    symlinkSync(target, join(runDir, 'scratch/workspace/link.txt'));

    expect(() => syncScratchWorkspace(runDir)).toThrow(/symlink/);
    expect(
      readManifestFile().artifacts.some((entry) => entry.filename.includes('link.txt')),
    ).toBe(false);
  });

  it('rejects a FIFO without opening it or manifesting it', () => {
    mkdirSync(join(runDir, 'scratch', 'workspace'), { recursive: true });
    const fifoPath = join(runDir, 'scratch/workspace/pipe');
    execSync(`mkfifo ${JSON.stringify(fifoPath)}`);

    expect(() => syncScratchWorkspace(runDir)).toThrow(/regular file/);
    expect(readManifestFile().artifacts.some((entry) => entry.filename.includes('pipe'))).toBe(
      false,
    );
  });

  it('rejects a file over the 256 MiB limit before reading it into memory', () => {
    mkdirSync(join(runDir, 'scratch', 'workspace'), { recursive: true });
    const hugePath = join(runDir, 'scratch/workspace/huge.bin');
    // A sparse file: its logical size exceeds the limit without allocating
    // real disk blocks, so both creating it and the rejection that must
    // happen before any read stay fast — no 256 MiB is ever written or read.
    writeFileSync(hugePath, '');
    truncateSync(hugePath, SCRATCH_WORKSPACE_MAX_FILE_BYTES + 1);

    expect(() => syncScratchWorkspace(runDir)).toThrow(/256 MiB/);
  }, 10_000);

  it('is idempotent — repeating a successful sync reports no changes', () => {
    writeWorkspaceFile('a.txt', 'hello');
    writeWorkspaceFile('sub/b.txt', 'world');
    syncScratchWorkspace(runDir);

    expect(syncScratchWorkspace(runDir)).toEqual([]);
  });
});
