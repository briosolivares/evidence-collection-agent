/**
 * INTEGRATION (T14) — `run_research_jobs` is complete and tested but
 * deliberately NOT registered: `src/tools/registry.ts`, `src/tools/index.ts`,
 * and `src/cli/runTask.ts` belong to the primary agent. Nothing here needs to
 * change for the wiring; what remains is:
 *
 * 1. `src/tools/registry.ts` — no change. This tool reaches everything it
 *    needs through its factory (run directory, budget tracker, cancellation
 *    signal, evidence ledger, session/model factories), because all of them
 *    are RUN-scoped decisions made where the browser session is created. A
 *    per-call `ToolCtx` read would let a later context mutation change which
 *    browser children get, which is the one thing this tool must not allow.
 *
 * 2. `src/cli/runTask.ts` — build the runner and the tool where the run's
 *    browser session and budget already exist:
 *      const researchRunner = createResearchJobRunner({
 *        runDir,
 *        template: {
 *          taskText,
 *          contractText: formatOutputSummary(summarizeOutputs(summaryDeps())),
 *          extractionRules: RESEARCH_EXTRACTION_RULES,
 *        },
 *        createCallModel: ({ system, signal }) =>
 *          makeCallModel({ model: config.model, system,
 *                          apiToolDefs: toApiToolDefs(childRegistry), maxOutputTokens, signal }),
 *        createSession: async ({ jobDir, evidenceStore, signal }) => {
 *          const browser = await sessionProvider.createSession();   // its OWN session
 *          await browser.newTab();
 *          return { registry: createResearchRegistry({ ... }), browser,
 *                   close: () => browser.close() };
 *        },
 *        runBudget: budget,
 *        signal: runSignal,                  // the run's AbortSignal
 *        coordinatorBrowser: config.browser, // enforces "not the coordinator's browser"
 *      });
 *    then append `createRunResearchJobsTool({ runner, runDir, evidenceStore })`
 *    LAST in the V2 registry, after `set_output_contract` and the row tools, so
 *    no existing tool's index moves and the cached prompt prefix keeps its
 *    bytes.
 *
 *    `signal` is the load-bearing argument: it is what makes cancelling the
 *    run stop the children, close their browsers, and still let
 *    incomplete-run finalization keep the evidence finished jobs staged. A
 *    runner built without it produces children the run cannot stop.
 *
 * 3. Headed lanes (mit, edgar, elon_tweets) need no special casing: an
 *    assignment marked `headed` is refused by the runner with the reason
 *    stated to the model, and the coordinator does that entity itself,
 *    serially, on its own authenticated tab.
 *
 * The plan's `runResearchJobsTool` symbol is the value
 * {@link createRunResearchJobsTool} returns; a module-level constant is not
 * possible while the runner reaches the tool through a factory rather than
 * `ToolCtx`.
 */

import { z } from 'zod';

import { recordEvidence, type EvidenceStore } from '../../evidence/evidenceStore.js';
import {
  mergeResearchResults,
  type ResearchMergeResult,
  type ResearchRowConflict,
  type ResearchRowDuplicate,
  type ResearchRowRejection,
} from '../../research/mergeResearchResults.js';
import {
  MAX_JOBS_PER_DISPATCH,
  RESEARCH_JOBS_DIR,
  type ResearchCandidateRow,
  type ResearchEvidenceRecord,
  type ResearchJob,
  type ResearchJobBudget,
  type ResearchJobResult,
  type ResearchJobRunner,
} from '../../research/researchJob.js';
import type { OutputRowInput } from '../../outputs/outputTable.js';
import { writeArtifact } from '../../run/artifacts.js';
import { accessKey, type ToolDef } from '../registry.js';

/** Registry name of this tool. Mirrored in
 * `FORBIDDEN_RESEARCH_TOOL_NAMES` so a child can never be handed it; the
 * test asserts the two strings agree. */
export const RUN_RESEARCH_JOBS_TOOL_NAME = 'run_research_jobs';

/**
 * Default per-job ceilings. Small on purpose: a research job answers one
 * bounded question about one entity, and a child that needs thirty turns has
 * either been given the coordinator's whole task or is lost. Every value is
 * finite — the runner rejects Infinity outright.
 */
export const DEFAULT_RESEARCH_JOB_BUDGET: ResearchJobBudget = {
  maxTurns: 12,
  maxModelTokens: 300_000,
  maxToolCalls: 60,
  maxWallTimeMs: 240_000,
};

/** Rows inlined in the model-facing result; the rest are in the staged merge
 * file. Fifty rows is more than a bounded entity assignment should produce,
 * so in practice nothing is elided. */
const MAX_INLINE_ROWS = 50;
/** Conflicts inlined. A conflict costs the model real reading, and ten
 * unresolved disagreements is already a signal to stop fanning out. */
const MAX_INLINE_CONFLICTS = 10;
/** Duplicates inlined. */
const MAX_INLINE_DUPLICATES = 20;
/** Rejections inlined. */
const MAX_INLINE_REJECTIONS = 20;
/** Limitations inlined. */
const MAX_INLINE_LIMITATIONS = 25;

/** One assignment as the model states it. The job id is derived by this tool
 * — a model-chosen id could collide, carry a path separator, or carry the
 * namespace separator, and all three are the coordinator's problem to
 * prevent, not the model's to remember. */
const assignmentSchema = z.strictObject({
  entity: z
    .string()
    .min(1)
    .max(200)
    .describe('The ONE thing this session researches: a person, company, filing, or page.'),
  instruction: z
    .string()
    .min(1)
    .max(4_000)
    .describe(
      'What to find for this entity and what a complete answer looks like. Everything shared by the assignments (the task, the contract, the extraction rules) is already in the session prompt — state only what is specific to this entity.',
    ),
  headed: z
    .boolean()
    .optional()
    .describe(
      'Set only when this entity genuinely needs a logged-in or headed browser. Such an assignment is REFUSED and stays yours to do serially, because a research session must not borrow your authenticated profile.',
    ),
});

/** Input accepted by `run_research_jobs`. */
export const runResearchJobsInputSchema = z.strictObject({
  assignments: z
    .array(assignmentSchema)
    .min(1)
    .max(MAX_JOBS_PER_DISPATCH)
    .describe(
      `1-${MAX_JOBS_PER_DISPATCH} INDEPENDENT entity assignments. Independent means no assignment needs another's findings — they run at the same time.`,
    ),
  outputId: z
    .string()
    .min(1)
    .optional()
    .describe('The table output these candidate rows are being collected for; echoed back.'),
});

/** Input accepted by `run_research_jobs`. */
export type RunResearchJobsInput = z.infer<typeof runResearchJobsInputSchema>;

/** One job's line in the model-facing result. */
export interface RunResearchJobsJobSummary {
  jobId: string;
  entity: string;
  status: ResearchJobResult['status'];
  rowsImported: number;
  rowsRejected: number;
  rowsInConflict: number;
  evidenceIndexed: number;
  turns: number;
  toolCalls: number;
  /** Present for any job that did not complete. */
  failure?: { reason: string; detail: string };
}

/** Model-facing result of one dispatch. Bounded: the complete merge is
 * always staged to a file, and the inline view says when it elided. */
export interface RunResearchJobsResult {
  /** Assignments dispatched (refused ones included — they have results too). */
  dispatched: number;
  /** Per job, in the merge's deterministic job order. */
  jobs: RunResearchJobsJobSummary[];
  /** Candidate rows ready for `upsert_output_rows`. NOT applied. */
  rows: OutputRowInput[];
  /** True when `rows` is a prefix of the merged rows; read the rest from
   * `mergePath`. */
  rowsTruncated: boolean;
  /** Total merged rows, however many are inlined. */
  rowCount: number;
  /** Overlap where the jobs agreed: imported once. */
  duplicates: ResearchRowDuplicate[];
  /** Overlap where the jobs DISAGREED: nothing was imported for these keys,
   * and you decide. */
  conflicts: ResearchRowConflict[];
  /** Candidates that could not be imported. */
  rejected: ResearchRowRejection[];
  /** What the jobs could not settle. */
  limitations: Array<{ jobId: string; limitation: string }>;
  /** Run-dir-relative path of the complete merge; read it with read_file. */
  mergePath: string;
  /** The table output these rows are for, when stated. */
  outputId?: string;
  /** Standing reminder of what this result is and is not. */
  note: string;
}

/** Everything the tool needs from the run. */
export interface RunResearchJobsDeps {
  /** The run-scoped dispatcher (see `createResearchJobRunner`). */
  runner: ResearchJobRunner;
  /** Absolute path of the run directory; the merge is staged inside it. */
  runDir: string;
  /**
   * The RUN's shared evidence ledger. Supplied, every job's evidence is
   * re-recorded here and the returned rows cite the ids it issues — which is
   * what makes them applyable, since the table store validates citations
   * against this ledger and a job-local `E1` is not in it. Omitted, rows
   * keep namespaced job-local citations and cannot be upserted as-is.
   */
  evidenceStore?: EvidenceStore;
  /** Per-job ceilings; defaults to {@link DEFAULT_RESEARCH_JOB_BUDGET}. */
  jobBudget?: ResearchJobBudget;
  /** Contract-level validation of one candidate's values, forwarded to the
   * merge so a malformed row is reported instead of poisoning the atomic
   * upsert of every other job's rows. */
  validateRowValues?: (row: ResearchCandidateRow, jobId: string) => readonly string[];
}

/**
 * Build the coordinator-facing `run_research_jobs` tool.
 *
 * Concurrency lives in the runner, not here: it is a GLOBAL run-scoped limit
 * (2–3 public sessions), so two dispatches cannot each open three browsers.
 * Headed/authenticated assignments are refused by the runner and come back
 * as refused results, keeping that work serial under the coordinator.
 *
 * @param deps - the run's dispatcher, run directory, shared evidence ledger,
 *   per-job budget, and optional contract-level row validation
 * @returns the registry definition, ready to append LAST to a registry
 */
export function createRunResearchJobsTool(
  deps: RunResearchJobsDeps,
): ToolDef<RunResearchJobsInput> {
  const jobBudget = deps.jobBudget ?? DEFAULT_RESEARCH_JOB_BUDGET;
  // One counter per run, so staged merge files never collide and their names
  // read as a history of dispatches.
  let dispatchCount = 0;

  return {
    name: RUN_RESEARCH_JOBS_TOOL_NAME,
    description:
      'Research 1-' +
      `${MAX_JOBS_PER_DISPATCH} INDEPENDENT entities at the same time, each in its own ` +
      'browser session with its own budget, and get back typed candidate rows plus evidence. ' +
      'Use it when the same lookup repeats across many entities and no lookup needs another\'s ' +
      'result. The sessions cannot write your table, change the contract, or touch your browser: ' +
      'they return candidates and YOU apply them with upsert_output_rows. Overlapping findings ' +
      'are reported, never silently merged — identical findings are imported once, and ' +
      'disagreements come back unimported for you to settle. Anything needing a logged-in or ' +
      'headed browser is refused and stays yours to do one at a time.',
    inputSchema: runResearchJobsInputSchema,
    // Spends the run's budget, opens browser sessions, and appends to the
    // run's evidence ledger. Nothing else may run beside it: the whole point
    // is that the concurrency is bounded and accounted for.
    readOnly: false,
    getAccess: () => ({
      reads: [],
      writes: [accessKey.evidence()],
      exclusive: true,
    }),
    async execute(input, ctx): Promise<RunResearchJobsResult> {
      dispatchCount += 1;
      const jobs = input.assignments.map((assignment, index) =>
        toResearchJob(assignment, index, jobBudget),
      );
      const results = await deps.runner.runJobs(jobs);

      const store = deps.evidenceStore;
      const merged = mergeResearchResults(results, {
        ...(store === undefined
          ? {}
          : { importEvidence: (record, jobId) => importIntoRunLedger(store, record, jobId) }),
        ...(store === undefined ? {} : { evidenceExists: (id) => store.get(id) !== undefined }),
        ...(deps.validateRowValues === undefined
          ? {}
          : { validateRowValues: deps.validateRowValues }),
      });

      // Staged before the result is bounded, so the complete merge is on
      // disk even when the model only ever sees a prefix of it.
      const mergePath = `${RESEARCH_JOBS_DIR}/merge-${dispatchCount}.json`;
      writeArtifact(
        // ctx.runDir and deps.runDir are the same directory in production;
        // ctx.runDir is used so a run-dir-relative path in the result always
        // resolves against the run the call actually happened in.
        ctx.runDir,
        mergePath,
        Buffer.from(`${JSON.stringify(merged, null, 2)}\n`, 'utf8'),
        // scratch/: private working state, so no roles (see artifacts.ts).
      );

      return buildResult(input, merged, mergePath, results.length);
    },
  };
}

/** Derive a valid, collision-free job id and attach the run's per-job
 * budget. The index prefix guarantees uniqueness even when two assignments
 * name the same entity, which a model does do. */
function toResearchJob(
  assignment: z.infer<typeof assignmentSchema>,
  index: number,
  budget: ResearchJobBudget,
): ResearchJob {
  const slug = assignment.entity
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return {
    jobId: slug === '' ? `j${index + 1}` : `j${index + 1}-${slug}`,
    entity: assignment.entity,
    instruction: assignment.instruction,
    budget,
    ...(assignment.headed === undefined ? {} : { headed: assignment.headed }),
  };
}

/**
 * Re-record one job's evidence in the run's shared ledger.
 *
 * The child's record is carried whole under `detail`, alongside the job id,
 * the job-local id, and the path and hash of the original file — so the
 * shared ledger's copy names exactly which job captured it and where the
 * untouched bytes still live. The child's file is not moved or rewritten:
 * its hash is the provenance.
 */
function importIntoRunLedger(
  store: EvidenceStore,
  record: ResearchEvidenceRecord,
  jobId: string,
): string {
  return recordEvidence(store, {
    kind: record.kind,
    summary: `[research job ${jobId}] ${record.summary}`,
    ...(record.sourceUrl === undefined ? {} : { sourceUrl: record.sourceUrl }),
    detail: {
      recordType: 'research_job_evidence',
      jobId,
      jobEvidenceId: record.id,
      jobEvidencePath: record.path,
      jobEvidenceSha256: record.sha256,
      recordedAt: record.recordedAt,
      detail: record.detail,
    },
  }).id;
}

/** Bound the merge into the model-facing result. Every truncation is stated,
 * and the complete merge is always one read_file away. */
function buildResult(
  input: RunResearchJobsInput,
  merged: ResearchMergeResult,
  mergePath: string,
  dispatched: number,
): RunResearchJobsResult {
  const applyable = merged.rows.length > 0;
  return {
    dispatched,
    jobs: merged.jobs.map((job) => ({
      jobId: job.jobId,
      entity: job.entity,
      status: job.status,
      rowsImported: job.rowsImported,
      rowsRejected: job.rowsRejected,
      rowsInConflict: job.rowsInConflict,
      evidenceIndexed: job.evidenceIndexed,
      turns: job.usage.turns,
      toolCalls: job.usage.toolCalls,
      ...(job.failure === undefined ? {} : { failure: job.failure }),
    })),
    rows: merged.rows.slice(0, MAX_INLINE_ROWS),
    rowsTruncated: merged.rows.length > MAX_INLINE_ROWS,
    rowCount: merged.rows.length,
    duplicates: merged.duplicates.slice(0, MAX_INLINE_DUPLICATES),
    conflicts: merged.conflicts.slice(0, MAX_INLINE_CONFLICTS),
    rejected: merged.rejected.slice(0, MAX_INLINE_REJECTIONS),
    limitations: merged.limitations.slice(0, MAX_INLINE_LIMITATIONS),
    mergePath,
    ...(input.outputId === undefined ? {} : { outputId: input.outputId }),
    note:
      `Nothing was written to any output. ${
        applyable
          ? 'Apply the rows above with upsert_output_rows once you agree with them'
          : 'No row was importable'
      }; settle every conflict yourself before applying anything for those keys. ` +
      `The complete merge — all rows, evidence, conflicts, and rejections — is at ` +
      `${mergePath}; read it with read_file when this summary elided anything.`,
  };
}
