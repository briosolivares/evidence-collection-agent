import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { initManifest, writeArtifact } from '../src/run/artifacts.js';
import { sha256Hex } from './hash.js';
import {
  findArtifactByExtension,
  findArtifactBySha256,
  readManifest,
  verifyManifestHashes,
} from './manifestVerification.js';

let runDir: string;

beforeEach(() => {
  runDir = mkdtempSync(join(tmpdir(), 'manifest-verification-test-'));
  initManifest(runDir, 'manifest verification test');
});

afterEach(() => {
  rmSync(runDir, { recursive: true, force: true });
});

describe('readManifest', () => {
  it('reads back a manifest written by initManifest', () => {
    const manifest = readManifest(runDir);
    expect(manifest.task).toBe('manifest verification test');
    expect(manifest.artifacts).toEqual([]);
  });

  it('throws when manifest.json is missing', () => {
    const emptyDir = mkdtempSync(join(tmpdir(), 'manifest-verification-test-empty-'));
    try {
      expect(() => readManifest(emptyDir)).toThrow(/missing|unreadable/);
    } finally {
      rmSync(emptyDir, { recursive: true, force: true });
    }
  });

  it('throws when manifest.json is not valid JSON', () => {
    writeFileSync(join(runDir, 'manifest.json'), '{not json');
    expect(() => readManifest(runDir)).toThrow(/valid JSON/);
  });
});

describe('verifyManifestHashes', () => {
  it('passes vacuously when the manifest lists no artifacts', () => {
    const result = verifyManifestHashes(runDir, readManifest(runDir));
    expect(result.passed).toBe(true);
  });

  it('passes when every listed artifact still hashes to its recorded value', () => {
    writeArtifact(runDir, 'a.csv', Buffer.from('title\nFoo'));
    writeArtifact(runDir, 'b.png', Buffer.from([0x89, 0x50, 0x4e, 0x47]));

    const result = verifyManifestHashes(runDir, readManifest(runDir));
    expect(result.passed).toBe(true);
    expect(result.name).toBe('manifest hashes verify');
  });

  it('fails and names the file when bytes were changed after capture', () => {
    writeArtifact(runDir, 'a.csv', Buffer.from('original'));
    writeFileSync(join(runDir, 'a.csv'), 'tampered');

    const result = verifyManifestHashes(runDir, readManifest(runDir));
    expect(result.passed).toBe(false);
    expect(result.detail).toContain('a.csv');
  });

  it('fails when a listed artifact was deleted from disk', () => {
    writeArtifact(runDir, 'a.csv', Buffer.from('original'));
    unlinkSync(join(runDir, 'a.csv'));

    const result = verifyManifestHashes(runDir, readManifest(runDir));
    expect(result.passed).toBe(false);
    expect(result.detail).toContain('a.csv');
  });
});

describe('findArtifactByExtension', () => {
  it('finds the entry with a matching extension, case-insensitively', () => {
    writeArtifact(runDir, 'answer.md', Buffer.from('hi'));
    writeArtifact(runDir, 'data.CSV', Buffer.from('a,b\n1,2'));

    const found = findArtifactByExtension(readManifest(runDir), '.csv');
    expect(found?.filename).toBe('data.CSV');
  });

  it('returns undefined when no artifact matches', () => {
    writeArtifact(runDir, 'answer.md', Buffer.from('hi'));
    expect(findArtifactByExtension(readManifest(runDir), '.csv')).toBeUndefined();
  });

  it('breaks ties between multiple matches by lexicographic filename', () => {
    writeArtifact(runDir, 'z.csv', Buffer.from('z'));
    writeArtifact(runDir, 'a.csv', Buffer.from('a'));

    const found = findArtifactByExtension(readManifest(runDir), '.csv');
    expect(found?.filename).toBe('a.csv');
  });
});

describe('findArtifactBySha256', () => {
  it('finds the entry whose recorded hash matches', () => {
    const bytes = Buffer.from('needle');
    writeArtifact(runDir, 'haystack.txt', Buffer.from('unrelated'));
    writeArtifact(runDir, 'needle.txt', bytes);

    const found = findArtifactBySha256(readManifest(runDir), sha256Hex(bytes));
    expect(found?.filename).toBe('needle.txt');
  });

  it('returns undefined when no artifact has that hash', () => {
    writeArtifact(runDir, 'a.txt', Buffer.from('a'));
    expect(findArtifactBySha256(readManifest(runDir), sha256Hex(Buffer.from('nope')))).toBeUndefined();
  });
});
