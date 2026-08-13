import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { initManifest, MANIFEST_FILENAME, type Manifest } from '../run/artifacts.js';
import { serializeContractRevision, type OutputContract } from './outputContract.js';
import {
  contractRevisionPath,
  createOutputContractStore,
  type OutputContractStore,
} from './outputContractStore.js';

const TASK = 'Publish the widget roster.';

function contract(filename = 'roster.csv'): OutputContract {
  return {
    outputs: [
      {
        id: 'roster',
        kind: 'table',
        filename,
        format: 'csv',
        columns: [{ name: 'name', required: true, type: 'string' }],
        rules: [],
      },
    ],
  } as OutputContract;
}

let runDir: string;
let store: OutputContractStore;

beforeEach(() => {
  runDir = mkdtempSync(join(tmpdir(), 'contract-store-test-'));
  initManifest(runDir, TASK);
  store = createOutputContractStore(runDir);
});

afterEach(() => {
  rmSync(runDir, { recursive: true, force: true });
});

function manifest(): Manifest {
  return JSON.parse(readFileSync(join(runDir, MANIFEST_FILENAME), 'utf8')) as Manifest;
}

describe('createOutputContractStore', () => {
  it('starts empty — the contract-first gate has nothing to accept yet', () => {
    expect(store.hasContract()).toBe(false);
    expect(store.currentRevision()).toBeUndefined();
    expect(store.currentContract()).toBeUndefined();
    expect(store.contractHistory()).toEqual([]);
  });

  it('persists revision 1 through writeArtifact and records it in the manifest', () => {
    const result = store.setOutputContract({ contract: contract() });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');

    const relPath = contractRevisionPath(1);
    expect(relPath).toBe('scratch/output-contract/revision-1.json');
    expect(existsSync(join(runDir, relPath))).toBe(true);
    // Stored bytes are exactly the canonical serialization.
    expect(readFileSync(join(runDir, relPath), 'utf8')).toBe(
      serializeContractRevision(result.revision),
    );
    // Hashed in the manifest, and — being scratch — carrying no role.
    const entry = manifest().artifacts.find((a) => a.filename === relPath);
    expect(entry).toBeDefined();
    expect(entry?.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(entry?.roles).toBeUndefined();

    expect(store.hasContract()).toBe(true);
    expect(store.currentContract()).toEqual(result.revision.contract);
  });

  it('numbers revisions in order and never overwrites history', () => {
    store.setOutputContract({ contract: contract() });
    const second = store.setOutputContract({
      contract: contract('members.csv'),
      revisionBasis: {
        kind: 'evidence_discovery',
        summary: 'The published file is named members.csv.',
        evidenceIds: ['E1'],
      },
    });
    expect(second.ok).toBe(true);
    if (!second.ok) throw new Error('unreachable');
    expect(second.revision.revision).toBe(2);

    // Both files exist, each holding its own revision — revision 1 is intact.
    expect(existsSync(join(runDir, contractRevisionPath(1)))).toBe(true);
    expect(existsSync(join(runDir, contractRevisionPath(2)))).toBe(true);
    const stored1 = JSON.parse(readFileSync(join(runDir, contractRevisionPath(1)), 'utf8')) as {
      revision: number;
      contract: OutputContract;
    };
    expect(stored1.revision).toBe(1);
    expect(
      (stored1.contract.outputs[0] as { filename: string }).filename,
    ).toBe('roster.csv');

    const history = store.contractHistory();
    expect(history.map((r) => r.revision)).toEqual([1, 2]);
    expect(store.currentRevision()?.revision).toBe(2);
  });

  it('hands the verifier a history copy that callers cannot corrupt', () => {
    store.setOutputContract({ contract: contract() });
    const history = store.contractHistory();
    history.pop();
    expect(store.contractHistory()).toHaveLength(1);
  });

  it('a rejected revision writes nothing and leaves history untouched', () => {
    // Missing basis on revision 2.
    store.setOutputContract({ contract: contract() });
    const rejected = store.setOutputContract({ contract: contract('members.csv') });
    expect(rejected.ok).toBe(false);

    expect(existsSync(join(runDir, contractRevisionPath(2)))).toBe(false);
    expect(store.contractHistory().map((r) => r.revision)).toEqual([1]);
    // The current contract is still revision 1's.
    expect((store.currentContract()?.outputs[0] as { filename: string }).filename).toBe(
      'roster.csv',
    );
    expect(manifest().artifacts.some((a) => a.filename === contractRevisionPath(2))).toBe(false);
  });

  it('an invalid first revision leaves the gate closed', () => {
    const rejected = store.setOutputContract({ contract: { outputs: [] } });
    expect(rejected.ok).toBe(false);
    expect(store.hasContract()).toBe(false);
    expect(existsSync(join(runDir, contractRevisionPath(1)))).toBe(false);
  });

  it('re-uses the next number after a rejection, not the rejected one', () => {
    store.setOutputContract({ contract: contract() });
    store.setOutputContract({ contract: contract('members.csv') }); // rejected
    const accepted = store.setOutputContract({
      contract: contract('members.csv'),
      revisionBasis: { kind: 'assumption_correction', summary: 'Wrong filename assumed.' },
    });
    expect(accepted.ok).toBe(true);
    if (!accepted.ok) throw new Error('unreachable');
    // The rejected attempt consumed no number.
    expect(accepted.revision.revision).toBe(2);
  });
});
