import { accessSync, constants as fsConstants, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  FileCredentialStore,
  type CredentialStore,
} from '../auth/credentialStore.js';
import {
  assertBrowserScriptSupportIsPaired,
  type BrowserController,
} from '../browser/controller.js';
import {
  writeHarnessDiagnostics,
  type HarnessCycleRecord,
  type HarnessOutcomeRecord,
} from '../harness/harness.js';
import {
  INITIALIZER_MODEL,
  makeContractInitializerModelDriver,
  makeInitializerCallModel,
  runContractInitializer,
  runInitializer,
  writeInitializerFiles,
  type ContractAuthor,
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
import type { AssistantContentBlock, TextBlock } from '../loop/messages.js';
import {
  appendSubmissionResult,
  appendWorkerFeedback,
  createWorkerSession,
  dropUnansweredAssistantTurn,
  recordWorkerSessionCrash,
  restoreWorkerSession,
  runWorkerTurn,
  writeWorkerSessionMetrics,
  type WorkerSession,
  type WorkerSessionDeps,
  type WorkerSessionSnapshot,
  type WorkerTurnOutcome,
} from '../loop/workerSession.js';
import {
  runCompletionCheck,
  type CompletionFailure,
  type SettledFact,
} from '../completion/completionCheck.js';
import { SUBMIT_FOR_VERIFICATION } from '../completion/workerResponseProtocol.js';
import { finalizeIncompleteRun } from '../completion/finalizeIncompleteRun.js';
import { findDevRoot, resolveSherlockPaths } from '../config/paths.js';
import type { CallModel } from '../loop/messages.js';
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
  type ProgressEvent,
} from '../model/callModel.js';
import {
  finalizeManifest,
  initManifest,
  readManifest,
  verifyManifestFiles,
  SCRATCH_DIR,
} from '../run/artifacts.js';
import { generateRunId } from '../run/runId.js';
import { createRunDir } from '../run/runDir.js';
import { appendTranscriptEvent, type CycleStartEvent } from '../run/transcript.js';
import {
  createRunTracing,
  type RunTracing,
} from '../tracing/runTracing.js';
import {
  createBashTool,
  createProductionRegistry,
  DEFAULT_TOOL_PROFILE,
  type ToolProfile,
} from '../tools/index.js';
import {
  toApiToolDefs,
  type ApiToolDef,
  type ToolCtx,
  type ToolDef,
  type ToolRegistry,
} from '../tools/registry.js';
import type { ToolCall } from '../tools/pipeline.js';
import type { ToolCallLifecycleHooks } from '../loop/scheduler.js';
import { createV2Registry } from '../tools/index.js';
import { createOutputRowTools } from '../tools/outputRows/outputRows.js';
import { createInspectDocumentTool } from '../tools/inspectDocument/inspectDocument.js';
import {
  createOutputTableStore,
  restoreOutputTableStore,
  type OutputTableStore,
} from '../outputs/outputTable.js';
import {
  createEvidenceStore,
  restoreEvidenceStore,
  type EvidenceStore,
} from '../evidence/evidenceStore.js';
import {
  createContentReaderRegistry,
} from '../content/contentReader.js';
import { createPdfContentReader } from '../content/pdfContentReader.js';
import { createSpreadsheetContentReader } from '../content/spreadsheetContentReader.js';
import { createOcrContentReader } from '../content/ocrContentReader.js';
import {
  toEarlyJavaScriptRequest,
  type BrowserJavaScriptPolicy,
} from '../browser/browserJavaScript.js';
import { createExecuteJavascriptTool } from '../tools/executeJavascript/executeJavascript.js';
import { createCaptureTextTool } from '../tools/captureText/captureText.js';
import { createWriteDocumentTool } from '../tools/writeDocument/writeDocument.js';
import { createPlaywrightPdfPageOpener } from '../outputs/renderDocument.js';
import type { DocumentOutputSpec } from '../outputs/documentSource.js';
import { requireBrowser } from '../tools/shared/browser.js';
import type { OutputSpec } from '../contracts/outputContract.js';
import { submitForVerificationTool } from '../tools/submitForVerification/submitForVerification.js';
import {
  contractRevisionPath,
  createOutputContractStore,
  type OutputContractStore,
} from '../contracts/outputContractStore.js';
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
/** How many times the code checks may reject a submission before the run
 * ends incomplete. Separate from (and larger than) the verifier's budget:
 * a code-check failure is cheap, objective, and usually a one-line fix, so
 * spending a scarce verifier attempt on one would be waste. */
const DEFAULT_MAX_COMPLETION_CHECK_FAILURES = 5;

/**
 * Environment variables the `bash` child must never inherit — THE one place a
 * new harness credential has to be added.
 *
 * Every name here was found by enumerating what this codebase actually reads
 * from `process.env`, not by guessing at a general list of scary-looking
 * names. Prefix entries end with `_` and strip a whole family.
 *
 * Be clear about what this does and does not buy. It is reproducibility and
 * blast-radius hygiene: a generated script cannot casually read the model key
 * out of its own environment and spend it, or exfiltrate tracing credentials
 * because it happened to run `env`. It is NOT a security boundary. Commands
 * run as the same operating-system user as this process, so anything that user
 * can read — including the credentials file this list deliberately hides the
 * PATH to — is still reachable by a command that goes looking. Treat the
 * denylist as removing an easy accident, never as containing a determined one.
 */
export const BASH_SECRET_ENV_DENYLIST: readonly string[] = [
  // Model provider credentials.
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  // Tracing credentials (LANGFUSE_PUBLIC_KEY / _SECRET_KEY / _BASE_URL).
  'LANGFUSE_',
  // Where stored site logins live. The file's own permissions still guard it;
  // this only avoids handing over its location for free.
  'CREDENTIALS_FILE',
  // A token present in developer shells that no generated script needs.
  'GITHUB_TOKEN',
];

/** The shell `bash` invokes. Fixed rather than configurable until a concrete
 * environment needs otherwise. */
const BASH_SHELL_PATH = '/bin/bash';

/**
 * Fail before the first model call if local execution cannot work.
 *
 * Both checks are cheap and both are things the worker would otherwise
 * discover mid-run, having already spent tokens planning around a tool that
 * was never going to run. `scratch/workspace` is created owner-only; an
 * existing directory is validated rather than silently re-permissioned, since
 * quietly widening a mode nobody asked us to change is worse than reporting it.
 */
function prepareLocalExecution(runDir: string): void {
  try {
    accessSync(BASH_SHELL_PATH, fsConstants.X_OK);
  } catch {
    throw new Error(
      `local code execution requires an executable ${BASH_SHELL_PATH}, which this ` +
        'host does not provide',
    );
  }
  const workspace = join(runDir, SCRATCH_DIR, 'workspace');
  mkdirSync(workspace, { recursive: true, mode: 0o700 });
}

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
  /** How many times the automated completion checks may reject a
   * submission before the run ends incomplete; defaults to 5. Deliberately
   * separate from maxWorkerCycles: a code-check failure is objective and
   * cheap to fix, so it must not consume a scarce verifier attempt. */
  maxCompletionCheckFailures?: number;
  /** Enables the V2 completion protocol: a run-scoped output-contract store,
   * the `set_output_contract` and `submit_for_verification` tools, the
   * contract-first gate, and code checks before the verifier. Defaults to
   * false during the migration so the prose INTENT.md/CONTRACT.md path keeps
   * working unchanged; T16 flips the default as part of the cutover. */
  outputContract?: boolean;
  /** Which role states the run's output contract (T4). Defaults to
   * 'initializer', preserved as the migration default until a
   * user-authorized measured comparison chooses otherwise — the
   * architecture does not depend on which is picked, since both feed the
   * same store, code checks, and verifier. */
  contractAuthor?: ContractAuthor;
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
  /** Whether this session runs with a logged-in profile's authority. An
   * authenticated session must state `javascriptPolicy` explicitly — see
   * resolveJavaScriptPolicy — because inheriting a default there would hide a
   * real capability grant behind a convenience. */
  authenticated?: boolean;
  /** Whether page JavaScript may run. Required for authenticated sessions;
   * anonymous sessions default to 'allow'. */
  javascriptPolicy?: BrowserJavaScriptPolicy;
  /** Enables the initializer → worker → verifier outer loop (see
   * HarnessConfig). Absent (the default): today's behavior, byte-for-byte —
   * one runAgentLoop call, no INTENT.md/CONTRACT.md/harness.json, no
   * verifier. Present: the initializer writes INTENT.md and CONTRACT.md
   * before the browser tab opens, then up to `maxWorkerCycles` worker cycles
   * run against the same tab, each verified before deciding whether another
   * cycle runs. Present also means the run is durably checkpointed (see
   * `resumeTask`) — a judge-less run (harness absent) never opens a
   * checkpoint store and behaves byte-for-byte as it always has. */
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
 * Judge-less runs end `completed` or `budget_exceeded` (the historical
 * LoopResult contract, unchanged). Harness runs end `verified` — the only
 * success state — or `incomplete` with an explicit reason: judge crash,
 * exhausted correction attempts, and budget exhaustion can no longer
 * masquerade as success (see RunOutcome).
 */
export type RunTaskResult = { runDir: string } & (LoopResult | RunOutcome);

/**
 * The two production initializer bindings, injectable so that WHICH ONE gets
 * chosen is testable without a network call.
 *
 * Worth a seam of its own because the bindings are not interchangeable and
 * nothing about either one, tested alone, reveals a wrong choice between them.
 */
export interface InitializerBindings {
  /** Prose INTENT.md/CONTRACT.md author. Offered no tools. */
  prose: () => CallModel;
  /** Contract author: offered set_output_contract, tool choice forced to it. */
  contract: () => CallModel;
}

/**
 * Pick the initializer binding that matches the protocol about to consume it.
 *
 * This mattered in production: the prose binding is offered NO tools, so
 * asking it for the `set_output_contract` call that `runContractInitializer`
 * requires fails on every attempt — a model cannot call a tool it was never
 * given. Both roles read the same `harness.contractAuthor`, so the default is
 * chosen here rather than at the call site, where the two could drift apart.
 *
 * @param v2Protocol - true when `harness.outputContract` is on
 * @param bindings - overridable for tests; defaults to the production pair
 */
export function defaultInitializerCallModel(
  v2Protocol: boolean,
  bindings: InitializerBindings = {
    prose: () => makeInitializerCallModel({}),
    contract: () => makeContractInitializerModelDriver({}),
  },
): CallModel {
  return v2Protocol ? bindings.contract() : bindings.prose();
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
  toolProfile: ToolProfile;
  maxOutputTokens: number;
  maxTurns: number;
  maxContextTokens: number;
  startUrl?: string;
  maxWorkerCycles: number;
  maxCompletionCheckFailures: number;
  outputContract: boolean;
  contractAuthor: ContractAuthor;
}): RunCheckpointV1['runConfiguration'] {
  return {
    model: args.model,
    toolProfile: args.toolProfile,
    maxOutputTokens: args.maxOutputTokens,
    maxTurns: ceilingToCheckpoint(args.maxTurns),
    maxContextTokens: args.maxContextTokens,
    ...(args.startUrl === undefined ? {} : { startUrl: args.startUrl }),
    harness: {
      maxWorkerCycles: args.maxWorkerCycles,
      maxCompletionCheckFailures: args.maxCompletionCheckFailures,
      outputContract: args.outputContract,
      contractAuthor: args.contractAuthor,
    },
  };
}

/** Everything a run's tool surface needs beyond the bash tool: the V2
 * run-scoped stores (contract, evidence, tables) when the typed protocol is
 * on, the assembled registry, and the API-facing tool definitions built from
 * it. Shared by a fresh `runTask` start and `resumeTask` — both build a
 * brand-new toolchain (a resumed run's output-contract STORE is then
 * rehydrated from disk; its output-TABLE and evidence stores are not, see
 * resumeTask's module note on why that gap is left open). */
interface RunToolchainInputs {
  runDir: string;
  v2Protocol: boolean;
  toolProfile: ToolProfile | undefined;
  browser: BrowserController;
  javascriptPolicy: BrowserJavaScriptPolicy | undefined;
  authenticated: boolean | undefined;
  bashTool: ToolDef;
  /** True when this toolchain is being built for a RESUMED run, which makes
   * every run-scoped store rebuild itself from what the interrupted process
   * already wrote instead of starting empty. Contract, evidence, and typed
   * rows are all durable; starting empty would silently discard them and then
   * fail the run for citing evidence ids "that do not exist". */
  restore?: boolean;
}

interface RunToolchain {
  outputContracts?: OutputContractStore;
  evidenceStore?: EvidenceStore;
  outputTables?: OutputTableStore;
  registry: ToolRegistry;
  apiToolDefs: ApiToolDef[];
}

function buildRunToolchain(inputs: RunToolchainInputs): RunToolchain {
  const { runDir, v2Protocol } = inputs;

  // Run-scoped V2 state. Built here, before the registry, because several
  // tools close over it — a tool cannot be constructed without the store it
  // mutates.
  const restore = inputs.restore === true;
  const outputContracts = v2Protocol ? createOutputContractStore(runDir) : undefined;
  // Rehydrated HERE, before the table store exists, not by the caller
  // afterwards: restoring typed rows replays them through their contract's
  // validation, so the contract has to be back in place first. A caller that
  // rehydrated later would validate every restored row against an empty
  // contract and reject all of them.
  if (restore && outputContracts !== undefined) {
    rehydrateContractStore(runDir, outputContracts);
  }
  const evidenceStore = v2Protocol
    ? restore
      ? restoreEvidenceStore(runDir)
      : createEvidenceStore(runDir)
    : undefined;
  const contentReaders = v2Protocol
    ? createContentReaderRegistry([
        createPdfContentReader(),
        createSpreadsheetContentReader(),
        createOcrContentReader(),
      ])
    : undefined;
  const outputTables = v2Protocol
    ? (restore ? restoreOutputTableStore : createOutputTableStore)({
        // `runDir` is what makes the store persist each table after every
        // successful mutation — and therefore what makes the restore above
        // have anything to find. Passing it on the FRESH path is not
        // optional bookkeeping: without it a run writes no snapshots, and a
        // resume of that run silently starts with zero rows.
        runDir,
        tableSpec: (outputId) => {
          const current = outputContracts!.currentContract();
          const found = current?.outputs.find(
            (output) => output.kind === 'table' && output.id === outputId,
          );
          return found as Extract<OutputSpec, { kind: 'table' }> | undefined;
        },
        evidenceExists: (evidenceId) => evidenceStore!.get(evidenceId) !== undefined,
      })
    : undefined;

  // The V2 registry, assembled at its frozen order (see V2_TOOL_ORDER).
  // Tools whose dependencies this run cannot satisfy are simply absent rather
  // than present-and-broken.
  const registry = v2Protocol
    ? createV2Registry(
        new Map<string, ToolDef>([
          ...createOutputRowTools({
            tables: outputTables!,
            summaryDeps: () => ({
              contract: outputContracts!.currentContract() ?? { outputs: [] },
              tables: outputTables!,
              evidenceExists: (id) => evidenceStore!.get(id) !== undefined,
              publishedExists: () => false,
              captureCount: () => 0,
            }),
          }).map((tool) => [tool.name, tool] as [string, ToolDef]),
          [
            'inspect_document',
            createInspectDocumentTool({ registry: contentReaders! }) as ToolDef,
          ],
          // execute_javascript is offered only when the session actually
          // provides the capability AND the policy allows it. An anonymous
          // session defaults to 'allow'; an authenticated one must have stated
          // its decision (resolveJavaScriptPolicy throws otherwise), so a
          // capability grant is never inherited by accident.
          ...(inputs.browser.executeJavaScript !== undefined
            ? ([
                [
                  'execute_javascript',
                  createExecuteJavascriptTool({
                    // Read ONCE here, at configuration time: a per-call read
                    // would let a later ctx mutation grant a capability no
                    // operator approved.
                    ...(inputs.javascriptPolicy === undefined
                      ? {}
                      : { policy: inputs.javascriptPolicy }),
                    authenticatedSession: inputs.authenticated === true,
                    page: (ctx) => ({
                      evaluateJson: (code, timeoutMs) =>
                        ctx.browser!.executeJavaScript!(
                          toEarlyJavaScriptRequest(code, timeoutMs),
                        ),
                      replaceUnresponsivePage: () => ctx.browser!.replaceUnresponsivePage!(),
                    }),
                    evidenceStore: () => evidenceStore,
                    onPolicyDecision: (line) =>
                      appendTranscriptEvent(runDir, {
                        type: 'javascript_policy',
                        decision: line,
                      }),
                  }) as ToolDef,
                ],
              ] as Array<[string, ToolDef]>)
            : []),
          // capture_text is offered on the same terms: only when the session
          // provides the capture seam. Without it, execute_javascript is the
          // only way to obtain the evidence id every typed row requires,
          // which makes a table task depend on page scripting being allowed.
          ...(inputs.browser.captureText !== undefined
            ? ([
                [
                  'capture_text',
                  createCaptureTextTool({
                    page: (ctx) => ({
                      captureText: (request) => requireBrowser(ctx).captureText!(request),
                    }),
                    evidenceStore: () => evidenceStore,
                  }) as ToolDef,
                ],
              ] as Array<[string, ToolDef]>)
            : []),
          // Publishing a prose deliverable. Both resolvers close over this
          // run's stores and are read PER CALL, never cached: a contract
          // revision must apply to the very next write, or the tool would
          // publish yesterday's filename.
          //
          // `openPdfPage` is offered only when the session can hand out a
          // throwaway page. Without it a `pdf` output fails explicitly before
          // anything is written, which is the failure worth having — the
          // alternative is a text file published under a .pdf name that the
          // verifier accepts and a human cannot open.
          [
            'write_document',
            createWriteDocumentTool({
              documentSpecs: () =>
                (outputContracts!.currentContract()?.outputs ?? []).filter(
                  (output): output is DocumentOutputSpec => output.kind === 'document',
                ),
              evidence: () => (id) => evidenceStore!.get(id),
              ...(inputs.browser.pdfPageSource === undefined
                ? {}
                : {
                    openPdfPage: () =>
                      createPlaywrightPdfPageOpener(inputs.browser.pdfPageSource!())(),
                  }),
            }) as ToolDef,
          ],
          // Local code execution, at its frozen position in V2_TOOL_ORDER.
          // Run-scoped for the same reason the stores above are: it carries
          // this run's secret-env denylist.
          ['bash', inputs.bashTool],
        ]),
      )
    : createProductionRegistry(inputs.toolProfile ?? DEFAULT_TOOL_PROFILE, {
        bash: inputs.bashTool,
      });

  // The model's tool surface follows the registry exactly, plus the submission
  // CONTROL tool — offered to the model but never executed through the
  // pipeline (the session intercepts it), which is why it is appended here and
  // not registered above.
  const apiToolDefs = v2Protocol
    ? [...toApiToolDefs(registry), submitForVerificationTool]
    : toApiToolDefs(registry);

  return {
    ...(outputContracts === undefined ? {} : { outputContracts }),
    ...(evidenceStore === undefined ? {} : { evidenceStore }),
    ...(outputTables === undefined ? {} : { outputTables }),
    registry,
    apiToolDefs,
  };
}

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
 * See runVerificationHarness for the loop itself, and resumeTask for
 * recovering a harness-mode run this same process (or a later one) never
 * finished.
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

  const v2Protocol = config.harness?.outputContract === true;
  const contractAuthor: ContractAuthor = config.harness?.contractAuthor ?? 'initializer';
  const maxCompletionCheckFailures =
    config.harness?.maxCompletionCheckFailures ?? DEFAULT_MAX_COMPLETION_CHECK_FAILURES;
  const resolvedModel = config.model ?? DEFAULT_MODEL;
  const resolvedToolProfile = config.toolProfile ?? DEFAULT_TOOL_PROFILE;
  const resolvedMaxTurns = config.maxTurns ?? DEFAULT_MAX_TURNS;

  const runDirForRun = createRunDir(
    config.runsBaseDir ?? DEFAULT_RUNS_BASE_DIR,
    // The task text names the run dir (slugified), so listings read like a
    // history of what was asked rather than a wall of timestamps.
    generateRunId(taskText),
  );
  const runDir = runDirForRun;
  initManifest(runDir, taskText);

  // Harness mode: one budget tracker for the whole run — initializer,
  // every worker cycle, and every judge call charge the same instance, and
  // starting a correction resets nothing. Constructed (and validated) here
  // — right after the run directory exists, matching where this
  // construction (and its validation) has always sat, and before the
  // registry so the checkpoint writer below has a live tracker to read from.
  const budget: RunBudgetTracker | undefined =
    config.harness === undefined
      ? undefined
      : createRunBudgetTracker({
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

  // Checkpointing applies to harness-mode runs only: a judge-less run never
  // opens harness/run.lock or harness/checkpoint.json, and its behavior is
  // untouched by any of this — see the module note on runHarnessCycles for
  // what "durable" does and does not mean here.
  const checkpointWriter: RunCheckpointWriter | undefined =
    config.harness === undefined
      ? undefined
      : createRunCheckpointWriter(await openRunCheckpointStore(runDir), {
          runConfiguration: buildCheckpointRunConfiguration({
            model: resolvedModel,
            toolProfile: resolvedToolProfile,
            maxOutputTokens,
            maxTurns: resolvedMaxTurns,
            maxContextTokens,
            ...(config.startUrl === undefined ? {} : { startUrl: config.startUrl }),
            maxWorkerCycles,
            maxCompletionCheckFailures,
            outputContract: v2Protocol,
            contractAuthor,
          }),
          budget: budget!,
        });

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
    v2Protocol,
    toolProfile: config.toolProfile,
    browser: config.browser,
    javascriptPolicy: config.javascriptPolicy,
    authenticated: config.authenticated,
    bashTool,
  });

  const baseCallModel = config.callModel ?? makeCallModel({
    model: config.model,
    system: SYSTEM_PROMPT,
    apiToolDefs: toolchain.apiToolDefs,
    maxOutputTokens,
    onProgress: config.onProgress,
  });

  const credentials =
    config.credentials ??
    new FileCredentialStore(
      process.env.CREDENTIALS_FILE ?? resolve(PACKAGE_ROOT, '.credentials.json'),
    );

  const tracing = config.tracing ?? createRunTracing();
  const callModel = tracing.wrapCallModel(baseCallModel, resolvedModel);
  const tracedRegistry = tracing.wrapRegistry(toolchain.registry);

  let tabOpened = false;
  try {
    // Harness mode: derive the contract-authoring files from the task text
    // alone, before any browsing starts, so a failure here still lets the
    // finally below finalize the manifest. Deliberately outside
    // tracing.traceRun and never through tracing.wrapCallModel — per the
    // design, initializer and judge calls run untraced in v1; their token
    // usage still lands on the shared budget via withBudgetAccounting.
    if (config.harness !== undefined) {
      await checkpointWriter!.saveInitializing();
      const initializerCallModel = withBudgetAccounting(
        config.harness.initializerCallModel ?? defaultInitializerCallModel(v2Protocol),
        budget!,
        'initializer',
      );
      if (v2Protocol && contractAuthor === 'initializer') {
        const authored = await runContractInitializer(
          taskText,
          initializerCallModel,
          toolchain.outputContracts!,
        );
        if (!authored.ok) {
          // A run whose requirements were never validated must not proceed
          // as if they had been.
          throw new Error(`Contract initializer failed: ${authored.reason}`);
        }
        await checkpointWriter!.saveInitializerAccepted({
          mode: 'contract',
          contractRevision: authored.revision,
        });
      } else if (!v2Protocol) {
        const initializerResult = await runInitializer(taskText, initializerCallModel);
        // Recorded BEFORE the files are written: a crash between this save
        // and writeInitializerFiles lets resumeTask finish the write
        // deterministically, without a second (billable, non-reproducible)
        // initializer call.
        await checkpointWriter!.saveInitializerAccepted({
          mode: 'prose',
          proseAccepted: initializerResult,
        });
        writeInitializerFiles(runDir, initializerResult);
        await checkpointWriter!.saveInitializerAccepted({
          mode: 'prose',
          proseAccepted: initializerResult,
          filesWritten: true,
        });
      } else {
        // v2Protocol with contractAuthor 'worker': the worker states the
        // contract itself on its first response (the contract-first gate) —
        // there is no initializer call to accept here. Still record which
        // protocol this run is on, so a resume from a checkpoint saved
        // before any contract exists knows the typed path is active without
        // re-deriving it from runConfiguration alone.
        await checkpointWriter!.saveInitializerAccepted({ mode: 'contract' });
      }
    }

    const result = await tracing.traceRun(taskText, async () => {
      await config.browser.newTab();
      tabOpened = true;

      if (config.startUrl !== undefined) {
        await config.browser.goto(config.startUrl);
      }

      // Created before the session because it is one of the session's deps,
      // and bound after, once the session exists — see
      // createToolCallCheckpointHooks. Inert until then, and inert forever on
      // the judge-less path, which has no checkpoint store to write to.
      const toolCheckpoint = createToolCallCheckpointHooks();

      const loopDeps: LoopDeps = {
        callModel,
        registry: tracedRegistry,
        runDir,
        browser: config.browser,
        credentials,
        requestPermission: config.requestPermission,
        toolHooks: toolCheckpoint.hooks,
        // Reaches an in-flight command, unlike the model-call boundary the
        // TUI's cancellation already covers.
        ...(config.signal === undefined ? {} : { abortSignal: config.signal }),
        ...(toolchain.outputContracts === undefined ? {} : { outputContracts: toolchain.outputContracts }),
        ...(toolchain.outputTables === undefined ? {} : { outputTables: toolchain.outputTables }),
        ...(toolchain.evidenceStore === undefined ? {} : { evidenceStore: toolchain.evidenceStore }),
        ...(v2Protocol ? { submissionProtocol: true } : {}),
      };

      if (config.harness === undefined) {
        const loopConfig: LoopConfig = {
          maxTurns: resolvedMaxTurns,
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
        checkpointWriter!,
        toolCheckpoint,
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
        // Closed before finalizeManifest, without masking an in-flight
        // error: an ordinary awaited call in its own finally layer, exactly
        // like closeTab/tracing.close beside it — a failure here propagates
        // normally rather than being swallowed.
        await checkpointWriter?.close();
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
 * `RunTaskConfig` field the checkpoint already remembers (model, toolProfile,
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
  /** Safety check against `runConfiguration.toolProfile`; omit to trust the
   * checkpoint. */
  toolProfile?: ToolProfile;
  /** Safety check against `runConfiguration.maxOutputTokens`; omit to trust
   * the checkpoint. */
  maxOutputTokens?: number;
  /** Safety check against `runConfiguration.maxTurns`; omit to trust the
   * checkpoint. */
  maxTurns?: number;
  /** Safety check against `runConfiguration.maxContextTokens`; omit to trust
   * the checkpoint. */
  maxContextTokens?: number;
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
  /** Optional run-scoped tracing implementation for the resumed run's
   * segment (a resumed run's trace is a NEW segment, not a continuation of
   * the original run's trace — tracing state is not part of the
   * checkpoint). */
  tracing?: RunTracing;
  /** Optional credential store consulted by fill_credentials. */
  credentials?: CredentialStore;
  /** Optional resolver for interactive tool calls. */
  requestPermission?: ToolCtx['requestPermission'];
  /** See RunTaskConfig.authenticated. */
  authenticated?: boolean;
  /** See RunTaskConfig.javascriptPolicy. */
  javascriptPolicy?: BrowserJavaScriptPolicy;
  harness?: {
    /** Safety check against `runConfiguration.harness.maxWorkerCycles`. */
    maxWorkerCycles?: number;
    /** Safety check against `runConfiguration.harness.maxCompletionCheckFailures`. */
    maxCompletionCheckFailures?: number;
    /** Safety check against `runConfiguration.harness.outputContract`. */
    outputContract?: boolean;
    /** Safety check against `runConfiguration.harness.contractAuthor`. */
    contractAuthor?: ContractAuthor;
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

/** Cross-check every scalar the caller chose to repeat against what the
 * checkpoint recorded; throws one Error listing every mismatch (never just
 * the first) if any disagree. Fields the caller omits are trusted from the
 * checkpoint without comment — see ResumeTaskConfig's module note on why
 * none of these are required. */
function assertScalarConfigMatches(
  stored: RunCheckpointV1['runConfiguration'],
  config: ResumeTaskConfig,
): void {
  const problems: string[] = [];
  const check = (name: string, given: unknown, expected: unknown): void => {
    if (given !== undefined && given !== expected) {
      problems.push(
        `${name}: resume was given ${JSON.stringify(given)} but the checkpoint recorded ${JSON.stringify(expected)}`,
      );
    }
  };
  check('model', config.model, stored.model);
  check('toolProfile', config.toolProfile, stored.toolProfile);
  check('maxOutputTokens', config.maxOutputTokens, stored.maxOutputTokens);
  check('maxTurns', config.maxTurns, ceilingFromCheckpoint(stored.maxTurns));
  check('maxContextTokens', config.maxContextTokens, stored.maxContextTokens);
  check('startUrl', config.startUrl, stored.startUrl);
  check('harness.maxWorkerCycles', config.harness?.maxWorkerCycles, stored.harness?.maxWorkerCycles);
  check(
    'harness.maxCompletionCheckFailures',
    config.harness?.maxCompletionCheckFailures,
    stored.harness?.maxCompletionCheckFailures,
  );
  check('harness.outputContract', config.harness?.outputContract, stored.harness?.outputContract);
  check('harness.contractAuthor', config.harness?.contractAuthor, stored.harness?.contractAuthor);
  if (problems.length > 0) {
    throw new Error(
      `cannot resume: the request's configuration does not match this run's checkpoint:\n${problems
        .map((problem) => `  - ${problem}`)
        .join('\n')}`,
    );
  }
}

/** Narrow a checkpoint's opaque `finalOutcome` back to a `RunOutcome`,
 * failing loudly on anything else — a corrupt or foreign value here must
 * never be handed back to a caller as if it were a trustworthy result. */
function validateStoredOutcome(outcome: unknown, runDir: string): RunOutcome {
  if (
    typeof outcome === 'object' &&
    outcome !== null &&
    'status' in outcome &&
    ((outcome as { status: unknown }).status === 'verified' ||
      (outcome as { status: unknown }).status === 'incomplete')
  ) {
    return outcome as RunOutcome;
  }
  throw new Error(
    `checkpoint at ${runDir} has runStatus 'terminal' but no valid finalOutcome recorded`,
  );
}

/**
 * Rehydrate a fresh `OutputContractStore` from its own durable history.
 *
 * The store itself starts every process with empty history (see
 * createOutputContractStore) — it is an in-memory index over files it wrote,
 * not something that reads its own directory back at construction. On
 * resume, every revision the run ever accepted is still on disk at
 * `scratch/output-contract/revision-<n>.json` (already integrity-checked by
 * `verifyManifestFiles` before this ever runs), so replaying them through
 * the SAME `setOutputContract` validator the original run used rebuilds an
 * identical store: same current contract, same history, same revision
 * count — without trusting the file's bytes any more than the model's
 * original call was trusted.
 */
function rehydrateContractStore(runDir: string, store: OutputContractStore): void {
  for (let revisionNumber = 1; ; revisionNumber += 1) {
    const path = join(runDir, contractRevisionPath(revisionNumber));
    if (!existsSync(path)) return;
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as {
      contract: unknown;
      basis?: unknown;
    };
    const result = store.setOutputContract({
      contract: parsed.contract,
      ...(parsed.basis === undefined ? {} : { revisionBasis: parsed.basis }),
    });
    if (!result.ok) {
      throw new Error(
        `failed to rehydrate contract revision ${revisionNumber} from ${path}: ` +
          `${result.errors.join('; ')}`,
      );
    }
    if (result.revision.revision !== revisionNumber) {
      throw new Error(
        `contract rehydration produced revision ${result.revision.revision} for ${path}, ` +
          `expected ${revisionNumber}`,
      );
    }
  }
}

/** A response's prose: its text blocks joined with newlines ("" if none).
 * Deliberately duplicated from workerSession.ts's private extractText (not
 * exported there) — the same established pattern initializer.ts already
 * follows for the identical one-line contract (see its own comment on why). */
function extractAssistantText(content: readonly AssistantContentBlock[]): string {
  return content
    .filter((block): block is TextBlock => block.type === 'text')
    .map((block) => block.text)
    .join('\n');
}

/**
 * Reconstruct the `WorkerTurnOutcome` a `'verifying'` checkpoint was saved
 * for, from the just-restored session's own conversation — never by
 * re-running the worker cycle that already produced it (see the module note
 * on `runHarnessCycles` for why that distinction matters).
 *
 * This works because `saveVerifying` happens at an exact, code-controlled
 * boundary: after `runWorkerCycle` returns a `'submitted'` or `'completed'`
 * result and any completion checks already passed, but BEFORE anything else
 * touches the conversation. So the restored session's LAST message is
 * exactly that cycle's final assistant turn — for the typed protocol, an
 * unanswered `submit_for_verification` tool_use; for the legacy protocol, a
 * plain text-only response. Which shape to expect is fully determined by
 * `v2Protocol` (a static, checkpoint-recorded fact — see runWorkerTurn's own
 * completion-protocol branch), so nothing here needs to guess.
 */
function reconstructPendingResult(
  session: WorkerSession,
  v2Protocol: boolean,
): Extract<WorkerTurnOutcome, { kind: 'submitted' | 'completed' }> {
  const lastMessage = session.state.messages.at(-1);
  if (lastMessage === undefined || lastMessage.role !== 'assistant') {
    throw new Error(
      "cannot resume a 'verifying' checkpoint: the restored conversation does not end with " +
        'the assistant turn that finished this cycle',
    );
  }
  const finalText = extractAssistantText(lastMessage.content);
  if (!v2Protocol) {
    return { kind: 'completed', finalText };
  }
  const submission = lastMessage.content.find(
    (block) => block.type === 'tool_use' && block.name === SUBMIT_FOR_VERIFICATION,
  );
  if (submission === undefined || submission.type !== 'tool_use') {
    throw new Error(
      "cannot resume a 'verifying' checkpoint: expected the restored conversation's last " +
        `assistant message to contain an unanswered ${SUBMIT_FOR_VERIFICATION} call`,
    );
  }
  return {
    kind: 'submitted',
    call: { id: submission.id, name: submission.name, input: submission.input },
    input: submission.input,
    finalText,
  };
}

/**
 * One tool call as a checkpoint records it, keyed by the model's own call id.
 */
type CheckpointedToolCall = NonNullable<RunCheckpointV1['pendingTurn']>['toolCalls'][number];

/**
 * Per-tool-call checkpointing, as a `ToolCallLifecycleHooks` the WorkerSession
 * can be built with.
 *
 * Two-phase construction is forced by an ordering the code cannot avoid: the
 * hooks must exist before the `WorkerSession` (they are one of its deps), but
 * they need that same session to read the turn number and the assistant
 * message a batch belongs to. So the hooks are created inert and `bind` is
 * called once the session exists. Before binding — and on the judge-less path,
 * which has no checkpoint store at all — every hook is a no-op, which is why
 * an unbound instance is safe to install rather than something to guard
 * against at each call site.
 */
interface ToolCallCheckpointHooks {
  hooks: ToolCallLifecycleHooks;
  /** Supply the session and the save this run should use. Called once, right
   * after the session is constructed. */
  bind(target: {
    session: WorkerSession;
    save: (pendingTurn: NonNullable<RunCheckpointV1['pendingTurn']>) => Promise<void>;
  }): void;
}

function createToolCallCheckpointHooks(): ToolCallCheckpointHooks {
  let target:
    | {
        session: WorkerSession;
        save: (pendingTurn: NonNullable<RunCheckpointV1['pendingTurn']>) => Promise<void>;
      }
    | undefined;

  // The batch currently being observed. Reset whenever the session's turn
  // count moves, which is how a new turn's first hook is distinguished from a
  // later call in the same turn: `runWorkerTurn` increments `turnCount` before
  // it schedules anything, so the count is a reliable batch identity without
  // the session having to announce batch boundaries.
  let openTurn: number | undefined;
  let observed: CheckpointedToolCall[] = [];

  /** The batch as it currently stands, ready to persist. Records only the
   * calls observed SO FAR, not the model's full batch: the hooks learn about
   * a call when it starts (state-changing) or settles (any), and never receive
   * the batch as a whole. A checkpoint that listed calls it had not seen would
   * be inventing detail. */
  const pendingTurn = (
    session: WorkerSession,
  ): NonNullable<RunCheckpointV1['pendingTurn']> => ({
    turnNumber: session.state.turnCount,
    assistantMessage: session.state.messages.at(-1),
    toolCalls: [...observed],
  });

  /** Record a call's current phase. Returns false when the call is not one
   * this batch is tracking, which is how a read-only call is filtered out of
   * the settle path — see `afterCallResult`. */
  const track = (
    session: WorkerSession,
    call: ToolCall,
    executionStatus: CheckpointedToolCall['executionStatus'],
    result?: unknown,
  ): boolean => {
    if (openTurn !== session.state.turnCount) {
      openTurn = session.state.turnCount;
      observed = [];
    }
    const existing = observed.findIndex((seen) => seen.request.id === call.id);
    if (existing === -1 && executionStatus !== 'running') return false;
    const entry: CheckpointedToolCall = {
      request: { id: call.id, name: call.name, input: call.input },
      executionStatus,
      ...(result === undefined ? {} : { result }),
    };
    if (existing === -1) {
      observed.push(entry);
    } else {
      observed[existing] = entry;
    }
    return true;
  };

  return {
    hooks: {
      // Propagates a save failure on purpose, which fails this one call
      // without running it (see scheduleToolCalls). If the runtime cannot
      // record that a state-changing call is about to happen, running it
      // anyway would leave a resume unable to tell whether it did.
      async beforeStateChangingCall(call): Promise<void> {
        if (target === undefined) return;
        track(target.session, call, 'running');
        await target.save(pendingTurn(target.session));
      },

      // Fires for EVERY call, read-only ones included, so it saves only for
      // calls the batch is already tracking — i.e. the state-changing ones
      // the hook above recorded as 'running'. A read has no side effect to
      // warn a resumed model about, and every checkpoint write serializes the
      // whole conversation, so saving after each read would multiply this
      // run's checkpoint I/O to record nothing anyone can act on.
      //
      // Best-effort, deliberately unlike the hook above: this one runs after
      // the tool already did its work, and `scheduleToolCalls` turns a throw
      // here into an error result that REPLACES that work's real result. A
      // failed checkpoint write must not destroy a successful tool call — the
      // run continues with a slightly staler checkpoint instead.
      async afterCallResult(call, result): Promise<void> {
        if (target === undefined) return;
        if (!track(target.session, call, 'finished', result)) return;
        try {
          await target.save(pendingTurn(target.session));
        } catch {
          // Intentionally swallowed; see above.
        }
      },
    },

    bind(next): void {
      target = next;
    },
  };
}

/** Describe an interrupted tool batch for the resumed model, or undefined
 * when the checkpoint records no calls worth warning about.
 *
 * A call left `'running'` is the one that matters: its side effects may or may
 * not have landed, and only the model can check. Calls already `'finished'`
 * are named too, because their results died with the process — the resumed
 * conversation has no record of them, so the model would otherwise have no
 * way to know it already did that work. */
function describeInterruptedBatch(
  checkpoint: RunCheckpointV1,
): string | undefined {
  if (checkpoint.runStatus !== 'executing_tools') return undefined;
  const calls = checkpoint.pendingTurn?.toolCalls ?? [];
  const running = calls.filter((call) => call.executionStatus === 'running');
  const finished = calls.filter((call) => call.executionStatus === 'finished');
  if (running.length === 0 && finished.length === 0) return undefined;

  const names = (subset: typeof calls): string =>
    subset.map((call) => call.request.name).join(', ');
  const parts: string[] = [];
  if (running.length > 0) {
    parts.push(
      `${running.length === 1 ? 'a call' : 'calls'} to ${names(running)} that had started ` +
        'but never reported a result — their effects may or may not have been applied, so ' +
        'check the current state before repeating them',
    );
  }
  if (finished.length > 0) {
    parts.push(
      `${finished.length === 1 ? 'a completed call' : 'completed calls'} to ` +
        `${names(finished)} whose results were lost with the interrupted turn`,
    );
  }
  return `The interrupted turn included ${parts.join(', and ')}.`;
}

/** Text appended to the resumed conversation exactly once (see
 * `runHarnessCycles`'s `pendingNotice` handling for the one case — resuming
 * a `'verifying'` checkpoint on the typed protocol — where it cannot be
 * appended immediately and is instead folded into the next feedback this
 * run produces). */
const RECOVERY_NOTICE =
  'This run was recovered after an interruption. Your scratch files and published ' +
  'artifacts survived exactly as they were. The browser session was recreated: any page ' +
  'or element refs from before the interruption are no longer valid — call outline (or ' +
  'navigate) again to get fresh refs before interacting with the page.';

/**
 * Resume a harness-mode run this process (or an earlier one) checkpointed
 * but never finished.
 *
 * Never usable on a judge-less run: `runTask` opens a checkpoint store only
 * when `config.harness` is present, so a run directory with no
 * `harness/checkpoint.json` has nothing to resume — this throws rather than
 * inventing a starting point.
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
export async function resumeTask(
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
    const v2Protocol = harnessConfiguration.outputContract;
    const maxWorkerCycles = harnessConfiguration.maxWorkerCycles;
    const maxContextTokens = checkpoint.runConfiguration.maxContextTokens;
    const taskText = readManifest(runDir).task;

    // Finish an interrupted prose initializer deterministically, without a
    // second (billable, non-reproducible) initializer model call. Only ever
    // relevant while runStatus is still 'initializing': every later status
    // implies the initializer phase already ran to completion (runTask
    // never opens the browser tab, and therefore never reaches
    // 'ready_for_model', until it has).
    if (checkpoint.runStatus === 'initializing') {
      if (!v2Protocol) {
        if (checkpoint.initializer?.proseAccepted === undefined) {
          throw new Error(
            `cannot resume ${runDir}: the initializer's own model call was never durably ` +
              'recorded before the interruption. There is no salvageable initializer state ' +
              '— start a fresh run with runTask instead.',
          );
        }
        if (checkpoint.initializer.filesWritten !== true) {
          writeInitializerFiles(runDir, checkpoint.initializer.proseAccepted);
        }
      }
      // Typed path (either contractAuthor): nothing to finish
      // deterministically. An initializer-authored contract accepted before
      // the crash is already durable on disk and picked back up by
      // rehydrateContractStore below; if the initializer's own call never
      // completed, the worker's own set_output_contract call — offered
      // unconditionally on the typed protocol regardless of contractAuthor
      // — can still establish revision 1 once the resumed session starts.
    }

    const bashTool = createBashTool({ secretEnvDenylist: BASH_SECRET_ENV_DENYLIST }) as ToolDef;
    const toolchain = buildRunToolchain({
      runDir,
      v2Protocol,
      toolProfile: checkpoint.runConfiguration.toolProfile as ToolProfile,
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

    const credentials =
      config.credentials ??
      new FileCredentialStore(
        process.env.CREDENTIALS_FILE ?? resolve(PACKAGE_ROOT, '.credentials.json'),
      );
    const tracing = config.tracing ?? createRunTracing();
    const baseCallModel = config.callModel ?? makeCallModel({
      model: checkpoint.runConfiguration.model,
      system: SYSTEM_PROMPT,
      apiToolDefs: toolchain.apiToolDefs,
      maxOutputTokens: checkpoint.runConfiguration.maxOutputTokens,
      onProgress: config.onProgress,
    });
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
      credentials,
      requestPermission: config.requestPermission,
      toolHooks: toolCheckpoint.hooks,
      ...(config.signal === undefined ? {} : { abortSignal: config.signal }),
      ...(toolchain.outputContracts === undefined ? {} : { outputContracts: toolchain.outputContracts }),
      ...(toolchain.outputTables === undefined ? {} : { outputTables: toolchain.outputTables }),
      ...(toolchain.evidenceStore === undefined ? {} : { evidenceStore: toolchain.evidenceStore }),
      ...(v2Protocol ? { submissionProtocol: true } : {}),
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
      // every case except resuming a 'verifying' checkpoint on the typed
      // protocol, where the conversation's last message is an unanswered
      // submit_for_verification tool_use — inserting a plain user message
      // before that call is answered would make the next request invalid.
      // That one case defers the notice into runHarnessCycles's pendingNotice
      // instead (folded into the first feedback this run produces).
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

      const deferNotice = checkpoint.runStatus === 'verifying' && v2Protocol;
      if (!deferNotice) {
        appendWorkerFeedback(session, recoveryNotice);
      }

      const verifierCallModel = withBudgetAccounting(
        config.harness?.verifierCallModel ?? makeVerifierModelDriver(),
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
                ? { precomputedResult: reconstructPendingResult(session, v2Protocol) }
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
  } finally {
    // Idempotent (see RunCheckpointStore.close) — safe even when
    // checkpointWriter.close() was never reached above (the terminal
    // short-circuit, or any throw before it), and safe as the second call
    // if it was.
    await store.close();
  }
}

// ---------------------------------------------------------------------------
// The harness cycle loop
// ---------------------------------------------------------------------------

/**
 * Run the harness's worker/judge cycles from an explicit starting point.
 *
 * Shared by a fresh run (`runVerificationHarness`: cycle 1, no prior
 * records, nothing precomputed) and `resumeTask` (whatever cycle, failure
 * count, and per-cycle diagnostic trail the checkpoint recorded) — one
 * function, so a resumed run's loop can never drift from a fresh run's.
 *
 * `start.precomputedResult`, when given, stands in for a worker cycle that
 * already finished before a crash (a `'verifying'` checkpoint resume, via
 * `reconstructPendingResult`) — this loop's first iteration uses it INSTEAD
 * of running the cycle's turns, consumed exactly once. Every later iteration
 * runs a fresh cycle normally. This is the one rule that makes the
 * fault-window promise in the module comments true: a completed worker
 * cycle is never re-run, even across a crash.
 *
 * Checkpoint saves sit at exactly three boundaries, chosen because they are
 * the only ones this function (not `scheduleToolCalls`, which it does not
 * control) can observe:
 *  - `saveReadyForModel`, immediately before every `runWorkerTurn` call —
 *    not just once per cycle: a cycle that takes several turns (tool calls
 *    before the final completion or submission) gets a fresh save before
 *    EACH of them, by calling `runWorkerTurn` directly in a loop here
 *    rather than treating `runWorkerCycle` as an unobservable black box (see
 *    the inline comment where this loop lives). This covers the session's
 *    very first turn, every later turn of a multi-turn cycle, a same-cycle
 *    retry after a rejected submission, and the next cycle after a
 *    correction. The instant after a correction's feedback is appended has
 *    zero synchronous work before this save fires (`cycle += 1`, nothing
 *    else), so a separate "save right after the verdict" call would be
 *    redundant with it — this single rule already covers that moment.
 *  - `saveVerifying`, after a cycle's completion checks (if any) already
 *    passed and BEFORE `runVerifier` — the boundary that makes re-running
 *    the (read-only) verifier after a crash acceptable while re-running the
 *    worker cycle it belongs to is not.
 *  - `saveTerminal`, once, right before returning — covers every ending
 *    (verified, every incomplete reason) uniformly.
 *
 * What this still does NOT cover: a crash INSIDE `runWorkerTurn` itself —
 * mid-model-call, or mid-`scheduleToolCalls` batch, which this function does
 * not control and was not asked to instrument — rolls back to whatever the
 * last per-turn save captured, discarding that one turn's work (its model
 * response and any tool calls it made) as if it had never been attempted.
 * The worker turns are never billed twice for the same content, since the
 * budget only records USAGE a model call actually reported, and a
 * genuinely-interrupted call reports none.
 */
async function runHarnessCycles(args: {
  taskText: string;
  runDir: string;
  maxWorkerCycles: number;
  maxCompletionCheckFailures: number;
  session: WorkerSession;
  verifierCallModel: CallModel;
  checkpointWriter: RunCheckpointWriter;
  /** Bound here rather than at construction: this is the first point where
   * the session, the writer, and the live progress snapshot all exist. */
  toolCheckpoint: ToolCallCheckpointHooks;
  start: {
    cycle: number;
    completionCheckFailures: number;
    cycleRecords: HarnessCycleRecord[];
    precomputedResult?: Extract<WorkerTurnOutcome, { kind: 'submitted' | 'completed' }>;
    /** Recovery-notice text to fold into the very next feedback this run
     * produces (see resumeTask's `deferNotice`), consumed exactly once. */
    pendingNotice?: string;
  };
}): Promise<RunOutcome> {
  const { taskText, runDir, maxWorkerCycles, session, verifierCallModel, checkpointWriter } = args;
  const contractStore = session.deps.outputContracts;
  const maxCompletionCheckFailures = args.maxCompletionCheckFailures;
  let completionCheckFailures = args.start.completionCheckFailures;
  const cycleRecords: HarnessCycleRecord[] = [...args.start.cycleRecords];
  let pendingResult = args.start.precomputedResult;
  let pendingNotice = args.start.pendingNotice;
  let outcome: RunOutcome | undefined;
  let cycle = args.start.cycle;

  const progressSnapshot = (): { currentCycle: number; completionCheckFailures: number; cycleRecords: HarnessCycleRecord[] } => ({
    currentCycle: cycle,
    completionCheckFailures,
    cycleRecords: [...cycleRecords],
  });

  // From here on, every state-changing tool call checkpoints itself. Bound
  // once, before the first turn: the session's tools already hold the hook
  // object (it is one of its deps), so binding is what switches the hooks
  // from inert to live rather than what installs them.
  args.toolCheckpoint.bind({
    session,
    save: (pendingTurn) =>
      checkpointWriter.saveExecutingTools({
        session,
        progress: progressSnapshot(),
        pendingTurn,
      }),
  });

  /** Fold in the one-time recovery notice, if one is still pending. */
  const withPendingNotice = (content: string): string => {
    if (pendingNotice === undefined) return content;
    const notice = pendingNotice;
    pendingNotice = undefined;
    return `${notice}\n\n${content}`;
  };

  try {
    for (; cycle <= maxWorkerCycles; cycle += 1) {
      let result: Exclude<WorkerTurnOutcome, { kind: 'working' }>;
      if (pendingResult !== undefined) {
        result = pendingResult;
        pendingResult = undefined;
      } else {
        const cycleStartEvent: CycleStartEvent = { type: 'cycle_start', cycle };
        appendTranscriptEvent(runDir, cycleStartEvent);
        // Reimplements runWorkerCycle's own loop (call runWorkerTurn until it
        // stops returning 'working') rather than calling runWorkerCycle as a
        // black box, specifically so a checkpoint lands before EVERY turn of
        // a cycle, not only before the cycle's first one. runWorkerTurn is a
        // public export of workerSession.ts for exactly this kind of
        // composition — this is still "a boundary runTask can observe", just
        // a finer one than the cycle itself. The payoff: a crash on a
        // cycle's second (or later) turn resumes from THAT turn, with every
        // earlier turn's tool results already in the restored conversation,
        // instead of silently discarding the whole cycle back to its start.
        let turnOutcome: WorkerTurnOutcome;
        for (;;) {
          await checkpointWriter.saveReadyForModel({ session, progress: progressSnapshot() });
          turnOutcome = await runWorkerTurn(session);
          if (turnOutcome.kind !== 'working') break;
        }
        result = turnOutcome;
      }

      if (result.kind === 'budget_exceeded') {
        cycleRecords.push({ cycle, workerStatus: 'budget_exceeded' });
        outcome = {
          status: 'incomplete',
          reason: 'budget_exceeded',
          detail: `worker budget guard '${result.reason}' tripped in cycle ${cycle}`,
          finalText: '',
        };
        break;
      }

      // Code checks before the verifier (T5): a malformed file must never
      // spend a verifier attempt. Failures return as the submission call's
      // own result, so the worker keeps working in the same conversation
      // and only a submission that survives them reaches the verifier.
      const contract = contractStore?.currentContract();
      // What code proved about this submission, handed to the verifier so it
      // does not re-derive a count less reliably than the checks did.
      let settled: readonly SettledFact[] = [];
      if (result.kind === 'submitted' && contract !== undefined) {
        // The table store renders the contract's table outputs as part of the
        // check — without it, a run with valid typed rows is told its own
        // deliverable is missing. The evidence predicate lets the same call
        // catch a row whose citation stopped resolving, and a count-ruled
        // table with no completeness evidence on file.
        const checks = runCompletionCheck(
          runDir,
          contract,
          session.deps.outputTables,
          session.deps.evidenceStore === undefined
            ? undefined
            : (id) => session.deps.evidenceStore!.get(id) !== undefined,
        );
        settled = checks.settled;
        if (!checks.ok) {
          completionCheckFailures += 1;
          appendTranscriptEvent(runDir, {
            type: 'completion_check_failed',
            cycle,
            failures: checks.failures,
          });
          if (completionCheckFailures >= maxCompletionCheckFailures) {
            cycleRecords.push({
              cycle,
              workerStatus: 'completed',
              verifierError:
                `automated checks rejected ${completionCheckFailures} submissions; ` +
                'the verifier was never reached',
            });
            outcome = {
              status: 'incomplete',
              reason: 'verification_attempts',
              detail:
                `automated completion checks failed ${completionCheckFailures} times; ` +
                `last failures: ${formatCheckFailures(checks.failures)}`,
              finalText: result.finalText,
            };
            break;
          }
          // Same conversation, same submission call: the worker reads the
          // objective defects and fixes them without a fresh cycle.
          appendSubmissionResult(
            session,
            result.call,
            withPendingNotice(
              `Automated checks rejected this submission. Nothing was verified. Fix all of ` +
                `these and submit again:\n${formatCheckFailures(checks.failures)}`,
            ),
          );
          cycle -= 1; // a rejected submission is not a verification cycle
          continue;
        }
      }

      await checkpointWriter.saveVerifying({ session, progress: progressSnapshot() });

      // Only a harness bug throws out of runVerifier (a run dir missing its
      // contract documents) or a caller cancellation (an AbortError); every
      // model-side failure — refusal, token limit, truncated stream,
      // transport error, an invalid report after its bounded repair —
      // already arrives as the verifier_unavailable outcome below. Both
      // throwing cases are handled by this function's single outer catch,
      // so no inner bookkeeping here: a second recordWorkerSessionCrash
      // would duplicate the run_error event and the failed-metrics write.
      const verification: VerifierOutcome = await runVerifier({
        taskText,
        runDir,
        callModel: verifierCallModel,
        ...(contract === undefined
          ? {}
          : { contracts: { current: contract, history: contractStore!.contractHistory() } }),
        ...(settled.length === 0 ? {} : { settled }),
      });

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
        if (result.kind === 'submitted') {
          appendSubmissionResult(
            session,
            result.call,
            withPendingNotice(JSON.stringify({ status: 'verified' })),
            false,
          );
        }
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
      // feedback appended to everything the worker already knows. When the
      // cycle ended in a submission, the findings answer that exact call.
      session.config.budget.recordCorrection();
      if (result.kind === 'submitted') {
        appendSubmissionResult(
          session,
          result.call,
          withPendingNotice(`Verification found problems. Fix these and submit again:\n${findingsText}`),
        );
      } else {
        appendWorkerFeedback(session, withPendingNotice(`Verification findings:\n${findingsText}`));
      }
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

  // An unverified ending preserves the run, but the manifest must stop
  // implying every deliverable is trustworthy: only the outputs whose
  // requirement is unmet are marked partial (see finalizeIncompleteRun).
  if (outcome.status === 'incomplete') {
    const contract = contractStore?.currentContract();
    const finalization = finalizeIncompleteRun(runDir, contract, session.deps.outputTables);
    if (finalization.markedPartial.length > 0) {
      appendTranscriptEvent(runDir, {
        type: 'incomplete_finalization',
        markedPartial: finalization.markedPartial,
        unsatisfiedOutputIds: finalization.unsatisfiedOutputIds,
      });
    }
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

  await checkpointWriter.saveTerminal({ session, progress: progressSnapshot(), outcome });

  return outcome;
}

/**
 * Run the verification harness's worker/judge phase over ONE persistent
 * WorkerSession, starting fresh at cycle 1. Cycle 1 opens with the task
 * text; every later cycle is the same conversation continued — the judge's
 * reason is appended as feedback (appendWorkerFeedback), so the worker keeps
 * its browser knowledge and prior tool results instead of starting over. By
 * the time this runs, the contract-authoring files already exist at the
 * run-dir root (written by `runTask` before the tab opened).
 *
 * The loop itself lives in `runHarnessCycles`, shared with `resumeTask` — see
 * its own doc comment for the per-cycle mechanics, checkpoint boundaries, and
 * every ending this can produce.
 */
async function runVerificationHarness(
  taskText: string,
  runDir: string,
  harnessConfig: HarnessConfig,
  maxWorkerCycles: number,
  loopDeps: LoopDeps,
  sessionConfig: { budget: RunBudgetTracker; maxContextTokens: number },
  checkpointWriter: RunCheckpointWriter,
  toolCheckpoint: ToolCallCheckpointHooks,
): Promise<RunOutcome> {
  const verifierCallModel = withBudgetAccounting(
    harnessConfig.verifierCallModel ?? makeVerifierModelDriver(),
    sessionConfig.budget,
    'verifier',
  );
  const maxCompletionCheckFailures =
    harnessConfig.maxCompletionCheckFailures ?? DEFAULT_MAX_COMPLETION_CHECK_FAILURES;
  const session = createWorkerSession(taskText, loopDeps, sessionConfig);

  return runHarnessCycles({
    taskText,
    runDir,
    maxWorkerCycles,
    maxCompletionCheckFailures,
    session,
    verifierCallModel,
    checkpointWriter,
    toolCheckpoint,
    start: { cycle: 1, completionCheckFailures: 0, cycleRecords: [] },
  });
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

/** Render code-check failures as the worker-facing list. */
function formatCheckFailures(failures: readonly CompletionFailure[]): string {
  return failures
    .map((failure) => {
      const target = failure.outputId === undefined ? '' : ` [${failure.outputId}]`;
      return `- ${failure.code}${target}: ${failure.message}`;
    })
    .join('\n');
}
