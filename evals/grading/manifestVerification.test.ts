import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { initManifest, writeArtifact } from '../../src/run/artifacts.js';
import { sha256Hex } from './hash.js';
import {
  findArtifactByExtension,
  findArtifactBySha256,
  findRequestedOutputByName,
  readManifest,
  requestedOutputs,
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
    writeArtifact(runDir, 'artifacts/a.csv', Buffer.from('title\nFoo'), {
      roles: ['requested_output'],
    });
    writeArtifact(runDir, 'artifacts/b.png', Buffer.from([0x89, 0x50, 0x4e, 0x47]), {
      roles: ['evidence'],
    });

    const result = verifyManifestHashes(runDir, readManifest(runDir));
    expect(result.passed).toBe(true);
    expect(result.name).toBe('manifest hashes verify');
  });

  it('fails and names the file when bytes were changed after capture', () => {
    writeArtifact(runDir, 'artifacts/a.csv', Buffer.from('original'), {
      roles: ['requested_output'],
    });
    writeFileSync(join(runDir, 'artifacts/a.csv'), 'tampered');

    const result = verifyManifestHashes(runDir, readManifest(runDir));
    expect(result.passed).toBe(false);
    expect(result.detail).toContain('artifacts/a.csv');
  });

  it('fails when a listed artifact was deleted from disk', () => {
    writeArtifact(runDir, 'artifacts/a.csv', Buffer.from('original'), {
      roles: ['requested_output'],
    });
    unlinkSync(join(runDir, 'artifacts/a.csv'));

    const result = verifyManifestHashes(runDir, readManifest(runDir));
    expect(result.passed).toBe(false);
    expect(result.detail).toContain('artifacts/a.csv');
  });

  it('still covers scratch/ files — tamper evidence is total, not just published', () => {
    writeArtifact(runDir, 'scratch/working.csv', Buffer.from('original scrape'));
    writeFileSync(join(runDir, 'scratch/working.csv'), 'tampered scrape');

    const result = verifyManifestHashes(runDir, readManifest(runDir));
    expect(result.passed).toBe(false);
    expect(result.detail).toContain('scratch/working.csv');
  });
});

describe('requestedOutputs', () => {
  it('returns only entries whose roles include requested_output', () => {
    writeArtifact(runDir, 'artifacts/answer.csv', Buffer.from('a'), {
      roles: ['requested_output'],
    });
    writeArtifact(runDir, 'artifacts/both.png', Buffer.from('b'), {
      roles: ['requested_output', 'evidence'],
    });
    writeArtifact(runDir, 'artifacts/capture.png', Buffer.from('c'), { roles: ['evidence'] });
    writeArtifact(runDir, 'scratch/working.csv', Buffer.from('d'));

    const outputs = requestedOutputs(readManifest(runDir)).map((entry) => entry.filename);
    expect(outputs).toEqual(['artifacts/answer.csv', 'artifacts/both.png']);
  });
});

describe('findArtifactByExtension', () => {
  it('finds the requested-output entry with a matching extension, case-insensitively', () => {
    writeArtifact(runDir, 'artifacts/answer.md', Buffer.from('hi'), {
      roles: ['requested_output'],
    });
    writeArtifact(runDir, 'artifacts/data.CSV', Buffer.from('a,b\n1,2'), {
      roles: ['requested_output'],
    });

    const found = findArtifactByExtension(readManifest(runDir), '.csv');
    expect(found?.filename).toBe('artifacts/data.CSV');
  });

  it('returns undefined when no artifact matches', () => {
    writeArtifact(runDir, 'artifacts/answer.md', Buffer.from('hi'), {
      roles: ['requested_output'],
    });
    expect(findArtifactByExtension(readManifest(runDir), '.csv')).toBeUndefined();
  });

  it('breaks ties between multiple requested-output matches by lexicographic filename', () => {
    writeArtifact(runDir, 'artifacts/z.csv', Buffer.from('z'), { roles: ['requested_output'] });
    writeArtifact(runDir, 'artifacts/a.csv', Buffer.from('a'), { roles: ['requested_output'] });

    const found = findArtifactByExtension(readManifest(runDir), '.csv');
    expect(found?.filename).toBe('artifacts/a.csv');
  });

  it('never selects scratch or evidence-only files, even ones sorting first — the shadowing fix', () => {
    // The motivating bug: an intermediate scrape CSV sorted alphabetically
    // before the deliverable and got graded in its place.
    writeArtifact(runDir, 'scratch/contributors_raw.csv', Buffer.from('rank,handle\n1,x'));
    writeArtifact(runDir, 'artifacts/aa_evidence_dump.csv', Buffer.from('col\nv'), {
      roles: ['evidence'],
    });
    writeArtifact(runDir, 'artifacts/top_30_contributors.csv', Buffer.from('github_handle\na'), {
      roles: ['requested_output'],
    });

    const found = findArtifactByExtension(readManifest(runDir), '.csv');
    expect(found?.filename).toBe('artifacts/top_30_contributors.csv');
  });
});

describe('findArtifactBySha256', () => {
  it('finds the requested-output entry whose recorded hash matches', () => {
    const bytes = Buffer.from('needle');
    writeArtifact(runDir, 'artifacts/haystack.txt', Buffer.from('unrelated'), {
      roles: ['requested_output'],
    });
    writeArtifact(runDir, 'artifacts/needle.txt', bytes, { roles: ['requested_output'] });

    const found = findArtifactBySha256(readManifest(runDir), sha256Hex(bytes));
    expect(found?.filename).toBe('artifacts/needle.txt');
  });

  it('returns undefined when no artifact has that hash', () => {
    writeArtifact(runDir, 'artifacts/a.txt', Buffer.from('a'), { roles: ['requested_output'] });
    expect(
      findArtifactBySha256(readManifest(runDir), sha256Hex(Buffer.from('nope'))),
    ).toBeUndefined();
  });

  it('ignores a hash match that is not a requested output', () => {
    const bytes = Buffer.from('filing bytes');
    writeArtifact(runDir, 'scratch/copy.htm', bytes);

    expect(findArtifactBySha256(readManifest(runDir), sha256Hex(bytes))).toBeUndefined();
  });
});

describe('findRequestedOutputByName', () => {
  it('matches on the base filename anywhere under artifacts/, case-insensitively', () => {
    writeArtifact(runDir, 'artifacts/reports/Answer.MD', Buffer.from('hi'), {
      roles: ['requested_output'],
    });

    const found = findRequestedOutputByName(readManifest(runDir), 'answer.md');
    expect(found?.filename).toBe('artifacts/reports/Answer.MD');
  });

  it('ignores same-named files that are not requested outputs', () => {
    writeArtifact(runDir, 'scratch/answer.md', Buffer.from('draft'));
    writeArtifact(runDir, 'artifacts/answer.md', Buffer.from('final'), {
      roles: ['requested_output'],
    });

    const found = findRequestedOutputByName(readManifest(runDir), 'answer.md');
    expect(found?.filename).toBe('artifacts/answer.md');
  });

  it('returns undefined when the name only exists as scratch or evidence', () => {
    writeArtifact(runDir, 'scratch/answer.md', Buffer.from('draft'));
    writeArtifact(runDir, 'artifacts/answer.png', Buffer.from('img'), { roles: ['evidence'] });

    expect(findRequestedOutputByName(readManifest(runDir), 'answer.md')).toBeUndefined();
  });

  it('breaks ties between multiple matches by lexicographic filename', () => {
    writeArtifact(runDir, 'artifacts/b/answer.md', Buffer.from('b'), {
      roles: ['requested_output'],
    });
    writeArtifact(runDir, 'artifacts/a/answer.md', Buffer.from('a'), {
      roles: ['requested_output'],
    });

    const found = findRequestedOutputByName(readManifest(runDir), 'answer.md');
    expect(found?.filename).toBe('artifacts/a/answer.md');
  });
});
