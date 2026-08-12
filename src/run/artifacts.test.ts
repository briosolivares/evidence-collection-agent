import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  CHECKLIST_DIR,
  deleteTrackedRunFile,
  finalizeManifest,
  initManifest,
  MANIFEST_FILENAME,
  writeArtifact,
  type Manifest,
} from './artifacts.js';

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
    const entry = writeArtifact(runDir, 'artifacts/abc.txt', Buffer.from('abc'), {
      roles: ['requested_output'],
    });

    expect(entry.sha256).toBe(SHA256_OF_ABC);
    const manifest = readManifestFile();
    expect(manifest.artifacts).toHaveLength(1);
    expect(manifest.artifacts[0]).toMatchObject({ filename: 'artifacts/abc.txt', sha256: SHA256_OF_ABC });
  });

  it('writes the exact bytes given, and re-hashing the file on disk matches the recorded hash', () => {
    // Binary content (all 256 byte values) so text-mode mangling would be caught.
    const bytes = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
    const entry = writeArtifact(runDir, 'scratch/blob.bin', bytes);

    const onDisk = readFileSync(join(runDir, 'scratch/blob.bin'));
    expect(onDisk.equals(bytes)).toBe(true);
    expect(createHash('sha256').update(onDisk).digest('hex')).toBe(entry.sha256);
  });

  it('upserts: writing the same path twice yields one entry carrying the new hash', () => {
    writeArtifact(runDir, 'artifacts/data.csv', Buffer.from('old contents'), { roles: ['requested_output'] });
    const second = Buffer.from('new contents');
    writeArtifact(runDir, 'artifacts/data.csv', second, { roles: ['requested_output'] });

    const manifest = readManifestFile();
    expect(manifest.artifacts).toHaveLength(1);
    expect(manifest.artifacts[0]!.sha256).toBe(createHash('sha256').update(second).digest('hex'));
  });

  it('upserts equivalent spellings of the same path into one entry', () => {
    writeArtifact(runDir, 'artifacts/data.csv', Buffer.from('one'), { roles: ['requested_output'] });
    writeArtifact(runDir, './artifacts/data.csv', Buffer.from('two'), { roles: ['requested_output'] });

    const manifest = readManifestFile();
    expect(manifest.artifacts).toHaveLength(1);
    expect(manifest.artifacts[0]!.filename).toBe('artifacts/data.csv');
  });

  it('keeps distinct paths as distinct entries', () => {
    writeArtifact(runDir, 'artifacts/a.txt', Buffer.from('a'), { roles: ['requested_output'] });
    writeArtifact(runDir, 'scratch/b.txt', Buffer.from('b'));

    expect(readManifestFile().artifacts).toHaveLength(2);
  });

  it('creates parent directories for nested artifact paths', () => {
    const entry = writeArtifact(runDir, 'artifacts/sub/dir/file.bin', Buffer.from('nested'), {
      roles: ['evidence'],
    });

    expect(entry.filename).toBe('artifacts/sub/dir/file.bin');
    expect(existsSync(join(runDir, 'artifacts', 'sub', 'dir', 'file.bin'))).toBe(true);
  });

  it('records sourceUrl when provided and omits the key otherwise', () => {
    writeArtifact(runDir, 'artifacts/page.png', Buffer.from('img'), {
      sourceUrl: 'https://example.com/page',
      roles: ['evidence'],
    });
    writeArtifact(runDir, 'scratch/notes.md', Buffer.from('text'));

    const [withUrl, withoutUrl] = readManifestFile().artifacts;
    expect(withUrl!.sourceUrl).toBe('https://example.com/page');
    expect(withoutUrl).not.toHaveProperty('sourceUrl');
  });

  it('records roles when provided — including both roles on one artifact — and omits the key otherwise', () => {
    writeArtifact(runDir, 'artifacts/answer.csv', Buffer.from('a'), { roles: ['requested_output'] });
    writeArtifact(runDir, 'artifacts/proof.png', Buffer.from('b'), {
      roles: ['requested_output', 'evidence'],
    });
    writeArtifact(runDir, 'scratch/working.csv', Buffer.from('c'));

    const [single, both, none] = readManifestFile().artifacts;
    expect(single!.roles).toEqual(['requested_output']);
    expect(both!.roles).toEqual(['requested_output', 'evidence']);
    expect(none).not.toHaveProperty('roles');
  });

  it('rejects artifact paths that escape the run directory and writes nothing', () => {
    expect(() => writeArtifact(runDir, '../evil.txt', Buffer.from('x'))).toThrow();
    expect(() => writeArtifact(runDir, '/tmp/evil.txt', Buffer.from('x'))).toThrow();

    expect(existsSync(join(dirname(runDir), 'evil.txt'))).toBe(false);
    expect(readManifestFile().artifacts).toHaveLength(0);
  });

  it('rejects paths outside artifacts/ and scratch/ and writes nothing', () => {
    for (const path of ['loose.csv', 'sub/loose.csv', 'artifacts', 'scratch']) {
      expect(() => writeArtifact(runDir, path, Buffer.from('x'))).toThrow(/artifacts\/.*scratch\//);
    }

    expect(existsSync(join(runDir, 'loose.csv'))).toBe(false);
    expect(readManifestFile().artifacts).toHaveLength(0);
  });

  it('normalizes traversal between the workspaces before applying the partition rules', () => {
    // Resolves to scratch/x.csv, so roles must be absent — the spelling
    // cannot smuggle a role onto a scratch file.
    expect(() =>
      writeArtifact(runDir, 'artifacts/../scratch/x.csv', Buffer.from('x'), {
        roles: ['requested_output'],
      }),
    ).toThrow(/scratch/);

    const entry = writeArtifact(runDir, 'artifacts/../scratch/x.csv', Buffer.from('x'));
    expect(entry.filename).toBe('scratch/x.csv');
  });

  it('rejects published writes without a non-empty roles list, writing nothing', () => {
    expect(() => writeArtifact(runDir, 'artifacts/answer.csv', Buffer.from('x'))).toThrow(/role/);
    expect(() =>
      writeArtifact(runDir, 'artifacts/answer.csv', Buffer.from('x'), { roles: [] }),
    ).toThrow(/role/);

    expect(existsSync(join(runDir, 'artifacts/answer.csv'))).toBe(false);
    expect(readManifestFile().artifacts).toHaveLength(0);
  });

  it('rejects scratch writes that carry roles, writing nothing', () => {
    expect(() =>
      writeArtifact(runDir, 'scratch/private.csv', Buffer.from('x'), { roles: ['evidence'] }),
    ).toThrow(/scratch/);

    expect(existsSync(join(runDir, 'scratch/private.csv'))).toBe(false);
    expect(readManifestFile().artifacts).toHaveLength(0);
  });

  it('allows checklist writes only with the internal managed-state discriminator', () => {
    expect(() => writeArtifact(runDir, 'checklist/1.json', Buffer.from('{}'))).toThrow(
      /managedState/,
    );

    const entry = writeArtifact(runDir, 'checklist/1.json', Buffer.from('{}'), {
      managedState: 'checklist',
    });
    expect(entry.filename).toBe('checklist/1.json');
    expect(entry).not.toHaveProperty('roles');
    expect(entry).not.toHaveProperty('sourceUrl');
  });

  it('rejects checklist provenance roles and source URLs, and rejects the discriminator elsewhere', () => {
    expect(() =>
      writeArtifact(runDir, 'checklist/1.json', Buffer.from('{}'), {
        managedState: 'checklist',
        roles: ['evidence'],
      }),
    ).toThrow(/roles or sourceUrl/);
    expect(() =>
      writeArtifact(runDir, 'checklist/1.json', Buffer.from('{}'), {
        managedState: 'checklist',
        sourceUrl: 'https://example.com',
      }),
    ).toThrow(/roles or sourceUrl/);
    expect(() =>
      writeArtifact(runDir, 'scratch/notes.txt', Buffer.from('x'), {
        managedState: 'checklist',
      }),
    ).toThrow(/only allowed for checklist/);
    expect(() =>
      writeArtifact(runDir, 'artifacts/report.txt', Buffer.from('x'), {
        managedState: 'checklist',
        roles: ['requested_output'],
      }),
    ).toThrow(/only allowed for checklist/);
  });
});

describe('manifest lifecycle', () => {
  it('stays valid JSON with all required fields through init, writes, and finalize', () => {
    initManifest(runDir, 'collect the evidence');

    let manifest = readManifestFile();
    expect(manifest.task).toBe('collect the evidence');
    expect(Number.isNaN(Date.parse(manifest.startedAt))).toBe(false);
    expect(manifest.artifacts).toEqual([]);

    writeArtifact(runDir, 'artifacts/a.txt', Buffer.from('a'), {
      sourceUrl: 'https://example.com/a',
      roles: ['evidence'],
    });
    writeArtifact(runDir, 'scratch/b.txt', Buffer.from('b'));
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

  it('initManifest creates the artifacts/, scratch/, and checklist/ workspace directories', () => {
    initManifest(runDir, 'task');

    expect(existsSync(join(runDir, 'artifacts'))).toBe(true);
    expect(existsSync(join(runDir, 'scratch'))).toBe(true);
    expect(existsSync(join(runDir, CHECKLIST_DIR))).toBe(true);
  });

  it('writeArtifact before initManifest throws and writes no file', () => {
    expect(() =>
      writeArtifact(runDir, 'artifacts/orphan.txt', Buffer.from('x'), { roles: ['requested_output'] }),
    ).toThrow(/manifest/);
    expect(existsSync(join(runDir, 'artifacts/orphan.txt'))).toBe(false);
  });

  it('finalizeManifest without a manifest throws', () => {
    expect(() => finalizeManifest(runDir)).toThrow();
  });

  it('deletes one tracked checklist file and exactly its manifest entry', () => {
    initManifest(runDir, 'task');
    writeArtifact(runDir, 'checklist/1.json', Buffer.from('{"id":"1"}\n'), {
      managedState: 'checklist',
    });
    writeArtifact(runDir, 'checklist/2.json', Buffer.from('{"id":"2"}\n'), {
      managedState: 'checklist',
    });
    writeArtifact(runDir, 'scratch/working.txt', Buffer.from('keep'));
    writeArtifact(runDir, 'artifacts/result.txt', Buffer.from('keep'), {
      roles: ['requested_output'],
    });

    expect(
      deleteTrackedRunFile(runDir, 'checklist/1.json', { managedState: 'checklist' }),
    ).toBe(true);
    expect(existsSync(join(runDir, 'checklist/1.json'))).toBe(false);
    expect(existsSync(join(runDir, 'checklist/2.json'))).toBe(true);
    expect(readManifestFile().artifacts.map((entry) => entry.filename)).toEqual([
      'checklist/2.json',
      'scratch/working.txt',
      'artifacts/result.txt',
    ]);
  });

  it('treats a missing tracked file as a no-op after requiring the manifest', () => {
    initManifest(runDir, 'task');

    expect(
      deleteTrackedRunFile(runDir, 'checklist/missing.json', { managedState: 'checklist' }),
    ).toBe(false);
    expect(readManifestFile().artifacts).toEqual([]);
  });

  it('confines tracked deletion to checklist paths and loads the manifest before mutation', () => {
    initManifest(runDir, 'task');
    writeArtifact(runDir, 'checklist/1.json', Buffer.from('{}'), { managedState: 'checklist' });

    expect(() =>
      deleteTrackedRunFile(runDir, '../outside.json', { managedState: 'checklist' }),
    ).toThrow();
    expect(() =>
      deleteTrackedRunFile(runDir, 'scratch/working.txt', { managedState: 'checklist' }),
    ).toThrow(/only allowed for checklist/);
    expect(existsSync(join(runDir, 'checklist/1.json'))).toBe(true);

    const withoutManifest = mkdtempSync(join(tmpdir(), 'artifacts-no-manifest-'));
    try {
      const checklistFile = join(withoutManifest, CHECKLIST_DIR, '1.json');
      mkdirSync(join(withoutManifest, CHECKLIST_DIR), { recursive: true });
      writeFileSync(checklistFile, '{}');
      expect(() =>
        deleteTrackedRunFile(withoutManifest, 'checklist/1.json', { managedState: 'checklist' }),
      ).toThrow(/manifest/);
      expect(existsSync(checklistFile)).toBe(true);
    } finally {
      rmSync(withoutManifest, { recursive: true, force: true });
    }
  });
});
