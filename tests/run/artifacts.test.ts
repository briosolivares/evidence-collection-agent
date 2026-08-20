import { createHash } from 'node:crypto';
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  finalizeManifest,
  initManifest,
  MANIFEST_FILENAME,
  MANIFEST_MAX_BYTES,
  readManifest,
  removeScratchArtifactEntry,
  writeArtifact,
  type Manifest,
} from '../../src/run/artifacts.js';

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

function manifestTempFiles(): string[] {
  return readdirSync(runDir).filter(
    (name) => name.startsWith(`.${MANIFEST_FILENAME}.`) && name.endsWith('.tmp'),
  );
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
    expect(manifest.artifacts[0]).toMatchObject({
      filename: 'artifacts/abc.txt',
      sha256: SHA256_OF_ABC,
    });
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
    writeArtifact(runDir, 'artifacts/data.csv', Buffer.from('old contents'), {
      roles: ['requested_output'],
    });
    const second = Buffer.from('new contents');
    writeArtifact(runDir, 'artifacts/data.csv', second, { roles: ['requested_output'] });

    const manifest = readManifestFile();
    expect(manifest.artifacts).toHaveLength(1);
    expect(manifest.artifacts[0]!.sha256).toBe(createHash('sha256').update(second).digest('hex'));
  });

  it('upserts equivalent spellings of the same path into one entry', () => {
    writeArtifact(runDir, 'artifacts/data.csv', Buffer.from('one'), {
      roles: ['requested_output'],
    });
    writeArtifact(runDir, './artifacts/data.csv', Buffer.from('two'), {
      roles: ['requested_output'],
    });

    const manifest = readManifestFile();
    expect(manifest.artifacts).toHaveLength(1);
    expect(manifest.artifacts[0]!.filename).toBe('artifacts/data.csv');
  });

  it('allows only same-role published overwrites and leaves refused bytes untouched', () => {
    writeArtifact(runDir, 'artifacts/data.csv', Buffer.from('old'), {
      roles: ['evidence', 'requested_output'],
    });

    expect(() =>
      writeArtifact(runDir, 'artifacts/data.csv', Buffer.from('refused'), {
        roles: ['evidence'],
      }),
    ).toThrow(/do not match requested roles/);
    expect(readFileSync(join(runDir, 'artifacts/data.csv'), 'utf8')).toBe('old');

    writeArtifact(runDir, 'artifacts/data.csv', Buffer.from('new'), {
      roles: ['requested_output', 'evidence'],
    });
    expect(readFileSync(join(runDir, 'artifacts/data.csv'), 'utf8')).toBe('new');
    expect(readManifestFile().artifacts).toHaveLength(1);
  });

  it('refuses to adopt an unmanifested published destination', () => {
    const destination = join(runDir, 'artifacts/untracked.txt');
    writeFileSync(destination, 'outside publication');

    expect(() =>
      writeArtifact(runDir, 'artifacts/untracked.txt', Buffer.from('replacement'), {
        roles: ['evidence'],
      }),
    ).toThrow(/unmanifested file/);
    expect(readFileSync(destination, 'utf8')).toBe('outside publication');
    expect(readManifestFile().artifacts).toEqual([]);
  });

  it('creates parent directories for nested artifact paths', () => {
    const entry = writeArtifact(runDir, 'artifacts/sub/dir/file.bin', Buffer.from('nested'), {
      roles: ['evidence'],
    });

    expect(entry.filename).toBe('artifacts/sub/dir/file.bin');
    expect(existsSync(join(runDir, 'artifacts', 'sub', 'dir', 'file.bin'))).toBe(true);
  });

  it('never follows a symlink in an artifact parent path', () => {
    const outside = join(runDir, 'outside-real');
    mkdirSync(outside);
    symlinkSync(outside, join(runDir, 'artifacts', 'linked'));

    expect(() =>
      writeArtifact(runDir, 'artifacts/linked/escape.txt', Buffer.from('must stay confined'), {
        roles: ['requested_output'],
      }),
    ).toThrow(/symlink|real directory/);
    expect(existsSync(join(outside, 'escape.txt'))).toBe(false);
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

  it('records trusted publication kind when provided and omits it otherwise', () => {
    writeArtifact(runDir, 'artifacts/page.png', Buffer.from('img'), {
      publicationKind: 'screenshot',
      roles: ['evidence'],
    });
    writeArtifact(runDir, 'scratch/notes.md', Buffer.from('text'));

    const [published, scratch] = readManifestFile().artifacts;
    expect(published!.publicationKind).toBe('screenshot');
    expect(scratch).not.toHaveProperty('publicationKind');
  });

  it('rejects publication kind on private scratch files', () => {
    expect(() =>
      writeArtifact(runDir, 'scratch/not-published.png', Buffer.from('img'), {
        publicationKind: 'screenshot',
      }),
    ).toThrow(/publicationKind/);
    expect(readManifestFile().artifacts).toEqual([]);
  });

  it('records roles when provided — including both roles on one artifact — and omits the key otherwise', () => {
    writeArtifact(runDir, 'artifacts/answer.csv', Buffer.from('a'), {
      roles: ['requested_output'],
    });
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
});

describe('manifest browserProvider', () => {
  it('records which runtime produced the run', () => {
    // A finished run used to say nothing about its browser, so which runtime
    // produced it had to be inferred from timestamps against a commit date.
    // The runtime decides both feasibility (a Google-authenticated step is
    // impossible on local Chrome) and latency, so it belongs in provenance.
    initManifest(runDir, 'collect the evidence', 'browserbase');

    expect(readManifestFile().browserProvider).toBe('browserbase');
  });

  it('omits the field for a run with no browser', () => {
    initManifest(runDir, 'collect the evidence');

    expect(readManifestFile()).not.toHaveProperty('browserProvider');
  });

  it('survives finalize', () => {
    initManifest(runDir, 'collect the evidence', 'local');
    finalizeManifest(runDir);

    expect(readManifestFile().browserProvider).toBe('local');
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
    const before = readFileSync(join(runDir, MANIFEST_FILENAME), 'utf8');

    expect(() => initManifest(runDir, 'second')).toThrow();
    expect(readFileSync(join(runDir, MANIFEST_FILENAME), 'utf8')).toBe(before);
    expect(manifestTempFiles()).toEqual([]);
  });

  it('replaces complete manifest snapshots and leaves no staging files', () => {
    initManifest(runDir, 'atomic lifecycle');
    const beforeWriteFd = openSync(join(runDir, MANIFEST_FILENAME), 'r');

    try {
      const entry = writeArtifact(runDir, 'artifacts/result.csv', Buffer.from('value\n1\n'), {
        sourceUrl: 'https://example.com/source',
        roles: ['requested_output', 'evidence'],
      });
      const initialSnapshot = JSON.parse(readFileSync(beforeWriteFd, 'utf8')) as Manifest;
      expect(initialSnapshot.artifacts).toEqual([]);

      const beforeFinalizeFd = openSync(join(runDir, MANIFEST_FILENAME), 'r');
      try {
        finalizeManifest(runDir);
        const preFinalizeSnapshot = JSON.parse(readFileSync(beforeFinalizeFd, 'utf8')) as Manifest;
        expect(preFinalizeSnapshot).not.toHaveProperty('finishedAt');
      } finally {
        closeSync(beforeFinalizeFd);
      }

      const final = readManifestFile();
      expect(final.artifacts).toEqual([entry]);
      expect(final.artifacts[0]).toMatchObject({
        filename: 'artifacts/result.csv',
        roles: ['requested_output', 'evidence'],
        sha256: createHash('sha256').update('value\n1\n').digest('hex'),
      });
      expect(Number.isNaN(Date.parse(final.finishedAt!))).toBe(false);
      expect(manifestTempFiles()).toEqual([]);
    } finally {
      closeSync(beforeWriteFd);
    }
  });

  it('initManifest creates the artifacts/ and scratch/ workspace directories', () => {
    initManifest(runDir, 'task');

    expect(existsSync(join(runDir, 'artifacts'))).toBe(true);
    expect(existsSync(join(runDir, 'scratch'))).toBe(true);
  });

  it('writeArtifact before initManifest throws and writes no file', () => {
    expect(() =>
      writeArtifact(runDir, 'artifacts/orphan.txt', Buffer.from('x'), {
        roles: ['requested_output'],
      }),
    ).toThrow(/manifest/);
    expect(existsSync(join(runDir, 'artifacts/orphan.txt'))).toBe(false);
  });

  it('finalizeManifest without a manifest throws', () => {
    expect(() => finalizeManifest(runDir)).toThrow();
  });
});

describe('readManifest', () => {
  it('returns the existing manifest shape without mutating it', () => {
    initManifest(runDir, 'read task');
    writeArtifact(runDir, 'artifacts/a.txt', Buffer.from('a'), { roles: ['requested_output'] });
    writeArtifact(runDir, 'scratch/b.txt', Buffer.from('b'));

    const before = readFileSync(join(runDir, MANIFEST_FILENAME), 'utf8');
    const manifest = readManifest(runDir);

    expect(manifest.task).toBe('read task');
    expect(manifest.artifacts).toHaveLength(2);
    expect(manifest).toEqual(readManifestFile());
    // Reading must not itself write — the file on disk is byte-for-byte the
    // same as before the call.
    expect(readFileSync(join(runDir, MANIFEST_FILENAME), 'utf8')).toBe(before);
  });

  it('fails loudly when the manifest is missing', () => {
    expect(() => readManifest(runDir)).toThrow(/manifest/);
  });

  it('fails loudly when the manifest is not valid JSON', () => {
    writeFileSync(join(runDir, MANIFEST_FILENAME), 'not json');
    expect(() => readManifest(runDir)).toThrow(/manifest at .* is not valid JSON/);
  });

  it('does not follow a manifest symlink', () => {
    const path = join(runDir, MANIFEST_FILENAME);
    const target = join(runDir, 'outside-manifest.json');
    writeFileSync(target, JSON.stringify({ task: 'outside', startedAt: '', artifacts: [] }));
    symlinkSync(target, path);

    expect(() => readManifest(runDir)).toThrow(/symlinks are not followed/);
  });

  it('rejects non-regular and oversized manifest paths before parsing', () => {
    const path = join(runDir, MANIFEST_FILENAME);
    mkdirSync(path);
    expect(() => readManifest(runDir)).toThrow(/must be a regular file/);

    rmSync(path, { recursive: true });
    writeFileSync(path, '');
    truncateSync(path, MANIFEST_MAX_BYTES + 1);
    expect(() => readManifest(runDir)).toThrow(new RegExp(`${MANIFEST_MAX_BYTES}-byte read limit`));
  });
});

describe('removeScratchArtifactEntry', () => {
  beforeEach(() => {
    initManifest(runDir, 'scratch removal task');
  });

  it('removes only the named scratch entry, preserving every unrelated entry', () => {
    writeArtifact(runDir, 'artifacts/keep.csv', Buffer.from('keep'), {
      roles: ['requested_output'],
    });
    writeArtifact(runDir, 'scratch/keep.tmp', Buffer.from('scratch keep'));
    writeArtifact(runDir, 'scratch/drop.tmp', Buffer.from('scratch drop'));

    removeScratchArtifactEntry(runDir, 'scratch/drop.tmp');

    const manifest = readManifestFile();
    expect(manifest.artifacts.map((entry) => entry.filename).sort()).toEqual([
      'artifacts/keep.csv',
      'scratch/keep.tmp',
    ]);
  });

  it('touches only the manifest — a file the caller already knows is gone is not looked for', () => {
    writeArtifact(runDir, 'scratch/drop.tmp', Buffer.from('x'));

    // The file is deliberately left on disk: removeScratchArtifactEntry must
    // not need (or attempt) to check or delete it.
    removeScratchArtifactEntry(runDir, 'scratch/drop.tmp');

    expect(existsSync(join(runDir, 'scratch/drop.tmp'))).toBe(true);
    expect(readManifestFile().artifacts).toHaveLength(0);
  });

  it('rejects removing an artifacts/ entry, leaving it on record', () => {
    writeArtifact(runDir, 'artifacts/published.csv', Buffer.from('x'), {
      roles: ['requested_output'],
    });

    expect(() => removeScratchArtifactEntry(runDir, 'artifacts/published.csv')).toThrow(/scratch/);
    expect(readManifestFile().artifacts).toHaveLength(1);
  });

  it('rejects an escaping or absolute path', () => {
    expect(() => removeScratchArtifactEntry(runDir, '../evil.tmp')).toThrow();
    expect(() => removeScratchArtifactEntry(runDir, '/tmp/evil.tmp')).toThrow();
  });

  it('is a no-op for a scratch path the manifest never tracked', () => {
    expect(() => removeScratchArtifactEntry(runDir, 'scratch/never-written.tmp')).not.toThrow();
    expect(readManifestFile().artifacts).toHaveLength(0);
  });
});
