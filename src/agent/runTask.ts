// Public composition root for the single Sherlock runtime.
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  assertJavaScriptPolicy,
  type BrowserJavaScriptPolicy,
} from '../browser/browserJavaScript.js';
import type { BrowserController } from '../browser/controller.js';
import { findDevRoot, resolveSherlockPaths } from '../config/paths.js';
import type { CallModel } from '../model/messages.js';
import { DEFAULT_MODEL, type ProgressEvent } from '../model/callModel.js';
import {
  createAnthropicModelDriver,
  isModelResponseRejectedError,
  validateModelResponseForExecution,
  type AcceptedModelResponse,
  type ModelAttemptEvent,
  type ModelDriver,
  type ModelDriverConfig,
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
import { ceilingToCheckpoint } from './checkpoint.js';
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

/** Configuration for one fresh evidence-collection run. Omitted budget
 * levers fall back to PRODUCTION_DEFAULTS. */
export interface RunTaskConfig {
  browser: BrowserController;
  runsBaseDir?: string;
  startUrl?: string;
  model?: string;
  /** Ceiling on worker turns; defaults to PRODUCTION_DEFAULTS.maxWorkerTurns. */
  maxTurns?: number;
  /** Ceiling on the worker's context window in tokens; defaults to
   * PRODUCTION_DEFAULTS.maxContextTokens. */
  maxContextTokens?: number;
  /** Ceiling on the run's wall time in milliseconds; defaults to
   * PRODUCTION_DEFAULTS.maxWallTimeMs. */
  maxWallTimeMs?: number;
  onProgress?: (event: ProgressEvent) => void;
  callModel?: CallModel;
  createStream?: ModelDriverConfig['createStream'];
  tracing?: RunTracing;
  requestPermission?: ToolCtx['requestPermission'];
  authenticated?: boolean;
  javascriptPolicy?: BrowserJavaScriptPolicy;
  harness?: HarnessConfig;
  signal?: AbortSignal;
}

/** A finished run directory and its truthful terminal outcome. */
export type RunTaskResult = { runDir: string } & RunOutcome;

/** Start a fresh run through the initializer → worker → verifier
 * coordinator while preserving runTask's public dependency seams. */
export async function runTask(taskText: string, config: RunTaskConfig): Promise<RunTaskResult> {
  const configuration = buildFreshConfiguration(taskText, config);
  const runDir = createRunDir(config.runsBaseDir ?? DEFAULT_RUNS_BASE_DIR, generateRunId(taskText));
  initManifest(runDir, taskText, configuration.browserProvider);

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

    const initializerModel = tracing.wrapModelDriver(
      modelFromCallModel(config.harness?.initializerCallModel, () =>
        createContractInitializerModelDriver({
          ...(config.createStream === undefined ? {} : { createStream: config.createStream }),
        }),
      ),
      INITIALIZER_MODEL,
      'initializer',
    );
    const workerModel = tracing.wrapModelDriver(
      modelFromCallModel(config.callModel, () =>
        createAnthropicModelDriver({
          model: configuration.model,
          system: workerPrompt,
          apiToolDefs: WORKER_API_TOOL_DEFS,
          maxOutputTokens: configuration.maxOutputTokens,
          ...(config.createStream === undefined ? {} : { createStream: config.createStream }),
        }),
      ),
      configuration.model,
      'worker',
    );
    const verifierModel = tracing.wrapModelDriver(
      modelFromCallModel(config.harness?.verifierCallModel, () =>
        createVerifierModelDriver({
          ...(config.createStream === undefined ? {} : { createStream: config.createStream }),
        }),
      ),
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
    maxOutputTokens: PRODUCTION_DEFAULTS.maxOutputTokens,
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
      maxToolCalls: ceilingToCheckpoint(PRODUCTION_DEFAULTS.maxToolCalls),
      maxModelTokens: ceilingToCheckpoint(PRODUCTION_DEFAULTS.maxModelTokens),
      maxWallTimeMs: ceilingToCheckpoint(
        config.maxWallTimeMs ?? PRODUCTION_DEFAULTS.maxWallTimeMs,
      ),
    },
  });
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
