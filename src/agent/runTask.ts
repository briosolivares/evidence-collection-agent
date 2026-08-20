// Public composition root for the single Sherlock runtime.
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  assertJavaScriptPolicy,
  type BrowserJavaScriptPolicy,
} from '../browser/browserJavaScript.js';
import type { BrowserController } from '../browser/controller.js';
import { findDevRoot, resolveSherlockPaths } from '../config/paths.js';
import type { CallModel, Message } from '../model/messages.js';
import { DEFAULT_MODEL, type CallModelConfig, type ProgressEvent } from '../model/callModel.js';
import {
  createAnthropicModelDriver,
  isModelResponseRejectedError,
  validateModelResponseForExecution,
  type AcceptedModelResponse,
  type ModelAttemptEvent,
  type ModelDriver,
} from '../model/modelDriver.js';
import { initManifest } from '../run/artifacts.js';
import { createRunDir } from '../run/runDir.js';
import { generateRunId } from '../run/runId.js';
import { incompleteFinalText, type RunOutcome } from '../run/runOutcome.js';
import { createRunTracing, type RunTracing } from '../tracing/runTracing.js';
import type { ToolCtx } from '../tools/registry.js';
import {
  INITIALIZER_MODEL,
  createContractInitializerModelDriver,
} from './initializer/initializer.js';
import { VERIFIER_MODEL, createVerifierModelDriver } from './verifier/verifier.js';
import {
  readCheckpointResumeInfo,
  ceilingFromCheckpoint,
  ceilingToCheckpoint,
} from './checkpoint.js';
import {
  durableRunConfigurationSchema,
  type DurableRunConfiguration,
  type DurableTerminalOutcome,
} from './checkpoint.schema.js';
import { runAgent } from './lifecycle.js';
import { workerPrompt } from '../prompts/index.js';
import { WORKER_API_TOOL_DEFS, createWorkerToolRegistry } from '../tools/index.js';
import { BASH_SECRET_ENV_DENYLIST } from '../tools/bash/secretEnvironment.js';

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DEFAULT_RUNS_BASE_DIR = resolveSherlockPaths({
  devRoot: findDevRoot(PACKAGE_ROOT),
}).runsBaseDir;

/** Production defaults. Tool outputs are bounded per result/message and
 * offloaded to disk; whole-run model, tool-call, and tool-result totals
 * remain observable without acting as arbitrary completion ceilings. Wall
 * time is the run's bound on research persistence. */
export const PRODUCTION_DEFAULTS = Object.freeze({
  maxOutputTokens: 8_192,
  maxWorkerTurns: Infinity,
  maxContextTokens: 900_000,
  maxToolCalls: Infinity,
  maxModelTokens: Infinity,
  maxWallTimeMs: 3_600_000,
  maxCompletionCheckFailures: 5,
  /** Retained in durable budget configuration as an unbounded compatibility
   * field. Correction cycles are bounded by the ordinary whole-run guards. */
  maxVerifierCorrections: Infinity,
});

/** Run-scoped initializer/verifier tuning and injectable model seams. */
export interface HarnessConfig {
  /** Test or alternate initializer model. */
  initializerCallModel?: CallModel;
  /** Test or alternate fresh verifier model. */
  verifierCallModel?: CallModel;
  /** Deterministic finish-check rejection ceiling; defaults to five. */
  maxCompletionCheckFailures?: number;
}

/** Configuration for one fresh evidence-collection run. */
export interface RunTaskConfig {
  browser: BrowserController;
  runsBaseDir?: string;
  startUrl?: string;
  model?: string;
  maxOutputTokens?: number;
  maxTurns?: number;
  maxContextTokens?: number;
  maxToolCalls?: number;
  maxModelTokens?: number;
  maxWallTimeMs?: number;
  onProgress?: (event: ProgressEvent) => void;
  callModel?: CallModel;
  createStream?: CallModelConfig['createStream'];
  tracing?: RunTracing;
  requestPermission?: ToolCtx['requestPermission'];
  authenticated?: boolean;
  javascriptPolicy?: BrowserJavaScriptPolicy;
  harness?: HarnessConfig;
  signal?: AbortSignal;
}

/** A finished run directory and its truthful terminal outcome. */
export type RunTaskResult = { runDir: string } & RunOutcome;

/** Live dependencies and optional durable-configuration assertions for
 * resuming a run. A fresh browser's authentication authority must always
 * be stated explicitly. */
export interface ResumeTaskConfig {
  browser: BrowserController;
  model?: string;
  maxOutputTokens?: number;
  maxTurns?: number;
  maxContextTokens?: number;
  maxToolCalls?: number;
  maxModelTokens?: number;
  maxWallTimeMs?: number;
  startUrl?: string;
  onProgress?: (event: ProgressEvent) => void;
  callModel?: CallModel;
  createStream?: CallModelConfig['createStream'];
  tracing?: RunTracing;
  requestPermission?: ToolCtx['requestPermission'];
  authenticated: boolean;
  javascriptPolicy?: BrowserJavaScriptPolicy;
  harness?: HarnessConfig;
  signal?: AbortSignal;
}

/** Start a fresh run through the initializer → worker → verifier
 * coordinator while preserving runTask's public dependency seams. */
export async function runTask(taskText: string, config: RunTaskConfig): Promise<RunTaskResult> {
  const configuration = buildFreshConfiguration(taskText, config);
  const runDir = createRunDir(config.runsBaseDir ?? DEFAULT_RUNS_BASE_DIR, generateRunId(taskText));
  initManifest(runDir, taskText, configuration.browserProvider);

  return executeRun(runDir, configuration, config);
}

/** Resume a checkpoint. The read-only loader performs no locking or
 * mutation; the coordinator re-reads the full checkpoint after acquiring its
 * run lock and rejects any configuration drift. */
export async function resumeTask(runDir: string, config: ResumeTaskConfig): Promise<RunTaskResult> {
  const resumeInfo = readCheckpointResumeInfo(runDir);
  const durable = resumeInfo.configuration;
  assertResumeConfigurationMatches(durable, config);
  const configuration = structuredClone(durable) as DurableRunConfiguration;
  if (resumeInfo.phase === 'terminal') {
    return executeTerminalResume(runDir, configuration, config);
  }
  return executeRun(runDir, configuration, config);
}

type LiveRunConfig = Pick<
  RunTaskConfig,
  | 'browser'
  | 'callModel'
  | 'createStream'
  | 'harness'
  | 'onProgress'
  | 'requestPermission'
  | 'signal'
  | 'tracing'
>;

const TERMINAL_RESUME_MODEL: ModelDriver = {
  generate: async () => {
    throw new Error('terminal resume unexpectedly invoked a model');
  },
};

/** Repair/read an already-terminal run without opening a new Langfuse root,
 * wrapping tools, or constructing live model clients. Explicit tracing still
 * receives the local run-directory announcement needed by the TUI. */
async function executeTerminalResume(
  runDir: string,
  configuration: DurableRunConfiguration,
  config: LiveRunConfig,
): Promise<RunTaskResult> {
  try {
    config.tracing?.announceRunDir?.(runDir);
    const outcome = await runAgent({
      runDir,
      configuration,
      initializerModel: TERMINAL_RESUME_MODEL,
      workerModel: TERMINAL_RESUME_MODEL,
      verifierModel: TERMINAL_RESUME_MODEL,
      registry: new Map(),
      browser: config.browser,
      ...(config.signal === undefined ? {} : { signal: config.signal }),
    });
    return normalizeOutcome(runDir, outcome);
  } finally {
    await config.tracing?.close();
  }
}

async function executeRun(
  runDir: string,
  configuration: DurableRunConfiguration,
  config: LiveRunConfig,
): Promise<RunTaskResult> {
  const tracing = config.tracing ?? createRunTracing();
  try {
    tracing.announceRunDir?.(runDir);
    const progress = createWorkerProgressBridge(config.onProgress);
    const registry = tracing.wrapRegistry(
      createWorkerToolRegistry({
        javascriptPolicy: configuration.javascriptPolicy,
        secretEnvDenylist: BASH_SECRET_ENV_DENYLIST,
      }),
    );

    const initializerModel = traceModelDriver(
      modelFromCallModel(config.harness?.initializerCallModel, () =>
        createContractInitializerModelDriver({
          ...(config.createStream === undefined ? {} : { createStream: config.createStream }),
        }),
      ),
      tracing,
      INITIALIZER_MODEL,
      'initializer',
    );
    const workerModel = traceModelDriver(
      modelFromCallModel(config.callModel, () =>
        createAnthropicModelDriver({
          model: configuration.model,
          system: workerPrompt,
          apiToolDefs: WORKER_API_TOOL_DEFS,
          maxOutputTokens: configuration.maxOutputTokens,
          ...(config.createStream === undefined ? {} : { createStream: config.createStream }),
        }),
      ),
      tracing,
      configuration.model,
      'worker',
    );
    const verifierModel = traceModelDriver(
      modelFromCallModel(config.harness?.verifierCallModel, () =>
        createVerifierModelDriver({
          ...(config.createStream === undefined ? {} : { createStream: config.createStream }),
        }),
      ),
      tracing,
      VERIFIER_MODEL,
      'verifier',
    );

    return await tracing.traceRun(configuration.taskText, async () => {
      const outcome = await runAgent({
        runDir,
        configuration,
        initializerModel,
        workerModel,
        verifierModel,
        registry,
        browser: config.browser,
        ...(config.requestPermission === undefined
          ? {}
          : { requestPermission: config.requestPermission }),
        ...(config.signal === undefined ? {} : { signal: config.signal }),
        ...(progress === undefined
          ? {}
          : {
              onModelEvent: (role, event) => {
                if (role === 'worker') progress(event);
              },
            }),
      });
      return normalizeOutcome(runDir, outcome);
    });
  } finally {
    await tracing.close();
  }
}

function buildFreshConfiguration(taskText: string, config: RunTaskConfig): DurableRunConfiguration {
  const authenticated = config.authenticated ?? false;
  const javascriptPolicy = assertJavaScriptPolicy(config.javascriptPolicy, authenticated);
  const startUrl = usableStartUrl(config.startUrl);
  return durableRunConfigurationSchema.parse({
    taskText,
    model: config.model ?? DEFAULT_MODEL,
    maxOutputTokens: config.maxOutputTokens ?? PRODUCTION_DEFAULTS.maxOutputTokens,
    maxContextTokens: ceilingToCheckpoint(
      config.maxContextTokens ?? PRODUCTION_DEFAULTS.maxContextTokens,
    ),
    browserProvider: browserProvider(config.browser),
    authenticated,
    javascriptPolicy,
    ...(startUrl === undefined ? {} : { startUrl }),
    maxInitializerAttempts: 2,
    maxCompletionCheckFailures:
      config.harness?.maxCompletionCheckFailures ?? PRODUCTION_DEFAULTS.maxCompletionCheckFailures,
    budgetLimits: {
      maxWorkerTurns: ceilingToCheckpoint(config.maxTurns ?? PRODUCTION_DEFAULTS.maxWorkerTurns),
      maxToolCalls: ceilingToCheckpoint(config.maxToolCalls ?? PRODUCTION_DEFAULTS.maxToolCalls),
      maxModelTokens: ceilingToCheckpoint(
        config.maxModelTokens ?? PRODUCTION_DEFAULTS.maxModelTokens,
      ),
      maxWallTimeMs: ceilingToCheckpoint(config.maxWallTimeMs ?? PRODUCTION_DEFAULTS.maxWallTimeMs),
      maxVerifierCorrections: ceilingToCheckpoint(PRODUCTION_DEFAULTS.maxVerifierCorrections),
    },
  });
}

function assertResumeConfigurationMatches(
  durable: Readonly<DurableRunConfiguration>,
  config: ResumeTaskConfig,
): void {
  const check = (name: string, supplied: unknown, stored: unknown): void => {
    if (supplied !== undefined && supplied !== stored) {
      throw new Error(
        `resume configuration mismatch for ${name}: checkpoint has ` +
          `${JSON.stringify(stored)}, caller supplied ${JSON.stringify(supplied)}`,
      );
    }
  };

  if (typeof config.authenticated !== 'boolean') {
    throw new Error('resume requires the caller to explicitly state authenticated=true or false');
  }

  const provider = browserProvider(config.browser);
  if (provider !== durable.browserProvider) {
    throw new Error(
      `resume configuration mismatch for browserProvider: checkpoint has ` +
        `${JSON.stringify(durable.browserProvider)}, live browser is ${JSON.stringify(provider)}`,
    );
  }

  check('model', config.model, durable.model);
  check('maxOutputTokens', config.maxOutputTokens, durable.maxOutputTokens);
  check('maxTurns', config.maxTurns, ceilingFromCheckpoint(durable.budgetLimits.maxWorkerTurns));
  check(
    'maxContextTokens',
    config.maxContextTokens,
    ceilingFromCheckpoint(durable.maxContextTokens),
  );
  check(
    'maxToolCalls',
    config.maxToolCalls,
    ceilingFromCheckpoint(durable.budgetLimits.maxToolCalls),
  );
  check(
    'maxModelTokens',
    config.maxModelTokens,
    ceilingFromCheckpoint(durable.budgetLimits.maxModelTokens),
  );
  check(
    'maxWallTimeMs',
    config.maxWallTimeMs,
    ceilingFromCheckpoint(durable.budgetLimits.maxWallTimeMs),
  );
  check(
    'startUrl',
    config.startUrl === undefined ? undefined : usableStartUrl(config.startUrl),
    durable.startUrl,
  );
  check('authenticated', config.authenticated, durable.authenticated);
  check('javascriptPolicy', config.javascriptPolicy, durable.javascriptPolicy);
  check(
    'harness.maxCompletionCheckFailures',
    config.harness?.maxCompletionCheckFailures,
    durable.maxCompletionCheckFailures,
  );
}

function modelFromCallModel(
  callModel: CallModel | undefined,
  createDefault: () => ModelDriver,
): ModelDriver {
  return callModel === undefined ? createDefault() : adaptCallModel(callModel);
}

/** Preserve the long-standing CallModel injection seam while putting even a
 * test/alternate implementation behind the runtime's whole-response validation. */
function adaptCallModel(callModel: CallModel): ModelDriver {
  return {
    async generate(options): Promise<AcceptedModelResponse> {
      options.signal?.throwIfAborted();
      options.onEvent?.({ type: 'attempt_start', attemptId: 1 });
      const response = await callModel(options.messages);
      options.signal?.throwIfAborted();
      try {
        const accepted = validateModelResponseForExecution(response, {
          maxToolCallsPerTurn: 16,
        });
        options.onEvent?.({
          type: 'attempt_accepted',
          attemptId: 1,
          usage: response.usage,
        });
        return {
          ...accepted,
          attempts: 1,
          usage: response.usage,
        };
      } catch (error) {
        if (isModelResponseRejectedError(error)) {
          options.onEvent?.({
            type: 'attempt_rejected',
            attemptId: 1,
            reason: error.reason,
            message: error.message,
          });
        }
        throw error;
      }
    },
  };
}

/** RunTracing's stable public decorator predates ModelDriver. This adapter
 * preserves aggregate driver accounting while letting the tracing layer see
 * the accepted response and exact per-call messages. */
function traceModelDriver(
  driver: ModelDriver,
  tracing: RunTracing,
  model: string,
  role: 'initializer' | 'worker' | 'verifier',
): ModelDriver {
  return {
    async generate(options): Promise<AcceptedModelResponse> {
      let accepted: AcceptedModelResponse | undefined;
      const traced = tracing.wrapCallModel(
        async (messages: readonly Message[]) => {
          accepted = await driver.generate({ ...options, messages });
          return {
            ...accepted.response,
            // Langfuse must see every known billable attempt in this logical
            // request, including a discarded max_tokens re-ask.
            usage: accepted.usage,
          };
        },
        model,
        role,
      );
      await traced(options.messages);
      if (accepted === undefined) {
        throw new Error('traced model call returned without an accepted response');
      }
      return accepted;
    },
  };
}

function createWorkerProgressBridge(
  onProgress: ((event: ProgressEvent) => void) | undefined,
): ((event: ModelAttemptEvent) => void) | undefined {
  if (onProgress === undefined) return undefined;
  let turn = 0;
  return (event): void => {
    switch (event.type) {
      case 'attempt_start':
        if (event.attemptId === 1) {
          turn += 1;
          onProgress({ type: 'turn_start', turn });
        }
        break;
      case 'text_delta':
        onProgress({ type: 'text_delta', turn, text: event.text });
        break;
      case 'tool_use_start':
        onProgress({
          type: 'tool_use_start',
          turn,
          toolName: event.toolName,
        });
        break;
      case 'retry':
        onProgress({
          type: 'retry',
          turn,
          attempt: event.attempt,
          maxAttempts: event.maxAttempts,
          delayMs: event.delayMs,
          reason: event.reason,
        });
        break;
      case 'attempt_accepted':
        onProgress({ type: 'turn_end', turn, usage: event.usage });
        break;
      case 'attempt_rejected':
        // Rejected deltas stay ephemeral. The next turn_start (or the run's
        // terminal event) settles the TUI's pending attempt as retried.
        break;
    }
  };
}

function normalizeOutcome(runDir: string, outcome: DurableTerminalOutcome): RunTaskResult {
  if (outcome.status === 'verified') return { runDir, ...outcome };
  if (outcome.status === 'incomplete') {
    return {
      runDir,
      status: 'incomplete',
      reason: outcome.reason,
      detail: outcome.detail,
      finalText: incompleteFinalText(outcome.finalText),
      unresolved: outcome.unresolved,
    } satisfies { runDir: string } & RunOutcome;
  }
  if (outcome.status === 'cancelled') {
    const error = new Error(outcome.reason);
    error.name = 'AbortError';
    throw error;
  }
  throw new Error(`run failed during ${outcome.during}: ${outcome.message}`);
}

function browserProvider(browser: BrowserController): DurableRunConfiguration['browserProvider'] {
  return browser.sessionDiagnostics?.provider ?? 'local';
}

export function usableStartUrl(startUrl: string | undefined): string | undefined {
  if (startUrl === undefined) return undefined;
  try {
    const protocol = new URL(startUrl).protocol;
    return protocol === 'http:' || protocol === 'https:' ? startUrl : undefined;
  } catch {
    return undefined;
  }
}
