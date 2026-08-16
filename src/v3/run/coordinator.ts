import { Buffer } from 'node:buffer';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { BrowserController } from '../../browser/controller.js';
import type { OutputContract } from '../../contracts/outputContract.js';
import type { CallModel } from '../../loop/messages.js';
import {
  isModelGenerationFailedError,
  isModelResponseRejectedError,
  type ModelDriver,
  type ModelAttemptEvent,
} from '../../model/modelDriver.js';
import {
  finalizeManifest,
  readManifest,
  recoverPendingArtifactWrites,
} from '../../run/artifacts.js';
import { writeFileDurablyAtomic } from '../../run/atomicFile.js';
import {
  captureRunBudgetSnapshot,
  createRunBudgetTracker,
  type RunBudgetConfig,
  type RunBudgetTracker,
} from '../../run/runBudget.js';
import {
  TRANSCRIPT_FILENAME,
  appendTranscriptEvent,
} from '../../run/transcript.js';
import { syncScratchWorkspace } from '../../run/syncScratchWorkspace.js';
import { BUSY_RESOURCE_GATE_TIMEOUT_MS } from '../../tools/pipeline.js';
import {
  createBusyResourceRegistry,
  EXCLUSIVE_ACCESS,
  type BusyResourceRegistry,
  type PermissionDecision,
  type PermissionRequest,
  type ToolRegistry,
} from '../../tools/registry.js';
import { inspectManifest } from '../completion/artifactInspection.js';
import {
  runV3FinishChecks,
  toV3SettledFacts,
  type V3FinishFacts,
} from '../completion/finishChecks.js';
import {
  V3_INITIALIZER_MAX_ATTEMPTS,
  captureV3ContractInitializerState,
  createV3ContractInitializerState,
  formatV3ContractGuidance,
  restoreV3ContractInitializerState,
  runV3ContractInitializer,
  type V3ContractInitializerState,
} from '../harness/initializer.js';
import {
  collectV3UserClarifications,
  runV3Verifier,
} from '../harness/verifier.js';
import {
  appendV3FinishResult,
  captureV3WorkerSessionSnapshot,
  createV3WorkerSession,
  restoreV3WorkerSession,
  resumeV3PendingToolTurn,
  runV3WorkerSession,
  type V3FinishRequest,
  type V3PendingToolTurn,
  type V3WorkerIncompleteReason,
  type V3WorkerLifecycleHooks,
  type V3WorkerMetrics,
  type V3WorkerSession,
  type V3WorkerSessionSnapshot,
} from '../loop/workerSession.js';
import {
  V3RoleBudgetExceededError,
  createV3BudgetedCallModel,
  isV3RoleBudgetExceededError,
} from '../model/budgetedCall.js';
import type { FinishInput } from '../tools/finish.js';
import {
  V3_CHECKPOINT_VERSION,
  openV3CheckpointStore,
  v3CeilingFromCheckpoint,
  v3DurableRunConfigurationSchema,
  type V3Checkpoint,
  type V3CheckpointPhase,
  type V3CheckpointStoreOptions,
  type V3DurableRunConfiguration,
  type V3DurableTerminalOutcome,
} from './checkpoint.js';
import { ensureV3OutputContractFile } from './outputContractFile.js';
import {
  createV3RunDeadline,
  raceWithV3RunSignal,
} from './runDeadline.js';

type V3CheckpointCommonKey =
  | 'version'
  | 'revision'
  | 'updatedAt'
  | 'configuration'
  | 'budget'
  | 'progress';

type V3CheckpointPhaseState = V3Checkpoint extends infer Checkpoint
  ? Checkpoint extends V3Checkpoint
    ? Omit<Checkpoint, V3CheckpointCommonKey>
    : never
  : never;

export interface RunV3CoordinatorOptions {
  runDir: string;
  configuration: V3DurableRunConfiguration;
  initializerModel: ModelDriver;
  workerModel: ModelDriver;
  verifierModel: ModelDriver;
  registry: ToolRegistry;
  /** One run-owned ledger for effects abandoned by an outer tool timeout.
   * Omit in production to create a fresh ledger; injectable for focused
   * recovery tests. */
  busyRegistry?: BusyResourceRegistry;
  browser?: BrowserController;
  requestPermission?: (
    request: PermissionRequest,
  ) => Promise<PermissionDecision>;
  signal?: AbortSignal;
  onModelEvent?: (
    role: 'initializer' | 'worker' | 'verifier',
    event: ModelAttemptEvent,
  ) => void;
  checkpointStoreOptions?: V3CheckpointStoreOptions;
  /** Observability/test seam called only after a checkpoint is durable. */
  afterCheckpoint?: (checkpoint: V3Checkpoint) => void | Promise<void>;
  /** Bound for browser page cleanup only. Production uses the exported
   * default; focused tests may shorten it without changing tool deadlines. */
  terminalBrowserCleanupTimeoutMs?: number;
  /** Finite warning gate before terminalization switches to an unbounded
   * fixed-point drain while retaining the run lock. Production uses the
   * shared tool gate; focused tests may shorten it. */
  terminalBusyResourceTimeoutMs?: number;
  /** Independent bound for integrity verification of an already-terminal
   * checkpoint. Active runs use their restored whole-run deadline instead. */
  terminalResumeInspectionTimeoutMs?: number;
  now?: () => number;
}

export const V3_TERMINAL_BROWSER_CLEANUP_TIMEOUT_MS = 10_000;
export const V3_TERMINAL_RESUME_INSPECTION_TIMEOUT_MS = 30_000;

/** Run or resume one v3 initializer → worker → checks → verifier lifecycle.
 * The checkpoint is authoritative; a terminal checkpoint is returned without
 * invoking a model or touching the browser. */
export async function runV3Coordinator(
  options: RunV3CoordinatorOptions,
): Promise<V3DurableTerminalOutcome> {
  const configuration = v3DurableRunConfigurationSchema.parse(
    options.configuration,
  );
  terminalBrowserCleanupTimeout(options);
  terminalBusyResourceTimeout(options);
  terminalResumeInspectionTimeout(options);
  if (configuration.maxInitializerAttempts !== V3_INITIALIZER_MAX_ATTEMPTS) {
    throw new Error(
      `v3 requires exactly ${V3_INITIALIZER_MAX_ATTEMPTS} initializer attempts ` +
        `(one initial response plus one repair)`,
    );
  }

  const store = await openV3CheckpointStore(
    options.runDir,
    options.checkpointStoreOptions,
  );
  try {
    const loaded = store.load();
    if (
      loaded !== undefined &&
      JSON.stringify(loaded.configuration) !== JSON.stringify(configuration)
    ) {
      throw new Error('resume configuration does not match the durable v3 checkpoint');
    }
    const now = options.now ?? Date.now;
    if (loaded?.phase === 'terminal') {
      const checkActive = createTerminalResumeInspectionGuard(options, now);
      recoverAndInspectRun(
        options.runDir,
        configuration,
        loaded.phase,
        checkActive,
      );
      if (loaded.contract !== undefined) {
        ensureV3OutputContractFile(options.runDir, loaded.contract);
      }
      if (loaded.outcome.status === 'verified') {
        const checks = runV3FinishChecks({
          runDir: options.runDir,
          contract: loaded.contract!,
          finish: loaded.finish!,
          checkActive,
        });
        if (checks.status === 'failed') {
          throw new Error(
            `verified terminal run no longer passes deterministic checks:\n${formatDefects(
              checks.defects,
            )}`,
          );
        }
      }
      repairTerminalProjections(options.runDir, loaded);
      return loaded.outcome;
    }

    const budget = createRunBudgetTracker(
      budgetConfig(configuration),
      {
        now,
        ...(loaded === undefined ? {} : { restore: loaded.budget }),
        ...(loaded === undefined
          ? {}
          : { restoreSnapshotAtMs: Date.parse(loaded.updatedAt) }),
      },
    );
    const deadline = createV3RunDeadline(budget, options.signal);
    try {
      const state = new CoordinatorState(
        options,
        configuration,
        store,
        budget,
        loaded,
        now,
        deadline.signal,
      );
      const terminalizePreflightControl = async (
        outcome: V3DurableTerminalOutcome,
      ): Promise<V3DurableTerminalOutcome> => {
        // The run deadline/cancellation stops active inspection, but a
        // terminal checkpoint must not strand a half-recovered artifact
        // transaction or executing-tool workspace. Re-run the idempotent
        // integrity pass under the separate finite terminal safety bound,
        // deliberately ignoring the already-fired run signal. If this pass
        // cannot complete, refuse terminalization and leave the active
        // checkpoint for a later recovery attempt.
        const cleanupCheck = createTerminalResumeInspectionGuard(
          options,
          now,
          false,
        );
        recoverAndInspectRun(
          options.runDir,
          configuration,
          loaded?.phase,
          cleanupCheck,
        );
        if (loaded?.contract !== undefined) {
          ensureV3OutputContractFile(options.runDir, loaded.contract);
        }
        return state.terminalize(outcome);
      };
      const checkActive = (): void => {
        deadline.signal.throwIfAborted();
        const limit = budget.exceededLimit(['worker_turns']);
        if (limit !== undefined) throw new V3RoleBudgetExceededError(limit);
      };
      try {
        recoverAndInspectRun(
          options.runDir,
          configuration,
          loaded?.phase,
          checkActive,
        );
        if (loaded?.contract !== undefined) {
          ensureV3OutputContractFile(options.runDir, loaded.contract);
        }
      } catch (error) {
        const deadlineError = wallDeadlineError(error, deadline.signal);
        if (deadlineError !== undefined) {
          return await terminalizePreflightControl(
            incompleteBudget(deadlineError.limit, state.finalText(), state.phase),
          );
        }
        if (isV3RoleBudgetExceededError(error)) {
          return await terminalizePreflightControl(
            incompleteBudget(error.limit, state.finalText(), state.phase),
          );
        }
        if (deadline.signal.aborted) {
          return await terminalizePreflightControl({
            status: 'cancelled',
            during: state.phase,
            reason: abortReason(deadline.signal.reason),
          });
        }
        throw error;
      }

      try {
        return await state.run();
      } catch (error) {
        if (state.isTerminalizing()) throw error;
        const deadlineError = wallDeadlineError(error, deadline.signal);
        if (deadlineError !== undefined) {
          return await state.terminalize(
            incompleteBudget(deadlineError.limit, state.finalText(), state.phase),
          );
        }
        if (isV3RoleBudgetExceededError(error)) {
          return await state.terminalize(
            incompleteBudget(error.limit, state.finalText(), state.phase),
          );
        }
        if (deadline.signal.aborted) {
          return await state.terminalize({
            status: 'cancelled',
            during: state.phase,
            reason: abortReason(deadline.signal.reason),
          });
        }
        if (error instanceof InitializerUnavailableError) {
          return await state.terminalize({
            status: 'incomplete',
            during: state.phase,
            reason: 'initializer_unavailable',
            detail: boundedDiagnostic(errorMessage(error)),
            finalText: '',
          });
        }
        if (
          error instanceof WorkerModelUnavailableError ||
          isModelGenerationFailedError(error)
        ) {
          return await state.terminalize({
            status: 'incomplete',
            during: state.phase,
            reason: 'worker_incomplete',
            detail: boundedDiagnostic(errorMessage(error)),
            finalText: state.finalText(),
          });
        }
        return await state.terminalize({
          status: 'failed',
          during: state.phase,
          message: boundedDiagnostic(errorMessage(error)),
        });
      }
    } finally {
      deadline.dispose();
    }
  } finally {
    await store.close();
  }
}

class CoordinatorState {
  phase: Exclude<V3CheckpointPhase, 'terminal'>;

  private revision: number;
  private contract: OutputContract | undefined;
  private session: V3WorkerSession | undefined;
  private pendingTurn: V3PendingToolTurn | undefined;
  private pendingFinish: V3FinishRequest | undefined;
  private pendingFacts: V3FinishFacts | undefined;
  private verifierCycles: number;
  private completionCheckFailures: number;
  private terminalizing = false;
  private suppressFinishReadyCheckpoint = false;
  private browserPrepared = false;
  private verifiedFinish: FinishInput | undefined;
  private readonly busyRegistry: BusyResourceRegistry;

  constructor(
    private readonly options: RunV3CoordinatorOptions,
    private readonly configuration: V3DurableRunConfiguration,
    private readonly store: Awaited<ReturnType<typeof openV3CheckpointStore>>,
    private readonly budget: RunBudgetTracker,
    private readonly loaded: Exclude<V3Checkpoint, { phase: 'terminal' }> | undefined,
    private readonly now: () => number,
    private readonly runSignal: AbortSignal,
  ) {
    this.phase = loaded?.phase ?? 'initializing';
    this.revision = loaded?.revision ?? 0;
    this.contract = loaded?.contract;
    this.verifierCycles = loaded?.progress.verifierCycles ?? 0;
    this.completionCheckFailures =
      loaded?.progress.completionCheckFailures ?? 0;
    if (loaded?.phase === 'executing_tool') this.pendingTurn = loaded.pendingTurn;
    if (loaded?.phase === 'checking' || loaded?.phase === 'verifying') {
      this.pendingFinish = loaded.pendingFinish;
    }
    if (loaded?.phase === 'verifying') {
      this.pendingFacts = loaded.pendingCheck.facts;
    }
    this.busyRegistry = options.busyRegistry ?? createBusyResourceRegistry();
  }

  async run(): Promise<V3DurableTerminalOutcome> {
    // Browser-internal abandoned renderer work and tool-pipeline abandonment
    // must live in one ledger. Otherwise a later finish could see the tool
    // layer as idle while the controller is still mutating the same page.
    this.options.browser?.setBusyRegistry?.(this.busyRegistry);
    this.runSignal.throwIfAborted();
    if (this.phase === 'initializing') await this.initialize();
    this.restoreOrCreateWorker();

    for (;;) {
      this.runSignal.throwIfAborted();

      if (this.phase === 'executing_tool') {
        await this.prepareBrowser();
        const outcome = await resumeV3PendingToolTurn(
          this.requireSession(),
          this.requirePendingTurn(),
        );
        this.pendingTurn = undefined;
        if (outcome.kind === 'incomplete') {
          return this.terminalize(
            workerIncomplete(outcome.reason, this.phase, outcome.detail),
          );
        }
        this.phase = 'ready_for_model';
      }

      if (this.phase === 'ready_for_model') {
        await this.prepareBrowser();
        const outcome = await runV3WorkerSession(this.requireSession());
        if (outcome.kind === 'incomplete') {
          return this.terminalize(
            workerIncomplete(outcome.reason, this.phase, outcome.detail),
          );
        }
        this.pendingFinish = outcome.request;
        // finishRequested already made the checking checkpoint durable.
        this.phase = 'checking';
      }

      if (this.phase === 'checking') {
        const request = this.requirePendingFinish();
        const resourcesSettled = await raceWithV3RunSignal(
          () =>
            this.busyRegistry.waitUntilFree(
              EXCLUSIVE_ACCESS,
              BUSY_RESOURCE_GATE_TIMEOUT_MS,
              this.runSignal,
            ),
          this.runSignal,
        );
        this.runSignal.throwIfAborted();
        if (!resourcesSettled) {
          await appendV3FinishResult(
            this.requireSession(),
            request,
            JSON.stringify({
              status: 'rejected',
              source: 'resource_busy',
              message:
                'Finish checks were not started because an earlier timed-out effect ' +
                'is still running. Inspect current state and call finish again only ' +
                'after the affected resource is confirmed settled.',
            }),
          );
          this.pendingFinish = undefined;
          this.phase = 'ready_for_model';
          continue;
        }
        const checks = runV3FinishChecks({
          runDir: this.options.runDir,
          contract: this.requireContract(),
          finish: request.input,
          checkActive: () => this.assertFinishInspectionActive(),
        });
        if (checks.status === 'failed') {
          this.completionCheckFailures += 1;
          appendTranscriptEvent(this.options.runDir, {
            type: 'v3_finish_check_failed',
            turn: request.turn,
            attempt: this.completionCheckFailures,
            defects: checks.defects,
          });
          if (
            this.completionCheckFailures >=
            this.configuration.maxCompletionCheckFailures
          ) {
            await this.appendTerminalFinishFailure(
              request,
              JSON.stringify({
                status: 'rejected',
                source: 'deterministic_finish_checks',
                exhausted: true,
                defects: checks.defects,
              }),
            );
            return this.terminalize({
              status: 'incomplete',
              during: this.phase,
              reason: 'completion_check_attempts',
              detail: boundedDiagnostic(
                `deterministic finish checks failed ${this.completionCheckFailures} ` +
                  `time(s): ${formatDefects(checks.defects)}`,
              ),
              finalText: request.input.summary,
            });
          }
          await appendV3FinishResult(
            this.requireSession(),
            request,
            JSON.stringify({
              status: 'rejected',
              source: 'deterministic_finish_checks',
              defects: checks.defects,
            }),
          );
          this.pendingFinish = undefined;
          this.phase = 'ready_for_model';
          continue;
        }

        this.pendingFacts = checks.facts;
        this.verifierCycles += 1;
        await this.saveVerifying(request, checks.facts);
        this.phase = 'verifying';
      }

      if (this.phase === 'verifying') {
        const request = this.requirePendingFinish();
        const facts = this.requirePendingFacts();
        let verification: Awaited<ReturnType<typeof runV3Verifier>>;
        try {
          verification = await runV3Verifier({
            taskText: this.configuration.taskText,
            runDir: this.options.runDir,
            contract: this.requireContract(),
            finish: facts.finish,
            clarifications: collectV3UserClarifications(
              this.requireSession().state.messages,
            ),
            settled: toV3SettledFacts(facts),
            model: this.options.verifierModel,
            budget: this.budget,
            signal: this.runSignal,
            ...(this.options.onModelEvent === undefined
              ? {}
              : {
                  onEvent: (event) =>
                    this.options.onModelEvent?.('verifier', event),
                }),
            afterAccounting: async () => {
              await this.saveVerifying(request, facts);
            },
            now: this.now,
          });

          // The verifier may consume more than one private model request.
          // Make that spend durable while retaining the `verifying` phase
          // before accepting its verdict. A deadline that fires after the
          // provider returns but before this boundary must still win.
          await this.saveVerifying(request, facts);
          this.runSignal.throwIfAborted();
        } catch (error) {
          const budgetError = verifierBudgetError(error, this.runSignal);
          if (budgetError !== undefined) {
            await this.appendTerminalFinishFailure(
              request,
              JSON.stringify({
                status: 'rejected',
                source: 'run_budget',
                budget_limit: budgetError.limit,
                message:
                  'Verification stopped because the shared run budget was exhausted.',
              }),
            );
          }
          throw error;
        }

        if (verification.status === 'verifier_unavailable') {
          await this.appendTerminalFinishFailure(
            request,
            JSON.stringify({
              status: 'unavailable',
              source: 'verifier',
              message:
                'Fresh-context verification was unavailable, so completion was not accepted.',
            }),
          );
          return this.terminalize({
            status: 'incomplete',
            during: this.phase,
            reason: 'verifier_unavailable',
            detail: boundedDiagnostic(verification.reason),
            finalText: request.input.summary,
          });
        }
        if (verification.status === 'verified') {
          // Success is terminal control state, not feedback the worker will
          // consume. Avoid a transient ready_for_model checkpoint and avoid
          // charging unused result bytes after verification has accepted.
          this.verifiedFinish = structuredClone(request.input);
          this.pendingFacts = undefined;
          return this.terminalize({
            status: 'verified',
            finalText: request.input.summary,
          });
        }

        this.budget.recordCorrection();
        const correctionLimit = this.budget.exceededLimit(['worker_turns']);
        if (correctionLimit === 'verifier_corrections') {
          await this.appendTerminalFinishFailure(
            request,
            JSON.stringify({
              status: 'needs_correction',
              exhausted: true,
              findings: verification.findings,
            }),
          );
          return this.terminalize({
            status: 'incomplete',
            during: this.phase,
            reason: 'verification_attempts',
            detail: boundedDiagnostic(
              `verifier requested another correction after ${this.verifierCycles} cycle(s): ` +
                formatFindings(verification.findings),
            ),
            finalText: request.input.summary,
          });
        }
        if (correctionLimit !== undefined) {
          await this.appendTerminalFinishFailure(
            request,
            JSON.stringify({
              status: 'needs_correction',
              exhausted: true,
              budget_limit: correctionLimit,
              findings: verification.findings,
            }),
          );
          return this.terminalize(
            incompleteBudget(correctionLimit, request.input.summary, this.phase),
          );
        }
        await appendV3FinishResult(
          this.requireSession(),
          request,
          JSON.stringify({
            status: 'needs_correction',
            findings: verification.findings,
          }),
        );
        this.pendingFinish = undefined;
        this.pendingFacts = undefined;
        this.phase = 'ready_for_model';
      }
    }
  }

  async terminalize(
    outcome: V3DurableTerminalOutcome,
  ): Promise<V3DurableTerminalOutcome> {
    if (this.terminalizing) throw new Error('recursive v3 terminalization');
    this.terminalizing = true;
    // Preflight cancellation/deadline failure can reach terminalization
    // before `run()` restored the durable worker. Later-phase terminal
    // checkpoints and pending finish feedback still require that exact
    // session cargo, so restore it without invoking any model or tool.
    if (this.phase !== 'initializing' && this.session === undefined) {
      this.restoreOrCreateWorker();
    }

    // A timed-out executor is still a live effect, even though the model has
    // already received a timeout result. Never close pages, persist terminal
    // success, or finalize the manifest while such work may still mutate it.
    // The finite gate keeps the normal path bounded. If it expires, retain
    // the run lock and drain to a fixed point; releasing the lock while the
    // effect remains live would let a fresh coordinator overlap it.
    const resourcesSettled = await this.busyRegistry.waitUntilFree(
      EXCLUSIVE_ACCESS,
      terminalBusyResourceTimeout(this.options),
    );
    if (!resourcesSettled) {
      await this.busyRegistry.drainUntilFree(EXCLUSIVE_ACCESS);
    }

    let finalOutcome = outcome;
    const cleanupErrors: string[] = [];
    if (this.options.browser !== undefined) {
      try {
        await withTimeout(
          this.options.browser.closeTaskPages(),
          terminalBrowserCleanupTimeout(this.options),
          'browser task-page cleanup',
        );
      } catch (error) {
        cleanupErrors.push(`browser pages: ${errorMessage(error)}`);
      }
    }
    if (cleanupErrors.length > 0) {
      finalOutcome = {
        status: 'failed',
        during: this.phase,
        message: boundedDiagnostic(
          `run reached ${formatOutcomeForDiagnostic(outcome)}, but terminal cleanup failed: ` +
            cleanupErrors.join('; '),
        ),
      };
    }

    // Verification is not accepted merely because the verifier returned
    // first. Cancellation or a hard whole-run limit that lands while final
    // effects/pages are draining must win before the terminal checkpoint.
    if (finalOutcome.status === 'verified') {
      const limit = this.budget.exceededLimit(['worker_turns']);
      if (limit !== undefined) {
        finalOutcome = incompleteBudget(
          limit,
          finalOutcome.finalText,
          this.phase,
        );
      } else if (this.runSignal.aborted) {
        finalOutcome = {
          status: 'cancelled',
          during: this.phase,
          reason: abortReason(this.runSignal.reason),
        };
      }
    }

    if (finalOutcome.status !== 'verified' && this.pendingFinish !== undefined) {
      await this.appendTerminalFinishFailure(
        this.pendingFinish,
        JSON.stringify({
          status: 'rejected',
          source: 'run_terminal',
          outcome: finalOutcome.status,
          message: formatOutcomeForDiagnostic(finalOutcome),
        }),
      );
    }

    await this.saveTerminal(finalOutcome);
    const terminal = this.store.load();
    if (terminal?.phase !== 'terminal') {
      throw new Error('terminal checkpoint was not readable after its durable save');
    }
    repairTerminalProjections(this.options.runDir, terminal);
    return finalOutcome;
  }

  finalText(): string {
    return this.pendingFinish?.input.summary ?? '';
  }

  private assertFinishInspectionActive(): void {
    this.runSignal.throwIfAborted();
    const limit = this.budget.exceededLimit(['worker_turns']);
    if (limit !== undefined) throw new V3RoleBudgetExceededError(limit);
  }

  isTerminalizing(): boolean {
    return this.terminalizing;
  }

  private async initialize(): Promise<void> {
    if (this.contract !== undefined) {
      ensureV3OutputContractFile(this.options.runDir, this.contract);
      this.createWorker();
      await this.saveReady();
      this.phase = 'ready_for_model';
      return;
    }

    const state = this.loaded?.phase === 'initializing' && this.loaded.initializer
      ? restoreV3ContractInitializerState(this.loaded.initializer)
      : createV3ContractInitializerState(this.configuration.taskText);
    if (this.revision === 0) await this.saveInitializing({ initializer: state });

    const budgetedCallModel = createV3BudgetedCallModel({
      model: this.options.initializerModel,
      budget: this.budget,
      role: 'initializer',
      onAcceptedResponse: (response) => {
        this.budget.recordToolCalls(
          response.content.filter((block) => block.type === 'tool_use').length,
        );
      },
      afterAttemptSettled: async () => {
        await this.saveInitializing({ initializer: state });
      },
      signal: this.runSignal,
      ...(this.options.onModelEvent === undefined
        ? {}
        : {
            onEvent: (event) =>
              this.options.onModelEvent?.('initializer', event),
          }),
      now: this.now,
    });
    const callModel = initializerModelBoundary(
      budgetedCallModel,
      this.runSignal,
    );
    let result;
    try {
      result = await runV3ContractInitializer(state, callModel, {
        beforeRequest: async (snapshot) => {
          await this.saveInitializing({ initializer: snapshot });
        },
        afterAttempt: async (event) => {
          if (event.outcome === 'correction') {
            this.recordInitializerCorrectionResults(event.state);
          }
          if (event.outcome === 'accepted' && event.contract !== undefined) {
            this.contract = event.contract;
            await this.saveInitializing({ contract: event.contract });
            // The checkpoint is authoritative. Publishing this immutable
            // convenience copy after it means a crash can only leave a missing
            // file that resume reconstructs, never an orphan contract that was
            // not accepted durably.
            ensureV3OutputContractFile(this.options.runDir, event.contract);
            return;
          }
          await this.saveInitializing({ initializer: event.state });
        },
      });
    } catch (error) {
      if (isModelResponseRejectedError(error)) {
        throw new InitializerUnavailableError(errorMessage(error), {
          cause: error,
        });
      }
      throw error;
    }
    if (!result.ok) {
      throw new InitializerUnavailableError(result.reason);
    }
    this.contract = result.contract;
    this.createWorker();
    await this.saveReady();
    this.phase = 'ready_for_model';
  }

  private restoreOrCreateWorker(): void {
    if (this.session !== undefined) return;
    const snapshot = this.loaded?.phase === 'initializing'
      ? undefined
      : this.loaded?.worker;
    if (snapshot !== undefined) {
      this.session = restoreV3WorkerSession(
        snapshot,
        this.workerDeps(),
        this.workerConfig(),
      );
      return;
    }
    if (this.contract !== undefined) this.createWorker();
  }

  private createWorker(): void {
    this.session = createV3WorkerSession(
      this.configuration.taskText,
      this.workerDeps(),
      this.workerConfig(),
      {
        guidance: [
          formatV3ContractGuidance(this.requireContract()),
          formatV3RunCapabilityGuidance(this.configuration),
        ],
      },
    );
  }

  private workerDeps() {
    return {
      model: workerModelBoundary(
        this.options.workerModel,
        this.runSignal,
      ),
      registry: this.options.registry,
      runDir: this.options.runDir,
      busyRegistry: this.busyRegistry,
      ...(this.options.browser === undefined
        ? {}
        : { browser: this.options.browser }),
      ...(this.options.requestPermission === undefined
        ? {}
        : { requestPermission: this.options.requestPermission }),
      signal: this.runSignal,
      ...(this.options.onModelEvent === undefined
        ? {}
        : {
            onModelEvent: (event: ModelAttemptEvent) =>
              this.options.onModelEvent?.('worker', event),
          }),
      lifecycle: this.lifecycle(),
      now: this.now,
    };
  }

  private workerConfig() {
    return {
      budget: this.budget,
      maxContextTokens: v3CeilingFromCheckpoint(
        this.configuration.maxContextTokens,
      ),
    };
  }

  private recordInitializerCorrectionResults(
    state: V3ContractInitializerState,
  ): void {
    const trailing = state.messages.at(-1);
    if (trailing?.role !== 'user') return;
    const bytes = trailing.content.reduce((total, block) => {
      if (block.type !== 'tool_result') return total;
      const content =
        typeof block.content === 'string'
          ? block.content
          : JSON.stringify(block.content);
      return total + Buffer.byteLength(content, 'utf8');
    }, 0);
    this.budget.recordToolResultBytes(bytes);
    this.throwIfSharedBudgetExceeded();
  }

  private throwIfSharedBudgetExceeded(): void {
    const limit = this.budget.exceededLimit(['worker_turns']);
    if (limit !== undefined) throw new V3RoleBudgetExceededError(limit);
  }

  private lifecycle(): V3WorkerLifecycleHooks {
    return {
      beforeModelRequest: async (event) => {
        await this.saveReady(event.session);
        this.phase = 'ready_for_model';
      },
      afterModelAccounting: async (event) => {
        // The response content is not accepted yet, but its known billable
        // usage is. Persist that monotone spend with the incremented turn so
        // a crash cannot retry the request from a pre-billing checkpoint.
        await this.saveReady(event.session);
        this.phase = 'ready_for_model';
      },
      beforeCall: async (pending) => {
        this.pendingTurn = pending;
        await this.saveExecuting(pending);
        this.phase = 'executing_tool';
      },
      afterDispatch: async (pending) => {
        this.pendingTurn = pending;
        await this.saveExecuting(pending);
        this.phase = 'executing_tool';
      },
      afterResult: async (pending) => {
        this.pendingTurn = pending;
        await this.saveExecuting(pending);
        this.phase = 'executing_tool';
      },
      finishRequested: async (event) => {
        this.pendingFinish = event.request;
        await this.saveChecking(event.session, event.request);
        this.phase = 'checking';
      },
      finishResultAppended: async (event) => {
        if (this.suppressFinishReadyCheckpoint) return;
        await this.saveReady(event.session);
        this.phase = 'ready_for_model';
      },
    };
  }

  /** Open exactly one run-owned task page for this coordinator invocation.
   * Terminal/checking/verifying-only recovery stays browser-lazy. A resumed
   * worker receives a fresh controller-owned page because page refs from a
   * dead process are never restored from the checkpoint. */
  private async prepareBrowser(): Promise<void> {
    if (this.browserPrepared) return;
    const browser = this.options.browser;
    if (browser === undefined) {
      if (this.configuration.startUrl !== undefined) {
        throw new Error('v3 startUrl requires a BrowserController');
      }
      this.browserPrepared = true;
      return;
    }
    if (browser.prepareTaskPage === undefined) {
      throw new Error(
        'v3 requires BrowserController.prepareTaskPage so task-page startup ' +
          'can be cancelled without leaving a late browser effect',
      );
    }
    // This single controller-owned transaction hashes/reclaims the stable run
    // id, opens a fresh tab, and optionally navigates it. Its abort contract
    // contains late page creation/navigation before rejection, so the wall
    // deadline may safely proceed into terminal cleanup.
    await browser.prepareTaskPage({
      ownershipId: this.options.runDir,
      signal: this.runSignal,
      ...(this.configuration.startUrl === undefined
        ? {}
        : { startUrl: this.configuration.startUrl }),
    });
    this.browserPrepared = true;
  }

  /** Answer an intercepted finish without publishing a resumable ready
   * checkpoint. The following terminal checkpoint is the only durable phase
   * transition; if the process dies first, recovery reruns checking/verifying
   * from its prior read-only checkpoint. */
  private async appendTerminalFinishFailure(
    request: V3FinishRequest,
    content: string,
  ): Promise<void> {
    this.suppressFinishReadyCheckpoint = true;
    try {
      await appendV3FinishResult(
        this.requireSession(),
        request,
        content,
      );
    } finally {
      this.suppressFinishReadyCheckpoint = false;
    }
    this.pendingFinish = undefined;
    this.pendingFacts = undefined;
  }

  private async saveInitializing(
    state:
      | { initializer: V3ContractInitializerState; contract?: never }
      | { contract: OutputContract; initializer?: never },
  ): Promise<void> {
    await this.save({
      phase: 'initializing',
      ...(state.contract === undefined
        ? { initializer: captureV3ContractInitializerState(state.initializer) }
        : { contract: state.contract }),
    });
  }

  private async saveReady(
    snapshot: V3WorkerSessionSnapshot = captureV3WorkerSessionSnapshot(
      this.requireSession(),
    ),
  ): Promise<void> {
    await this.save({
      phase: 'ready_for_model',
      contract: this.requireContract(),
      worker: snapshot,
    });
  }

  private async saveExecuting(pendingTurn: V3PendingToolTurn): Promise<void> {
    await this.save({
      phase: 'executing_tool',
      contract: this.requireContract(),
      worker: captureV3WorkerSessionSnapshot(this.requireSession()),
      pendingTurn,
    });
  }

  private async saveChecking(
    worker: V3WorkerSessionSnapshot,
    pendingFinish: V3FinishRequest,
  ): Promise<void> {
    await this.save({
      phase: 'checking',
      contract: this.requireContract(),
      worker,
      pendingFinish,
      pendingCheck: {
        status: 'pending',
        attempt: this.completionCheckFailures + 1,
      },
    });
  }

  private async saveVerifying(
    pendingFinish: V3FinishRequest,
    facts: V3FinishFacts,
  ): Promise<void> {
    await this.save({
      phase: 'verifying',
      contract: this.requireContract(),
      worker: captureV3WorkerSessionSnapshot(this.requireSession()),
      pendingFinish,
      pendingCheck: {
        status: 'passed',
        attempt: this.completionCheckFailures + 1,
        facts,
      },
      pendingVerifier: {
        cycle: this.verifierCycles,
        recovery: 'restart_read_only',
      },
    });
  }

  private async saveTerminal(
    outcome: V3DurableTerminalOutcome,
  ): Promise<void> {
    await this.save({
      phase: 'terminal',
      ...(this.contract === undefined ? {} : { contract: this.contract }),
      ...(this.session === undefined
        ? {}
        : { worker: captureV3WorkerSessionSnapshot(this.session) }),
      ...(outcome.status === 'verified'
        ? { finish: this.requireVerifiedFinish() }
        : {}),
      outcome,
    });
  }

  private async save(
    phaseState: V3CheckpointPhaseState,
  ): Promise<void> {
    const checkpoint = {
      version: V3_CHECKPOINT_VERSION,
      revision: this.revision + 1,
      updatedAt: new Date(this.now()).toISOString(),
      configuration: this.configuration,
      budget: captureRunBudgetSnapshot(this.budget),
      progress: {
        verifierCycles: this.verifierCycles,
        completionCheckFailures: this.completionCheckFailures,
      },
      ...phaseState,
    } as V3Checkpoint;
    await this.store.save(checkpoint);
    this.revision = checkpoint.revision;
    await this.options.afterCheckpoint?.(structuredClone(checkpoint));
  }

  private requireSession(): V3WorkerSession {
    if (this.session === undefined) throw new Error('v3 worker session is unavailable');
    return this.session;
  }

  private requireContract(): OutputContract {
    if (this.contract === undefined) throw new Error('v3 output contract is unavailable');
    return this.contract;
  }

  private requirePendingTurn(): V3PendingToolTurn {
    if (this.pendingTurn === undefined) throw new Error('pending tool turn is unavailable');
    return this.pendingTurn;
  }

  private requirePendingFinish(): V3FinishRequest {
    if (this.pendingFinish === undefined) throw new Error('pending finish is unavailable');
    return this.pendingFinish;
  }

  private requirePendingFacts(): V3FinishFacts {
    if (this.pendingFacts === undefined) throw new Error('pending finish facts are unavailable');
    return this.pendingFacts;
  }

  private requireVerifiedFinish(): FinishInput {
    if (this.verifiedFinish === undefined) {
      throw new Error('verified terminal outcome is missing its accepted finish claims');
    }
    return structuredClone(this.verifiedFinish);
  }
}

class InitializerUnavailableError extends Error {
  override readonly name = 'InitializerUnavailableError';
}

class WorkerModelUnavailableError extends Error {
  override readonly name = 'WorkerModelUnavailableError';
}

function initializerModelBoundary(
  callModel: CallModel,
  signal: AbortSignal,
): CallModel {
  return async (messages) => {
    try {
      return await callModel(messages);
    } catch (error) {
      if (
        (isAbortError(error) && signal.aborted) ||
        isV3RoleBudgetExceededError(error) ||
        isModelResponseRejectedError(error)
      ) {
        throw error;
      }
      throw new InitializerUnavailableError(errorMessage(error), {
        cause: error,
      });
    }
  };
}

function workerModelBoundary(
  model: ModelDriver,
  signal: AbortSignal,
): ModelDriver {
  return {
    async generate(options) {
      try {
        return await model.generate(options);
      } catch (error) {
        if (
          (isAbortError(error) && signal.aborted) ||
          isModelResponseRejectedError(error) ||
          isModelGenerationFailedError(error)
        ) {
          throw error;
        }
        throw new WorkerModelUnavailableError(errorMessage(error), {
          cause: error,
        });
      }
    },
  };
}

function inspectRunForResume(
  runDir: string,
  configuration: V3DurableRunConfiguration,
  phase: V3CheckpointPhase | undefined,
  checkActive: () => void,
): void {
  checkActive();
  let inspection = inspectManifest(runDir, { checkActive });
  assertManifestMetadata(inspection.manifest, configuration, phase);

  if (phase === 'executing_tool') {
    const unrecoverable = inspection.defects.filter(
      (defect) =>
        !(
          defect.artifactPath?.startsWith('scratch/workspace/') === true &&
          (defect.code === 'hash_mismatch' ||
            defect.code === 'missing_recorded_file')
        ),
    );
    if (unrecoverable.length > 0) {
      throw manifestIntegrityError(unrecoverable);
    }
    // A killed bash/browser child may have changed workspace bytes after the
    // last manifest write. Reconcile that one explicitly sanctioned direct-
    // write partition before accepting hashes for recovery.
    syncScratchWorkspace(runDir, { checkActive });
    inspection = inspectManifest(runDir, { checkActive });
    assertManifestMetadata(inspection.manifest, configuration, phase);
  }

  if (inspection.defects.length > 0) {
    throw manifestIntegrityError(inspection.defects);
  }
}

function recoverAndInspectRun(
  runDir: string,
  configuration: V3DurableRunConfiguration,
  phase: V3CheckpointPhase | undefined,
  checkActive: () => void,
): void {
  // Artifact bytes and manifest metadata are one recoverable transaction.
  // Complete or roll back any interrupted publication under the run lock
  // before trusting either side during resume inspection.
  checkActive();
  recoverPendingArtifactWrites(runDir, { checkActive });
  // This deliberately runs before the terminal short-circuit: a recorded
  // success must never survive artifact tampering unnoticed.
  inspectRunForResume(runDir, configuration, phase, checkActive);
}

function assertManifestMetadata(
  manifest: ReturnType<typeof inspectManifest>['manifest'],
  configuration: V3DurableRunConfiguration,
  phase: V3CheckpointPhase | undefined,
): void {
  if (manifest === undefined) return;
  if (manifest.task !== configuration.taskText) {
    throw new Error('manifest task does not match the durable v3 configuration');
  }
  if (manifest.browserProvider !== configuration.browserProvider) {
    throw new Error(
      'manifest browserProvider does not match the durable v3 configuration',
    );
  }
  if (phase !== 'terminal' && manifest.finishedAt !== undefined) {
    throw new Error(
      'an active or fresh v3 run cannot reuse an already-finalized manifest',
    );
  }
}

function manifestIntegrityError(
  defects: readonly { code: string; message: string }[],
): Error {
  return new Error(
    `v3 run manifest integrity check failed:\n${defects
      .map((defect) => `- ${defect.code}: ${defect.message}`)
      .join('\n')}`,
  );
}

function ensureTerminalTranscriptEvent(
  runDir: string,
  outcome: V3DurableTerminalOutcome,
): void {
  let raw = '';
  try {
    raw = readFileSync(join(runDir, TRANSCRIPT_FILENAME), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }

  const transcriptPath = join(runDir, TRANSCRIPT_FILENAME);
  if (raw !== '' && !raw.endsWith('\n')) {
    const lastNewline = raw.lastIndexOf('\n');
    const completePrefix = raw.slice(0, lastNewline + 1);
    const tail = raw.slice(lastNewline + 1);
    try {
      JSON.parse(tail);
      raw = `${raw}\n`;
    } catch {
      // appendFileSync can be killed after writing only a prefix. A nonempty
      // unterminated final fragment is the sole transcript region recovery
      // may discard; newline-terminated history remains append-only and any
      // corruption there still fails loudly below.
      raw = completePrefix;
    }
    writeFileDurablyAtomic(transcriptPath, raw);
  }

  let matchingEvents = 0;
  for (const [index, line] of raw.split('\n').entries()) {
    if (line === '') continue;
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch (error) {
      throw new Error(
        `${TRANSCRIPT_FILENAME} line ${index + 1} is not valid JSON during terminal recovery: ${errorMessage(error)}`,
      );
    }
    if (
      event !== null &&
      typeof event === 'object' &&
      (event as Record<string, unknown>).type === 'v3_run_terminal'
    ) {
      if (
        JSON.stringify((event as Record<string, unknown>).outcome) !==
        JSON.stringify(outcome)
      ) {
        throw new Error(
          `${TRANSCRIPT_FILENAME} contains a terminal outcome that disagrees with the checkpoint`,
        );
      }
      matchingEvents += 1;
    }
  }

  if (matchingEvents > 1) {
    throw new Error(
      `${TRANSCRIPT_FILENAME} contains ${matchingEvents} duplicate v3 terminal events`,
    );
  }
  if (matchingEvents === 0) {
    appendTranscriptEvent(runDir, {
      type: 'v3_run_terminal',
      outcome,
    });
  }
}

function repairTerminalProjections(
  runDir: string,
  checkpoint: Extract<V3Checkpoint, { phase: 'terminal' }>,
): void {
  const errors: string[] = [];
  const attempts: Array<[string, () => void]> = [
    ['metrics', () => writeTerminalMetrics(runDir, checkpoint)],
    [
      'transcript',
      () => ensureTerminalTranscriptEvent(runDir, checkpoint.outcome),
    ],
    ['manifest', () => finalizeManifestIfNeeded(runDir)],
  ];
  for (const [name, attempt] of attempts) {
    try {
      attempt();
    } catch (error) {
      errors.push(`${name}: ${errorMessage(error)}`);
    }
  }
  if (errors.length > 0) {
    throw new Error(
      `v3 terminal projection repair failed after attempting every finalizer: ${errors.join('; ')}`,
    );
  }
}

function budgetConfig(
  configuration: V3DurableRunConfiguration,
): RunBudgetConfig {
  const limits = configuration.budgetLimits;
  return {
    maxWorkerTurns: v3CeilingFromCheckpoint(limits.maxWorkerTurns),
    maxToolCalls: v3CeilingFromCheckpoint(limits.maxToolCalls),
    maxModelTokens: v3CeilingFromCheckpoint(limits.maxModelTokens),
    maxToolResultBytes: v3CeilingFromCheckpoint(limits.maxToolResultBytes),
    maxWallTimeMs: v3CeilingFromCheckpoint(limits.maxWallTimeMs),
    maxVerifierCorrections: v3CeilingFromCheckpoint(
      limits.maxVerifierCorrections,
    ),
  };
}

function formatV3RunCapabilityGuidance(
  configuration: V3DurableRunConfiguration,
): string {
  const authority = configuration.authenticated
    ? 'authenticated browser state'
    : 'an anonymous browser session';
  if (configuration.javascriptPolicy === 'deny') {
    return (
      `Run capabilities: provider=${configuration.browserProvider}; ${authority}. ` +
      'JavaScript policy is deny: browser_execute is disabled in its entirety because its ' +
      'general CDP authority can evaluate page code. Do not call or retry browser_execute; ' +
      'work only from non-browser inputs already available to the run.'
    );
  }
  return (
    `Run capabilities: provider=${configuration.browserProvider}; ${authority}. ` +
    'JavaScript policy is allow for this run.'
  );
}

function workerIncomplete(
  reason: V3WorkerIncompleteReason,
  during: Exclude<V3CheckpointPhase, 'terminal'>,
  detail?: string,
): V3DurableTerminalOutcome {
  const budgetReasons: readonly V3WorkerIncompleteReason[] = [
    'max_turns',
    'context_budget',
    'tool_calls',
    'model_tokens',
    'tool_result_bytes',
    'wall_time',
    'verifier_corrections',
  ];
  return {
    status: 'incomplete',
    during,
    reason: budgetReasons.includes(reason)
      ? 'budget_exceeded'
      : 'worker_incomplete',
    detail: boundedDiagnostic(detail ?? `worker ended incomplete: ${reason}`),
    finalText: '',
  };
}

function incompleteBudget(
  limit: string,
  finalText: string,
  during: Exclude<V3CheckpointPhase, 'terminal'>,
): V3DurableTerminalOutcome {
  return {
    status: 'incomplete',
    during,
    reason: 'budget_exceeded',
    detail: `run budget limit exceeded: ${limit}`,
    finalText,
  };
}

function writeMetricsAtomically(
  runDir: string,
  metrics: V3WorkerMetrics,
): void {
  writeFileDurablyAtomic(
    join(runDir, 'metrics.json'),
    `${JSON.stringify(metrics, null, 2)}\n`,
  );
}

function writeTerminalMetrics(
  runDir: string,
  checkpoint: Extract<V3Checkpoint, { phase: 'terminal' }>,
): void {
  const roles = checkpoint.budget.roles;
  const totals = Object.values(roles).reduce(
    (sum, usage) => {
      if (usage !== undefined) {
        sum.inputTokens += usage.inputTokens;
        sum.outputTokens += usage.outputTokens;
        sum.cacheReadInputTokens += usage.cacheReadInputTokens;
        sum.cacheCreationInputTokens += usage.cacheCreationInputTokens;
      }
      return sum;
    },
    {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
    },
  );
  writeMetricsAtomically(runDir, {
    status: checkpoint.outcome.status,
    turns: checkpoint.worker?.turnCount ?? 0,
    protocolCorrections: checkpoint.worker?.protocolCorrections ?? 0,
    ...totals,
    toolCalls: checkpoint.budget.toolCalls,
    toolResultBytes: checkpoint.budget.toolResultBytes,
    peakContextTokens: checkpoint.worker?.peakContextTokens ?? 0,
    wallClockMs: checkpoint.budget.elapsedWallTimeMs,
    roles,
  });
}

function finalizeManifestIfNeeded(runDir: string): void {
  if (readManifest(runDir).finishedAt === undefined) finalizeManifest(runDir);
}

function terminalBrowserCleanupTimeout(
  options: RunV3CoordinatorOptions,
): number {
  const timeoutMs =
    options.terminalBrowserCleanupTimeoutMs ??
    V3_TERMINAL_BROWSER_CLEANUP_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error(
      `terminalBrowserCleanupTimeoutMs must be finite and > 0, got ${timeoutMs}`,
    );
  }
  return timeoutMs;
}

function terminalBusyResourceTimeout(
  options: RunV3CoordinatorOptions,
): number {
  const timeoutMs =
    options.terminalBusyResourceTimeoutMs ?? BUSY_RESOURCE_GATE_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error(
      `terminalBusyResourceTimeoutMs must be finite and > 0, got ${timeoutMs}`,
    );
  }
  return timeoutMs;
}

function terminalResumeInspectionTimeout(
  options: RunV3CoordinatorOptions,
): number {
  const timeoutMs =
    options.terminalResumeInspectionTimeoutMs ??
    V3_TERMINAL_RESUME_INSPECTION_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error(
      `terminalResumeInspectionTimeoutMs must be finite and > 0, got ${timeoutMs}`,
    );
  }
  return timeoutMs;
}

function createTerminalResumeInspectionGuard(
  options: RunV3CoordinatorOptions,
  now: () => number,
  honorCancellation = true,
): () => void {
  const startedAt = now();
  if (!Number.isFinite(startedAt)) {
    throw new Error(`terminal resume inspection clock must be finite, got ${startedAt}`);
  }
  const timeoutMs = terminalResumeInspectionTimeout(options);
  return () => {
    if (honorCancellation) options.signal?.throwIfAborted();
    const current = now();
    if (!Number.isFinite(current) || current < startedAt) {
      throw new Error(
        `terminal resume inspection clock moved backwards or became invalid: ${current}`,
      );
    }
    if (current - startedAt >= timeoutMs) {
      throw new Error(
        `terminal resume inspection exceeded its ${timeoutMs}ms safety bound`,
      );
    }
  };
}

function withTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label} did not settle within ${timeoutMs}ms`));
    }, timeoutMs);
    operation.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function formatDefects(
  defects: readonly { code: string; message: string }[],
): string {
  return defects.map((defect) => `${defect.code}: ${defect.message}`).join('; ');
}

function formatFindings(
  findings: readonly { code: string; message: string }[],
): string {
  return findings.map((finding) => `${finding.code}: ${finding.message}`).join('; ');
}

function formatOutcomeForDiagnostic(
  outcome: V3DurableTerminalOutcome,
): string {
  if (outcome.status === 'verified') return 'verified';
  if (outcome.status === 'incomplete') {
    return `incomplete during ${outcome.during} (${outcome.reason}: ${outcome.detail})`;
  }
  if (outcome.status === 'cancelled') {
    return `cancelled during ${outcome.during} (${outcome.reason})`;
  }
  return `failed during ${outcome.during} (${outcome.message})`;
}

function boundedDiagnostic(value: string): string {
  const maximum = 16_000;
  if (Buffer.byteLength(value, 'utf8') <= maximum) return value;
  return Buffer.from(value, 'utf8').subarray(0, maximum - 64).toString('utf8') +
    '\n[diagnostic truncated]';
}

function abortReason(error: unknown): string {
  const message = errorMessage(error).trim();
  return boundedDiagnostic(message === '' ? 'run cancelled' : message);
}

function wallDeadlineError(
  error: unknown,
  signal: AbortSignal,
): V3RoleBudgetExceededError | undefined {
  if (
    isV3RoleBudgetExceededError(error) &&
    error.limit === 'wall_time'
  ) {
    return error;
  }
  return isV3RoleBudgetExceededError(signal.reason) &&
    signal.reason.limit === 'wall_time'
    ? signal.reason
    : undefined;
}

function verifierBudgetError(
  error: unknown,
  signal: AbortSignal,
): V3RoleBudgetExceededError | undefined {
  if (isV3RoleBudgetExceededError(error)) return error;
  return isV3RoleBudgetExceededError(signal.reason)
    ? signal.reason
    : undefined;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
