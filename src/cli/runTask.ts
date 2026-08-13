import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  FileCredentialStore,
  type CredentialStore,
} from '../auth/credentialStore.js';
import type { BrowserController } from '../browser/controller.js';
import {
  writeHarnessDiagnostics,
  type HarnessCycleRecord,
  type HarnessOutcomeRecord,
} from '../harness/harness.js';
import {
  INITIALIZER_MODEL,
  makeInitializerCallModel,
  runInitializer,
  writeInitializerFiles,
} from '../harness/initializer.js';
import {
  makeVerifierModelDriver,
  runVerifier,
  type VerificationFinding,
  type VerifierOutcome,
} from '../harness/verifier.js';
import {
  runAgentLoop,
  type LoopConfig,
  type LoopDeps,
  type LoopResult,
} from '../loop/agentLoop.js';
import {
  appendWorkerFeedback,
  createWorkerSession,
  recordWorkerSessionCrash,
  runWorkerCycle,
  writeWorkerSessionMetrics,
} from '../loop/workerSession.js';
import { findDevRoot, resolveSherlockPaths } from '../config/paths.js';
import type { CallModel } from '../loop/messages.js';
import {
  createRunBudgetTracker,
  withBudgetAccounting,
  type RunBudgetTracker,
} from '../run/runBudget.js';
import type { RunOutcome } from '../run/runOutcome.js';
import {
  DEFAULT_MODEL,
  makeCallModel,
  type ProgressEvent,
} from '../model/callModel.js';
import {
  finalizeManifest,
  initManifest,
} from '../run/artifacts.js';
import { generateRunId } from '../run/runId.js';
import { createRunDir } from '../run/runDir.js';
import { appendTranscriptEvent, type CycleStartEvent } from '../run/transcript.js';
import {
  createRunTracing,
  type RunTracing,
} from '../tracing/runTracing.js';
import {
  createProductionRegistry,
  DEFAULT_TOOL_PROFILE,
  type ToolProfile,
} from '../tools/index.js';
import { toApiToolDefs, type ToolCtx } from '../tools/registry.js';
import { SYSTEM_PROMPT } from './systemPrompt.js';

// Default runs base when the caller passes none: the checkout's runs/
// in a dev tree, ~/.sherlock/runs installed — never the cwd, which
// would scatter run directories across wherever callers launch from.
const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DEFAULT_RUNS_BASE_DIR = resolveSherlockPaths({
  devRoot: findDevRoot(PACKAGE_ROOT),
}).runsBaseDir;
const DEFAULT_MAX_OUTPUT_TOKENS = 8_192;
// Uncapped by default: a well-reasoning agent follows its trajectory to
// completion, and the context ceiling below still guarantees termination
// (per-request context grows every turn). Pass a finite maxTurns to cap.
const DEFAULT_MAX_TURNS = Infinity;
// Per-request context ceiling (see LoopConfig.maxContextTokens). 900k:
// claude-sonnet-5's real context window is 1M tokens (verified against
// current model docs 2026-08-11 — the prior 200k default assumed a 200k
// window), so 900k opens ~5x headroom over the deepest observed run while
// keeping termination graceful: the run ends budget_exceeded with metrics
// and gradable artifacts instead of crashing into the API's 1M wall as a
// 400. The 100k margin absorbs the guard's post-hoc overshoot (a single
// turn added ~15k at most) plus output. Note this ceiling is also the
// de-facto cost guard — deep-run spend is dominated by cache reads (0.1x
// input price) and scales roughly linearly with it. If runs die here,
// cheaper repeat-page representation remains the remedy of record, not a
// bigger cap.
const DEFAULT_MAX_CONTEXT_TOKENS = 900_000;

/**
 * Keep only start URLs runTask can actually open: `goto` accepts HTTP(S)
 * pages only, so schemes like `about:blank` (a task's way of saying
 * "blank tab") map to "no start URL" rather than a run-killing throw.
 */
export function usableStartUrl(startUrl: string | undefined): string | undefined {
  if (startUrl === undefined) return undefined;
  try {
    const protocol = new URL(startUrl).protocol;
    return protocol === 'http:' || protocol === 'https:' ? startUrl : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Configuration for the initializer → worker → judge outer loop (see
 * .agents/planning/2026-08-12-research-quality-harness/judge-design.md).
 * Present iff `RunTaskConfig.harness` is present — when it is absent,
 * `runTask` behaves exactly as it did before this loop existed: a single
 * `runAgentLoop` call, no INTENT.md/CONTRACT.md/harness.json, no judge.
 */
export interface HarnessConfig {
  /** Maximum number of worker cycles this run may spend; an integer >= 1.
   * Defaults to 3 (raised from the design's v1 cap of 2 after the
   * 2026-08-13 v2 validation: on the one wikipedia trial that failed
   * grading, the judge's cycle-2 CONTINUE had named exactly the assertion
   * the grader failed — the cap, not the diagnosis, was the binding
   * constraint). A judge 'continue' verdict on the final cycle ends the
   * run `incomplete: verification_attempts` — the last cycle's artifacts
   * are preserved, explicitly unverified; exhausting corrections is no
   * longer reported as success. */
  maxWorkerCycles?: number;
  /** Test seam for the initializer's single model call, mirroring
   * `RunTaskConfig.callModel`. Production default: makeInitializerCallModel. */
  initializerCallModel?: CallModel;
  /** Test seam for the verifier's read-only mini-loop, mirroring
   * `RunTaskConfig.callModel`. Production default: makeVerifierModelDriver. */
  verifierCallModel?: CallModel;
}

/** Configuration for one complete evidence-collection run. */
export interface RunTaskConfig {
  /** A live session browser with no active task tab. The caller owns and
   * eventually closes the session; runTask owns only the fresh tab it opens. */
  browser: BrowserController;
  /** Directory that holds run directories; defaults to the checkout's
   * `runs/` in a dev tree, `~/.sherlock/runs` installed. */
  runsBaseDir?: string;
  /** Optional HTTP(S) page to load before the first model turn. */
  startUrl?: string;
  /** Model id; the production model client's default when omitted. */
  model?: string;
  /** Deterministic tool surface; defaults to the ten atomic tools. */
  toolProfile?: ToolProfile;
  /** Maximum tokens generated by each production model call; defaults to 8192. */
  maxOutputTokens?: number;
  /** Maximum model turns in the loop; uncapped (Infinity) by default —
   * the context ceiling is then the run's terminating guard. */
  maxTurns?: number;
  /** Per-request context ceiling (see LoopConfig.maxContextTokens);
   * defaults to 900000 (just under the model's 1M window, so runs end
   * budget_exceeded instead of crashing on the API's context limit). */
  maxContextTokens?: number;
  /** Optional callback for production model streaming progress. */
  onProgress?: (event: ProgressEvent) => void;
  /** Optional model implementation for tests or alternate clients. When
   * omitted, runTask creates the production streaming Anthropic client. */
  callModel?: CallModel;
  /** Optional run-scoped tracing implementation. When omitted, tracing is
   * configured from LANGFUSE_* environment variables or becomes a no-op. */
  tracing?: RunTracing;
  /** Optional credential store consulted by fill_credentials. When omitted,
   * reads the gitignored `.credentials.json` at the repo root, or the file
   * named by the CREDENTIALS_FILE environment variable. */
  credentials?: CredentialStore;
  /** Optional resolver for interactive tool calls (the TUI wires its
   * question dialog here). When omitted — evals, headless CLI — tools that
   * require user interaction fail closed in the pipeline. */
  requestPermission?: ToolCtx['requestPermission'];
  /** Enables the initializer → worker → judge outer loop (see HarnessConfig
   * and judge-design.md). Absent (the default): today's behavior,
   * byte-for-byte — one runAgentLoop call, no INTENT.md/CONTRACT.md/
   * harness.json, no judge. Present: the initializer writes INTENT.md and
   * CONTRACT.md before the browser tab opens, then up to
   * `maxWorkerCycles` worker cycles run against the same tab, each
   * verified by the judge before deciding whether another cycle runs. */
  harness?: HarnessConfig;
}

/**
 * The finished run directory together with the run's terminal outcome.
 * Judge-less runs end `completed` or `budget_exceeded` (the historical
 * LoopResult contract, unchanged). Harness runs end `verified` — the only
 * success state — or `incomplete` with an explicit reason: judge crash,
 * exhausted correction attempts, and budget exhaustion can no longer
 * masquerade as success (see RunOutcome).
 */
export type RunTaskResult = { runDir: string } & (LoopResult | RunOutcome);

/**
 * Run one task through the production evidence-collection stack.
 *
 * Absent `config.harness`, this is exactly one `runAgentLoop` call: the
 * worker gets the task text verbatim, and the run ends with whatever
 * `LoopResult` that single call produces. Present `config.harness`, the
 * verification harness runs instead: the initializer derives the
 * contract-authoring files from the task text, then ONE persistent worker
 * session runs up to `harness.maxWorkerCycles` cycles against the same run
 * directory and browser tab, every cycle charging one shared whole-run
 * budget. `verified` (a judge `done` verdict) is the only success;
 * a `budget_exceeded` cycle, a judge crash, and correction exhaustion end
 * the run `incomplete` with an explicit reason and preserved artifacts.
 * See runVerificationHarness for the loop itself.
 *
 * @param taskText - the user's task, recorded verbatim in the manifest and
 *   sent as the first conversation message of cycle 1 (every later cycle's
 *   opening message is derived from it — see runHarnessCycles)
 * @param config - a live browser session with no active task tab plus
 *   optional run location, starting page, model settings, loop guards, and
 *   harness settings; `callModel` may replace the production worker client
 *   at this dependency seam, and `harness.initializerCallModel`/
 *   `harness.judgeCallModel` do the same for the other two roles
 * @returns the absolute run directory and terminal loop outcome; before the
 *   promise resolves, the transcript and metrics are complete (a rolled-up
 *   metrics.json plus one metrics-cycle-N.json per worker cycle when the
 *   harness ran), the manifest is finalized, and this run's tab is closed
 *   while the browser stays open
 */
export async function runTask(
  taskText: string,
  config: RunTaskConfig,
): Promise<RunTaskResult> {
  const maxOutputTokens = config.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
  if (!Number.isInteger(maxOutputTokens) || maxOutputTokens < 1) {
    throw new Error(
      `maxOutputTokens must be a positive integer, got ${maxOutputTokens}`,
    );
  }

  // Harness-mode-only guard: absent config.harness, maxWorkerCycles is never
  // read, so a caller that never opts in can never trip this.
  const maxWorkerCycles = config.harness?.maxWorkerCycles ?? 3;
  if (
    config.harness !== undefined
    && (!Number.isInteger(maxWorkerCycles) || maxWorkerCycles < 1)
  ) {
    throw new Error(
      `harness.maxWorkerCycles must be a positive integer, got ${maxWorkerCycles}`,
    );
  }

  const registry = createProductionRegistry(
    config.toolProfile ?? DEFAULT_TOOL_PROFILE,
  );
  const baseCallModel = config.callModel ?? makeCallModel({
    model: config.model,
    system: SYSTEM_PROMPT,
    apiToolDefs: toApiToolDefs(registry),
    maxOutputTokens,
    onProgress: config.onProgress,
  });

  const runDir = createRunDir(
    config.runsBaseDir ?? DEFAULT_RUNS_BASE_DIR,
    // The task text names the run dir (slugified), so listings read like a
    // history of what was asked rather than a wall of timestamps.
    generateRunId(taskText),
  );
  initManifest(runDir, taskText);

  const credentials =
    config.credentials ??
    new FileCredentialStore(
      process.env.CREDENTIALS_FILE ?? resolve(PACKAGE_ROOT, '.credentials.json'),
    );

  const tracing = config.tracing ?? createRunTracing();
  const callModel = tracing.wrapCallModel(
    baseCallModel,
    config.model ?? DEFAULT_MODEL,
  );
  const tracedRegistry = tracing.wrapRegistry(registry);

  // Harness mode: one budget tracker for the whole run — initializer,
  // every worker cycle, and every judge call charge the same instance, and
  // starting a correction resets nothing. Constructed (and validated) here
  // so an invalid finite-limit configuration fails before the browser or
  // any model starts.
  const budget: RunBudgetTracker | undefined =
    config.harness === undefined
      ? undefined
      : createRunBudgetTracker({
          maxWorkerTurns: config.maxTurns ?? DEFAULT_MAX_TURNS,
          maxToolCalls: Infinity,
          maxModelTokens: Infinity,
          maxToolResultBytes: Infinity,
          maxWallTimeMs: Infinity,
          maxVerifierCorrections: maxWorkerCycles - 1,
        });
  const maxContextTokens = config.maxContextTokens ?? DEFAULT_MAX_CONTEXT_TOKENS;
  if (Number.isNaN(maxContextTokens) || maxContextTokens < 0) {
    throw new Error(`maxContextTokens must be >= 0, got ${maxContextTokens}`);
  }

  let tabOpened = false;
  try {
    // Harness mode: derive the contract-authoring files from the task text
    // alone, before any browsing starts, so a failure here still lets the
    // finally below finalize the manifest. Deliberately outside
    // tracing.traceRun and never through tracing.wrapCallModel — per the
    // design, initializer and judge calls run untraced in v1; their token
    // usage still lands on the shared budget via withBudgetAccounting.
    if (config.harness !== undefined) {
      const initializerCallModel = withBudgetAccounting(
        config.harness.initializerCallModel ?? makeInitializerCallModel({}),
        budget!,
        'initializer',
      );
      const initializerResult = await runInitializer(taskText, initializerCallModel);
      writeInitializerFiles(runDir, initializerResult);
    }

    const result = await tracing.traceRun(taskText, async () => {
      await config.browser.newTab();
      tabOpened = true;

      if (config.startUrl !== undefined) {
        await config.browser.goto(config.startUrl);
      }

      const loopDeps: LoopDeps = {
        callModel,
        registry: tracedRegistry,
        runDir,
        browser: config.browser,
        credentials,
        requestPermission: config.requestPermission,
      };

      if (config.harness === undefined) {
        const loopConfig: LoopConfig = {
          maxTurns: config.maxTurns ?? DEFAULT_MAX_TURNS,
          maxContextTokens,
        };
        return runAgentLoop(taskText, loopDeps, loopConfig);
      }

      return runVerificationHarness(
        taskText,
        runDir,
        config.harness,
        maxWorkerCycles,
        loopDeps,
        { budget: budget!, maxContextTokens },
      );
    });
    return { runDir, ...result };
  } finally {
    try {
      if (tabOpened) {
        await config.browser.closeTab();
      }
    } finally {
      try {
        finalizeManifest(runDir);
      } finally {
        await tracing.close();
      }
    }
  }
}

/**
 * Run the verification harness's worker/judge phase over ONE persistent
 * WorkerSession. Cycle 1 opens with the task text; every later cycle is
 * the same conversation continued — the judge's reason is appended as
 * feedback (appendWorkerFeedback), so the worker keeps its browser
 * knowledge and prior tool results instead of starting over. By the time
 * this runs, the contract-authoring files already exist at the run-dir
 * root (written by `runTask` before the tab opened).
 *
 * Loop, per cycle (1-based):
 * 1. Append a `cycle_start` transcript event, then advance the session
 *    until the cycle ends (runWorkerCycle) — every turn charges the shared
 *    whole-run budget, which no correction ever resets.
 * 2. A `budget_exceeded` cycle ends the run as
 *    `incomplete: budget_exceeded` without judging — budgets end runs,
 *    and an unverified end is not success.
 * 3. A `completed` cycle is judged. Verdict `done` → `verified` (the only
 *    success). Verdict `continue` with cycles remaining → charge one
 *    correction and continue the same session with the reason as
 *    feedback. Verdict `continue` on the final cycle →
 *    `incomplete: verification_attempts`. A judge that throws (an
 *    AbortError excepted — that is the caller's cancellation and
 *    propagates) → `incomplete: verifier_unavailable`, with the message
 *    recorded as the cycle's `judgeError`; the worker's artifacts are
 *    preserved in every incomplete case.
 *
 * Every non-crash ending writes harness.json (diagnostics including the
 * truthful outcome) and one metrics.json carrying whole-run aggregates
 * plus per-role usage. A worker-cycle crash records failed metrics and
 * propagates unchanged (no harness.json for a run that never finished).
 *
 * @returns the truthful RunOutcome — never a success shape for a judge
 *   crash, exhausted corrections, or exhausted budget
 */
async function runVerificationHarness(
  taskText: string,
  runDir: string,
  harnessConfig: HarnessConfig,
  maxWorkerCycles: number,
  loopDeps: LoopDeps,
  sessionConfig: { budget: RunBudgetTracker; maxContextTokens: number },
): Promise<RunOutcome> {
  const verifierCallModel = withBudgetAccounting(
    harnessConfig.verifierCallModel ?? makeVerifierModelDriver(),
    sessionConfig.budget,
    'verifier',
  );

  const session = createWorkerSession(taskText, loopDeps, sessionConfig);
  const cycleRecords: HarnessCycleRecord[] = [];
  let outcome: RunOutcome | undefined;

  try {
    for (let cycle = 1; cycle <= maxWorkerCycles; cycle += 1) {
      const cycleStartEvent: CycleStartEvent = { type: 'cycle_start', cycle };
      appendTranscriptEvent(runDir, cycleStartEvent);

      const result = await runWorkerCycle(session);

      if (result.kind === 'budget_exceeded') {
        // Budgets end runs: no verifier call, no verdict/reason to record.
        cycleRecords.push({ cycle, workerStatus: 'budget_exceeded' });
        outcome = {
          status: 'incomplete',
          reason: 'budget_exceeded',
          detail: `worker budget guard '${result.reason}' tripped in cycle ${cycle}`,
          finalText: '',
        };
        break;
      }

      let verification: VerifierOutcome;
      try {
        verification = await runVerifier({ taskText, runDir, callModel: verifierCallModel });
      } catch (thrown) {
        // A cancellation is the caller's, not the verifier's — honor it.
        if (thrown instanceof Error && thrown.name === 'AbortError') throw thrown;
        // Only a harness bug throws out of runVerifier (a run dir missing
        // its contract documents); every model-side failure already
        // arrives as the verifier_unavailable outcome below.
        recordWorkerSessionCrash(session, thrown);
        throw thrown;
      }

      // Fail closed: an unavailable verifier is never success. The
      // worker's artifacts are preserved, but nobody trustworthy reviewed
      // them, so the run is incomplete with the failure on record.
      if (verification.status === 'verifier_unavailable') {
        cycleRecords.push({
          cycle,
          workerStatus: 'completed',
          verifierError: verification.reason,
        });
        outcome = {
          status: 'incomplete',
          reason: 'verifier_unavailable',
          detail: `verifier unavailable in cycle ${cycle}: ${verification.reason}`,
          finalText: result.finalText,
        };
        break;
      }

      const findingsText = formatFindings(verification.findings);
      cycleRecords.push({
        cycle,
        workerStatus: 'completed',
        verdict: verification.status,
        // `verified` carries no findings — nothing worth recording there.
        ...(findingsText.length > 0 ? { reason: findingsText } : {}),
      });

      if (verification.status === 'verified') {
        outcome = { status: 'verified', finalText: result.finalText };
        break;
      }
      if (cycle === maxWorkerCycles) {
        // Correction attempts are spent. The last cycle's work stands,
        // explicitly unverified — post-hoc graders and humans decide what
        // it was worth; the harness no longer calls it success.
        outcome = {
          status: 'incomplete',
          reason: 'verification_attempts',
          detail:
            `verifier still requested corrections after ${maxWorkerCycles} ` +
            `worker cycle${maxWorkerCycles === 1 ? '' : 's'}`,
          finalText: result.finalText,
        };
        break;
      }

      // Same session, same conversation: the correction arrives as
      // feedback appended to everything the worker already knows.
      sessionConfig.budget.recordCorrection();
      appendWorkerFeedback(session, `Verification findings:\n${findingsText}`);
    }
  } catch (error) {
    recordWorkerSessionCrash(session, error);
    throw error;
  }

  if (outcome === undefined) {
    // Unreachable: maxWorkerCycles >= 1 guarantees at least one iteration,
    // and every iteration either breaks with an outcome or is the loop's
    // last (cycle === maxWorkerCycles), which also breaks with one.
    throw new Error('verification harness ended without an outcome');
  }

  const outcomeRecord: HarnessOutcomeRecord =
    outcome.status === 'verified'
      ? { status: 'verified' }
      : { status: 'incomplete', reason: outcome.reason, detail: outcome.detail };
  writeHarnessDiagnostics(runDir, {
    initializer: { model: INITIALIZER_MODEL },
    cycles: cycleRecords,
    outcome: outcomeRecord,
  });
  writeWorkerSessionMetrics(session, outcome.status);

  return outcome;
}

/**
 * Render typed verification findings as the plain-text feedback the worker
 * receives (and the diagnostics record). One line per finding, each naming
 * its area, stable code, message, and the output/evidence it points at —
 * concrete enough to act on without the verifier's conversation. An empty
 * findings array (a `verified` result) renders as "".
 */
function formatFindings(findings: readonly VerificationFinding[]): string {
  return findings
    .map((finding) => {
      const target = finding.outputId === undefined ? '' : ` [${finding.outputId}]`;
      const evidence =
        finding.evidenceIds === undefined || finding.evidenceIds.length === 0
          ? ''
          : ` (evidence: ${finding.evidenceIds.join(', ')})`;
      return `- ${finding.area}/${finding.code}${target}: ${finding.message}${evidence}`;
    })
    .join('\n');
}
