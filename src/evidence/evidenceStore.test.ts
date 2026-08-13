import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { initManifest, MANIFEST_FILENAME, type Manifest } from '../run/artifacts.js';
import {
  createEvidenceStore,
  EVIDENCE_DIR,
  recordEvidence,
  type EvidenceRecord,
  type EvidenceStore,
} from './evidenceStore.js';

// A temp dir stands in for the run directory; the suite stays hermetic.
let runDir: string;
let store: EvidenceStore;

beforeEach(() => {
  runDir = mkdtempSync(join(tmpdir(), 'evidence-store-test-'));
  initManifest(runDir, 'collect the evidence');
  store = createEvidenceStore(runDir);
});

afterEach(() => {
  rmSync(runDir, { recursive: true, force: true });
});

function readManifest(): Manifest {
  return JSON.parse(readFileSync(join(runDir, MANIFEST_FILENAME), 'utf8')) as Manifest;
}

function readRecordFile(path: string): EvidenceRecord {
  return JSON.parse(readFileSync(join(runDir, path), 'utf8')) as EvidenceRecord;
}

describe('recordEvidence', () => {
  it('persists the complete record, hashes it into the manifest, and returns a citable id', () => {
    const detail = {
      code: '[...document.querySelectorAll("li")].map((li) => li.textContent)',
      value: ['alpha', 'beta'],
    };

    const evidence = recordEvidence(store, {
      kind: 'javascript_extraction',
      summary: 'Two list items from the fixture page',
      sourceUrl: 'https://example.test/list',
      detail,
    });

    expect(evidence.id).toBe('E1');
    expect(evidence.path).toBe(`${EVIDENCE_DIR}/E1.json`);
    expect(existsSync(join(runDir, evidence.path))).toBe(true);

    // The returned hash is the hash of the bytes actually on disk.
    const bytes = readFileSync(join(runDir, evidence.path));
    expect(evidence.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));

    // ...and the manifest holds the same hash for the same path.
    const entry = readManifest().artifacts.find((a) => a.filename === evidence.path);
    expect(entry).toMatchObject({
      sha256: evidence.sha256,
      sourceUrl: 'https://example.test/list',
    });

    // Evidence is private working state: no roles field at all (its presence
    // is the published/private marker — see assertWorkspacePartition).
    expect(entry).not.toHaveProperty('roles');

    const persisted = readRecordFile(evidence.path);
    expect(persisted).toEqual({
      id: 'E1',
      kind: 'javascript_extraction',
      summary: 'Two list items from the fixture page',
      sourceUrl: 'https://example.test/list',
      recordedAt: evidence.recordedAt,
      detail,
    });
    expect(Date.parse(persisted.recordedAt)).not.toBeNaN();
  });

  it('issues stable increasing ids and indexes them for lookup and listing', () => {
    const first = recordEvidence(store, {
      kind: 'javascript_extraction',
      summary: 'first extraction',
      detail: { value: 1 },
    });
    const second = recordEvidence(store, {
      kind: 'javascript_extraction',
      summary: 'second extraction',
      detail: { value: 2 },
    });

    expect([first.id, second.id]).toEqual(['E1', 'E2']);
    expect(store.get('E1')).toEqual(first);
    expect(store.get('E2')).toEqual(second);
    expect(store.get('E3')).toBeUndefined();
    expect(store.list().map((e) => e.id)).toEqual(['E1', 'E2']);
    expect(first.sha256).not.toBe(second.sha256);
  });

  it('omits sourceUrl entirely when the evidence has no source URL', () => {
    const evidence = recordEvidence(store, {
      kind: 'javascript_extraction',
      summary: 'no source url',
      detail: { value: null },
    });

    expect(evidence).not.toHaveProperty('sourceUrl');
    expect(readRecordFile(evidence.path)).not.toHaveProperty('sourceUrl');
  });

  it('snapshots detail at record time, so later caller mutation cannot diverge from disk', () => {
    const detail: { rows: string[] } = { rows: ['one'] };
    const evidence = recordEvidence(store, {
      kind: 'javascript_extraction',
      summary: 'mutated after recording',
      detail,
    });

    detail.rows.push('two');

    expect((evidence.detail as { rows: string[] }).rows).toEqual(['one']);
    expect(readRecordFile(evidence.path).detail).toEqual({ rows: ['one'] });
  });

  it.each([
    [
      'an unknown kind',
      { kind: 'screenshot' as never, summary: 'wrong kind', detail: {} },
      /unknown evidence kind/,
    ],
    [
      'a blank summary',
      { kind: 'javascript_extraction' as const, summary: '   ', detail: {} },
      /non-empty description/,
    ],
    [
      'a non-string summary',
      { kind: 'javascript_extraction' as const, summary: 7 as never, detail: {} },
      /non-empty description/,
    ],
    [
      'an undefined detail',
      {
        kind: 'javascript_extraction' as const,
        summary: 'nothing to record',
        detail: undefined,
      },
      /JSON-serializable, got undefined/,
    ],
    [
      'a function detail',
      {
        kind: 'javascript_extraction' as const,
        summary: 'not data',
        detail: () => 1,
      },
      /JSON-serializable, got function/,
    ],
  ])('rejects %s without writing a file or consuming an id', (_name, input, message) => {
    expect(() => recordEvidence(store, input)).toThrow(message);

    expect(existsSync(join(runDir, EVIDENCE_DIR))).toBe(false);
    expect(store.list()).toEqual([]);
    // The rejected call must not have burned E1.
    expect(
      recordEvidence(store, {
        kind: 'javascript_extraction',
        summary: 'the next good record',
        detail: { value: 'ok' },
      }).id,
    ).toBe('E1');
  });

  it('rejects a cyclic detail with a JSON-serializable message and no file', () => {
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;

    expect(() =>
      recordEvidence(store, {
        kind: 'javascript_extraction',
        summary: 'cycle',
        detail: cyclic,
      }),
    ).toThrow(/JSON-serializable/);
    expect(existsSync(join(runDir, EVIDENCE_DIR))).toBe(false);
    expect(store.list()).toEqual([]);
  });

  it('fails without recording when the run directory has no manifest', () => {
    const bare = mkdtempSync(join(tmpdir(), 'evidence-store-nomanifest-'));
    try {
      const bareStore = createEvidenceStore(bare);

      expect(() =>
        recordEvidence(bareStore, {
          kind: 'javascript_extraction',
          summary: 'never persisted',
          detail: { value: 1 },
        }),
      ).toThrow(/no manifest/);
      expect(bareStore.get('E1')).toBeUndefined();
      expect(bareStore.list()).toEqual([]);
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  });
});

describe('createEvidenceStore', () => {
  it('exposes the run directory it persists into', () => {
    expect(createEvidenceStore(runDir).runDir).toBe(runDir);
  });

  it('refuses an empty run directory', () => {
    expect(() => createEvidenceStore('')).toThrow(TypeError);
  });

  it('keeps records under scratch/, never artifacts/', () => {
    expect(EVIDENCE_DIR.startsWith('scratch/')).toBe(true);
  });
});
