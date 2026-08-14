import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { OutputSpec } from '../../contracts/outputContract.js';
import { createOutputTableStore, type OutputTableStore } from '../../outputs/outputTable.js';
import type { OutputSummaryDeps } from '../../outputs/outputSummary.js';
import { initManifest } from '../../run/artifacts.js';
import { executeToolCall } from '../pipeline.js';
import { accessesConflict, accessKey, createRegistry, type ToolCtx, type ToolDef } from '../registry.js';
import { createOutputRowTools } from './updateTable.js';

// Driven through executeToolCall — the same pipeline production uses — so
// schema validation and result shaping are exercised exactly as the model
// would experience them. getAccess is exercised both directly (the exact
// keys it declares) and through accessesConflict (the behaviour those keys
// produce), since the whole point of adding it is a scheduling change, not
// a functional one.

const ROSTER: Extract<OutputSpec, { kind: 'table' }> = {
  id: 'roster',
  kind: 'table',
  filename: 'roster.csv',
  format: 'csv',
  columns: [{ name: 'name', required: true, type: 'string' }],
  rules: [],
} as Extract<OutputSpec, { kind: 'table' }>;

const SPONSORS: Extract<OutputSpec, { kind: 'table' }> = {
  id: 'sponsors',
  kind: 'table',
  filename: 'sponsors.csv',
  format: 'csv',
  columns: [{ name: 'name', required: true, type: 'string' }],
  rules: [],
} as Extract<OutputSpec, { kind: 'table' }>;

const TABLE_SPECS: Record<string, Extract<OutputSpec, { kind: 'table' }>> = {
  [ROSTER.id]: ROSTER,
  [SPONSORS.id]: SPONSORS,
};

/** Evidence E1 exists; everything else does not. */
const EVIDENCE = new Set(['E1']);

let runDir: string;
let tables: OutputTableStore;

function summaryDeps(): OutputSummaryDeps {
  return {
    contract: { outputs: [ROSTER, SPONSORS] },
    tables,
    evidenceExists: (id) => EVIDENCE.has(id),
    publishedExists: () => false,
    captureCount: () => 0,
  };
}

let registry: ReturnType<typeof createRegistry>;

beforeEach(() => {
  runDir = mkdtempSync(join(tmpdir(), 'update-table-test-'));
  initManifest(runDir, 'Publish the roster.');
  tables = createOutputTableStore({
    tableSpec: (outputId) => TABLE_SPECS[outputId],
    evidenceExists: (id) => EVIDENCE.has(id),
    runDir,
  });
  registry = createRegistry(createOutputRowTools({ tables, summaryDeps }));
});

afterEach(() => {
  rmSync(runDir, { recursive: true, force: true });
});

function call(name: string, input: unknown, ctx: Partial<ToolCtx> = {}) {
  return executeToolCall(registry, { id: `call-${name}`, name, input }, { runDir, ...ctx });
}

function tool(name: string): ToolDef {
  const found = registry.get(name);
  if (found === undefined) throw new Error(`no tool named ${name}`);
  return found;
}

describe('update_table: behaviour', () => {
  it('an upsert section adds a row and reports the derived output state', async () => {
    const result = await call('update_table', {
      outputId: 'roster',
      upsert: { rows: [{ rowId: 'r1', values: { name: 'Alpha' }, evidenceIds: ['E1'] }] },
    });

    expect(result.isError).toBe(false);
    const payload = JSON.parse(result.content) as { created: string[]; rowCount: number };
    expect(payload.created).toEqual(['r1']);
    expect(payload.rowCount).toBe(1);
  });

  it('rejects an unproven row and writes nothing', async () => {
    const result = await call('update_table', {
      outputId: 'roster',
      upsert: { rows: [{ rowId: 'r1', values: { name: 'Alpha' }, evidenceIds: [] }] },
    });

    expect(result.isError).toBe(true);
    expect(tables.table('roster').rows).toHaveLength(0);
  });

  it('a delete section removes a row an earlier call added', async () => {
    await call('update_table', {
      outputId: 'roster',
      upsert: { rows: [{ rowId: 'r1', values: { name: 'Alpha' }, evidenceIds: ['E1'] }] },
    });

    const result = await call('update_table', { outputId: 'roster', delete: { rowIds: ['r1'] } });
    expect(result.isError).toBe(false);
    const payload = JSON.parse(result.content) as { deleted: string[] };
    expect(payload.deleted).toEqual(['r1']);
    expect(tables.table('roster').rows).toHaveLength(0);
  });

  it('a completeness section records the completeness proof', async () => {
    const result = await call('update_table', {
      outputId: 'roster',
      completeness: {
        method: 'the directory header states the count',
        evidenceIds: ['E1'],
        statedTotal: 1,
      },
    });

    expect(result.isError).toBe(false);
    expect(tables.table('roster').completeness).toMatchObject({ method: expect.any(String) });
  });

  it('a combined call applies an upsert and a completeness section together', async () => {
    const result = await call('update_table', {
      outputId: 'roster',
      upsert: { rows: [{ rowId: 'r1', values: { name: 'Alpha' }, evidenceIds: ['E1'] }] },
      completeness: { method: 'counted at the door', evidenceIds: ['E1'], statedTotal: 1 },
    });

    expect(result.isError).toBe(false);
    const payload = JSON.parse(result.content) as { created: string[]; rowCount: number };
    expect(payload.created).toEqual(['r1']);
    expect(payload.rowCount).toBe(1);
    expect(tables.table('roster').rows).toHaveLength(1);
    expect(tables.table('roster').completeness).toMatchObject({ statedTotal: 1 });
  });

  it('rejects a call with none of upsert, delete, or completeness', async () => {
    const result = await call('update_table', { outputId: 'roster' });

    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/at least one of upsert, delete, or completeness/);
  });

  it('a bad delete section leaves a good upsert section unapplied — atomic across sections', async () => {
    const result = await call('update_table', {
      outputId: 'roster',
      upsert: { rows: [{ rowId: 'r1', values: { name: 'Alpha' }, evidenceIds: ['E1'] }] },
      delete: { rowIds: ['ghost'] },
    });

    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/unknown rowId\(s\): ghost/);
    // The upsert must not have taken effect either — the whole call is one
    // atomic unit, not "apply in order, stop on first error".
    expect(tables.table('roster').rows).toHaveLength(0);
  });
});

describe('update_table: getAccess', () => {
  it('declares table:<outputId> and manifest() as writes, and reads nothing', () => {
    expect(tool('update_table').getAccess({ outputId: 'roster' })).toEqual({
      reads: [],
      writes: [accessKey.table('roster'), accessKey.manifest()],
    });
  });

  it('two calls on DIFFERENT outputIds still conflict, because both persist through the shared manifest', () => {
    // This is not a missed optimization: OutputTableStore's persist() writes
    // the mutated table through writeArtifact, which reads-then-rewrites
    // the run's single manifest.json — the same reason write_file/
    // edit_file/screenshot/download all declare manifest() too. Two
    // concurrent mutations, even to different tables, race that one file.
    const left = tool('update_table').getAccess({ outputId: 'roster' });
    const right = tool('update_table').getAccess({ outputId: 'sponsors' });
    expect(accessesConflict(left, right)).toBe(true);
  });

  it('does not conflict with an unrelated tool call that touches neither a table nor the manifest', () => {
    // The behavioural difference the getAccess declaration is FOR: before,
    // this fell back to full EXCLUSIVE_ACCESS and would have conflicted
    // with literally everything, including a browser action on a page this
    // tool never touches.
    const tableAccess = tool('update_table').getAccess({ outputId: 'roster' });
    const unrelated = { reads: [], writes: [accessKey.page('p1'), accessKey.observation('p1')] };
    expect(accessesConflict(tableAccess, unrelated)).toBe(false);
  });
});
