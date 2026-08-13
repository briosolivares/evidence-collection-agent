import { describe, expect, it } from 'vitest';

import type { OutputSpec } from '../contracts/outputContract.js';
import {
  createOutputTableStore,
  type OutputRowInput,
  type OutputTableStore,
  type TableMutationResult,
} from './outputTable.js';

// The store's three guarantees, tested directly: atomic batches, versioned
// rows, and evidence-linked facts.

const SPEC: Extract<OutputSpec, { kind: 'table' }> = {
  id: 'roster',
  kind: 'table',
  filename: 'roster.csv',
  format: 'csv',
  columns: [
    { name: 'name', required: true, type: 'string' },
    { name: 'url', required: false, type: 'url' },
    { name: 'count', required: false, type: 'integer' },
    { name: 'status', required: false, type: 'enum', values: ['active', 'alumni'] },
  ],
  rules: [],
} as Extract<OutputSpec, { kind: 'table' }>;

/** Evidence E1/E2 exist; everything else does not. */
const EVIDENCE = new Set(['E1', 'E2']);

function store(spec: Extract<OutputSpec, { kind: 'table' }> = SPEC): OutputTableStore {
  return createOutputTableStore({
    tableSpec: (outputId) => (outputId === spec.id ? spec : undefined),
    evidenceExists: (id) => EVIDENCE.has(id),
  });
}

function row(overrides: Partial<OutputRowInput> = {}): OutputRowInput {
  return {
    rowId: 'r1',
    values: { name: 'Alpha', url: 'https://example.com/a', count: 3, status: 'active' },
    evidenceIds: ['E1'],
    ...overrides,
  };
}

function errorsOf(result: TableMutationResult): string[] {
  if (result.ok) throw new Error('expected the mutation to be rejected');
  return result.errors;
}

describe('createOutputTableStore', () => {
  it('creates a table lazily from its contract spec', () => {
    const table = store().table('roster');
    expect(table).toEqual({ outputId: 'roster', rows: [] });
  });

  it('refuses a table the contract never declared', () => {
    expect(() => store().table('nope')).toThrow(/no table output "nope"/);
  });
});

describe('upsertOutputRows', () => {
  it('inserts a valid row at version 1', () => {
    const s = store();
    const result = s.upsertOutputRows('roster', [row()]);

    expect(result).toEqual({ ok: true, created: ['r1'], updated: [], rowCount: 1 });
    expect(s.table('roster').rows[0]).toMatchObject({ rowId: 'r1', version: 1 });
  });

  it('updates an existing row and bumps its version', () => {
    const s = store();
    s.upsertOutputRows('roster', [row()]);
    const result = s.upsertOutputRows('roster', [row({ values: { ...row().values, name: 'Beta' } })]);

    expect(result).toEqual({ ok: true, created: [], updated: ['r1'], rowCount: 1 });
    expect(s.table('roster').rows[0]).toMatchObject({ version: 2 });
    expect(s.table('roster').rows[0]?.values.name).toBe('Beta');
  });

  it('makes NO partial change when any row in the batch is invalid', () => {
    const s = store();
    const result = s.upsertOutputRows('roster', [
      row({ rowId: 'good' }),
      row({ rowId: 'bad', values: { name: '', url: 'https://e.com/b', count: 1, status: 'active' } }),
    ]);

    expect(result.ok).toBe(false);
    // The valid row must not have been written either.
    expect(s.table('roster').rows).toEqual([]);
  });

  it('rejects an empty batch', () => {
    expect(errorsOf(store().upsertOutputRows('roster', []))).toEqual(['no rows supplied']);
  });

  it('rejects a duplicate rowId within one batch', () => {
    expect(
      errorsOf(store().upsertOutputRows('roster', [row(), row()])).join('\n'),
    ).toMatch(/appears twice/);
  });

  it('requires exactly the declared columns', () => {
    const s = store();
    expect(
      errorsOf(
        s.upsertOutputRows('roster', [
          row({ values: { name: 'A', url: 'https://e.com/a', count: 1 } as never }),
        ]),
      ).join('\n'),
    ).toMatch(/missing column "status"/);
    expect(
      errorsOf(
        s.upsertOutputRows('roster', [
          row({ values: { ...row().values, extra: 'x' } as never }),
        ]),
      ).join('\n'),
    ).toMatch(/undeclared column "extra"/);
  });

  it('validates value types per column', () => {
    const s = store();
    const bad = (values: Record<string, unknown>): string =>
      errorsOf(s.upsertOutputRows('roster', [row({ values: values as never })])).join('\n');

    expect(bad({ ...row().values, count: 1.5 })).toMatch(/must be an integer/);
    expect(bad({ ...row().values, url: 'not-a-url' })).toMatch(/not a valid URL/);
    expect(bad({ ...row().values, url: 'ftp://example.com/x' })).toMatch(/must be an http\(s\) URL/);
    expect(bad({ ...row().values, status: 'pledge' })).toMatch(/not one of the declared values/);
    expect(bad({ ...row().values, name: 42 })).toMatch(/must be a string/);
  });

  it('allows an empty optional column but not an empty required one', () => {
    const s = store();
    expect(
      s.upsertOutputRows('roster', [
        row({ values: { name: 'A', url: null, count: null, status: null } }),
      ]).ok,
    ).toBe(true);
    expect(
      errorsOf(
        s.upsertOutputRows('roster', [
          row({ rowId: 'r2', values: { name: null, url: null, count: null, status: null } }),
        ]),
      ).join('\n'),
    ).toMatch(/required but empty/);
  });

  it('rejects formula-leading strings rather than silently altering them', () => {
    const s = store();
    for (const dangerous of ['=SUM(A1:A9)', '+1', '-2', '@import']) {
      const errors = errorsOf(
        s.upsertOutputRows('roster', [row({ values: { ...row().values, name: dangerous } })]),
      ).join('\n');
      expect(errors).toMatch(/formula character/);
    }
    // Nothing was written, and the value was never rewritten behind the
    // model's back.
    expect(s.table('roster').rows).toEqual([]);
  });

  it('requires at least one existing evidence id per row', () => {
    const s = store();
    expect(
      errorsOf(s.upsertOutputRows('roster', [row({ evidenceIds: [] })])).join('\n'),
    ).toMatch(/cites no evidence/);
    expect(
      errorsOf(s.upsertOutputRows('roster', [row({ evidenceIds: ['E9'] })])).join('\n'),
    ).toMatch(/unknown evidence id "E9"/);
    expect(s.upsertOutputRows('roster', [row({ evidenceIds: ['E1', 'E2'] })]).ok).toBe(true);
  });

  it('reports a version conflict, changes nothing, and returns current versions', () => {
    const s = store();
    s.upsertOutputRows('roster', [row()]); // version 1

    const result = s.upsertOutputRows('roster', [
      row({ expectedVersion: 5, values: { ...row().values, name: 'Stale' } }),
    ]);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.currentVersions).toEqual({ r1: 1 });
    // Unchanged.
    expect(s.table('roster').rows[0]).toMatchObject({ version: 1 });
    expect(s.table('roster').rows[0]?.values.name).toBe('Alpha');
  });

  it('accepts a matching expectedVersion', () => {
    const s = store();
    s.upsertOutputRows('roster', [row()]);
    expect(s.upsertOutputRows('roster', [row({ expectedVersion: 1 })]).ok).toBe(true);
  });

  it('treats expectedVersion 0 as "must not exist yet"', () => {
    const s = store();
    expect(s.upsertOutputRows('roster', [row({ expectedVersion: 0 })]).ok).toBe(true);
    expect(s.upsertOutputRows('roster', [row({ expectedVersion: 0 })]).ok).toBe(false);
  });
});

describe('deleteOutputRows', () => {
  it('deletes known rows', () => {
    const s = store();
    s.upsertOutputRows('roster', [row(), row({ rowId: 'r2' })]);
    const result = s.deleteOutputRows('roster', ['r1']);

    expect(result).toMatchObject({ ok: true, rowCount: 1 });
    expect(s.table('roster').rows.map((r) => r.rowId)).toEqual(['r2']);
  });

  it('deletes nothing when any id is unknown', () => {
    const s = store();
    s.upsertOutputRows('roster', [row()]);
    expect(errorsOf(s.deleteOutputRows('roster', ['r1', 'ghost'])).join('\n')).toMatch(/ghost/);
    expect(s.table('roster').rows).toHaveLength(1);
  });

  it('rejects an empty id list', () => {
    expect(errorsOf(store().deleteOutputRows('roster', []))).toEqual(['no rowIds supplied']);
  });
});

describe('setTableCompleteness', () => {
  it('records a valid completeness proof', () => {
    const s = store();
    const result = s.setTableCompleteness('roster', {
      method: 'The directory header states the member count.',
      evidenceIds: ['E1'],
      statedTotal: 12,
    });

    expect(result.ok).toBe(true);
    expect(s.table('roster').completeness).toMatchObject({ statedTotal: 12 });
  });

  it('requires a method and at least one existing evidence id', () => {
    const s = store();
    expect(
      errorsOf(s.setTableCompleteness('roster', { method: '  ', evidenceIds: ['E1'] })).join('\n'),
    ).toMatch(/non-empty method/);
    expect(
      errorsOf(s.setTableCompleteness('roster', { method: 'counted', evidenceIds: [] })).join('\n'),
    ).toMatch(/at least one evidence id/);
    expect(
      errorsOf(
        s.setTableCompleteness('roster', { method: 'counted', evidenceIds: ['E9'] }),
      ).join('\n'),
    ).toMatch(/unknown evidence id "E9"/);
  });

  it('rejects a non-integer or negative statedTotal', () => {
    const s = store();
    for (const statedTotal of [-1, 2.5]) {
      expect(
        errorsOf(
          s.setTableCompleteness('roster', {
            method: 'counted',
            evidenceIds: ['E1'],
            statedTotal,
          }),
        ).join('\n'),
      ).toMatch(/statedTotal/);
    }
  });
});
