import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  assertBrowserScriptSupportIsPaired,
  type BrowserController,
} from '../browser/controller.js';
import type { BrowserJavaScriptPolicy } from '../browser/browserJavaScript.js';
import type { HarnessCycleRecord } from '../harness/harness.js';
import {
  makeContractInitializerModelDriver,
  runContractInitializer,
  type ContractAuthor,
} from '../harness/initializer.js';
import { makeVerifierModelDriver } from '../harness/verifier.js';
import type { CallModel } from '../loop/messages.js';
import {
  appendWorkerFeedback,
  createWorkerSession,
  dropUnansweredAssistantTurn,
  restoreWorkerSession,
  type WorkerSession,
  type WorkerSessionDeps,
  type WorkerSessionSnapshot,
} from '../loop/workerSession.js';
import { findDevRoot, resolveSherlockPaths } from '../config/paths.js';
import {
  createRunBudgetTracker,
  withBudgetAccounting,
  type RunBudgetConfig,
  type RunBudgetTracker,
} from '../run/runBudget.js';
import {
  ceilingFromCheckpoint,
  ceilingToCheckpoint,
  openRunCheckpointStore,
  type RunCheckpointV1,
} from '../run/runCheckpointStore.js';
import { createRunCheckpointWriter, type RunCheckpointWriter } from './runCheckpoint.js';
import { syncScratchWorkspace } from '../run/syncScratchWorkspace.js';
import type { RunOutcome } from '../run/runOutcome.js';
import {
  DEFAULT_MODEL,
  makeCallModel,
  type CallModelConfig,
  type ProgressEvent,
} from '../model/callModel.js';
import {
  finalizeManifest,
  initManifest,
  readManifest,
  verifyManifestFiles,
} from '../run/artifacts.js';
import { generateRunId } from '../run/runId.js';
import { createRunDir } from '../run/runDir.js';
import {
  createRunTracing,
  type RunTracing,
} from '../tracing/runTracing.js';
import { createBashTool } from '../tools/index.js';
import {
  type ToolCtx,
  type ToolDef,
} from '../tools/registry.js';
import { SYSTEM_PROMPT } from './systemPrompt.js';
import { BASH_SECRET_ENV_DENYLIST, prepareLocalExecution } from './localExecution.js';
import { withCancellationGuard } from './cancellationGuard.js';
import { buildRunToolchain } from './runToolchain.js';
import {
  DEFAULT_MAX_COMPLETION_CHECK_FAILURES,
  runHarnessCycles,
  runVerificationHarness,
} from './harnessCycles.js';
import {
  createToolCallCheckpointHooks,
  type ToolCallCheckpointHooks,
} from './toolCallCheckpoint.js';
import {
  assertScalarConfigMatches,
  describeInterruptedBatch,
  reconstructPendingResult,
  validateStoredOutcome,
  RECOVERY_NOTICE,
} from './resumeRecovery.js';
import {
  isV3CheckpointVersion,
  resumeTaskV3,
  runTaskV3,
} from './runTaskV3.js';
import { readRunCheckpointVersion } from '../v3/run/checkpoint.js';

// Default runs base when the caller passes none: the checkout's runs/
// in a dev tree, ~/.sherlock/runs installed — never the cwd, which
// would scatter run directories across wherever callers launch from.
const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DEFAULT_RUNS_BASE_DIR = resolveSherlockPaths({
  devRoot: findDevRoot(PACKAGE_ROOT),
}).runsBaseDir;
const DEFAULT_MAX_OUTPUT_TOKENS = 8_192;
// Preserve the pre-cutover rollback/A-B route byte-for-byte: v3 owns the new
// finite 24-turn production default. Step 6 removes this constant with the
// rest of the legacy composition.
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
 * Tuning for the initializer → worker → verifier outer loop (see
 * .agents/planning/2026-08-12-research-quality-harness/judge-design.md).
 * Every run goes through this loop and the typed output-contract protocol —
 * there is no judge-less mode and no legacy prose-contract mode to opt out
 * of. `RunTaskConfig.harness` stays optional as a pure tuning bag: a caller
 * that omits it entirely gets every default below, not different behavior.
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
   * `RunTaskConfig.callModel`. Production default:
   * makeContractInitializerModelDriver. */
  initializerCallModel?: CallModel;
  /** Test seam for the verifier's read-only mini-loop, mirroring
   * `RunTaskConfig.callModel`. Production default: makeVerifierModelDriver. */
  verifierCallModel?: CallModel;
  /** How many times the automated completion checks may reject a
   * submission before the run ends incomplete; defaults to 5. Deliberately
   * separate from maxWorkerCycles: a code-check failure is objective and
   * cheap to fix, so it must not consume a scarce verifier attempt. */
  maxCompletionCheckFailures?: number;
  /** Which role states the run's output contract. Defaults to
   * 'initializer' — the architecture does not depend on which is picked,
   * since both feed the same store, code checks, and verifier. */
  contractAuthor?: ContractAuthor;
}

/** Configuration for one complete evidence-collection run. */
export interface RunTaskConfig {
  /** A live session browser with no active task tab. The caller owns and
   * eventually closes the session; runTask owns only the fresh tab it opens. */
  browser: BrowserController;
  /** Temporary migration/test selector. Production callers omit this and
   * receive v3. Step 6 removes the legacy value and this field after the
   * public cutover gate is green. */
  runtimeProtocol?: 'v3' | 'legacy';
  /** Directory that holds run directories; defaults to the checkout's
   * `runs/` in a dev tree, `~/.sherlock/runs` installed. */
  runsBaseDir?: string;
  /** Optional HTTP(S) page to load before the first model turn. */
  startUrl?: string;
  /** Model id; the production model client's default when omitted. */
  model?: string;
  /** Maximum tokens generated by each production model call; defaults to 8192. */
  maxOutputTokens?: number;
  /** Maximum worker model calls across the whole run; V3 defaults to 24. */
  maxTurns?: number;
  /** Per-request context ceiling (see LoopConfig.maxContextTokens);
   * defaults to 900000 (just under the model's 1M window, so runs end
   * budget_exceeded instead of crashing on the API's context limit). */
  maxContextTokens?: number;
  /** Maximum attempted tool calls across initializer, worker, and verifier.
   * V3 defaults to 100. Infinity remains an explicit opt-out. */
  maxToolCalls?: number;
  /** Maximum aggregate known model tokens across every role. V3 defaults to
   * 250000. Infinity remains an explicit opt-out. */
  maxModelTokens?: number;
  /** Maximum model-visible tool-result bytes across the run. V3 defaults to
   * 5000000. Infinity remains an explicit opt-out. */
  maxToolResultBytes?: number;
  /** Whole-run wall-clock limit including downtime across resume. V3 defaults
   * to one hour. Infinity remains an explicit opt-out. */
  maxWallTimeMs?: number;
  /** Optional callback for production model streaming progress. */
  onProgress?: (event: ProgressEvent) => void;
  /** Optional model implementation for tests or alternate clients. When
   * omitted, runTask creates the production streaming Anthropic client. */
  callModel?: CallModel;
  /**
   * TEST SEAM: stream-factory override forwarded, unchanged, to EVERY
   * role's production model client this run builds — the worker's
   * `makeCallModel`, the initializer's `makeContractInitializerModelDriver`
   * (when `harness.initializerCallModel` is not itself supplied), and the
   * verifier's `makeVerifierModelDriver` (when `harness.verifierCallModel`
   * is not itself supplied). Without this seam, a test that scripts only
   * `callModel` (or only one harness role's seam) still leaves the other
   * roles pointed at their real `makeCallModel` default, which builds a
   * genuine Anthropic client and makes a LIVE network call for that role —
   * exactly the hazard that made a harness run under test hit the network
   * for the initializer while only the worker's stream was scripted. Prefer
   * `callModel/harness.*CallModel` when a role needs distinct scripted
   * behavior; use `createStream` when every role should share one fake wire
   * and nothing else about the driver differs.
   */
  createStream?: CallModelConfig['createStream'];
  /** Optional run-scoped tracing implementation. When omitted, tracing is
   * configured from LANGFUSE_* environment variables or becomes a no-op. */
  tracing?: RunTracing;
  /** Optional resolver for interactive tool calls (the TUI wires its
   * question dialog here). When omitted — evals, headless CLI — tools that
   * require user interaction fail closed in the pipeline. */
  requestPermission?: ToolCtx['requestPermission'];
  /** Whether this session runs with a logged-in profile's authority. An
   * authenticated session must state `javascriptPolicy` explicitly — see
   * resolveJavaScriptPolicy — because inheriting a default there would hide a
   * real capability grant behind a convenience. */
  authenticated?: boolean;
  /** Whether page JavaScript may run. Required for authenticated sessions;
   * anonymous sessions default to 'allow'. */
  javascriptPolicy?: BrowserJavaScriptPolicy;
  /** Tuning for the initializer → worker → verifier outer loop every run
   * goes through (see HarnessConfig); optional purely as a tuning bag —
   * omitting it gets every default, not a different architecture. The run
   * is always durably checkpointed (see `resumeTask`). */
  harness?: HarnessConfig;
  /**
   * Cancellation for the run's tools, reaching work the model-call boundary
   * cannot.
   *
   * Aborting a model call already ends a run: the rejection propagates out of
   * the loop. But that only takes effect BETWEEN calls, so it could never stop
   * something already executing — which was harmless while every tool was a
   * short filesystem or page operation, and stops being harmless once `bash`
   * can hold a process group for two minutes. This signal reaches
   * `ToolCtx.abortSignal`, so cancelling a run terminates an in-flight command
   * instead of orphaning it.
   */
  signal?: AbortSignal;
}

/**
 * The finished run directory together with the run's terminal outcome.
 * `verified` (a judge `done` verdict) is the only success state;
 * `incomplete` carries an explicit reason — judge crash, exhausted
 * correction attempts, and budget exhaustion can no longer masquerade as
 * success (see RunOutcome).
 */
export type RunTaskResult = { runDir: string } & RunOutcome;

/**
 * The two production initializer bindings, injectable so that WHICH ONE gets
 * chosen is testable without a network call.
 *
 * Worth a seam of its own because the bindings are not interchangeable and
 * nothing about either one, tested alone, reveals a wrong choice between them.
 */
interface InitializerBindings {
  /** Contract author: offered set_output_contract, tool choice forced to it. */
  contract: () => CallModel;
}

/**
 * Build the initializer's default model binding.
 *
 * A seam of its own (rather than calling makeContractInitializerModelDriver
 * inline at the call site) survives from when a second binding existed and
 * choosing wrongly between them broke a live run: the prose binding was
 * offered no tools, so asking it for the `set_output_contract` call
 * `runContractInitializer` requires failed on every attempt. Only one
 * binding remains now, but the seam still lets a test assert what
 * production actually puts on the wire without a network call.
 *
 * @param bindings - overridable for tests; defaults to the production binding
 */
export function defaultInitializerCallModel(
  bindings: InitializerBindings = {
    contract: () => makeContractInitializerModelDriver({}),
  },
): CallModel {
  return bindings.contract();
}

/**
 * Build this run's static, checkpoint-durable configuration record.
 *
 * Shared by a fresh `runTask` start (which assembles it from `RunTaskConfig`
 * plus the values it already resolved) and `resumeTask`'s scalar-config
 * cross-check (which compares a caller's optional overrides against
 * whatever a PRIOR call to this same function recorded) — one function, so
 * the two can never describe "this run's configuration" differently.
 */
function buildCheckpointRunConfiguration(args: {
  model: string;
  maxOutputTokens: number;
  maxTurns: number;
  maxContextTokens: number;
  startUrl?: string;
  maxWorkerCycles: number;
  maxCompletionCheckFailures: number;
  contractAuthor: ContractAuthor;
}): RunCheckpointV1['runConfiguration'] {
  return {
    model: args.model,
    maxOutputTokens: args.maxOutputTokens,
    maxTurns: ceilingToCheckpoint(args.maxTurns),
    maxContextTokens: args.maxContextTokens,
    ...(args.startUrl === undefined ? {} : { startUrl: args.startUrl }),
    harness: {
      maxWorkerCycles: args.maxWorkerCycles,
      maxCompletionCheckFailures: args.maxCompletionCheckFailures,
      contractAuthor: args.contractAuthor,
    },
  };
}

/**
 * Run one task through the production evidence-collection stack: the
 * initializer derives the run's typed output contract from the task text (or
 * defers to the worker's own first response, per `harness.contractAuthor`),
 * then ONE persistent worker session runs up to `harness.maxWorkerCycles`
 * cycles against the same run directory and browser tab, every cycle
 * charging one shared whole-run budget. `verified` (a judge `done` verdict)
 * is the only success; a `budget_exceeded` cycle, a judge crash, and
 * correction exhaustion end the run `incomplete` with an explicit reason and
 * preserved artifacts. See runVerificationHarness for the loop itself, and
 * resumeTask for recovering a run this same process (or a later one) never
 * finished.
 *
 * @param taskText - the user's task, recorded verbatim in the manifest and
 *   sent as the first conversation message of cycle 1 (every later cycle's
 *   opening message is derived from it — see runHarnessCycles)
 * @param config - a live browser session with no active task tab plus
 *   optional run location, starting page, model settings, loop guards, and
 *   harness tuning; `callModel` may replace the production worker client at
 *   this dependency seam, and `harness.initializerCallModel`/
 *   `harness.verifierCallModel` do the same for the other two roles
 * @returns the absolute run directory and terminal outcome; before the
 *   promise resolves, the transcript and metrics are complete, the manifest
 *   is finalized, and this run's tab is closed while the browser stays open
 */
/** Temporary cutover selector. The immutable initializer-authored protocol is
 * v3 and is the default everywhere. `contractAuthor: 'worker'` retains the
 * old production path only until Step 6 deletes its remaining callers. */
export async function runTask(
  taskText: string,
  config: RunTaskConfig,
): Promise<RunTaskResult> {
  if (
    config.runtimeProtocol === 'v3' &&
    config.harness?.contractAuthor === 'worker'
  ) {
    throw new Error(
      'runtimeProtocol "v3" requires harness.contractAuthor "initializer"',
    );
  }
  if (
    config.runtimeProtocol === 'legacy' ||
    config.harness?.contractAuthor === 'worker'
  ) {
    return runTaskLegacy(taskText, config);
  }
  return runTaskV3(taskText, config);
}

async function runTaskLegacy(
  taskText: string,
  config: RunTaskConfig,
): Promise<RunTaskResult> {
  const unsupportedV3Budgets = [
    ['maxToolCalls', config.maxToolCalls],
    ['maxModelTokens', config.maxModelTokens],
    ['maxToolResultBytes', config.maxToolResultBytes],
    ['maxWallTimeMs', config.maxWallTimeMs],
  ]
    .filter((entry): entry is [string, number] => entry[1] !== undefined)
    .map(([name]) => name);
  if (unsupportedV3Budgets.length > 0) {
    throw new Error(
      `legacy runtimeProtocol does not support v3 budget fields: ` +
        unsupportedV3Budgets.join(', '),
    );
  }

  const maxOutputTokens = config.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
  if (!Number.isInteger(maxOutputTokens) || maxOutputTokens < 1) {
    throw new Error(
      `maxOutputTokens must be a positive integer, got ${maxOutputTokens}`,
    );
  }

  const maxWorkerCycles = config.harness?.maxWorkerCycles ?? 3;
  if (!Number.isInteger(maxWorkerCycles) || maxWorkerCycles < 1) {
    throw new Error(
      `harness.maxWorkerCycles must be a positive integer, got ${maxWorkerCycles}`,
    );
  }

  const contractAuthor: ContractAuthor = config.harness?.contractAuthor ?? 'initializer';
  const maxCompletionCheckFailures =
    config.harness?.maxCompletionCheckFailures ?? DEFAULT_MAX_COMPLETION_CHECK_FAILURES;
  const resolvedModel = config.model ?? DEFAULT_MODEL;
  const resolvedMaxTurns = config.maxTurns ?? DEFAULT_MAX_TURNS;

  const runDirForRun = createRunDir(
    config.runsBaseDir ?? DEFAULT_RUNS_BASE_DIR,
    // The task text names the run dir (slugified), so listings read like a
    // history of what was asked rather than a wall of timestamps.
    generateRunId(taskText),
  );
  const runDir = runDirForRun;
  // Only the Browserbase provider attaches diagnostics, so their absence is
  // local Chrome — the same inference the startup banner makes.
  initManifest(runDir, taskText, config.browser.sessionDiagnostics?.provider ?? 'local');

  // One budget tracker for the whole run — initializer, every worker cycle,
  // and every judge call charge the same instance, and starting a
  // correction resets nothing. Constructed (and validated) here — right
  // after the run directory exists — and before the registry so the
  // checkpoint writer below has a live tracker to read from.
  const budget: RunBudgetTracker = createRunBudgetTracker({
    maxWorkerTurns: resolvedMaxTurns,
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

  const checkpointWriter: RunCheckpointWriter = createRunCheckpointWriter(
    await openRunCheckpointStore(runDir),
    {
      runConfiguration: buildCheckpointRunConfiguration({
        model: resolvedModel,
        maxOutputTokens,
        maxTurns: resolvedMaxTurns,
        maxContextTokens,
        ...(config.startUrl === undefined ? {} : { startUrl: config.startUrl }),
        maxWorkerCycles,
        maxCompletionCheckFailures,
        contractAuthor,
      }),
      budget,
    },
  );

  // Before any model call: prove the shell exists and the command workspace is
  // there, so `bash` is either genuinely available or the run fails now rather
  // than after the worker has planned around it.
  prepareLocalExecution(runDir);
  assertBrowserScriptSupportIsPaired(config.browser);

  // One bash tool per run, closing over this run's denylist. Supplied to
  // whichever registry gets built — it is a factory precisely so the policy
  // travels with the run rather than living in a module-level array.
  const bashTool = createBashTool({
    secretEnvDenylist: BASH_SECRET_ENV_DENYLIST,
  }) as ToolDef;

  const toolchain = buildRunToolchain({
    runDir,
    browser: config.browser,
    javascriptPolicy: config.javascriptPolicy,
    authenticated: config.authenticated,
    bashTool,
  });

  const baseCallModel = config.callModel ?? withCancellationGuard(
    makeCallModel({
      model: config.model,
      system: SYSTEM_PROMPT,
      apiToolDefs: toolchain.apiToolDefs,
      maxOutputTokens,
      onProgress: config.onProgress,
      signal: config.signal,
      createStream: config.createStream,
    }),
    config.signal,
  );

  const tracing = config.tracing ?? createRunTracing();
  const callModel = tracing.wrapCallModel(baseCallModel, resolvedModel);
  const tracedRegistry = tracing.wrapRegistry(toolchain.registry);

  let tabOpened = false;
  try {
    // Derive the run's output contract from the task text alone, before any
    // browsing starts, so a failure here still lets the finally below
    // finalize the manifest. Deliberately outside tracing.traceRun and never
    // through tracing.wrapCallModel — per the design, initializer and judge
    // calls run untraced in v1; their token usage still lands on the shared
    // budget via withBudgetAccounting.
    await checkpointWriter.saveInitializing();
    const initializerCallModel = withBudgetAccounting(
      config.harness?.initializerCallModel ??
        withCancellationGuard(
          defaultInitializerCallModel(
            config.createStream === undefined && config.signal === undefined
              ? undefined
              : {
                  contract: () =>
                    makeContractInitializerModelDriver({
                      createStream: config.createStream,
                      signal: config.signal,
                    }),
                },
          ),
          config.signal,
        ),
      budget,
      'initializer',
    );
    if (contractAuthor === 'initializer') {
      const authored = await runContractInitializer(
        taskText,
        initializerCallModel,
        toolchain.outputContracts,
      );
      if (!authored.ok) {
        // A run whose requirements were never validated must not proceed
        // as if they had been.
        throw new Error(`Contract initializer failed: ${authored.reason}`);
      }
      await checkpointWriter.saveInitializerAccepted({
        mode: 'contract',
        contractRevision: authored.revision,
      });
    } else {
      // contractAuthor 'worker': the worker states the contract itself on
      // its first response (the contract-first gate) — there is no
      // initializer call to accept here. Still record which protocol this
      // run is on, so a resume from a checkpoint saved before any contract
      // exists knows the contract-first gate is active without re-deriving
      // it from runConfiguration alone.
      await checkpointWriter.saveInitializerAccepted({ mode: 'contract' });
    }

    const result = await tracing.traceRun(taskText, async () => {
      await config.browser.newTab();
      tabOpened = true;

      if (config.startUrl !== undefined) {
        await config.browser.goto(config.startUrl);
      }

      // Created before the session because it is one of the session's deps,
      // and bound after, once the session exists — see
      // createToolCallCheckpointHooks.
      const toolCheckpoint = createToolCallCheckpointHooks();

      const loopDeps: WorkerSessionDeps = {
        callModel,
        registry: tracedRegistry,
        runDir,
        browser: config.browser,
        requestPermission: config.requestPermission,
        toolHooks: toolCheckpoint.hooks,
        busyRegistry: toolchain.busyRegistry,
        // Reaches an in-flight command, unlike the model-call boundary the
        // TUI's cancellation already covers.
        ...(config.signal === undefined ? {} : { abortSignal: config.signal }),
        outputContracts: toolchain.outputContracts,
        outputTables: toolchain.outputTables,
        evidenceStore: toolchain.evidenceStore,
      };

      return runVerificationHarness(
        taskText,
        runDir,
        config.harness ?? {},
        maxWorkerCycles,
        loopDeps,
        { budget, maxContextTokens },
        checkpointWriter,
        toolCheckpoint,
        config.createStream,
        config.signal,
      );
    });
    return { runDir, ...result };
  } finally {
    try {
      if (tabOpened) {
        await config.browser.closeTaskPages();
      }
    } finally {
      try {
        // Closed before finalizeManifest, without masking an in-flight
        // error: an ordinary awaited call in its own finally layer, exactly
        // like closeTaskPages/tracing.close beside it — a failure here propagates
        // normally rather than being swallowed.
        await checkpointWriter.close();
      } finally {
        try {
          finalizeManifest(runDir);
        } finally {
          await tracing.close();
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// resumeTask
// ---------------------------------------------------------------------------

/**
 * The non-serializable half of `RunTaskConfig`: everything a resumed run
 * needs that a checkpoint cannot hold — a live browser, live model-call
 * seams, and the recovery-specific confirmation below. Every scalar
 * `RunTaskConfig` field the checkpoint already remembers (model,
 * maxOutputTokens, maxTurns, maxContextTokens, startUrl, and every
 * `harness.*` scalar) is read from the checkpoint, not from this config —
 * `resumeTask` cannot silently continue a run under different settings than
 * it started with. Repeating one of those fields here is optional and
 * purely a safety check: when given, it must match what the checkpoint
 * recorded, or `resumeTask` fails loudly rather than guessing which one is
 * right (see `assertScalarConfigMatches`).
 */
export interface ResumeTaskConfig {
  /** A live session browser with no active task tab — ALWAYS a fresh
   * controller, never the one the interrupted process held. See the module
   * note on why prior page/element refs cannot be reused. */
  browser: BrowserController;
  /** Safety check against `runConfiguration.model`; omit to trust the
   * checkpoint. */
  model?: string;
  /** Safety check against `runConfiguration.maxOutputTokens`; omit to trust
   * the checkpoint. */
  maxOutputTokens?: number;
  /** Safety check against `runConfiguration.maxTurns`; omit to trust the
   * checkpoint. */
  maxTurns?: number;
  /** Safety check against `runConfiguration.maxContextTokens`; omit to trust
   * the checkpoint. */
  maxContextTokens?: number;
  /** Safety check against the durable v3 tool-call ceiling. */
  maxToolCalls?: number;
  /** Safety check against the durable v3 aggregate model-token ceiling. */
  maxModelTokens?: number;
  /** Safety check against the durable v3 tool-result byte ceiling. */
  maxToolResultBytes?: number;
  /** Safety check against the durable v3 whole-run wall-clock ceiling. */
  maxWallTimeMs?: number;
  /** Safety check against `runConfiguration.startUrl`; omit to trust the
   * checkpoint. */
  startUrl?: string;
  /** Optional live-progress callback for the resumed worker's model calls. */
  onProgress?: (event: ProgressEvent) => void;
  /** Optional model implementation for the resumed WORKER's calls (tests or
   * alternate clients). The initializer is never re-invoked on resume (see
   * the module note on `resumeTask`'s 'initializing' handling), so there is
   * no `initializerCallModel` seam here. */
  callModel?: CallModel;
  /**
   * TEST SEAM: same stream-factory override as `RunTaskConfig.createStream`,
   * forwarded to the resumed WORKER's `makeCallModel` (when `callModel` is
   * not itself supplied) and to `harness.verifierCallModel`'s default
   * `makeVerifierModelDriver` (when that seam is not itself supplied). The
   * initializer is never re-invoked on resume (see `callModel`'s note
   * above), so there is nothing else this needs to reach. Without it, a
   * resumed run under test with only `callModel` scripted still leaves the
   * verifier pointed at a real `makeVerifierModelDriver()`, which makes a
   * LIVE network call.
   */
  createStream?: CallModelConfig['createStream'];
  /** Optional run-scoped tracing implementation for the resumed run's
   * segment (a resumed run's trace is a NEW segment, not a continuation of
   * the original run's trace — tracing state is not part of the
   * checkpoint). */
  tracing?: RunTracing;
  /** Optional resolver for interactive tool calls. */
  requestPermission?: ToolCtx['requestPermission'];
  /**
   * Explicit assertion of whether the fresh resume controller carries an
   * authenticated session. Required at runtime for v3 checkpoints so an
   * anonymous run cannot resume onto logged-in browser state without renewed
   * caller authority; optional here only for legacy v1 resume compatibility.
   */
  authenticated?: boolean;
  /** See RunTaskConfig.javascriptPolicy. */
  javascriptPolicy?: BrowserJavaScriptPolicy;
  harness?: {
    /** Safety check against `runConfiguration.harness.maxWorkerCycles`. */
    maxWorkerCycles?: number;
    /** Safety check against `runConfiguration.harness.maxCompletionCheckFailures`. */
    maxCompletionCheckFailures?: number;
    /** Safety check against `runConfiguration.harness.contractAuthor`. */
    contractAuthor?: ContractAuthor;
    /** Test/alternate model seam needed only when a v3 resume continues an
     * initializer request that had not yet produced an accepted contract. */
    initializerCallModel?: CallModel;
    /** Test seam for the verifier's read-only mini-loop — the only
     * harness-role model binding a resumed run can still need. */
    verifierCallModel?: CallModel;
  };
  /** See RunTaskConfig.signal. */
  signal?: AbortSignal;
  /**
   * Must be `true` whenever the checkpoint being resumed could have left a
   * `bash` command running in `scratch/workspace` when the process stopped
   * — i.e. whenever `runStatus` is `'ready_for_model'` (see the module note
   * on why the other statuses can never have a command in flight).
   * `resumeTask` throws instead of guessing when this is required and not
   * given; once given, it triggers `syncScratchWorkspace` before any hash
   * verification, so the manifest catches up with whatever the interrupted
   * command left behind.
   */
  confirmPreviousCommandStopped?: boolean;
}

/**
 * Resume a run this process (or an earlier one) checkpointed but never
 * finished.
 *
 * Every `runTask` run opens a checkpoint store, so any run directory it
 * created has one — but a directory with no `harness/checkpoint.json` at
 * all (never passed to `runTask`, or from before this store existed) has
 * nothing to resume; this throws rather than inventing a starting point.
 *
 * Recovery sequence (see the inline comments below for exactly where each
 * check sits): open the store (which acquires `harness/run.lock` first, so
 * two resume attempts on the same run directory can never race); validate
 * the checkpoint against the request; sync `scratch/workspace` and verify
 * every manifest-tracked file's bytes BEFORE any model call; finish an
 * interrupted deterministic initializer write, if there is one; restore the
 * worker session and budget from their durable snapshots; rehydrate the
 * typed contract store; open a fresh browser tab; append the one-time
 * recovery notice; and continue the harness loop from exactly where the
 * checkpoint left off.
 *
 * Every run-scoped store is rebuilt from disk, not started empty: the output
 * CONTRACT from its durable revision files, the EVIDENCE ledger from
 * `scratch/evidence/`, and the typed ROWS from `scratch/tables/` (see
 * `RunToolchainInputs.restore`). Evidence ids therefore keep resolving after
 * a resume, and rows minted since the last submission survive it.
 *
 * Fault windows this still does NOT close (see also runCheckpoint.ts's module
 * comment): a crash mid-tool-batch re-runs the whole in-flight worker turn.
 * Per-call checkpoints make that turn's interruption DESCRIBABLE — the
 * resumed model is told which call was in flight and which had already
 * finished — but not replayable, because a turn's results reach the
 * conversation only when the entire batch returns, so half a batch has no
 * valid conversation to be replayed into. A resumed run's tracing is also a
 * new segment, never a continuation of the original run's trace.
 */
/** Route resume by the durable checkpoint discriminator without acquiring or
 * mutating either dialect's run lock. V1 is retained only for runs created by
 * the temporary worker-contract legacy route. */
export async function resumeTask(
  runDir: string,
  config: ResumeTaskConfig,
): Promise<RunTaskResult> {
  const version = readRunCheckpointVersion(runDir);
  if (isV3CheckpointVersion(version)) return resumeTaskV3(runDir, config);
  return resumeTaskLegacy(runDir, config);
}

async function resumeTaskLegacy(
  runDir: string,
  config: ResumeTaskConfig,
): Promise<RunTaskResult> {
  const store = await openRunCheckpointStore(runDir);
  try {
    const checkpoint = store.load();
    if (checkpoint === undefined) {
      throw new Error(
        `no checkpoint to resume at ${runDir} — only harness-mode runs are checkpointed`,
      );
    }
    assertScalarConfigMatches(checkpoint.runConfiguration, config);

    // A bash command can only ever be running between a 'ready_for_model'
    // save and the next one: 'initializing' never reaches a tool call (the
    // initializer makes at most one forced set_output_contract call, never
    // bash), and 'verifying' is saved only after a cycle's own turn (or
    // turns) have all already returned — the sole thing that runs between a
    // 'verifying' save and the next is runVerifier's read-only, tool-free
    // model call.
    //
    // 'executing_tools' is the same window seen from the inside: it is saved
    // only while a batch is actually running, so it is the ONE status that
    // says a command was in flight rather than merely might have been.
    const mayHaveCommandInFlight =
      checkpoint.runStatus === 'ready_for_model' ||
      checkpoint.runStatus === 'executing_tools';
    if (mayHaveCommandInFlight) {
      if (config.confirmPreviousCommandStopped !== true) {
        throw new Error(
          `cannot resume ${runDir}: this checkpoint (status '${checkpoint.runStatus}') may ` +
            'have left a bash command running in scratch/workspace when the process stopped. ' +
            'Confirm the previous process is actually gone, then pass ' +
            'confirmPreviousCommandStopped: true to resume.',
        );
      }
      // Before any hash verification: catches up the manifest with whatever
      // an interrupted command left in scratch/workspace, so a legitimate
      // change there is never mistaken for tampering by the check below.
      syncScratchWorkspace(runDir);
    }
    // Changed bytes fail recovery before any model call — a run that
    // resumes on top of silently altered evidence or artifacts is worse
    // than a run that refuses to resume at all.
    verifyManifestFiles(runDir);

    if (checkpoint.runStatus === 'terminal') {
      // Zero model and tool calls: the run already ended, and idempotent
      // finalization is all that is left to do — the original process may
      // have crashed after saveTerminal but before finalizeManifest ran.
      const outcome = validateStoredOutcome(checkpoint.finalOutcome, runDir);
      finalizeManifest(runDir);
      return { runDir, ...outcome };
    }

    prepareLocalExecution(runDir);
    assertBrowserScriptSupportIsPaired(config.browser);

    const harnessConfiguration = checkpoint.runConfiguration.harness;
    if (harnessConfiguration === undefined) {
      throw new Error(
        `checkpoint at ${runDir} has no harness configuration — only harness-mode runs are ` +
          'checkpointed',
      );
    }
    const maxWorkerCycles = harnessConfiguration.maxWorkerCycles;
    const maxContextTokens = checkpoint.runConfiguration.maxContextTokens;
    const taskText = readManifest(runDir).task;

    // Nothing to finish deterministically while runStatus is still
    // 'initializing': an initializer-authored contract accepted before the
    // crash is already durable on disk and picked back up by
    // rehydrateContractStore below; if the initializer's own call never
    // completed, the worker's own set_output_contract call — offered
    // unconditionally regardless of contractAuthor — can still establish
    // revision 1 once the resumed session starts.

    const bashTool = createBashTool({ secretEnvDenylist: BASH_SECRET_ENV_DENYLIST }) as ToolDef;
    const toolchain = buildRunToolchain({
      runDir,
      browser: config.browser,
      javascriptPolicy: config.javascriptPolicy,
      authenticated: config.authenticated,
      bashTool,
      // Rebuilds the contract, evidence, and typed-row stores from disk (see
      // RunToolchainInputs.restore) — including the contract rehydration this
      // function used to perform itself, which had to move inside so it
      // happens before the row replay that depends on it.
      restore: true,
    });

    const tracing = config.tracing ?? createRunTracing();
    const baseCallModel = config.callModel ?? withCancellationGuard(
      makeCallModel({
        model: checkpoint.runConfiguration.model,
        system: SYSTEM_PROMPT,
        apiToolDefs: toolchain.apiToolDefs,
        maxOutputTokens: checkpoint.runConfiguration.maxOutputTokens,
        onProgress: config.onProgress,
        signal: config.signal,
        createStream: config.createStream,
      }),
      config.signal,
    );
    const callModel = tracing.wrapCallModel(baseCallModel, checkpoint.runConfiguration.model);
    const tracedRegistry = tracing.wrapRegistry(toolchain.registry);

    const budgetConfig: RunBudgetConfig = {
      maxWorkerTurns: ceilingFromCheckpoint(checkpoint.budget.config.maxWorkerTurns),
      maxToolCalls: ceilingFromCheckpoint(checkpoint.budget.config.maxToolCalls),
      maxModelTokens: ceilingFromCheckpoint(checkpoint.budget.config.maxModelTokens),
      maxToolResultBytes: ceilingFromCheckpoint(checkpoint.budget.config.maxToolResultBytes),
      maxWallTimeMs: ceilingFromCheckpoint(checkpoint.budget.config.maxWallTimeMs),
      maxVerifierCorrections: ceilingFromCheckpoint(checkpoint.budget.config.maxVerifierCorrections),
    };
    // restore backdates startedAt by the snapshot's already-elapsed wall
    // time (see createRunBudgetTracker) — a restart never refills headroom.
    const budget = createRunBudgetTracker(budgetConfig, {
      restore: {
        elapsedWallTimeMs: checkpoint.budget.elapsedWallTimeMs,
        roles: checkpoint.budget.roles,
        toolCalls: checkpoint.budget.toolCalls,
        toolResultBytes: checkpoint.budget.toolResultBytes,
        corrections: checkpoint.budget.corrections,
      },
    });

    const checkpointWriter = createRunCheckpointWriter(store, {
      runConfiguration: checkpoint.runConfiguration,
      budget,
    });

    const toolCheckpoint = createToolCallCheckpointHooks();

    const sessionDeps: WorkerSessionDeps = {
      callModel,
      registry: tracedRegistry,
      runDir,
      browser: config.browser,
      requestPermission: config.requestPermission,
      toolHooks: toolCheckpoint.hooks,
      busyRegistry: toolchain.busyRegistry,
      ...(config.signal === undefined ? {} : { abortSignal: config.signal }),
      outputContracts: toolchain.outputContracts,
      outputTables: toolchain.outputTables,
      evidenceStore: toolchain.evidenceStore,
    };
    const sessionConfig = { budget, maxContextTokens };
    // Present exactly when runStatus already left 'initializing' (see
    // runCheckpointV1Schema's own superRefine) — a fresh WorkerSession is
    // built otherwise, exactly as a brand-new runTask call would.
    const session: WorkerSession =
      checkpoint.workerSession === undefined
        ? createWorkerSession(taskText, sessionDeps, sessionConfig)
        : restoreWorkerSession(
            // Opaque cargo as far as the checkpoint schema is concerned
            // (see runCheckpointStore.ts's module comment) — this writer's
            // own assembleSession put exactly this shape there.
            checkpoint.workerSession as unknown as WorkerSessionSnapshot,
            sessionDeps,
            sessionConfig,
          );

    let tabOpened = false;
    try {
      // A NEW BrowserController every time: the interrupted process's tab,
      // page refs, and element refs are gone with it. Reusing them would be
      // reusing state that no longer corresponds to anything real.
      await config.browser.newTab();
      tabOpened = true;
      if (checkpoint.runConfiguration.startUrl !== undefined) {
        await config.browser.goto(checkpoint.runConfiguration.startUrl);
      }

      // Exactly one recovery notice. Safe to append immediately here for
      // every case except resuming a 'verifying' checkpoint, where the
      // conversation's last message is an unanswered submit_for_verification
      // tool_use — inserting a plain user message before that call is
      // answered would make the next request invalid. That one case defers
      // the notice into runHarnessCycles's pendingNotice instead (folded
      // into the first feedback this run produces).
      //
      // 'executing_tools' has the same hazard from the other direction, and it
      // is not solved by deferring: that status is saved mid-turn, so its
      // conversation ENDS with tool_use blocks nothing answered. Those have to
      // go before anything is appended after them — see
      // dropUnansweredAssistantTurn for why sending them would fail the resume
      // outright rather than recover it.
      if (checkpoint.runStatus === 'executing_tools') {
        dropUnansweredAssistantTurn(session);
      }

      // The same checkpoint knows WHICH call was in flight, so the notice can
      // say so specifically instead of leaving the model to guess whether its
      // last action landed.
      const interrupted = describeInterruptedBatch(checkpoint);
      const recoveryNotice =
        interrupted === undefined ? RECOVERY_NOTICE : `${RECOVERY_NOTICE} ${interrupted}`;

      const deferNotice = checkpoint.runStatus === 'verifying';
      if (!deferNotice) {
        appendWorkerFeedback(session, recoveryNotice);
      }

      const verifierCallModel = withBudgetAccounting(
        config.harness?.verifierCallModel ??
          withCancellationGuard(
            makeVerifierModelDriver({ createStream: config.createStream, signal: config.signal }),
            config.signal,
          ),
        budget,
        'verifier',
      );

      const cycleRecords = [...(checkpoint.runProgress.cycleRecords as HarnessCycleRecord[])];
      const start =
        checkpoint.workerSession === undefined
          ? { cycle: 1, completionCheckFailures: 0, cycleRecords: [] as HarnessCycleRecord[] }
          : {
              cycle: checkpoint.runProgress.currentCycle,
              completionCheckFailures: checkpoint.runProgress.completionCheckFailures,
              cycleRecords,
              ...(checkpoint.runStatus === 'verifying'
                ? { precomputedResult: reconstructPendingResult(session) }
                : {}),
              ...(deferNotice ? { pendingNotice: recoveryNotice } : {}),
            };

      const result = await runHarnessCycles({
        taskText,
        runDir,
        maxWorkerCycles,
        maxCompletionCheckFailures: harnessConfiguration.maxCompletionCheckFailures,
        session,
        verifierCallModel,
        checkpointWriter,
        toolCheckpoint,
        start,
      });
      return { runDir, ...result };
    } finally {
      try {
        if (tabOpened) {
          await config.browser.closeTaskPages();
        }
      } finally {
        try {
          finalizeManifest(runDir);
        } finally {
          await tracing.close();
        }
      }
    }
  } finally {
    // Idempotent (see RunCheckpointStore.close) — safe even when
    // checkpointWriter.close() was never reached above (the terminal
    // short-circuit, or any throw before it), and safe as the second call
    // if it was.
    await store.close();
  }
}
