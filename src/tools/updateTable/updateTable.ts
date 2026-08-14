import { z } from 'zod';

import type { OutputTableStore, TableUpdateResult } from '../../outputs/outputTable.js';
import { formatOutputSummary, summarizeOutputs, type OutputSummaryDeps } from '../../outputs/outputSummary.js';
import { accessKey, type ToolDef } from '../registry.js';

// One tool for every typed-table mutation. It used to be three
// (upsert_output_rows, delete_output_rows, set_table_completeness); they
// shared one contract with the model — propose typed data, get back either a
// complete rejection naming every problem or the table's new derived state —
// so they are now one call that accepts any combination of the three
// sections. A single research step often needs more than one of these (e.g.
// upsert the rows it just found AND record completeness in the same turn);
// giving it three round trips for that bought nothing.
//
// Run-scoped, so it is a factory: `runTask` builds it with the run's table
// store and a `summaryDeps` closure over the contract, evidence store, and
// manifest readers, and registers it at its frozen position.

const rowValueSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);

const rowInputSchema = z.strictObject({
  rowId: z
    .string()
    .min(1)
    .describe('Stable id for this row. Re-using it updates that row instead of adding another.'),
  values: z
    .record(z.string(), rowValueSchema)
    .describe('One entry per contract column, keyed by the exact column name.'),
  evidenceIds: z
    .array(z.string().min(1))
    .min(1)
    .describe('Evidence records proving this row. At least one; an unproven row is rejected.'),
});

const upsertSectionSchema = z
  .strictObject({
    rows: z.array(rowInputSchema).min(1).describe('The rows to add or update.'),
  })
  .describe(
    'Add or update rows of this table output. Supply typed values keyed by the contract\'s ' +
      'exact column names, plus the evidence ids proving each row. Never write CSV or JSON ' +
      'text yourself — the runtime renders the file.',
  );

const deleteSectionSchema = z
  .strictObject({
    rowIds: z.array(z.string().min(1)).min(1),
  })
  .describe(
    'Remove rows from this table output by their row ids. If any id is unknown, nothing in ' +
      'this call is applied and the unknown ids are reported.',
  );

const completenessSectionSchema = z
  .strictObject({
    method: z
      .string()
      .min(1)
      .describe('How the population was established, e.g. "the directory header states 12 members".'),
    evidenceIds: z.array(z.string().min(1)).min(1),
    statedTotal: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe('The population size the method establishes, when it yields a number.'),
    limitations: z
      .array(z.string().min(1))
      .optional()
      .describe('Anything the method could not settle, stated plainly.'),
  })
  .describe(
    'Record how you established that this table lists its ENTIRE population — required for ' +
      'any table with an exact or minimum row-count rule. "I found 12 rows" and "there are ' +
      'exactly 12" are different claims; this records evidence for the second. State the ' +
      'method, cite the evidence, and name anything the method could not settle.',
  );

const updateTableInputSchema = z
  .strictObject({
    outputId: z.string().min(1).describe('The table output these rows belong to.'),
    upsert: upsertSectionSchema.optional(),
    delete: deleteSectionSchema.optional(),
    completeness: completenessSectionSchema.optional(),
  })
  .refine(
    (input) => input.upsert !== undefined || input.delete !== undefined || input.completeness !== undefined,
    {
      message:
        'supply at least one of upsert, delete, or completeness — a call with none of them ' +
        'changes nothing',
    },
  );

export type UpdateTableInput = z.infer<typeof updateTableInputSchema>;

/** What the tool returns to the model on success. */
export interface UpdateTableResult {
  outputId: string;
  created: string[];
  updated: string[];
  deleted: string[];
  rowCount: number;
  /** The run's derived output state, so problems surface here rather than
   * costing a submission attempt. */
  outputState: string;
}

/** What the tool needs from the run. */
export interface OutputRowToolsDeps {
  tables: OutputTableStore;
  /** Rebuilt per call so a contract revision is reflected immediately. */
  summaryDeps: () => OutputSummaryDeps;
}

/** Turn a store result into either a thrown, fully-explained rejection or
 * the model-facing success payload. */
function settle(outputId: string, result: TableUpdateResult, deps: OutputRowToolsDeps): UpdateTableResult {
  if (!result.ok) {
    throw new Error(
      `No change was made. Fix all of these and call again:\n${result.errors
        .map((error) => `- ${error}`)
        .join('\n')}`,
    );
  }
  return {
    outputId,
    created: result.created,
    updated: result.updated,
    deleted: result.deleted,
    rowCount: result.rowCount,
    outputState: formatOutputSummary(summarizeOutputs(deps.summaryDeps())),
  };
}

/**
 * Access for one table mutation: `table:<outputId>` is the key
 * `accessKey.table` exists for (see registry.ts), so two calls mutating the
 * SAME output's rows serialize while calls to different outputs run in
 * parallel instead of falling back to full EXCLUSIVE_ACCESS. `manifest()`
 * is also a write because a successful mutation persists the table's whole
 * state through `writeArtifact` (see OutputTableStore's `persist`), which
 * reads-then-rewrites the run's shared manifest.json — the same reason
 * write_file/edit_file/screenshot/download all declare it too. That means
 * two mutations on DIFFERENT tables still serialize with each other (both
 * write manifest()), but no longer serialize against unrelated tools like
 * browser actions or bash that never touch a table or the manifest.
 */
function tableAccess(outputId: string): { reads: string[]; writes: string[] } {
  return { reads: [], writes: [accessKey.table(outputId), accessKey.manifest()] };
}

/** Build the typed-table tool over one run's stores. Still named/shaped for
 * the three-tool era (see runTask.ts, which constructs it) — a rename is a
 * follow-up outside this change's scope. */
export function createOutputRowTools(deps: OutputRowToolsDeps): ToolDef[] {
  const updateTableTool: ToolDef<UpdateTableInput> = {
    name: 'update_table',
    description:
      'Add rows, update rows, delete rows, and/or record a table output\'s completeness proof ' +
      '— any combination in one call. Supply typed values keyed by the contract\'s exact column ' +
      'names, plus the evidence ids proving each row. The whole call is validated before ' +
      'anything changes: if any part of any section is wrong, nothing is written and every ' +
      'problem across every section is reported at once. Never write CSV or JSON text yourself ' +
      '— the runtime renders the file.',
    inputSchema: updateTableInputSchema,
    getAccess: (input) => tableAccess(input.outputId),
    execute: (input) => {
      const sections = {
        ...(input.upsert === undefined ? {} : { upsert: { rows: input.upsert.rows } }),
        ...(input.delete === undefined ? {} : { delete: { rowIds: input.delete.rowIds } }),
        ...(input.completeness === undefined ? {} : { completeness: input.completeness }),
      };
      return settle(input.outputId, deps.tables.updateTable(input.outputId, sections), deps);
    },
  };

  return [updateTableTool as ToolDef];
}
