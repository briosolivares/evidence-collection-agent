import type { OutputContract, OutputSpec } from '../contracts/outputContract.js';
import { validateTableRules, type CompletionFailure } from '../completion/completionCheck.js';
import type { OutputTable, OutputTableStore } from './outputTable.js';

// What the worker is shown about its own progress. Derived, never
// model-maintained: there is no notes tool and no second progress database
// to drift out of sync with reality. Everything here is computed from the
// contract plus the live table state, so the summary cannot claim a row
// count the table does not have.
//
// Its purpose is to move discovery of a problem EARLIER. Without it, a
// worker learns that its table is two rows short only by spending a
// submission; with it, the same fact is visible in the result of the upsert
// that fell short.

/** One table output's live state against its contract requirements. */
export interface OutputTableSummary {
  outputId: string;
  filename: string;
  format: string;
  /** Rows currently stored. */
  rowCount: number;
  /** Rule violations that would fail the code check right now. */
  ruleFailures: string[];
  /** True when the contract's rules require completeness proof. */
  completenessRequired: boolean;
  /** True when that proof has been supplied. */
  completenessProvided: boolean;
  /** Evidence ids cited by rows that no longer resolve. */
  danglingEvidenceIds: string[];
}

/** One non-table output's state. */
export interface OutputArtifactSummary {
  outputId: string;
  kind: OutputSpec['kind'];
  /** What the contract asks for, in one short phrase. */
  requirement: string;
  /** Whether the run has produced it, as far as code can tell. */
  satisfied: boolean;
}

/** The whole run's derived output state. */
export interface OutputSummary {
  tables: OutputTableSummary[];
  others: OutputArtifactSummary[];
  /** True when nothing code can check is currently wrong. A submission is
   * still the only thing that starts verification — this is a preview, not
   * a promise. */
  readyForSubmission: boolean;
  /** Everything currently wrong, in contract order. */
  blockers: string[];
}

/** What summarizing needs from the run. */
export interface OutputSummaryDeps {
  contract: OutputContract;
  tables: OutputTableStore;
  /** Whether an Evidence ID still resolves. */
  evidenceExists: (evidenceId: string) => boolean;
  /** Whether a published output file exists, for non-table outputs. */
  publishedExists: (filename: string) => boolean;
  /** How many published captures match a screenshots/download output. */
  captureCount: (output: Extract<OutputSpec, { kind: 'screenshots' | 'download' }>) => number;
}

/**
 * Derive the run's current output state.
 *
 * @returns the summary (see OutputSummary). Pure: it reads state and
 *   computes, never mutating a table or writing a file
 */
export function summarizeOutputs(deps: OutputSummaryDeps): OutputSummary {
  const tables: OutputTableSummary[] = [];
  const others: OutputArtifactSummary[] = [];
  const blockers: string[] = [];

  for (const output of deps.contract.outputs) {
    if (output.kind === 'table') {
      const table = deps.tables.table(output.id);
      const summary = summarizeTable(output, table, deps.evidenceExists);
      tables.push(summary);
      for (const failure of summary.ruleFailures) {
        blockers.push(`${output.id}: ${failure}`);
      }
      if (summary.completenessRequired && !summary.completenessProvided) {
        blockers.push(
          `${output.id}: this table declares a row-count rule, so it needs completeness ` +
            "evidence (update_table's completeness section) proving the population it enumerates.",
        );
      }
      if (summary.danglingEvidenceIds.length > 0) {
        blockers.push(
          `${output.id}: rows cite evidence that no longer resolves: ` +
            `${summary.danglingEvidenceIds.join(', ')}.`,
        );
      }
      continue;
    }

    if (output.kind === 'document') {
      const satisfied = deps.publishedExists(output.filename);
      others.push({
        outputId: output.id,
        kind: output.kind,
        requirement: `document ${output.filename} (${output.format})`,
        satisfied,
      });
      if (!satisfied) blockers.push(`${output.id}: ${output.filename} has not been written yet.`);
      continue;
    }

    const count = deps.captureCount(output);
    const required = 'exact' in output.count ? output.count.exact : output.count.minimum;
    const satisfied = 'exact' in output.count ? count === required : count >= required;
    const phrase = 'exact' in output.count ? `exactly ${required}` : `at least ${required}`;
    others.push({
      outputId: output.id,
      kind: output.kind,
      requirement: `${phrase} ${output.kind}`,
      satisfied,
    });
    if (!satisfied) {
      blockers.push(`${output.id}: ${count} of ${phrase} ${output.kind} published so far.`);
    }
  }

  return { tables, others, readyForSubmission: blockers.length === 0, blockers };
}

/** One table's live state, including the rule failures a submission would
 * hit right now (reusing the code check's own rule logic, so the preview and
 * the gate can never disagree). */
function summarizeTable(
  spec: Extract<OutputSpec, { kind: 'table' }>,
  table: OutputTable,
  evidenceExists: (id: string) => boolean,
): OutputTableSummary {
  const rows = table.rows.map((row) => {
    const values: Record<string, string> = {};
    for (const column of spec.columns) {
      const value = row.values[column.name];
      values[column.name] = value === null || value === undefined ? '' : String(value);
    }
    return values;
  });

  const ruleFailures = validateTableRules(spec, rows).map(
    (failure: CompletionFailure) => failure.message,
  );
  const completenessRequired = spec.rules.some(
    (rule) => rule.type === 'exact_row_count' || rule.type === 'minimum_row_count',
  );
  const dangling = new Set<string>();
  for (const row of table.rows) {
    for (const id of row.evidenceIds) {
      if (!evidenceExists(id)) dangling.add(id);
    }
  }

  return {
    outputId: spec.id,
    filename: spec.filename,
    format: spec.format,
    rowCount: table.rows.length,
    ruleFailures,
    completenessRequired,
    completenessProvided: table.completeness !== undefined,
    danglingEvidenceIds: [...dangling],
  };
}

/** Render a summary as the compact text a tool result carries. */
export function formatOutputSummary(summary: OutputSummary): string {
  const lines: string[] = [];
  for (const table of summary.tables) {
    const completeness = table.completenessRequired
      ? table.completenessProvided
        ? ', completeness evidence supplied'
        : ', completeness evidence MISSING'
      : '';
    lines.push(`${table.outputId} (${table.filename}): ${table.rowCount} rows${completeness}`);
  }
  for (const other of summary.others) {
    lines.push(
      `${other.outputId}: ${other.requirement} — ${other.satisfied ? 'satisfied' : 'not yet met'}`,
    );
  }
  if (summary.blockers.length > 0) {
    lines.push('', 'Outstanding:');
    for (const blocker of summary.blockers) lines.push(`- ${blocker}`);
  } else {
    lines.push('', 'Every automated check currently passes.');
  }
  return lines.join('\n');
}
