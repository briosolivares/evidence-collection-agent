/**
 * Merging bounded research jobs back into one deliverable (T14).
 *
 * The dangerous version of this function is three lines long: concatenate
 * every job's rows and upsert them. That silently makes the last job to
 * finish the authority on any entity two jobs both looked at — a
 * completion-order-dependent deliverable, which is the worst kind of wrong
 * because it is not reproducible.
 *
 * This merge is therefore built around four rules:
 *
 *  1. Deterministic order. Jobs are processed in lexicographic `jobId` order,
 *     never completion order, so the same job results always produce the
 *     same merge — including which candidate wins a tie.
 *  2. Namespaced identity. Every imported row id becomes `<jobId>:<rowId>`,
 *     so two jobs that both chose the row id "jane-doe" cannot overwrite
 *     each other by accident. Real overlap has to be detected by MEANING
 *     (rule 3), not hidden by an id collision.
 *  3. Overlap is reported, never resolved silently. Two candidates with the
 *     same dedupe key and identical values are a duplicate: one is imported
 *     and the rest are reported. With DIFFERENT values they are a conflict:
 *     NOTHING is imported for that key and every candidate is handed to the
 *     coordinator with the disagreeing columns named. A conflict is a real
 *     research disagreement; picking a winner by arrival time would be
 *     fabrication with extra steps.
 *  4. Every citation is validated. A row may cite only evidence its own job
 *     actually recorded (or evidence the coordinator already holds, via
 *     `evidenceExists`). An unciteable row is rejected and reported, so a
 *     child cannot smuggle an unproven value in behind a plausible id.
 *
 * A failed, cancelled, or budget-exhausted job costs nothing but its own
 * rows: its siblings' candidates are merged exactly as if it had never run,
 * and the evidence it did record is still indexed.
 */

import type { OutputRowInput } from '../outputs/outputTable.js';
import type {
  ResearchCandidateRow,
  ResearchEvidenceRecord,
  ResearchJobResult,
  ResearchJobStatus,
  ResearchJobUsage,
} from './researchJob.js';

/** Separator between a job id and a job-local id. Job ids cannot contain it
 * (see `ResearchJob.jobId`), so namespaced ids are unambiguous. */
export const RESEARCH_NAMESPACE_SEPARATOR = ':';

/** One job's evidence record as the coordinator should cite it. */
export interface ResearchMergedEvidence {
  /** The id to cite: the id `importEvidence` issued in the run's shared
   * ledger, or the namespaced job-local id when no importer was supplied. */
  evidenceId: string;
  /** The job that recorded it. */
  jobId: string;
  /** The id inside that job's own ledger ('E1', 'E2', ...). */
  localId: string;
  kind: ResearchEvidenceRecord['kind'];
  summary: string;
  sourceUrl?: string;
  recordedAt: string;
  /** Path of the persisted record, relative to the run directory. */
  path: string;
  sha256: string;
}

/** Two or more candidates that agree: one imported, the rest reported so
 * nobody has to wonder why the row count is lower than the sum. */
export interface ResearchRowDuplicate {
  /** The key they agreed on. */
  dedupeKey: string;
  /** The namespaced row id that was imported. */
  importedRowId: string;
  /** The job whose candidate was imported (lowest jobId of the group). */
  importedJobId: string;
  /** The namespaced row ids that were not imported, in job order. */
  duplicateRowIds: string[];
}

/** One candidate inside a conflict, carried whole so the coordinator can
 * decide without re-reading any job's transcript. */
export interface ResearchConflictCandidate {
  jobId: string;
  /** The namespaced row id this candidate WOULD have taken. */
  rowId: string;
  values: Record<string, string | number | boolean | null>;
  /** Citable evidence ids for this candidate. */
  evidenceIds: string[];
}

/** Two or more candidates for one key that disagree. NOTHING was imported
 * for this key. */
export interface ResearchRowConflict {
  dedupeKey: string;
  /** Columns whose values are not identical across the candidates. */
  disagreeingColumns: string[];
  /** Every candidate, in job order. */
  candidates: ResearchConflictCandidate[];
}

/** One candidate row that could not be imported. */
export interface ResearchRowRejection {
  jobId: string;
  /** The row id as the job proposed it (not namespaced — this row never
   * became a row). */
  rowId: string;
  /** Machine reason: `unknown_evidence`, `no_evidence`, `empty_values`,
   * `invalid_values`, or `duplicate_row_id_within_job`. */
  reason: string;
  /** What is wrong, in one sentence the coordinator can act on. */
  detail: string;
}

/** What one job contributed. */
export interface ResearchMergeJobSummary {
  jobId: string;
  entity: string;
  status: ResearchJobStatus;
  rowsProposed: number;
  rowsImported: number;
  rowsRejected: number;
  /** Candidates withheld because another job disagreed about them. */
  rowsInConflict: number;
  evidenceIndexed: number;
  usage: ResearchJobUsage;
  /** Present for a job that ended anything but `completed`. */
  failure?: { reason: string; detail: string };
}

/** The complete, reviewable outcome of one merge. */
export interface ResearchMergeResult {
  /** Rows ready for `upsert_output_rows`, in deterministic order. Ids are
   * namespaced and `expectedVersion: 0` is set as the lost-update guard
   * `OutputRowInput.expectedVersion` was added for: a row that somehow
   * already exists is reported as a version conflict rather than
   * overwritten. */
  rows: OutputRowInput[];
  /** Every job's evidence, indexed and citable. */
  evidence: ResearchMergedEvidence[];
  /** Agreeing overlap: imported once, reported. */
  duplicates: ResearchRowDuplicate[];
  /** Disagreeing overlap: imported never, reported. */
  conflicts: ResearchRowConflict[];
  /** Candidates that could not be imported at all. */
  rejected: ResearchRowRejection[];
  /** What the jobs said they could not settle, in job order. */
  limitations: Array<{ jobId: string; limitation: string }>;
  /** One entry per job, in job order. */
  jobs: ResearchMergeJobSummary[];
}

/** The coordinator-side seams the merge needs. Both are optional: with
 * neither, the merge is a pure function over the job results. */
export interface ResearchMergeDeps {
  /**
   * Record one job's evidence in the RUN's shared ledger and return the id
   * the coordinator will cite. Supplying this is what makes merged rows
   * applyable: the run's table store validates citations against the run's
   * ledger, and a job-local `E1` is not in it.
   *
   * Called once per record, in job order then record order, so the ids it
   * issues are deterministic too.
   */
  importEvidence?: (record: ResearchEvidenceRecord, jobId: string) => string;
  /** Whether an id already exists in the run's shared ledger — lets a job
   * cite evidence the coordinator handed it in its briefing. */
  evidenceExists?: (evidenceId: string) => boolean;
  /**
   * Contract-level validation of one candidate's values, injected because
   * the merge has no contract. Returning problems REJECTS that row (and
   * reports it) instead of letting one malformed row make the coordinator's
   * atomic upsert reject the whole batch — which would be exactly the
   * "one child's failure discards its siblings' work" failure this task
   * forbids.
   */
  validateRowValues?: (row: ResearchCandidateRow, jobId: string) => readonly string[];
}

/**
 * Merge research job results into rows, evidence, and an explicit report of
 * every overlap and rejection.
 *
 * @param results - one entry per dispatched job, in any order; processed in
 *   lexicographic `jobId` order so the outcome never depends on which job
 *   finished first
 * @param deps - optional evidence importer, shared-ledger existence check,
 *   and contract-level value validation
 * @returns rows ready to upsert plus the full merge report. Rows are
 *   contributed only by `completed` jobs; every job's evidence and
 *   limitations are indexed regardless of how it ended, because a capture a
 *   cancelled job already made is still a real capture
 */
export function mergeResearchResults(
  results: readonly ResearchJobResult[],
  deps: ResearchMergeDeps = {},
): ResearchMergeResult {
  // Lexicographic, not completion order: this single line is what makes the
  // whole merge reproducible.
  const ordered = [...results].sort((left, right) => compareJobIds(left.jobId, right.jobId));

  const evidence: ResearchMergedEvidence[] = [];
  const rejected: ResearchRowRejection[] = [];
  const limitations: Array<{ jobId: string; limitation: string }> = [];
  const summaries = new Map<string, ResearchMergeJobSummary>();
  // Insertion order is job order, so grouped candidates stay deterministic.
  const groups = new Map<string, AcceptedCandidate[]>();

  for (const job of ordered) {
    const citable = new Map<string, string>();
    for (const record of job.evidence) {
      const evidenceId =
        deps.importEvidence?.(record, job.jobId) ?? namespaced(job.jobId, record.id);
      citable.set(record.id, evidenceId);
      evidence.push({
        evidenceId,
        jobId: job.jobId,
        localId: record.id,
        kind: record.kind,
        summary: record.summary,
        ...(record.sourceUrl === undefined ? {} : { sourceUrl: record.sourceUrl }),
        recordedAt: record.recordedAt,
        path: record.path,
        sha256: record.sha256,
      });
    }

    for (const limitation of job.limitations) {
      limitations.push({ jobId: job.jobId, limitation });
    }

    const summary: ResearchMergeJobSummary = {
      jobId: job.jobId,
      entity: job.entity,
      status: job.status,
      rowsProposed: job.status === 'completed' ? job.rows.length : 0,
      rowsImported: 0,
      rowsRejected: 0,
      rowsInConflict: 0,
      evidenceIndexed: job.evidence.length,
      usage: job.usage,
      ...(job.failure === undefined ? {} : { failure: job.failure }),
    };
    summaries.set(job.jobId, summary);

    // A job that did not complete contributes no rows. Its evidence and
    // limitations above are already indexed, and its siblings are untouched.
    if (job.status !== 'completed') continue;

    const seenRowIds = new Set<string>();
    for (const row of job.rows) {
      const rejection = rejectionFor(row, job.jobId, citable, seenRowIds, deps);
      if (rejection !== undefined) {
        rejected.push(rejection);
        summary.rowsRejected += 1;
        continue;
      }
      seenRowIds.add(row.rowId);
      const key = dedupeKeyOf(row);
      const candidate: AcceptedCandidate = {
        jobId: job.jobId,
        localRowId: row.rowId,
        rowId: namespaced(job.jobId, row.rowId),
        values: { ...row.values },
        evidenceIds: row.evidenceIds.map((id) => citable.get(id) ?? id),
      };
      const group = groups.get(key);
      if (group === undefined) groups.set(key, [candidate]);
      else group.push(candidate);
    }
  }

  const rows: OutputRowInput[] = [];
  const duplicates: ResearchRowDuplicate[] = [];
  const conflicts: ResearchRowConflict[] = [];

  for (const [key, group] of groups) {
    const disagreeing = disagreeingColumns(group);
    if (group.length > 1 && disagreeing.length > 0) {
      // A real research disagreement. Import nothing and hand the
      // coordinator both stories; deciding by arrival time would be a coin
      // flip dressed up as a deliverable.
      conflicts.push({
        dedupeKey: key,
        disagreeingColumns: disagreeing,
        candidates: group.map((candidate) => ({
          jobId: candidate.jobId,
          rowId: candidate.rowId,
          values: candidate.values,
          evidenceIds: candidate.evidenceIds,
        })),
      });
      for (const candidate of group) {
        summaries.get(candidate.jobId)!.rowsInConflict += 1;
      }
      continue;
    }

    const [kept, ...rest] = group as [AcceptedCandidate, ...AcceptedCandidate[]];
    rows.push({
      rowId: kept.rowId,
      values: kept.values,
      // Union of every agreeing candidate's citations: two jobs proving the
      // same values independently is strictly better evidence, and dropping
      // the second job's proof would lose that.
      evidenceIds: unique([...kept.evidenceIds, ...rest.flatMap((other) => other.evidenceIds)]),
      // The lost-update guard OutputRowInput.expectedVersion exists for
      // (see its doc): these ids are new by construction, so a stored row
      // at any version means something else already wrote it, and the
      // coordinator must be told rather than have it silently replaced.
      expectedVersion: 0,
    });
    summaries.get(kept.jobId)!.rowsImported += 1;
    if (rest.length > 0) {
      duplicates.push({
        dedupeKey: key,
        importedRowId: kept.rowId,
        importedJobId: kept.jobId,
        duplicateRowIds: rest.map((candidate) => candidate.rowId),
      });
    }
  }

  return {
    rows,
    evidence,
    duplicates,
    conflicts,
    rejected,
    limitations,
    jobs: ordered.map((job) => summaries.get(job.jobId)!),
  };
}

/** One candidate that passed validation and is awaiting overlap analysis. */
interface AcceptedCandidate {
  jobId: string;
  localRowId: string;
  /** Namespaced. */
  rowId: string;
  values: Record<string, string | number | boolean | null>;
  /** Already mapped to citable ids. */
  evidenceIds: string[];
}

/** `<jobId>:<localId>`. */
function namespaced(jobId: string, localId: string): string {
  return `${jobId}${RESEARCH_NAMESPACE_SEPARATOR}${localId}`;
}

/** Stable, locale-independent id ordering. `localeCompare` would make the
 * merge depend on the machine's collation. */
function compareJobIds(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

/**
 * The key two jobs must agree on to be talking about the same thing: the
 * candidate's `dedupeKey`, or its row id when it gave none.
 *
 * Normalized (trimmed, inner whitespace collapsed, lower-cased) so
 * "Jane  Doe" and "jane doe" are recognized as one entity. Deliberately no
 * deeper normalization: stripping punctuation or accents would start merging
 * genuinely different names.
 */
function dedupeKeyOf(row: ResearchCandidateRow): string {
  const raw = row.dedupeKey ?? row.rowId;
  return raw.trim().replace(/\s+/g, ' ').toLowerCase();
}

/** Columns on which a group of candidates does not agree, sorted for a
 * stable report. A column one candidate omits and another supplies counts as
 * a disagreement — "absent" and "empty" are different claims. */
function disagreeingColumns(group: readonly AcceptedCandidate[]): string[] {
  if (group.length < 2) return [];
  const columns = new Set<string>();
  for (const candidate of group) {
    for (const column of Object.keys(candidate.values)) columns.add(column);
  }
  const disagreeing: string[] = [];
  for (const column of columns) {
    const first = group[0]!.values;
    const hasFirst = column in first;
    for (const candidate of group.slice(1)) {
      const has = column in candidate.values;
      if (has !== hasFirst || (has && !sameValue(first[column]!, candidate.values[column]!))) {
        disagreeing.push(column);
        break;
      }
    }
  }
  return disagreeing.sort();
}

/** Value equality for conflict detection. Strict: "12" and 12 are different
 * claims about a cell's type, and the contract cares which one arrives. */
function sameValue(
  left: string | number | boolean | null,
  right: string | number | boolean | null,
): boolean {
  return left === right;
}

/** First occurrence wins; order preserved. */
function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

/**
 * Why this candidate cannot be imported, or undefined when it can.
 *
 * Rejection is per row on purpose: the coordinator's upsert is atomic, so a
 * single malformed row inside a shared batch would reject every other job's
 * rows with it.
 */
function rejectionFor(
  row: ResearchCandidateRow,
  jobId: string,
  citable: ReadonlyMap<string, string>,
  seenRowIds: ReadonlySet<string>,
  deps: ResearchMergeDeps,
): ResearchRowRejection | undefined {
  if (seenRowIds.has(row.rowId)) {
    return {
      jobId,
      rowId: row.rowId,
      reason: 'duplicate_row_id_within_job',
      detail:
        `this job proposed row id "${row.rowId}" more than once; only the first was kept, ` +
        'because a namespaced id must identify one row',
    };
  }
  if (
    typeof row.values !== 'object' ||
    row.values === null ||
    Array.isArray(row.values) ||
    Object.keys(row.values).length === 0
  ) {
    return {
      jobId,
      rowId: row.rowId,
      reason: 'empty_values',
      detail: 'the candidate carried no column values, so there is nothing to import',
    };
  }
  if (!Array.isArray(row.evidenceIds) || row.evidenceIds.length === 0) {
    return {
      jobId,
      rowId: row.rowId,
      reason: 'no_evidence',
      detail: 'the candidate cites no evidence; an unproven row is not importable',
    };
  }
  const unknown = row.evidenceIds.filter(
    (id) => !citable.has(id) && deps.evidenceExists?.(id) !== true,
  );
  if (unknown.length > 0) {
    return {
      jobId,
      rowId: row.rowId,
      reason: 'unknown_evidence',
      detail:
        `the candidate cites ${unknown.join(', ')}, which this job never recorded and the ` +
        'run does not hold; a citation nobody can open is not proof',
    };
  }
  const problems = deps.validateRowValues?.(row, jobId) ?? [];
  if (problems.length > 0) {
    return {
      jobId,
      rowId: row.rowId,
      reason: 'invalid_values',
      detail: problems.join('; '),
    };
  }
  return undefined;
}
