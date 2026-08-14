import { readFileSync } from 'node:fs';
import { basename, dirname, extname } from 'node:path';

import type { OutputColumn, OutputSpec } from '../contracts/outputContract.js';
import { readManifest, SCRATCH_DIR, writeArtifact } from '../run/artifacts.js';
import { resolveRunPath } from '../run/runDir.js';

// Tabular output as a typed application concern rather than text the model
// hand-writes. The model proposes ROWS; code owns the file. That inversion
// is what makes the deliverable's shape trustworthy: columns, order,
// quoting, and formatting are derived from the contract, so a model that
// drifts mid-run cannot silently change the artifact's structure.
//
// There is exactly one way to mutate a table: `updateTable`, which applies
// any combination of an upsert, a delete, and a completeness record as one
// atomic call. Three properties this store guarantees, each tested directly:
//
//  1. Atomic batches. Every section supplied to a call is validated against
//     the pre-call state before any of them apply, so a bad section can
//     never leave a good section's change in place, and a partially-wrong
//     call leaves the table exactly as it was. A model retrying after an
//     error must never find half its previous attempt applied.
//  2. Evidence-linked facts. Every factual row must cite at least one
//     Evidence ID, and the store rejects IDs that do not exist. A row nobody
//     can trace to a source is exactly the kind of plausible fabrication the
//     whole architecture exists to prevent.
//  3. Optional durability. Without a `runDir` the store is exactly what it
//     always was: purely in-memory. With one, every successful mutation
//     writes that table's whole current state to
//     `scratch/tables/<outputId>.json`, so a resume can rebuild the same
//     rows via `restoreOutputTableStore` instead of starting the table over.
//     Rejected mutations write nothing — disk never records a row the store
//     refused.

/** Run-dir subdirectory holding one JSON snapshot per table, named
 * `<outputId>.json`. Private working state — under scratch/, so these
 * writes take no roles — but hashed into the manifest like every other
 * artifact, which is also how `restoreOutputTableStore` finds them again:
 * by asking the manifest, never by scanning the directory. */
export const SCRATCH_TABLES_DIR = `${SCRATCH_DIR}/tables`;

/** One row of a table output. Values are stored as the caller supplied
 * them; rendering (see renderTable.ts) formats them. */
export interface OutputRow {
  /** Stable caller-chosen identity, unique within the table. Re-upserting
   * the same rowId updates that row rather than adding another. */
  rowId: string;
  /** Column name → value. Keys must exactly match the contract's columns. */
  values: Record<string, string | number | boolean | null>;
  /** Evidence records supporting this row's facts; at least one. */
  evidenceIds: string[];
}

/** Proof that a count-ruled table enumerates its whole population. Required
 * because "I found 12 rows" and "there are exactly 12" are different claims,
 * and only the second satisfies an exact-count rule. */
export interface TableCompletenessEvidence {
  /** How the population was established, e.g. "the directory's own member
   * count, read from the page header". */
  method: string;
  /** Evidence records backing the method; at least one. */
  evidenceIds: string[];
  /** The population size the method establishes, when it yields a number. */
  statedTotal?: number;
  /** Anything the method could not settle, stated plainly. */
  limitations?: string[];
}

/** One table's live state. */
export interface OutputTable {
  /** The contract output this table satisfies. */
  outputId: string;
  /** Rows in insertion order; rendering re-reads the contract for columns. */
  rows: OutputRow[];
  /** Completeness proof, once supplied. */
  completeness?: TableCompletenessEvidence;
}

/** A rejected mutation: nothing changed, and every problem is named. */
export interface TableMutationRejected {
  ok: false;
  errors: [string, ...string[]];
}

/** One row as proposed by a caller. */
export interface OutputRowInput {
  rowId: string;
  values: Record<string, string | number | boolean | null>;
  evidenceIds: string[];
}

/** Any combination of the three mutation kinds, applied by `updateTable` as
 * one atomic call — see that method's doc for the atomicity mechanism. */
export interface TableUpdateSections {
  upsert?: { rows: readonly OutputRowInput[] };
  delete?: { rowIds: readonly string[] };
  completeness?: TableCompletenessEvidence;
}

/** An applied `updateTable` call. `deleted` is reported separately from
 * `updated` since a single call may do both. */
export interface TableUpdateApplied {
  ok: true;
  created: string[];
  updated: string[];
  deleted: string[];
  rowCount: number;
}

export type TableUpdateResult = TableUpdateApplied | TableMutationRejected;

/** The run's tables, created lazily from contract table specs. */
export interface OutputTableStore {
  /** The table for `outputId`, created empty on first use. Throws when the
   * contract has no table output with that id — writing rows into a table
   * nothing will publish is always a mistake. */
  table(outputId: string): OutputTable;
  /** Every table that has been touched, in creation order. */
  tables(): OutputTable[];
  /** Apply any combination of an upsert, a delete, and a completeness record
   * as ONE atomic call: every section supplied is validated against the
   * table's state before the call started, and only if every section is
   * valid does any of them apply. A bad delete alongside a good upsert
   * therefore leaves the table completely unchanged, not half-upserted. */
  updateTable(outputId: string, sections: TableUpdateSections): TableUpdateResult;
}

/** What the store needs from the run to validate rows. */
export interface OutputTableStoreDeps {
  /** The contract's table specs, looked up fresh so a contract revision is
   * reflected immediately. */
  tableSpec: (outputId: string) => Extract<OutputSpec, { kind: 'table' }> | undefined;
  /** Whether an Evidence ID exists in this run. Injected rather than
   * imported so the table store stays independent of the evidence store's
   * internals. */
  evidenceExists: (evidenceId: string) => boolean;
  /** Absolute path of the run directory. Absent (the default) keeps the
   * store exactly as it always was: purely in-memory, nothing written.
   * Given, every successful mutation persists that table's whole state to
   * `scratch/tables/<outputId>.json` (see SCRATCH_TABLES_DIR) — the
   * mechanism that lets a resumed run rebuild the same rows instead of
   * silently losing every one minted since the last submission. */
  runDir?: string;
}

/** Create the run's table store. */
export function createOutputTableStore(deps: OutputTableStoreDeps): OutputTableStore {
  const tables = new Map<string, OutputTable>();

  // Only called after a mutation already succeeded (see each mutation
  // method below) — a rejected call never reaches here, so disk can never
  // record a row the store refused. Whole-table snapshot, not a delta: a
  // delta log would need its own replay semantics that could disagree with
  // the store, where re-writing the live table can't.
  //
  // Suspended while `restoreOutputTableStore` replays a snapshot: those
  // writes would be pure waste, since each one rewrites the whole table AND
  // the manifest to arrive at bytes already on disk that replay is simply
  // reading back in.
  let replaying = false;

  const persist = (current: OutputTable): void => {
    if (deps.runDir === undefined || replaying) return;
    const json = `${JSON.stringify(current, null, 2)}\n`;
    writeArtifact(deps.runDir, `${SCRATCH_TABLES_DIR}/${current.outputId}.json`, Buffer.from(json, 'utf8'));
  };

  const requireSpec = (outputId: string): Extract<OutputSpec, { kind: 'table' }> => {
    const spec = deps.tableSpec(outputId);
    if (spec === undefined) {
      throw new Error(
        `no table output "${outputId}" in the contract — rows can only go to a declared table`,
      );
    }
    return spec;
  };

  const table = (outputId: string): OutputTable => {
    requireSpec(outputId);
    let existing = tables.get(outputId);
    if (existing === undefined) {
      existing = { outputId, rows: [] };
      tables.set(outputId, existing);
    }
    return existing;
  };

  // Each mutation kind below is split into a VALIDATE step (pure — reads
  // `current`, never writes it) and an APPLY step (mutates `current`,
  // assuming validation already passed). `updateTable` is what the split is
  // FOR: it runs every section's validate step against the same untouched
  // `current` before running any section's apply step, so a multi-section
  // call is atomic across sections, not just within one.

  const validateUpsert = (
    spec: Extract<OutputSpec, { kind: 'table' }>,
    rows: readonly OutputRowInput[],
  ): string[] => {
    if (rows.length === 0) return ['no rows supplied'];
    const errors: string[] = [];
    const seenIds = new Set<string>();
    for (const row of rows) {
      const label = `row "${row.rowId}"`;
      if (typeof row.rowId !== 'string' || row.rowId.trim() === '') {
        errors.push('every row needs a non-empty rowId');
        continue;
      }
      if (seenIds.has(row.rowId)) {
        errors.push(`${label} appears twice in one batch`);
      }
      seenIds.add(row.rowId);

      errors.push(...validateRowValues(spec, row, label));
      errors.push(...validateRowEvidence(deps, row, label));
    }
    return errors;
  };

  const applyUpsert = (
    current: OutputTable,
    rows: readonly OutputRowInput[],
  ): { created: string[]; updated: string[] } => {
    const created: string[] = [];
    const updated: string[] = [];
    for (const row of rows) {
      const index = current.rows.findIndex((candidate) => candidate.rowId === row.rowId);
      const stored: OutputRow = { rowId: row.rowId, values: { ...row.values }, evidenceIds: [...row.evidenceIds] };
      if (index >= 0) {
        current.rows[index] = stored;
        updated.push(row.rowId);
      } else {
        current.rows.push(stored);
        created.push(row.rowId);
      }
    }
    return { created, updated };
  };

  const validateDelete = (current: OutputTable, rowIds: readonly string[]): string[] => {
    if (rowIds.length === 0) return ['no rowIds supplied'];
    const missing = rowIds.filter((rowId) => !current.rows.some((row) => row.rowId === rowId));
    if (missing.length > 0) return [`unknown rowId(s): ${missing.join(', ')}`];
    return [];
  };

  const applyDelete = (current: OutputTable, rowIds: readonly string[]): string[] => {
    const removing = new Set(rowIds);
    current.rows = current.rows.filter((row) => !removing.has(row.rowId));
    return [...removing];
  };

  const validateCompleteness = (evidence: TableCompletenessEvidence): string[] => {
    const errors: string[] = [];
    if (typeof evidence.method !== 'string' || evidence.method.trim() === '') {
      errors.push('completeness evidence needs a non-empty method');
    }
    if (!Array.isArray(evidence.evidenceIds) || evidence.evidenceIds.length === 0) {
      errors.push('completeness evidence needs at least one evidence id');
    } else {
      for (const id of evidence.evidenceIds) {
        if (!deps.evidenceExists(id)) {
          errors.push(`completeness evidence cites unknown evidence id "${id}"`);
        }
      }
    }
    if (
      evidence.statedTotal !== undefined &&
      (!Number.isInteger(evidence.statedTotal) || evidence.statedTotal < 0)
    ) {
      errors.push(
        `completeness statedTotal must be a non-negative integer, got ${evidence.statedTotal}`,
      );
    }
    return errors;
  };

  const applyCompleteness = (current: OutputTable, evidence: TableCompletenessEvidence): void => {
    current.completeness = {
      method: evidence.method,
      evidenceIds: [...evidence.evidenceIds],
      ...(evidence.statedTotal !== undefined ? { statedTotal: evidence.statedTotal } : {}),
      ...(evidence.limitations !== undefined ? { limitations: [...evidence.limitations] } : {}),
    };
  };

  const store: OutputTableStore = {
    table,
    tables: () => [...tables.values()],

    updateTable(outputId, sections): TableUpdateResult {
      const spec = requireSpec(outputId);
      const current = table(outputId);

      // Validate every supplied section against `current` BEFORE applying
      // any of them. This — not "apply in order, roll back on failure" — is
      // what makes the call atomic across sections: nothing here mutates
      // `current`, so there is nothing to undo, and no intermediate state is
      // ever persisted to disk for a call that ultimately fails. A rollback
      // approach would need to re-apply (and re-persist) a compensating
      // mutation after the fact, which cannot undo a crash landing between
      // the failed section and the rollback; validating first has no such
      // window because the table is never touched until every section here
      // is already known-good.
      const errors: string[] = [];
      if (sections.upsert !== undefined) errors.push(...validateUpsert(spec, sections.upsert.rows));
      if (sections.delete !== undefined) errors.push(...validateDelete(current, sections.delete.rowIds));
      if (sections.completeness !== undefined) errors.push(...validateCompleteness(sections.completeness));
      if (errors.length > 0) return { ok: false, errors: errors as [string, ...string[]] };

      let created: string[] = [];
      let updated: string[] = [];
      let deleted: string[] = [];
      if (sections.upsert !== undefined) {
        ({ created, updated } = applyUpsert(current, sections.upsert.rows));
      }
      if (sections.delete !== undefined) {
        deleted = applyDelete(current, sections.delete.rowIds);
      }
      if (sections.completeness !== undefined) {
        applyCompleteness(current, sections.completeness);
      }
      // One persist for the whole call, not one per section — the snapshot
      // is the table's whole state regardless, so writing it three times
      // would just triplicate identical disk/manifest I/O.
      persist(current);
      return { ok: true, created, updated, deleted, rowCount: current.rows.length };
    },
  };

  replayRunners.set(store, (replay) => {
    replaying = true;
    try {
      replay();
    } finally {
      replaying = false;
    }
  });

  return store;
}

/**
 * How `restoreOutputTableStore` borrows a store's private replay mode.
 *
 * A WeakMap keyed on the store rather than a method on `OutputTableStore`,
 * following `captureRunBudgetSnapshot`'s precedent in `run/runBudget.ts`:
 * suspending persistence is the restore path's business alone, and putting it
 * on the interface would offer every caller — including the model's tools — a
 * way to mutate rows without recording them.
 */
const replayRunners = new WeakMap<OutputTableStore, (replay: () => void) => void>();

/**
 * Rebuild a table store from the snapshots a prior instance of it persisted
 * (see `OutputTableStoreDeps.runDir`), for resuming a run from a checkpoint.
 *
 * Snapshots are found through the manifest — the run's authority on which
 * files are real — never by scanning `scratch/tables/` directly. Each one is
 * replayed through the store's own public mutation path, `updateTable`: the
 * restored store is therefore incapable of holding a row the live store
 * would have rejected. Each snapshot's rows carry only their final values
 * already — a snapshot is the table's whole current state, not a change
 * log — so one `updateTable` call per table reproduces it exactly, and that
 * call goes through the same validation as a live call, so a row a live
 * store would reject fails the same way on restore.
 *
 * @param deps - same as {@link createOutputTableStore}, but `runDir` is
 *   required: restoring only makes sense against a run directory that has
 *   snapshots to read, and the restored store keeps persisting to it as
 *   mutations continue after resume
 * @returns a store whose `tables()` reflects every snapshot found, restored
 *   in a deterministic order (sorted by outputId) so two resumes of the same
 *   run behave identically
 * @throws if a snapshot no longer validates — e.g. the contract was revised
 *   between the checkpoint and the resume — naming the offending outputId
 *   and the specific validation failures. Quietly dropping such a row would
 *   reproduce the exact bug this mechanism exists to close.
 */
export function restoreOutputTableStore(
  deps: OutputTableStoreDeps & { runDir: string },
): OutputTableStore {
  const store = createOutputTableStore(deps);
  const manifest = readManifest(deps.runDir);

  const snapshots = manifest.artifacts
    .filter(
      (entry) => dirname(entry.filename) === SCRATCH_TABLES_DIR && extname(entry.filename) === '.json',
    )
    .map((entry) => ({ outputId: basename(entry.filename, '.json'), filename: entry.filename }))
    .sort((a, b) => a.outputId.localeCompare(b.outputId));

  // Replay writes nothing back: the snapshots being read ARE the persisted
  // state, so re-persisting after every row applied during replay would
  // rewrite the manifest once per row to reproduce bytes already on disk.
  const runReplay = replayRunners.get(store);
  if (runReplay === undefined) {
    throw new Error('output table store was not built by createOutputTableStore');
  }
  runReplay(() => {
    for (const { outputId, filename } of snapshots) {
      const raw = readFileSync(resolveRunPath(deps.runDir, filename), 'utf8');
      const snapshot = JSON.parse(raw) as OutputTable;
      replaySnapshot(store, outputId, snapshot);
    }
  });

  return store;
}

/** Replay one table's snapshot into `store` through its public mutation
 * path, `updateTable`, only — see {@link restoreOutputTableStore}. A
 * snapshot's rows are already deduplicated to their final values (it is the
 * table's whole state, not a change log), so one call reproduces the whole
 * table; an empty `rows` array is omitted rather than sent as an upsert
 * section, since an upsert of zero rows is itself a validation error. */
function replaySnapshot(store: OutputTableStore, outputId: string, snapshot: OutputTable): void {
  const sections: TableUpdateSections = {};
  if (snapshot.rows.length > 0) {
    sections.upsert = {
      rows: snapshot.rows.map(
        (row): OutputRowInput => ({
          rowId: row.rowId,
          values: row.values,
          evidenceIds: row.evidenceIds,
        }),
      ),
    };
  }
  if (snapshot.completeness !== undefined) {
    sections.completeness = snapshot.completeness;
  }
  if (sections.upsert === undefined && sections.completeness === undefined) return;

  const result = store.updateTable(outputId, sections);
  if (!result.ok) {
    throw new Error(
      `cannot restore output table "${outputId}": snapshot no longer validates — ` +
        result.errors.join('; '),
    );
  }
}

/** Values must match the contract's columns exactly — no extras, no
 * missing keys, and each value legal for its declared type. */
function validateRowValues(
  spec: Extract<OutputSpec, { kind: 'table' }>,
  row: OutputRowInput,
  label: string,
): string[] {
  const errors: string[] = [];
  if (typeof row.values !== 'object' || row.values === null || Array.isArray(row.values)) {
    return [`${label} needs a values object keyed by column name`];
  }
  const declared = new Set(spec.columns.map((column) => column.name));
  for (const key of Object.keys(row.values)) {
    if (!declared.has(key)) {
      errors.push(`${label} has undeclared column "${key}"`);
    }
  }
  for (const column of spec.columns) {
    if (!(column.name in row.values)) {
      errors.push(`${label} is missing column "${column.name}"`);
      continue;
    }
    errors.push(...validateValue(column, row.values[column.name]!, label));
  }
  return errors;
}

/** One value against its column's declared type. */
function validateValue(
  column: OutputColumn,
  value: string | number | boolean | null,
  label: string,
): string[] {
  const where = `${label} column "${column.name}"`;
  const blank = value === null || (typeof value === 'string' && value.trim() === '');
  if (blank) {
    // A required column may not be blank; an optional one may.
    return column.required ? [`${where} is required but empty`] : [];
  }

  switch (column.type) {
    case 'string':
      if (typeof value !== 'string') return [`${where} must be a string`];
      // A leading =, +, -, or @ makes spreadsheet software execute the cell.
      // Rejected rather than silently prefixed: quietly altering a requested
      // value would change the deliverable's data (see renderTable.ts).
      if (/^[=+\-@\t\r]/.test(value)) {
        return [
          `${where} starts with a formula character (${JSON.stringify(value[0])}). ` +
            'Spreadsheet software would execute it. Supply the value without that leading ' +
            'character, or state the requirement differently.',
        ];
      }
      return [];
    case 'integer':
      if (typeof value !== 'number' || !Number.isInteger(value)) {
        return [`${where} must be an integer`];
      }
      return [];
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        return [`${where} must be a finite number`];
      }
      return [];
    case 'boolean':
      if (typeof value !== 'boolean') return [`${where} must be a boolean`];
      return [];
    case 'url': {
      if (typeof value !== 'string') return [`${where} must be a URL string`];
      try {
        const protocol = new URL(value).protocol;
        if (protocol !== 'http:' && protocol !== 'https:') {
          return [`${where} must be an http(s) URL, got ${protocol}`];
        }
      } catch {
        return [`${where} is not a valid URL: ${JSON.stringify(value)}`];
      }
      return [];
    }
    case 'enum': {
      if (typeof value !== 'string') return [`${where} must be one of the declared values`];
      if (!column.values.includes(value)) {
        return [
          `${where} value ${JSON.stringify(value)} is not one of the declared values ` +
            `[${column.values.join(', ')}]`,
        ];
      }
      return [];
    }
    case 'date':
    case 'datetime': {
      if (typeof value !== 'string') return [`${where} must be a date string`];
      if (Number.isNaN(Date.parse(value))) {
        return [`${where} is not a parseable date: ${JSON.stringify(value)}`];
      }
      return [];
    }
  }
}

/** Every factual row must cite existing evidence. */
function validateRowEvidence(
  deps: OutputTableStoreDeps,
  row: OutputRowInput,
  label: string,
): string[] {
  if (!Array.isArray(row.evidenceIds) || row.evidenceIds.length === 0) {
    return [
      `${label} cites no evidence. Every factual row needs at least one evidence id — ` +
        'a row nobody can trace to a source is unproven.',
    ];
  }
  const errors: string[] = [];
  for (const id of row.evidenceIds) {
    if (!deps.evidenceExists(id)) {
      errors.push(`${label} cites unknown evidence id "${id}"`);
    }
  }
  return errors;
}
