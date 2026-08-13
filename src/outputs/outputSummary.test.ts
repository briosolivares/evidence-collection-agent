import { describe, expect, it } from 'vitest';

import type { OutputContract, OutputSpec } from '../contracts/outputContract.js';
import { createOutputTableStore, type OutputTableStore } from './outputTable.js';
import { formatOutputSummary, summarizeOutputs, type OutputSummaryDeps } from './outputSummary.js';

// The summary must be DERIVED, never asserted: every number here is computed
// from the contract plus live table state, so it cannot claim a row count the
// table does not have.

const EVIDENCE = new Set(['E1']);

function tableSpec(overrides: Record<string, unknown> = {}): OutputSpec {
  return {
    id: 'roster',
    kind: 'table',
    filename: 'roster.csv',
    format: 'csv',
    columns: [{ name: 'name', required: true, type: 'string' }],
    rules: [],
    ...overrides,
  } as OutputSpec;
}

function deps(
  outputs: OutputSpec[],
  tables: OutputTableStore,
  overrides: Partial<OutputSummaryDeps> = {},
): OutputSummaryDeps {
  return {
    contract: { outputs } as OutputContract,
    tables,
    evidenceExists: (id) => EVIDENCE.has(id),
    publishedExists: () => false,
    captureCount: () => 0,
    ...overrides,
  };
}

function storeFor(outputs: OutputSpec[]): OutputTableStore {
  return createOutputTableStore({
    tableSpec: (id) =>
      outputs.find((o) => o.kind === 'table' && o.id === id) as never,
    evidenceExists: (id) => EVIDENCE.has(id),
  });
}

describe('summarizeOutputs', () => {
  it('reports a live row count and readiness for a satisfied table', () => {
    const outputs = [tableSpec()];
    const tables = storeFor(outputs);
    tables.upsertOutputRows('roster', [
      { rowId: 'r1', values: { name: 'Alpha' }, evidenceIds: ['E1'] },
    ]);

    const summary = summarizeOutputs(deps(outputs, tables));
    expect(summary.tables[0]).toMatchObject({ outputId: 'roster', rowCount: 1 });
    expect(summary.readyForSubmission).toBe(true);
    expect(summary.blockers).toEqual([]);
  });

  it('surfaces a row-count rule failure before a submission is spent', () => {
    const outputs = [tableSpec({ rules: [{ type: 'exact_row_count', value: 3 }] })];
    const tables = storeFor(outputs);
    tables.upsertOutputRows('roster', [
      { rowId: 'r1', values: { name: 'Alpha' }, evidenceIds: ['E1'] },
    ]);

    const summary = summarizeOutputs(deps(outputs, tables));
    expect(summary.readyForSubmission).toBe(false);
    expect(summary.blockers.join('\n')).toMatch(/requires exactly 3/);
  });

  it('requires completeness evidence for a count-ruled table', () => {
    const outputs = [tableSpec({ rules: [{ type: 'minimum_row_count', value: 1 }] })];
    const tables = storeFor(outputs);
    tables.upsertOutputRows('roster', [
      { rowId: 'r1', values: { name: 'Alpha' }, evidenceIds: ['E1'] },
    ]);

    let summary = summarizeOutputs(deps(outputs, tables));
    expect(summary.tables[0]?.completenessRequired).toBe(true);
    expect(summary.tables[0]?.completenessProvided).toBe(false);
    expect(summary.blockers.join('\n')).toMatch(/completeness evidence/);

    tables.setTableCompleteness('roster', { method: 'header count', evidenceIds: ['E1'] });
    summary = summarizeOutputs(deps(outputs, tables));
    expect(summary.readyForSubmission).toBe(true);
  });

  it('does not require completeness evidence for an unruled table', () => {
    const outputs = [tableSpec()];
    const tables = storeFor(outputs);
    expect(summarizeOutputs(deps(outputs, tables)).tables[0]?.completenessRequired).toBe(false);
  });

  it('reports evidence that stopped resolving', () => {
    const outputs = [tableSpec()];
    const tables = storeFor(outputs);
    tables.upsertOutputRows('roster', [
      { rowId: 'r1', values: { name: 'Alpha' }, evidenceIds: ['E1'] },
    ]);
    // The evidence disappears from under the row.
    const summary = summarizeOutputs(deps(outputs, tables, { evidenceExists: () => false }));
    expect(summary.tables[0]?.danglingEvidenceIds).toEqual(['E1']);
    expect(summary.blockers.join('\n')).toMatch(/no longer resolves/);
  });

  it('reports unmet document and capture requirements', () => {
    const outputs = [
      { id: 'report', kind: 'document', filename: 'report.md', format: 'markdown' } as OutputSpec,
      { id: 'shots', kind: 'screenshots', count: { exact: 2 } } as OutputSpec,
    ];
    const tables = storeFor(outputs);
    const summary = summarizeOutputs(deps(outputs, tables, { captureCount: () => 1 }));

    expect(summary.readyForSubmission).toBe(false);
    expect(summary.blockers.join('\n')).toMatch(/report\.md has not been written/);
    expect(summary.blockers.join('\n')).toMatch(/1 of exactly 2 screenshots/);
  });

  it('marks satisfied documents and captures', () => {
    const outputs = [
      { id: 'report', kind: 'document', filename: 'report.md', format: 'markdown' } as OutputSpec,
      { id: 'shots', kind: 'screenshots', count: { minimum: 1 } } as OutputSpec,
    ];
    const tables = storeFor(outputs);
    const summary = summarizeOutputs(
      deps(outputs, tables, { publishedExists: () => true, captureCount: () => 3 }),
    );
    expect(summary.readyForSubmission).toBe(true);
    expect(summary.others.every((other) => other.satisfied)).toBe(true);
  });
});

describe('formatOutputSummary', () => {
  it('renders row counts, completeness state, and outstanding work', () => {
    const outputs = [tableSpec({ rules: [{ type: 'exact_row_count', value: 2 }] })];
    const tables = storeFor(outputs);
    tables.upsertOutputRows('roster', [
      { rowId: 'r1', values: { name: 'Alpha' }, evidenceIds: ['E1'] },
    ]);
    const text = formatOutputSummary(summarizeOutputs(deps(outputs, tables)));

    expect(text).toContain('roster (roster.csv): 1 rows');
    expect(text).toContain('completeness evidence MISSING');
    expect(text).toContain('Outstanding:');
  });

  it('says so plainly when everything passes', () => {
    const outputs = [tableSpec()];
    const tables = storeFor(outputs);
    expect(formatOutputSummary(summarizeOutputs(deps(outputs, tables)))).toContain(
      'Every automated check currently passes.',
    );
  });
});
