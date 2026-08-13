/**
 * Bounded research jobs (T14): the coordinator may hand a small number of
 * INDEPENDENT entity assignments to child sessions that browse in parallel
 * and hand back typed candidates. Deliberately not a general agent swarm,
 * and deliberately not a second writer on the run's deliverables.
 *
 * Five properties draw that line, and each is tested directly:
 *
 *  1. Isolation by construction, not by convention. A job's run directory IS
 *     its own directory — `scratch/research-jobs/<jobId>/`, a complete
 *     miniature run workspace with its own manifest, artifacts/, scratch/,
 *     transcript, and evidence ledger. Every child file write resolves
 *     through `resolveRunPath` against THAT root, so a child physically
 *     cannot reach the run's deliverables, the contract documents, or
 *     another job's files. It also holds none of the coordinator's stores,
 *     so there is no shared mutable table to race on: the only way a child's
 *     findings reach a deliverable is the coordinator applying
 *     {@link mergeResearchResults} output itself.
 *  2. A restricted tool set, verified at dispatch. The child gets
 *     observe/action/JavaScript/resource/evidence tools and nothing else
 *     (see researchRegistry.ts). `assertResearchRegistry` runs on every
 *     created session, so a mis-wired registry carrying `write_file`,
 *     `upsert_output_rows`, `set_output_contract`, `fill_credentials`, or
 *     `run_research_jobs` (no recursion) fails that job loudly instead of
 *     silently granting a child the coordinator's powers.
 *  3. Finite budgets, charged twice. Every job states finite
 *     turns/tokens/tool-calls/wall-time — Infinity is rejected here even
 *     though `RunBudgetConfig` accepts it, because an unbounded child is
 *     precisely the failure this task exists to prevent. The job's tracker
 *     is LINKED to the run's: every model call and tool call charges both,
 *     and the child stops when EITHER ceiling trips. Children therefore
 *     cannot inflate whole-run spend behind the coordinator's back.
 *  4. Linked cancellation. Each job runs under its own AbortSignal derived
 *     from the run's. Cancelling the run aborts every child (including ones
 *     still queued, which then never call a model), each child's session is
 *     closed exactly once, and the evidence a cancelled child already
 *     recorded is still returned — incomplete-run finalization keeps
 *     finished work.
 *  5. A typed result, never a conversation. A job returns candidate
 *     `OutputRow`-shaped rows, its evidence records, its limitations, and
 *     its usage. The child's messages stay in its own transcript file; they
 *     are never replayed into the coordinator's context, which is what keeps
 *     "three parallel jobs" from meaning "three transcripts of context
 *     growth".
 *
 * Headed/authenticated work is NOT fanned out: a job marked `headed` is
 * refused (see {@link ResearchJob.headed}) because a child would need the
 * coordinator's logged-in profile, and sharing that profile is both a
 * capability leak and a race on one browser. That work stays serial under
 * the coordinator.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { z } from 'zod';

import {
  createEvidenceStore,
  type Evidence,
  type EvidenceStore,
} from '../evidence/evidenceStore.js';
import type { CallModel } from '../loop/messages.js';
import {
  appendWorkerFeedback,
  createWorkerSession,
  runWorkerTurn,
  writeWorkerSessionMetrics,
  type WorkerSessionDeps,
} from '../loop/workerSession.js';
import { initManifest, SCRATCH_DIR } from '../run/artifacts.js';
import {
  createRunBudgetTracker,
  type RunBudgetTracker,
  type RunRoleUsage,
} from '../run/runBudget.js';
import { appendTranscriptEvent } from '../run/transcript.js';
import type { ToolCtx, ToolRegistry } from '../tools/registry.js';
import { assertResearchRegistry } from './researchRegistry.js';

/** Run-dir subdirectory holding one directory per research job. Private
 * working state under scratch/, so nothing written there is ever mistaken
 * for a deliverable. */
export const RESEARCH_JOBS_DIR = `${SCRATCH_DIR}/research-jobs`;

/** Filename of a job's staged typed result inside its job directory. */
export const RESEARCH_JOB_RESULT_FILENAME = 'result.json';

/** Public research sessions in flight at once. Two or three, per the
 * design: enough to overlap the network waits that dominate repeated-entity
 * research, few enough that a site sees a plausible number of readers and
 * that a bad assignment cannot fan out into a crawl. */
export const MIN_CONCURRENT_PUBLIC_JOBS = 2;
/** @see MIN_CONCURRENT_PUBLIC_JOBS */
export const MAX_CONCURRENT_PUBLIC_JOBS = 3;
/** The conservative end of the allowed range; raise deliberately. */
export const DEFAULT_CONCURRENT_PUBLIC_JOBS = 2;

/** Entity assignments one dispatch may carry. "One to a small bounded
 * number" — a coordinator that wants forty entities researched must decide
 * which handful actually needs a separate session. */
export const MAX_JOBS_PER_DISPATCH = 8;

/** Candidate rows one job may report. A job that thinks it found more than
 * this has misunderstood its assignment (it was given ONE entity), and the
 * cap keeps a runaway report from becoming the coordinator's problem. */
export const MAX_ROWS_PER_JOB = 200;

/** Limitations one job may report. */
const MAX_LIMITATIONS_PER_JOB = 25;

/** Job ids name a directory and namespace row ids at merge time, so they
 * must be a single safe path segment with no ':' (the namespace separator). */
const JOB_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/**
 * One job's hard ceilings. Every field must be a FINITE integer: unlike
 * `RunBudgetConfig`, Infinity is not accepted, because "explicitly
 * unbounded" is never a legitimate answer for a child the coordinator is
 * not watching turn by turn.
 */
export interface ResearchJobBudget {
  /** Model calls this job may make; integer >= 1. */
  maxTurns: number;
  /** Total model tokens (input + output + cache read + cache write) this job
   * may spend; integer >= 1. Doubles as the job's per-request context
   * ceiling — one request cannot legitimately exceed the whole job budget. */
  maxModelTokens: number;
  /** Attempted tool calls this job may make; integer >= 0. */
  maxToolCalls: number;
  /** Wall time from the job's start, in milliseconds; integer >= 1. */
  maxWallTimeMs: number;
}

/** One entity assignment. */
export interface ResearchJob {
  /** Stable id, unique within a dispatch. Becomes the job's directory name
   * and the namespace its row ids are merged under, so it must match
   * `[A-Za-z0-9][A-Za-z0-9_-]{0,63}` — no separators, no ':'. */
  jobId: string;
  /** The entity this job — and only this job — researches. */
  entity: string;
  /** The entity-specific instruction. APPENDED to the shared conversation as
   * its own message so the cached prefix (system + tools + the standing
   * briefing) stays byte-identical across jobs; see
   * {@link buildResearchJobPrompt}. */
  instruction: string;
  /** This job's finite ceilings. */
  budget: ResearchJobBudget;
  /** True when the work needs a headed or logged-in session. Such a job is
   * REFUSED rather than dispatched: a child would need the coordinator's
   * profile, and handing that to a parallel session both leaks the
   * credential and races on one browser. The coordinator does this work
   * itself, serially. */
  headed?: boolean;
}

/** One candidate row a job proposes — `OutputRow`-shaped, but with no
 * version and no path to the table: only the coordinator writes rows. */
export interface ResearchCandidateRow {
  /** Row identity WITHIN this job. The merge namespaces it, so two jobs
   * cannot collide on it. */
  rowId: string;
  /** Column name → value, keyed by the contract's columns. */
  values: Record<string, string | number | boolean | null>;
  /** Evidence ids from THIS job's ledger (or evidence the coordinator gave
   * it); every one is validated at merge time. */
  evidenceIds: string[];
  /** What makes this row the same real-world thing another job might also
   * report. Defaults to `rowId` at merge time — two jobs that both find
   * "Jane Doe" under that row id are reporting one entity, and the merge
   * must say so rather than keep both or silently keep the last. */
  dedupeKey?: string;
}

/** One evidence record staged by a job, addressed so the coordinator can
 * re-read the exact bytes. */
export interface ResearchEvidenceRecord {
  /** The id as issued inside the job's own ledger ('E1', 'E2', ...). Local
   * by design: two jobs both issue 'E1', and the merge namespaces them. */
  id: string;
  kind: Evidence['kind'];
  summary: string;
  sourceUrl?: string;
  recordedAt: string;
  /** Path of the persisted record relative to the PARENT run directory. */
  path: string;
  /** SHA-256 of the persisted record's exact bytes. */
  sha256: string;
  /** The complete record detail, so the coordinator can re-record it into
   * the run's shared ledger without reading the file back. */
  detail: unknown;
}

/** What one job cost, charged to the run's budget as well. */
export interface ResearchJobUsage {
  /** Model calls that reported usage. */
  turns: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  /** Attempted tool calls. */
  toolCalls: number;
  /** Wall-clock milliseconds from job start to job end. */
  wallClockMs: number;
}

/** How a job ended. `refused` never started (headed/authenticated work);
 * `cancelled` was stopped by the run's signal; `budget_exceeded` hit its own
 * or the run's ceiling; `failed` covers a setup error, a mis-wired registry,
 * a model failure, and an unparseable report. */
export type ResearchJobStatus =
  | 'completed'
  | 'budget_exceeded'
  | 'cancelled'
  | 'failed'
  | 'refused';

/**
 * Everything one job hands back. Deliberately excludes the child's
 * conversation: the messages live in `<jobDir>/transcript.jsonl` for audit,
 * and nothing replays them into the coordinator's context.
 */
export interface ResearchJobResult {
  jobId: string;
  entity: string;
  status: ResearchJobStatus;
  /** Candidate rows, empty for every non-`completed` status. */
  rows: ResearchCandidateRow[];
  /** Evidence the job recorded — returned even when the job failed or was
   * cancelled, because a partial run's finished captures still count. */
  evidence: ResearchEvidenceRecord[];
  /** What the job could not settle, in its own words. */
  limitations: string[];
  usage: ResearchJobUsage;
  /** Job directory, relative to the parent run directory. Absent for a
   * refused job, which never got one. */
  jobDir?: string;
  /** Why a non-`completed` job ended. A short machine reason plus a
   * one-paragraph detail — never the child's prose. */
  failure?: { reason: string; detail: string };
}

/** The child's own browser session and restricted tool set. */
export interface ResearchJobSession {
  /** The restricted registry (see `createResearchRegistry`). Validated with
   * `assertResearchRegistry` before the job's first turn. */
  registry: ToolRegistry;
  /** The child's OWN browser context. Must never be the coordinator's —
   * pass `coordinatorBrowser` in the runner deps and the runner enforces
   * it. */
  browser?: ToolCtx['browser'];
  /** Release this child's browser context. Called exactly once per job,
   * including on failure and cancellation. */
  close(): Promise<void>;
}

/** What a session factory is told about the job it is building for. */
export interface ResearchJobSessionContext {
  jobId: string;
  entity: string;
  /** Absolute path of the job's directory — the child's run directory. Its
   * manifest is already initialized. */
  jobDir: string;
  /** The job's OWN evidence ledger, rooted in `jobDir`. Wire it into
   * `createResearchRegistry({ evidenceStore: () => store })`. */
  evidenceStore: ResearchEvidenceLedger;
  /** The job's cancellation signal, already linked to the run's. */
  signal: AbortSignal;
}

/** The evidence ledger a session factory receives: the run's `EvidenceStore`
 * interface, rooted in the JOB's directory rather than the run's. Aliased so
 * wiring code reads as "the job's ledger" at the call site. */
export type ResearchEvidenceLedger = EvidenceStore;

/** What a model-client factory is told about the job it is building for. */
export interface ResearchJobModelContext {
  jobId: string;
  entity: string;
  /** The cache-stable system prompt. Byte-identical for every job built
   * from the same template — that identity IS the shared cached prefix. */
  system: string;
  /** The job's cancellation signal; pass it to the model client. */
  signal: AbortSignal;
  jobDir: string;
}

/** The cache-stable parts of the research-worker prompt: everything shared
 * by every job in the run. */
export interface ResearchTemplate {
  /** The run's original task text, verbatim. */
  taskText: string;
  /** The contract as the coordinator currently understands it, rendered as
   * text (e.g. `formatOutputSummary`). */
  contractText: string;
  /** The extraction rules every job must follow. */
  extractionRules: string;
}

/** One job's prompt, split into the shared parts and the appended one. */
export interface ResearchJobPrompt {
  /** System prompt; byte-identical across jobs of the same template. */
  system: string;
  /** The standing briefing, the conversation's FIRST message. A module
   * constant: byte-identical across every job of every run. */
  briefing: string;
  /** The entity-specific instruction, appended as its own message. */
  assignment: string;
}

/** Everything the runner touches outside itself. */
export interface ResearchJobRunnerDeps {
  /** Absolute path of the PARENT run directory; job directories are created
   * under `<runDir>/scratch/research-jobs/`. */
  runDir: string;
  /** The shared cache-stable prompt material. */
  template: ResearchTemplate;
  /** Build the child's model client. Production wiring passes
   * `context.system` and `context.signal` to `makeCallModel`; tests script
   * responses here. */
  createCallModel: (context: ResearchJobModelContext) => CallModel;
  /** Build the child's restricted tool set and its own browser context. */
  createSession: (context: ResearchJobSessionContext) => Promise<ResearchJobSession>;
  /** The RUN's budget tracker. Every child model call and tool call charges
   * it, so child spend lands in the run's metrics and in its ceilings. */
  runBudget: RunBudgetTracker;
  /** The run's cancellation signal. Every job's signal derives from it. */
  signal?: AbortSignal;
  /** The coordinator's browser. Supplied, the runner REFUSES any session
   * that hands a child this exact controller. */
  coordinatorBrowser?: ToolCtx['browser'];
  /** Public sessions in flight; an integer in
   * [{@link MIN_CONCURRENT_PUBLIC_JOBS}, {@link MAX_CONCURRENT_PUBLIC_JOBS}].
   * Defaults to {@link DEFAULT_CONCURRENT_PUBLIC_JOBS}. */
  maxConcurrentPublicJobs?: number;
  /** Clock seam, in milliseconds; defaults to `Date.now`. */
  now?: () => number;
}

/** The run-scoped dispatcher. One instance per run. */
export interface ResearchJobRunner {
  /**
   * Run every assignment and return one result per job, in INPUT order
   * regardless of completion order.
   *
   * Never rejects for a job-level problem: a child that fails, is
   * cancelled, exhausts its budget, or was mis-wired comes back as its own
   * result, so independent children keep theirs. Rejects only for a
   * dispatch-level configuration error (no jobs, too many, duplicate ids, a
   * non-finite budget) — detected before anything runs.
   */
  runJobs(jobs: readonly ResearchJob[]): Promise<ResearchJobResult[]>;
  /** Public sessions this runner will keep in flight. */
  readonly maxConcurrentPublicJobs: number;
}

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

/** The standing briefing: the working protocol and the report format. A
 * constant on purpose — it must not vary with the entity, or the shared
 * prefix would end before the conversation even starts. */
const RESEARCH_BRIEFING = [
  'You are one of several research sessions working on the task above, each',
  'assigned a different entity. Your job is to browse, capture evidence, and',
  'report typed candidate rows. You are NOT writing the deliverable: you have',
  'no output, contract, or file-writing tools, and the coordinator decides what',
  'reaches the answer.',
  '',
  'How to work:',
  '- Observe a page before acting on it, and act only through the tools you have.',
  '- Capture every value that will appear in a row as evidence, so it has an',
  '  Evidence ID to cite. A row citing no evidence is discarded.',
  '- Stay on your own assignment. Another session is covering the other entities.',
  '- You cannot start further research jobs.',
  '',
  'How to finish: reply with NO tool calls and exactly one fenced JSON block of',
  'this shape (and nothing else that looks like JSON):',
  '',
  '```json',
  '{',
  '  "rows": [',
  '    {',
  '      "rowId": "stable id for this row, e.g. the entity name",',
  '      "values": { "<contract column name>": "<value>" },',
  '      "evidenceIds": ["E1"],',
  '      "dedupeKey": "optional: what makes this the same thing another session might also find"',
  '    }',
  '  ],',
  '  "limitations": ["anything you could not settle, stated plainly"]',
  '}',
  '```',
  '',
  'Report zero rows with a limitation rather than a guessed row. An honest',
  '"not found" is usable; a fabricated row poisons the deliverable.',
].join('\n');

/** Role framing, ahead of the run-specific sections. */
const RESEARCH_ROLE_SECTION = [
  '# Research session',
  '',
  'You research ONE assigned entity for the task below and hand back typed',
  'candidate rows with evidence. You share no state with the other sessions.',
].join('\n');

/**
 * Build the cache-stable system prompt for every job of one run.
 *
 * @param template - the run's task, contract rendering, and extraction rules
 * @returns the system text. For a fixed template this is byte-identical on
 *   every call and for every job, which is what lets three concurrent jobs
 *   read ONE cache entry instead of writing three
 */
export function buildResearchSystemPrompt(template: ResearchTemplate): string {
  return [
    RESEARCH_ROLE_SECTION,
    `## The run's original task\n\n${template.taskText}`,
    `## The output contract these rows are collected for\n\n${template.contractText}`,
    `## Extraction rules\n\n${template.extractionRules}`,
  ].join('\n\n');
}

/**
 * Split one job's prompt into the shared parts and the appended part.
 *
 * The entity assignment is APPENDED — its own conversation message after the
 * standing briefing — rather than interpolated into the system prompt or the
 * briefing. That is the whole cache story: `system` and `briefing` are
 * byte-identical across jobs, so every job's request shares one cached
 * prefix and only the tail differs.
 *
 * @param template - the run's shared prompt material
 * @param job - the assignment whose instruction is appended
 * @returns the system prompt, the standing briefing, and the assignment
 */
export function buildResearchJobPrompt(
  template: ResearchTemplate,
  job: ResearchJob,
): ResearchJobPrompt {
  return {
    system: buildResearchSystemPrompt(template),
    briefing: RESEARCH_BRIEFING,
    assignment: `## Your assignment\n\nEntity: ${job.entity}\n\n${job.instruction}`,
  };
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/** Reject a ceiling that is not a finite integer at or above its floor.
 * Deliberately stricter than `RunBudgetConfig`: Infinity is a legal
 * whole-run choice and never a legal per-job one. */
function assertFiniteLimit(jobId: string, field: string, value: number, minimum: number): void {
  if (!Number.isInteger(value) || value < minimum) {
    throw new Error(
      `research job "${jobId}" budget.${field} must be a FINITE integer >= ${minimum}, ` +
        `got ${String(value)} — a child the coordinator is not watching turn by turn ` +
        `may not be unbounded`,
    );
  }
}

/**
 * Validate one job's shape and budget.
 *
 * @param job - the assignment to check
 * @throws Error naming the first problem: a malformed id, a blank entity or
 *   instruction, or a non-finite/NaN/negative/fractional ceiling
 */
export function validateResearchJob(job: ResearchJob): void {
  if (typeof job.jobId !== 'string' || !JOB_ID_PATTERN.test(job.jobId)) {
    throw new Error(
      `research job id must match ${String(JOB_ID_PATTERN)} (it names a directory and ` +
        `namespaces row ids), got ${JSON.stringify(job.jobId)}`,
    );
  }
  if (typeof job.entity !== 'string' || job.entity.trim() === '') {
    throw new Error(`research job "${job.jobId}" needs a non-empty entity`);
  }
  if (typeof job.instruction !== 'string' || job.instruction.trim() === '') {
    throw new Error(`research job "${job.jobId}" needs a non-empty instruction`);
  }
  const budget = job.budget as ResearchJobBudget | undefined;
  if (budget === undefined || typeof budget !== 'object') {
    throw new Error(`research job "${job.jobId}" needs a budget`);
  }
  assertFiniteLimit(job.jobId, 'maxTurns', budget.maxTurns, 1);
  assertFiniteLimit(job.jobId, 'maxModelTokens', budget.maxModelTokens, 1);
  assertFiniteLimit(job.jobId, 'maxToolCalls', budget.maxToolCalls, 0);
  assertFiniteLimit(job.jobId, 'maxWallTimeMs', budget.maxWallTimeMs, 1);
}

/** Validate a whole dispatch before anything runs, so a bad batch costs no
 * browser session and no model call. */
function assertDispatchable(jobs: readonly ResearchJob[]): void {
  if (!Array.isArray(jobs) || jobs.length === 0) {
    throw new Error('a research dispatch needs at least one entity assignment');
  }
  if (jobs.length > MAX_JOBS_PER_DISPATCH) {
    throw new Error(
      `a research dispatch carries at most ${MAX_JOBS_PER_DISPATCH} assignments, got ` +
        `${jobs.length} — decide which handful genuinely needs its own session`,
    );
  }
  const seen = new Set<string>();
  for (const job of jobs) {
    validateResearchJob(job);
    if (seen.has(job.jobId)) {
      throw new Error(
        `duplicate research job id "${job.jobId}" — ids name directories and namespace ` +
          `row ids, so two jobs sharing one would overwrite each other`,
      );
    }
    seen.add(job.jobId);
  }
}

/** Validate the configured concurrency. Explicit rather than clamped: a
 * caller that asked for 8 parallel sessions has a design disagreement worth
 * surfacing, not silently correcting. */
function resolveConcurrency(requested: number | undefined): number {
  const value = requested ?? DEFAULT_CONCURRENT_PUBLIC_JOBS;
  if (
    !Number.isInteger(value) ||
    value < MIN_CONCURRENT_PUBLIC_JOBS ||
    value > MAX_CONCURRENT_PUBLIC_JOBS
  ) {
    throw new Error(
      `maxConcurrentPublicJobs must be an integer in ` +
        `[${MIN_CONCURRENT_PUBLIC_JOBS}, ${MAX_CONCURRENT_PUBLIC_JOBS}], got ${String(value)}`,
    );
  }
  return value;
}

// ---------------------------------------------------------------------------
// Report parsing
// ---------------------------------------------------------------------------

const rowValueSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);

const candidateRowSchema = z.strictObject({
  rowId: z.string().min(1).max(200),
  values: z.record(z.string(), rowValueSchema),
  evidenceIds: z.array(z.string().min(1)).min(1),
  dedupeKey: z.string().min(1).max(400).optional(),
});

/** The report a job's final message must carry. Unknown keys are rejected:
 * a child inventing `"appliedRows"` is trying to do the coordinator's job,
 * and silently ignoring the field would hide that. */
const researchReportSchema = z.strictObject({
  rows: z.array(candidateRowSchema).max(MAX_ROWS_PER_JOB).optional(),
  limitations: z.array(z.string().min(1)).max(MAX_LIMITATIONS_PER_JOB).optional(),
});

/** A parsed report, or the reason the text was not one. */
export type ResearchReportParse =
  | { ok: true; rows: ResearchCandidateRow[]; limitations: string[] }
  | { ok: false; reason: string };

/**
 * Parse a job's final message into its typed report.
 *
 * Prefers the LAST fenced block (a job that shows a worked example and then
 * its answer means the answer), then falls back to the outermost braces.
 * Nothing about the prose is kept — only the typed report crosses into the
 * coordinator.
 *
 * @param text - the job's final assistant text
 * @returns the typed rows and limitations, or the reason it could not be read
 */
export function parseResearchReport(text: string): ResearchReportParse {
  const candidates = [...collectFencedBlocks(text), ...bareObjectCandidates(text)];
  if (candidates.length === 0) {
    return {
      ok: false,
      reason: 'the final message carried no JSON report block',
    };
  }
  let lastError = 'no candidate block parsed as the report shape';
  // Last first: the answer follows any illustration of it.
  for (const candidate of [...candidates].reverse()) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(candidate);
    } catch (thrown) {
      lastError = `a report block was not valid JSON: ${errorText(thrown)}`;
      continue;
    }
    const validated = researchReportSchema.safeParse(parsed);
    if (!validated.success) {
      lastError = `a report block did not match the required shape: ${validated.error.message}`;
      continue;
    }
    return {
      ok: true,
      rows: (validated.data.rows ?? []).map((row) => ({
        rowId: row.rowId,
        values: { ...row.values },
        evidenceIds: [...row.evidenceIds],
        ...(row.dedupeKey === undefined ? {} : { dedupeKey: row.dedupeKey }),
      })),
      limitations: [...(validated.data.limitations ?? [])],
    };
  }
  return { ok: false, reason: lastError };
}

/** Every fenced code block's body, in document order. */
function collectFencedBlocks(text: string): string[] {
  const blocks: string[] = [];
  const fence = /```[A-Za-z0-9_-]*\r?\n([\s\S]*?)```/g;
  for (;;) {
    const match = fence.exec(text);
    if (match === null) break;
    blocks.push(match[1]!);
  }
  return blocks;
}

/** The first-brace-to-last-brace slice, for a job that answered without a
 * fence. At most one candidate — brace matching over model prose is a
 * guessing game, and the fenced form is what the briefing asks for. */
function bareObjectCandidates(text: string): string[] {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return [];
  return [text.slice(start, end + 1)];
}

// ---------------------------------------------------------------------------
// Budget linkage
// ---------------------------------------------------------------------------

/** A job's tracker plus the counters `RunBudgetTracker` does not expose. */
interface LinkedJobBudget {
  tracker: RunBudgetTracker;
  toolCalls(): number;
}

/**
 * A tracker that charges the job AND the run.
 *
 * Recording forwards to both, so child spend appears in the run's
 * metrics.json and counts against its ceilings — the plan's "child usage is
 * charged to the parent's whole-run budget". Reads (`roleUsage`,
 * `totalModelTokens`) answer for the JOB, so a job's staged usage is its
 * own. `exceededLimit` consults the job first and the run second: a child
 * stops at its own ceiling, and also stops the moment the whole run is out
 * of headroom, which is what makes cancelling-by-budget propagate downward.
 *
 * Children charge the run's `worker` role because `ModelRole` has no
 * research role yet (adding one is a T16 concern); their turns therefore
 * count against `maxWorkerTurns`, which is the honest accounting — a
 * research turn is a worker turn someone paid for.
 */
function createLinkedJobBudget(
  budget: ResearchJobBudget,
  parent: RunBudgetTracker,
  now?: () => number,
): LinkedJobBudget {
  const child = createRunBudgetTracker(
    {
      maxWorkerTurns: budget.maxTurns,
      maxToolCalls: budget.maxToolCalls,
      maxModelTokens: budget.maxModelTokens,
      maxWallTimeMs: budget.maxWallTimeMs,
      // The job has no byte ceiling of its own; the run's still applies
      // through the parent check in exceededLimit below.
      maxToolResultBytes: Infinity,
      // A child never runs a verifier correction.
      maxVerifierCorrections: 0,
    },
    now === undefined ? {} : { now },
  );
  let toolCalls = 0;

  return {
    toolCalls: () => toolCalls,
    tracker: {
      config: child.config,
      recordModelUsage(role, usage, wallClockMs): void {
        child.recordModelUsage(role, usage, wallClockMs);
        parent.recordModelUsage(role, usage, wallClockMs);
      },
      recordToolCalls(count): void {
        child.recordToolCalls(count);
        parent.recordToolCalls(count);
        toolCalls += count;
      },
      recordToolResultBytes(bytes): void {
        child.recordToolResultBytes(bytes);
        parent.recordToolResultBytes(bytes);
      },
      recordCorrection(): void {
        child.recordCorrection();
        parent.recordCorrection();
      },
      correctionsUsed: () => child.correctionsUsed(),
      workerTurnsUsed: () => child.workerTurnsUsed(),
      totalModelTokens: () => child.totalModelTokens(),
      exceededLimit: () => child.exceededLimit() ?? parent.exceededLimit(),
      roleUsage: () => child.roleUsage(),
    },
  };
}

// ---------------------------------------------------------------------------
// Cancellation
// ---------------------------------------------------------------------------

/** The cancellation error shape the rest of the stack already recognizes
 * (see `recordWorkerSessionCrash`: an AbortError is "stopped", never
 * "crashed"). */
function abortError(message: string): Error {
  return Object.assign(new Error(message), { name: 'AbortError' });
}

/** True for the error above, however it reached us. */
function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

/** One job's signal, derived from the run's. Aborting the run aborts every
 * child; a run already aborted produces an already-aborted child, so a
 * queued job never opens a browser or calls a model. */
function linkCancellation(parent: AbortSignal | undefined): {
  signal: AbortSignal;
  release: () => void;
} {
  const controller = new AbortController();
  if (parent === undefined) {
    return { signal: controller.signal, release: () => undefined };
  }
  if (parent.aborted) {
    controller.abort(parent.reason);
    return { signal: controller.signal, release: () => undefined };
  }
  const onAbort = (): void => controller.abort(parent.reason);
  parent.addEventListener('abort', onAbort, { once: true });
  return {
    signal: controller.signal,
    release: () => parent.removeEventListener('abort', onAbort),
  };
}

/**
 * Wrap a model client so cancellation is observed even when the client
 * ignores the signal. Checked before the call (a queued job cancelled while
 * waiting never spends a token) and raced against it (a call already in
 * flight stops being awaited). The production client also takes the signal
 * directly; this wrapper is what makes the guarantee independent of it.
 */
function cancellableCallModel(callModel: CallModel, signal: AbortSignal): CallModel {
  return async (messages) => {
    if (signal.aborted) throw abortError('research job cancelled before its model call');
    let onAbort: (() => void) | undefined;
    try {
      return await Promise.race([
        callModel(messages),
        new Promise<never>((_resolve, reject) => {
          onAbort = (): void => reject(abortError('research job cancelled mid model call'));
          signal.addEventListener('abort', onAbort, { once: true });
        }),
      ]);
    } finally {
      if (onAbort !== undefined) signal.removeEventListener('abort', onAbort);
    }
  };
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

const ZERO_ROLE_USAGE: RunRoleUsage = {
  turns: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadInputTokens: 0,
  cacheCreationInputTokens: 0,
  wallClockMs: 0,
};

/**
 * Create the run's research-job runner.
 *
 * @param deps - the parent run directory, the shared prompt template, the
 *   model and session factories, the run's budget tracker and cancellation
 *   signal, and optionally the coordinator's browser (so a session that
 *   hands a child that exact controller is refused)
 * @returns the dispatcher; construction validates the concurrency setting,
 *   so a misconfigured runner fails before any job starts
 * @throws Error when `runDir` is empty or `maxConcurrentPublicJobs` is
 *   outside [2, 3]
 */
export function createResearchJobRunner(deps: ResearchJobRunnerDeps): ResearchJobRunner {
  if (typeof deps.runDir !== 'string' || deps.runDir === '') {
    throw new Error('research job runner requires the parent run directory');
  }
  const maxConcurrentPublicJobs = resolveConcurrency(deps.maxConcurrentPublicJobs);

  return {
    maxConcurrentPublicJobs,

    async runJobs(jobs): Promise<ResearchJobResult[]> {
      assertDispatchable(jobs);

      const results = new Array<ResearchJobResult | undefined>(jobs.length);
      const queue: number[] = [];
      jobs.forEach((job, index) => {
        if (job.headed === true) {
          results[index] = refusedResult(job);
          return;
        }
        queue.push(index);
      });

      // A shared cursor over the queue: each lane takes the next index when
      // it finishes one, so the in-flight count never exceeds the limit and
      // a slow job cannot idle a lane that has work left.
      let cursor = 0;
      const lane = async (): Promise<void> => {
        for (;;) {
          const slot = cursor;
          cursor += 1;
          const index = queue[slot];
          if (index === undefined) return;
          // runOneJob never rejects, so one child's failure cannot reject
          // Promise.all and discard results the others already produced.
          results[index] = await runOneJob(jobs[index]!, deps);
        }
      };
      await Promise.all(
        Array.from({ length: Math.min(maxConcurrentPublicJobs, queue.length) }, () => lane()),
      );

      // Input order, whatever order they finished in: the merge must be
      // deterministic, and so must the coordinator's view of it.
      return results.map((result, index) => result ?? missingResult(jobs[index]!));
    },
  };
}

/** The result for a headed/authenticated assignment: refused, with the
 * reason stated so the coordinator does that work itself. */
function refusedResult(job: ResearchJob): ResearchJobResult {
  return {
    jobId: job.jobId,
    entity: job.entity,
    status: 'refused',
    rows: [],
    evidence: [],
    limitations: [],
    usage: emptyUsage(),
    failure: {
      reason: 'headed_work_stays_with_coordinator',
      detail:
        'This assignment needs a headed or logged-in session. A research child would ' +
        "have to borrow the coordinator's authenticated profile, which both leaks the " +
        'credential into a parallel session and races two drivers on one browser. Do ' +
        'this entity yourself, serially.',
    },
  };
}

/** Defensive filler: a lane that somehow left a slot empty must still
 * produce a result rather than an undefined hole the coordinator would read
 * as success. Unreachable while every queued index is assigned. */
function missingResult(job: ResearchJob): ResearchJobResult {
  return {
    jobId: job.jobId,
    entity: job.entity,
    status: 'failed',
    rows: [],
    evidence: [],
    limitations: [],
    usage: emptyUsage(),
    failure: { reason: 'never_dispatched', detail: 'the dispatcher produced no result' },
  };
}

function emptyUsage(): ResearchJobUsage {
  return {
    turns: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    toolCalls: 0,
    wallClockMs: 0,
  };
}

/**
 * Run one job to its end and stage its typed result.
 *
 * Never throws. Every failure mode — a setup error, a mis-wired registry, a
 * model failure, an exhausted budget, cancellation, an unreadable report —
 * becomes this job's own result, so the sibling jobs keep theirs.
 */
async function runOneJob(
  job: ResearchJob,
  deps: ResearchJobRunnerDeps,
): Promise<ResearchJobResult> {
  const now = deps.now ?? Date.now;
  const startedMs = now();
  const jobDirRel = `${RESEARCH_JOBS_DIR}/${job.jobId}`;
  const jobDir = join(deps.runDir, RESEARCH_JOBS_DIR, job.jobId);
  const cancellation = linkCancellation(deps.signal);
  const linked = createLinkedJobBudget(job.budget, deps.runBudget, deps.now);

  let evidenceLedger: ResearchEvidenceLedger | undefined;
  let session: ResearchJobSession | undefined;
  let status: ResearchJobStatus = 'failed';
  let rows: ResearchCandidateRow[] = [];
  let limitations: string[] = [];
  let failure: { reason: string; detail: string } | undefined = {
    reason: 'not_started',
    detail: 'the job produced no outcome',
  };
  let turnsStarted = 0;

  try {
    // The job directory is a complete miniature run workspace: its own
    // manifest, artifacts/, scratch/, and — because the child's ToolCtx.runDir
    // is this directory — the confinement root every child write resolves
    // against.
    mkdirSync(jobDir, { recursive: true });
    initManifest(jobDir, `research job ${job.jobId}: ${job.entity}`);
    appendTranscriptEvent(jobDir, {
      type: 'research_job_start',
      jobId: job.jobId,
      entity: job.entity,
      budget: { ...job.budget },
    });
    evidenceLedger = createEvidenceStore(jobDir);

    if (cancellation.signal.aborted) {
      throw abortError('research job cancelled before it started');
    }

    session = await deps.createSession({
      jobId: job.jobId,
      entity: job.entity,
      jobDir,
      evidenceStore: evidenceLedger,
      signal: cancellation.signal,
    });

    // Two isolation invariants, enforced rather than trusted. Both are
    // wiring bugs, and both would silently hand a child the coordinator's
    // authority, so they fail the job loudly.
    if (deps.coordinatorBrowser !== undefined && session.browser === deps.coordinatorBrowser) {
      throw new Error(
        "the session factory handed this job the coordinator's browser; a research " +
          'child must own its browser context so it cannot race the coordinator or ' +
          'inherit its logged-in state',
      );
    }
    assertResearchRegistry(session.registry);

    const prompt = buildResearchJobPrompt(deps.template, job);
    const callModel = cancellableCallModel(
      deps.createCallModel({
        jobId: job.jobId,
        entity: job.entity,
        system: prompt.system,
        signal: cancellation.signal,
        jobDir,
      }),
      cancellation.signal,
    );

    const workerDeps: WorkerSessionDeps = {
      callModel,
      registry: session.registry,
      // The CHILD's run directory. Not the parent's: this is what makes
      // "children cannot modify shared tables or requested outputs" a
      // filesystem fact rather than a promise.
      runDir: jobDir,
      ...(session.browser === undefined ? {} : { browser: session.browser }),
      // Deliberately absent: no credentials (children are anonymous), no
      // requestPermission (interactive tools fail closed), no
      // outputContracts (nothing to gate, and nothing to revise), no
      // submissionProtocol (a child finishes by reporting, not submitting).
    };
    const workerSession = createWorkerSession(prompt.briefing, workerDeps, {
      budget: linked.tracker,
      // One request cannot legitimately exceed the job's whole token budget.
      maxContextTokens: job.budget.maxModelTokens,
    });
    // The entity-specific instruction, APPENDED as its own message: the
    // briefing above is byte-identical across jobs, so the cached prefix
    // survives (see buildResearchJobPrompt). Two consecutive user messages
    // are legal — the API combines same-role turns — and the same shape
    // already occurs on the worker's protocol-correction path.
    appendWorkerFeedback(workerSession, prompt.assignment);

    let finalText: string | undefined;
    for (;;) {
      if (cancellation.signal.aborted) {
        throw abortError('research job cancelled between turns');
      }
      turnsStarted += 1;
      const outcome = await runWorkerTurn(workerSession);
      if (outcome.kind === 'working') continue;
      if (outcome.kind === 'budget_exceeded') {
        status = 'budget_exceeded';
        failure = {
          reason: `budget_${outcome.reason}`,
          detail: `the job stopped at its ${outcome.reason} ceiling before reporting`,
        };
        break;
      }
      if (outcome.kind === 'submitted') {
        // Unreachable: the child registry has no submit_for_verification and
        // submissionProtocol is off. Named rather than ignored so a future
        // wiring change cannot turn it into a silent empty report.
        status = 'failed';
        failure = {
          reason: 'unexpected_submission',
          detail: 'the job tried to submit for verification; only the coordinator submits',
        };
        break;
      }
      finalText = outcome.finalText;
      break;
    }

    if (finalText !== undefined) {
      const report = parseResearchReport(finalText);
      if (report.ok) {
        status = 'completed';
        rows = report.rows;
        limitations = report.limitations;
        failure = undefined;
      } else {
        status = 'failed';
        failure = {
          reason: 'unreadable_report',
          detail:
            `${report.reason}. The evidence this job recorded is still staged and ` +
            `usable; its rows are not.`,
        };
      }
    }

    // Every ending that got this far leaves the job's own metrics.json beside
    // its transcript. A cancelled job deliberately gets none — see the catch
    // below, and `recordWorkerSessionCrash`'s same rule.
    writeWorkerSessionMetrics(
      workerSession,
      status === 'completed' || status === 'budget_exceeded' ? status : 'failed',
    );
  } catch (error) {
    if (isAbortError(error)) {
      // Cancellation is "stopped", not "crashed": no metrics file, and the
      // evidence already recorded is still returned below.
      status = 'cancelled';
      failure = { reason: 'cancelled', detail: errorText(error) };
    } else {
      status = 'failed';
      failure = { reason: 'job_error', detail: errorText(error) };
    }
  } finally {
    cancellation.release();
    if (session !== undefined) {
      try {
        await session.close();
      } catch {
        // A browser that will not close cannot invalidate findings that are
        // already in memory and on disk. The leak is the session owner's
        // problem, not this job's result.
      }
    }
  }

  const usage = linked.tracker.roleUsage().worker ?? ZERO_ROLE_USAGE;
  const result: ResearchJobResult = {
    jobId: job.jobId,
    entity: job.entity,
    status,
    rows,
    evidence: stageEvidence(evidenceLedger, jobDirRel),
    limitations,
    usage: {
      turns: usage.turns,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheReadInputTokens: usage.cacheReadInputTokens,
      cacheCreationInputTokens: usage.cacheCreationInputTokens,
      toolCalls: linked.toolCalls(),
      wallClockMs: now() - startedMs,
    },
    jobDir: jobDirRel,
    ...(failure === undefined ? {} : { failure }),
  };

  try {
    appendTranscriptEvent(jobDir, {
      type: 'research_job_end',
      jobId: job.jobId,
      status,
      turnsStarted,
      rows: result.rows.length,
      evidence: result.evidence.length,
      ...(failure === undefined ? {} : { failure }),
    });
    writeFileSync(
      join(jobDir, RESEARCH_JOB_RESULT_FILENAME),
      `${JSON.stringify(result, null, 2)}\n`,
      'utf8',
    );
  } catch {
    // Staging is for the audit trail; the in-memory result is authoritative.
    // A directory that vanished must not turn a completed job into a lost one.
  }
  return result;
}

/** Re-address a job's evidence for the coordinator: ids stay job-local (the
 * merge namespaces them), paths become parent-run-relative so read_file and
 * grep reach them from the run directory. */
function stageEvidence(
  ledger: ResearchEvidenceLedger | undefined,
  jobDirRel: string,
): ResearchEvidenceRecord[] {
  if (ledger === undefined) return [];
  return ledger.list().map((evidence) => ({
    id: evidence.id,
    kind: evidence.kind,
    summary: evidence.summary,
    ...(evidence.sourceUrl === undefined ? {} : { sourceUrl: evidence.sourceUrl }),
    recordedAt: evidence.recordedAt,
    // The child's own manifest holds the path relative to the job dir;
    // POSIX separators keep the value usable as a run-dir-relative path on
    // every platform.
    path: `${jobDirRel}/${evidence.path.split(/[\\/]/).join('/')}`,
    sha256: evidence.sha256,
    detail: evidence.detail,
  }));
}

/** One line of whatever was thrown. */
function errorText(thrown: unknown): string {
  return thrown instanceof Error ? thrown.message : String(thrown);
}
