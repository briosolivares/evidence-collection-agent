import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { finalizeManifest, initManifest, MANIFEST_FILENAME, writeArtifact, type Manifest } from './artifacts.js';

/** SHA-256 of the ASCII bytes "abc" — the classic FIPS 180 known-answer vector. */
const SHA256_OF_ABC = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';

// A temp dir stands in for the run directory; the suite stays hermetic.
let runDir: string;

beforeEach(() => {
  runDir = mkdtempSync(join(tmpdir(), 'artifacts-test-'));
});

afterEach(() => {
  rmSync(runDir, { recursive: true, force: true });
});

function readManifestFile(): Manifest {
  return JSON.parse(readFileSync(join(runDir, MANIFEST_FILENAME), 'utf8')) as Manifest;
}

describe('writeArtifact', () => {
  beforeEach(() => {
    initManifest(runDir, 'test task');
  });

  it('records the SHA-256 known-answer vector for "abc"', () => {
    const entry = writeArtifact(runDir, 'abc.txt', Buffer.from('abc'));

    expect(entry.sha256).toBe(SHA256_OF_ABC);
    const manifest = readManifestFile();
    expect(manifest.artifacts).toHaveLength(1);
    expect(manifest.artifacts[0]).toMatchObject({ filename: 'abc.txt', sha256: SHA256_OF_ABC });
  });

  it('writes the exact bytes given, and re-hashing the file on disk matches the recorded hash', () => {
    // Binary content (all 256 byte values) so text-mode mangling would be caught.
    const bytes = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
    const entry = writeArtifact(runDir, 'blob.bin', bytes);

    const onDisk = readFileSync(join(runDir, 'blob.bin'));
    expect(onDisk.equals(bytes)).toBe(true);
    expect(createHash('sha256').update(onDisk).digest('hex')).toBe(entry.sha256);
  });

  it('upserts: writing the same path twice yields one entry carrying the new hash', () => {
    writeArtifact(runDir, 'data.csv', Buffer.from('old contents'));
    const second = Buffer.from('new contents');
    writeArtifact(runDir, 'data.csv', second);

    const manifest = readManifestFile();
    expect(manifest.artifacts).toHaveLength(1);
    expect(manifest.artifacts[0]!.sha256).toBe(createHash('sha256').update(second).digest('hex'));
  });

  it('upserts equivalent spellings of the same path into one entry', () => {
    writeArtifact(runDir, 'data.csv', Buffer.from('one'));
    writeArtifact(runDir, './data.csv', Buffer.from('two'));

    const manifest = readManifestFile();
    expect(manifest.artifacts).toHaveLength(1);
    expect(manifest.artifacts[0]!.filename).toBe('data.csv');
  });

  it('keeps distinct paths as distinct entries', () => {
    writeArtifact(runDir, 'a.txt', Buffer.from('a'));
    writeArtifact(runDir, 'b.txt', Buffer.from('b'));

    expect(readManifestFile().artifacts).toHaveLength(2);
  });

  it('creates parent directories for nested artifact paths', () => {
    const entry = writeArtifact(runDir, 'sub/dir/file.bin', Buffer.from('nested'));

    expect(entry.filename).toBe('sub/dir/file.bin');
    expect(existsSync(join(runDir, 'sub', 'dir', 'file.bin'))).toBe(true);
  });

  it('records sourceUrl when provided and omits the key otherwise', () => {
    writeArtifact(runDir, 'page.png', Buffer.from('img'), { sourceUrl: 'https://example.com/page' });
    writeArtifact(runDir, 'notes.md', Buffer.from('text'));

    const [withUrl, withoutUrl] = readManifestFile().artifacts;
    expect(withUrl!.sourceUrl).toBe('https://example.com/page');
    expect(withoutUrl).not.toHaveProperty('sourceUrl');
  });

  it('rejects artifact paths that escape the run directory and writes nothing', () => {
    expect(() => writeArtifact(runDir, '../evil.txt', Buffer.from('x'))).toThrow();
    expect(() => writeArtifact(runDir, '/tmp/evil.txt', Buffer.from('x'))).toThrow();

    expect(existsSync(join(dirname(runDir), 'evil.txt'))).toBe(false);
    expect(readManifestFile().artifacts).toHaveLength(0);
  });
});

describe('manifest lifecycle', () => {
  it('stays valid JSON with all required fields through init, writes, and finalize', () => {
    initManifest(runDir, 'collect the evidence');

    let manifest = readManifestFile();
    expect(manifest.task).toBe('collect the evidence');
    expect(Number.isNaN(Date.parse(manifest.startedAt))).toBe(false);
    expect(manifest.artifacts).toEqual([]);

    writeArtifact(runDir, 'a.txt', Buffer.from('a'), { sourceUrl: 'https://example.com/a' });
    writeArtifact(runDir, 'b.txt', Buffer.from('b'));
    finalizeManifest(runDir);

    manifest = readManifestFile();
    expect(manifest.task).toBe('collect the evidence');
    expect(Number.isNaN(Date.parse(manifest.startedAt))).toBe(false);
    expect(Number.isNaN(Date.parse(manifest.finishedAt!))).toBe(false);
    expect(manifest.artifacts).toHaveLength(2);
    for (const entry of manifest.artifacts) {
      expect(entry.filename).toBeTruthy();
      expect(entry.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(Number.isNaN(Date.parse(entry.capturedAt))).toBe(false);
    }
  });

  it('initManifest refuses to overwrite an existing manifest', () => {
    initManifest(runDir, 'first');
    expect(() => initManifest(runDir, 'second')).toThrow();
  });

  it('writeArtifact before initManifest throws and writes no file', () => {
    expect(() => writeArtifact(runDir, 'orphan.txt', Buffer.from('x'))).toThrow();
    expect(existsSync(join(runDir, 'orphan.txt'))).toBe(false);
  });

  it('finalizeManifest without a manifest throws', () => {
    expect(() => finalizeManifest(runDir)).toThrow();
  });
});
