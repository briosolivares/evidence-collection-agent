import { z } from 'zod';

import type { OutputTableStore, TableMutationResult } from '../../outputs/outputTable.js';
import { formatOutputSummary, summarizeOutputs, type OutputSummaryDeps } from '../../outputs/outputSummary.js';
import type { ToolDef } from '../registry.js';

// The three row-level tools. They are grouped in one module because they
// share one contract with the model: propose typed rows, get back either a
// complete rejection naming every problem or the table's new derived state.
//
// INTEGRATION (primary agent, at cutover): build these with
// createOutputRowTools({ tables, summaryDeps }) where summaryDeps closes over
// the run's contract, table store, evidence store, and manifest readers, then
// append them to the V2 registry after set_output_contract. They are not
// registered here.

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
  expectedVersion: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe('Apply only if the stored row is at this version. 0 means "must not exist yet".'),
});

/** What every row tool returns to the model on success. */
export interface OutputRowsResult {
  outputId: string;
  created: string[];
  updated: string[];
  rowCount: number;
  /** The run's derived output state, so problems surface here rather than
   * costing a submission attempt. */
  outputState: string;
}

/** What the row tools need from the run. */
export interface OutputRowToolsDeps {
  tables: OutputTableStore;
  /** Rebuilt per call so a contract revision is reflected immediately. */
  summaryDeps: () => OutputSummaryDeps;
}

/** Turn a store result into either a thrown, fully-explained rejection or
 * the model-facing success payload. */
function settle(
  outputId: string,
  result: TableMutationResult,
  deps: OutputRowToolsDeps,
): OutputRowsResult {
  if (!result.ok) {
    const versions =
      result.currentVersions === undefined
        ? ''
        : `\nCurrent versions: ${JSON.stringify(result.currentVersions)}`;
    throw new Error(
      `No change was made. Fix all of these and call again:\n${result.errors
        .map((error) => `- ${error}`)
        .join('\n')}${versions}`,
    );
  }
  return {
    outputId,
    created: result.created,
    updated: result.updated,
    rowCount: result.rowCount,
    outputState: formatOutputSummary(summarizeOutputs(deps.summaryDeps())),
  };
}

/** Build the three row tools over one run's stores. */
export function createOutputRowTools(deps: OutputRowToolsDeps): ToolDef[] {
  const upsertOutputRowsTool: ToolDef<{ outputId: string; rows: z.infer<typeof rowInputSchema>[] }> = {
    name: 'upsert_output_rows',
    description:
      'Add or update rows of a table output. Supply typed values keyed by the contract\'s exact ' +
      'column names, plus the evidence ids proving each row. The whole batch is validated ' +
      'before anything changes: if any row is wrong, nothing is written and every problem is ' +
      'reported at once. Never write CSV or JSON text yourself — the runtime renders the file.',
    inputSchema: z.strictObject({
      outputId: z.string().min(1).describe('The table output these rows belong to.'),
      rows: z.array(rowInputSchema).min(1).describe('The rows to add or update.'),
    }),
    readOnly: false,
    execute: (input) => settle(input.outputId, deps.tables.upsertOutputRows(input.outputId, input.rows), deps),
  };

  const deleteOutputRowsTool: ToolDef<{ outputId: string; rowIds: string[] }> = {
    name: 'delete_output_rows',
    description:
      'Remove rows from a table output by their row ids. If any id is unknown, nothing is ' +
      'deleted and the unknown ids are reported.',
    inputSchema: z.strictObject({
      outputId: z.string().min(1),
      rowIds: z.array(z.string().min(1)).min(1),
    }),
    readOnly: false,
    execute: (input) =>
      settle(input.outputId, deps.tables.deleteOutputRows(input.outputId, input.rowIds), deps),
  };

  const setTableCompletenessTool: ToolDef<{
    outputId: string;
    method: string;
    evidenceIds: string[];
    statedTotal?: number;
    limitations?: string[];
  }> = {
    name: 'set_table_completeness',
    description:
      'Record how you established that a table lists its ENTIRE population — required for any ' +
      'table with an exact or minimum row-count rule. "I found 12 rows" and "there are exactly ' +
      '12" are different claims; this records evidence for the second. State the method, cite ' +
      'the evidence, and name anything the method could not settle.',
    inputSchema: z.strictObject({
      outputId: z.string().min(1),
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
    }),
    readOnly: false,
    execute: (input) =>
      settle(
        input.outputId,
        deps.tables.setTableCompleteness(input.outputId, {
          method: input.method,
          evidenceIds: input.evidenceIds,
          ...(input.statedTotal === undefined ? {} : { statedTotal: input.statedTotal }),
          ...(input.limitations === undefined ? {} : { limitations: input.limitations }),
        }),
        deps,
      ),
  };

  return [
    upsertOutputRowsTool as ToolDef,
    deleteOutputRowsTool as ToolDef,
    setTableCompletenessTool as ToolDef,
  ];
}
