import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  FileCredentialStore,
  type CredentialStore,
} from '../auth/credentialStore.js';
import type { BrowserController } from '../browser/controller.js';
import {
  archiveCycleMetrics,
  rollupCycleMetrics,
  writeHarnessDiagnostics,
  writeMetricsRollup,
  type HarnessCycleRecord,
} from '../harness/harness.js';
import {
  INITIALIZER_MODEL,
  makeInitializerCallModel,
  runInitializer,
  writeInitializerFiles,
} from '../harness/initializer.js';
import { makeJudgeCallModel, runJudge, type JudgeVerdict } from '../harness/judge.js';
import {
  runAgentLoop,
  type LoopConfig,
  type LoopDeps,
  type LoopResult,
  type RunMetrics,
} from '../loop/agentLoop.js';
import { findDevRoot, resolveSherlockPaths } from '../config/paths.js';
import type { CallModel } from '../loop/messages.js';
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
   * constraint. The extra cycle costs nothing unless the judge is still
   * dissatisfied at cycle 2, a minority of runs). A judge 'continue'
   * verdict on the final cycle still ends the run with that cycle's
   * completed result — this caps spend, not correctness (post-hoc graders
   * stay the arbiter of whether the run actually succeeded). */
  maxWorkerCycles?: number;
  /** Test seam for the initializer's single model call, mirroring
   * `RunTaskConfig.callModel`. Production default: makeInitializerCallModel. */
  initializerCallModel?: CallModel;
  /** Test seam for the judge's read-only mini-loop, mirroring
   * `RunTaskConfig.callModel`. Production default: makeJudgeCallModel. */
  judgeCallModel?: CallModel;
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

/** The finished run directory together with the loop's terminal outcome. */
export type RunTaskResult = { runDir: string } & LoopResult;

/**
 * Run one task through the production evidence-collection stack.
 *
 * Absent `config.harness`, this is exactly one `runAgentLoop` call: the
 * worker gets the task text verbatim, and the run ends with whatever
 * `LoopResult` that single call produces. Present `config.harness`, an
 * initializer → worker → judge outer loop runs instead (see
 * .agents/planning/2026-08-12-research-quality-harness/judge-design.md):
 * the initializer derives INTENT.md and CONTRACT.md from the task text,
 * then up to `harness.maxWorkerCycles` worker cycles run against the same
 * run directory and the same browser tab — a `budget_exceeded` cycle ends
 * the run without judging; a `completed` cycle is judged, and a `done`
 * verdict, cycle exhaustion, or an unparseable verdict all end the run with
 * that cycle's completed result, while a `continue` verdict with cycles
 * remaining starts a fresh worker cycle whose opening message carries the
 * judge's reason as plain feedback text. See runHarnessCycles for the loop
 * itself.
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

  let tabOpened = false;
  try {
    // Harness mode: derive INTENT.md/CONTRACT.md from the task text alone,
    // before any browsing starts, so a failure here still lets the finally
    // below finalize the manifest. Deliberately outside tracing.traceRun and
    // never through tracing.wrapCallModel — per the design, initializer and
    // judge calls run untraced in v1 (tracing coverage for these two roles
    // is future work, not required for the harness to function).
    if (config.harness !== undefined) {
      const initializerCallModel =
        config.harness.initializerCallModel ?? makeInitializerCallModel({});
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
      const loopConfig: LoopConfig = {
        maxTurns: config.maxTurns ?? DEFAULT_MAX_TURNS,
        maxContextTokens: config.maxContextTokens ?? DEFAULT_MAX_CONTEXT_TOKENS,
      };

      if (config.harness === undefined) {
        return runAgentLoop(taskText, loopDeps, loopConfig);
      }

      return runHarnessCycles(
        taskText,
        runDir,
        config.harness,
        maxWorkerCycles,
        loopDeps,
        loopConfig,
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
 * Run the initializer → worker → judge outer loop's worker-cycle phase: up
 * to `maxWorkerCycles` fresh `runAgentLoop` invocations against the same run
 * directory and the same (already-open) browser tab, each gated by a judge
 * verdict before another cycle starts. By the time this runs, INTENT.md and
 * CONTRACT.md already exist at the run-dir root (written by `runTask`
 * before the tab opened); this function owns only the cycle loop itself —
 * the `cycle_start` transcript events, each cycle's metrics archival, and
 * the harness.json diagnostics and metrics.json rollup written once the
 * loop ends.
 *
 * Loop, per cycle (1-based, see judge-design.md's "Loop" section):
 * 1. Append a `cycle_start` transcript event, then run `runAgentLoop` with
 *    this cycle's opening message (cycle 1: `taskText` unchanged; cycle
 *    N>1: `taskText` plus the previous cycle's judge reason as plain
 *    feedback text — no special framing, borrowed from Claude Code's
 *    `/goal` stop-hook delivery, see judge-design.md's "Judge-reason
 *    delivery").
 * 2. Archive this cycle's metrics.json (runAgentLoop would otherwise
 *    overwrite it on the next cycle) and record it for the eventual rollup.
 * 3. `budget_exceeded` ends the run right here, without judging — budgets
 *    end runs. `completed` runs the judge (`runJudge`): a `done` verdict, a
 *    `continue` verdict with no cycles left, or an unparseable verdict (the
 *    judge's own fail-safe default, never a false `done`) all end the run
 *    with this cycle's completed result; a `continue` verdict with cycles
 *    remaining carries its reason into the next cycle's opening message. A
 *    judge that throws (infrastructure failure, not a verdict — an
 *    AbortError excepted, which is the caller's cancellation and
 *    propagates) also ends the run with this cycle's completed result,
 *    recording the message as the cycle's `judgeError`: the worker's
 *    finished work must never be destroyed by its verifier's crash.
 *
 * Every ending writes harness.json (see HarnessDiagnostics) and a rolled-up
 * metrics.json (see rollupCycleMetrics) before returning. Both are skipped
 * if any worker cycle throws (an AbortError or any other error) — the error
 * propagates unchanged, exactly like a single-cycle judge-less run's crash
 * contract, and no rollup or diagnostics for a run that never finished
 * ever gets written.
 *
 * @param taskText - the original task text; cycle 1's opening message
 *   verbatim, and the stem every later cycle's opening message is built from
 * @param runDir - the run directory; must already hold INTENT.md and
 *   CONTRACT.md (the judge throws loudly if either is missing)
 * @param harnessConfig - `config.harness` as the caller passed it (see
 *   HarnessConfig); only `judgeCallModel` is read here — `maxWorkerCycles`
 *   and `initializerCallModel` are already spent by the time this runs
 * @param maxWorkerCycles - the validated cycle budget (integer >= 1)
 * @param loopDeps - deps for each cycle's `runAgentLoop` call; the same
 *   instance every cycle, so the same browser tab, registry, and callModel
 *   carry over
 * @param loopConfig - guards for each cycle's `runAgentLoop` call; the same
 *   every cycle
 * @returns the final cycle's LoopResult
 */
async function runHarnessCycles(
  taskText: string,
  runDir: string,
  harnessConfig: HarnessConfig,
  maxWorkerCycles: number,
  loopDeps: LoopDeps,
  loopConfig: LoopConfig,
): Promise<LoopResult> {
  const judgeCallModel = harnessConfig.judgeCallModel ?? makeJudgeCallModel();

  const cycleRecords: HarnessCycleRecord[] = [];
  const perCycleMetrics: RunMetrics[] = [];
  let openingMessage = taskText;
  let finalResult: LoopResult | undefined;

  for (let cycle = 1; cycle <= maxWorkerCycles; cycle += 1) {
    const cycleStartEvent: CycleStartEvent = { type: 'cycle_start', cycle };
    appendTranscriptEvent(runDir, cycleStartEvent);

    const result = await runAgentLoop(openingMessage, loopDeps, loopConfig);
    perCycleMetrics.push(archiveCycleMetrics(runDir, cycle));

    if (result.status === 'budget_exceeded') {
      // Budgets end runs: no judge call, and no verdict/reason to record.
      cycleRecords.push({ cycle, workerStatus: result.status });
      finalResult = result;
      break;
    }

    let verdict: JudgeVerdict;
    try {
      verdict = await runJudge({ taskText, runDir, callModel: judgeCallModel });
    } catch (thrown) {
      // A cancellation is the caller's, not the judge's — honor it.
      if (thrown instanceof Error && thrown.name === 'AbortError') throw thrown;
      // Anything else is judge infrastructure failing (an API rejection, a
      // network fault) after the worker already finished its cycle. That
      // must never destroy the finished run (measured live 2026-08-13: an
      // API 400 on a judge request errored entire trials whose workers had
      // completed) — record the failure and end the run with the worker's
      // completed result. No rework cycle either: there is no verdict, so
      // there is no feedback a worker could act on.
      cycleRecords.push({
        cycle,
        workerStatus: result.status,
        judgeError: thrown instanceof Error ? thrown.message : String(thrown),
      });
      finalResult = result;
      break;
    }
    cycleRecords.push({
      cycle,
      workerStatus: result.status,
      verdict: verdict.verdict,
      // JudgeVerdict.reason is always '' on 'done' (see judge.ts) — nothing
      // worth recording there.
      ...(verdict.reason.length > 0 ? { reason: verdict.reason } : {}),
    });

    if (verdict.verdict === 'done' || cycle === maxWorkerCycles) {
      // Cycle exhaustion on a lingering 'continue' still ends the run with
      // the completed result — post-hoc graders decide; the harness only
      // records (see judge-design.md's "Loop" section).
      finalResult = result;
      break;
    }

    openingMessage = `${taskText}\n\nJudge feedback:\n${verdict.reason}`;
  }

  if (finalResult === undefined) {
    // Unreachable: maxWorkerCycles >= 1 (validated in runTask) guarantees at
    // least one iteration, and every iteration either breaks with
    // finalResult set or is the loop's last (cycle === maxWorkerCycles),
    // which also breaks with finalResult set.
    throw new Error('harness cycle loop ended without a result');
  }

  writeHarnessDiagnostics(runDir, {
    initializer: { model: INITIALIZER_MODEL },
    cycles: cycleRecords,
  });
  writeMetricsRollup(runDir, rollupCycleMetrics(finalResult.status, perCycleMetrics));

  return finalResult;
}
