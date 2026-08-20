import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { BrowserController } from '../browser/controller.js';
import { errorMessage, isAbortError } from '../errors.js';
import type { OutputContract } from './initializer/outputContract.schema.js';
import type { CallModel } from '../model/messages.js';
import {
  isModelGenerationFailedError,
  isModelResponseRejectedError,
  type ModelDriver,
  type ModelAttemptEvent,
} from '../model/modelDriver.js';
import { finalizeManifest, readManifest, recoverPendingArtifactWrites } from '../run/artifacts.js';
import { writeFileDurablyAtomic } from '../run/atomicFile.js';
import {
  captureRunBudgetSnapshot,
  createRunBudgetTracker,
  type RunBudgetConfig,
  type RunBudgetTracker,
} from '../run/runBudget.js';
import { TRANSCRIPT_FILENAME, appendTranscriptEvent } from '../run/transcript.js';
import { syncScratchWorkspace } from '../run/syncScratchWorkspace.js';
import { BUSY_RESOURCE_GATE_TIMEOUT_MS } from '../tools/pipeline.js';
import {
  createBusyResourceRegistry,
  type BusyResourceRegistry,
  type PermissionDecision,
  type PermissionRequest,
  type ToolRegistry,
} from '../tools/registry.js';
import { inspectManifest } from './completion/artifactInspection.js';
import {
  runFinishChecks,
  toSettledFacts,
  type FinishDefect,
  type FinishFacts,
} from './completion/finishChecks.js';
import {
  INITIALIZER_MAX_ATTEMPTS,
  captureContractInitializerState,
  createContractInitializerState,
  formatContractGuidance,
  restoreContractInitializerState,
  runContractInitializer,
  type ContractInitializerState,
} from './initializer/initializer.js';
import { runVerifier, VERIFICATION_HISTORY_LIMIT } from './verifier/verifier.js';
import {
  type CorrectionFinding,
  type SurfacedArtifact,
  type VerificationHistoryEntry,
} from './verifier/verificationResult.schema.js';
import {
  appendFinishResult,
  captureWorkerSnapshot,
  createWorker,
  restoreWorker,
  resumePendingToolTurn,
  runWorker,
  type FinishRequest,
  type PendingToolTurn,
  type WorkerIncompleteReason,
  type WorkerHooks,
  type WorkerMetrics,
  type Worker,
  type WorkerSnapshot,
} from './worker/worker.js';
import { createBudgetedCallModel } from '../model/budgetedCall.js';
import { RoleBudgetExceededError, isRoleBudgetExceededError } from '../run/runBudget.js';
import { durableFinishInputSchema, type FinishInput } from '../tools/finish/finish.js';
import {
  openCheckpointStore,
  ceilingFromCheckpoint,
  type CheckpointStoreOptions,
} from './checkpoint.js';
import {
  CHECKPOINT_VERSION,
  durableRunConfigurationSchema,
  type Checkpoint,
  type CheckpointPhase,
  type DurableRunConfiguration,
  type DurableTerminalOutcome,
} from './checkpoint.schema.js';
import {
  buildFindingsReportInputFromCheckpoint,
  writeFindingsReport,
  type FindingsReportCurrentFindings,
  type FindingsReportInput,
} from './findingsReport.js';
import { ensureOutputContractFile } from './initializer/contractFile.js';
import { createRunDeadline, raceWithRunSignal } from '../run/runDeadline.js';

type CheckpointCommonKey =
  | 'version'
  | 'revision'
  | 'updatedAt'
  | 'configuration'
  | 'budget'
  | 'progress';

type PhaseState<Snapshot> = Snapshot extends Checkpoint
  ? Omit<Snapshot, CheckpointCommonKey>
  : never;
type CheckpointPhaseState = PhaseState<Checkpoint>;

type InitializingCoordinatorState = {
  phase: 'initializing';
  contract?: OutputContract;
  initializer?: ContractInitializerState;
};

type ActiveCoordinatorState = {
  contract: OutputContract;
  session: Worker;
};

type CoordinatorPhaseState =
  | InitializingCoordinatorState
  | (ActiveCoordinatorState & { phase: 'ready_for_model' })
  | (ActiveCoordinatorState & { phase: 'executing_tool'; pendingTurn: PendingToolTurn })
  | (ActiveCoordinatorState & { phase: 'checking'; pendingFinish: FinishRequest })
  | (ActiveCoordinatorState & {
      phase: 'verifying';
      pendingFinish: FinishRequest;
      facts: FinishFacts;
      structuralFindings: FinishDefect[];
    });

type ReadyCoordinatorState = Extract<CoordinatorPhaseState, { phase: 'ready_for_model' }>;
type ExecutingCoordinatorState = Extract<CoordinatorPhaseState, { phase: 'executing_tool' }>;
type CheckingCoordinatorState = Extract<CoordinatorPhaseState, { phase: 'checking' }>;
type VerifyingCoordinatorState = Extract<CoordinatorPhaseState, { phase: 'verifying' }>;

const readyState = (active: ActiveCoordinatorState): ReadyCoordinatorState => ({
  contract: active.contract,
  session: active.session,
  phase: 'ready_for_model',
});

export interface RunAgentOptions {
  runDir: string;
  configuration: DurableRunConfiguration;
  initializerModel: ModelDriver;
  workerModel: ModelDriver;
  verifierModel: ModelDriver;
  registry: ToolRegistry;
  /** One run-owned ledger for effects abandoned by an outer tool timeout.
   * Omit in production to create a fresh ledger; injectable for focused
   * recovery tests. */
  busyRegistry?: BusyResourceRegistry;
  browser?: BrowserController;
  requestPermission?: (request: PermissionRequest) => Promise<PermissionDecision>;
  signal?: AbortSignal;
  onModelEvent?: (role: 'initializer' | 'worker' | 'verifier', event: ModelAttemptEvent) => void;
  checkpointStoreOptions?: CheckpointStoreOptions;
  /** Observability/test seam called only after a checkpoint is durable. */
  afterCheckpoint?: (checkpoint: Checkpoint) => void | Promise<void>;
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

export const TERMINAL_BROWSER_CLEANUP_TIMEOUT_MS = 10_000;
export const TERMINAL_RESUME_INSPECTION_TIMEOUT_MS = 30_000;

/** Run or recover one initializer → worker → checks → verifier lifecycle.
 * The checkpoint is authoritative; a terminal checkpoint is returned without
 * invoking a model or touching the browser. */
export async function runAgent(options: RunAgentOptions): Promise<DurableTerminalOutcome> {
  const configuration = durableRunConfigurationSchema.parse(options.configuration);
  terminalBrowserCleanupTimeout(options);
  terminalBusyResourceTimeout(options);
  terminalResumeInspectionTimeout(options);
  if (configuration.maxInitializerAttempts !== INITIALIZER_MAX_ATTEMPTS) {
    throw new Error(
      `requires exactly ${INITIALIZER_MAX_ATTEMPTS} initializer attempts ` +
        `(one initial response plus one repair)`,
    );
  }

  const store = await openCheckpointStore(options.runDir, options.checkpointStoreOptions);
  try {
    const loaded = store.load();
    if (
      loaded !== undefined &&
      JSON.stringify(loaded.configuration) !== JSON.stringify(configuration)
    ) {
      throw new Error('resume configuration does not match the durable checkpoint');
    }
    const now = options.now ?? Date.now;
    if (loaded?.phase === 'terminal') {
      const checkActive = createTerminalResumeInspectionGuard(options, now);
      recoverAndInspectRun(options.runDir, configuration, loaded.phase, checkActive);
      if (loaded.contract !== undefined) {
        ensureOutputContractFile(options.runDir, loaded.contract);
      }
      let verifiedChecks: ReturnType<typeof runFinishChecks> | undefined;
      if (loaded.outcome.status === 'verified') {
        verifiedChecks = runFinishChecks({
          runDir: options.runDir,
          contract: loaded.contract!,
          finish: loaded.finish!,
          checkActive,
        });
        if (verifiedChecks.status === 'failed') {
          throw new Error(
            `verified terminal run no longer passes deterministic checks:\n${formatDefects(
              verifiedChecks.defects,
            )}`,
          );
        }
      }
      repairTerminalProjections(options.runDir, loaded);
      writeFindingsReportOnResume(options.runDir, loaded, verifiedChecks?.facts);
      return loaded.outcome;
    }

    const budget = createRunBudgetTracker(budgetConfig(configuration), {
      now,
      ...(loaded === undefined ? {} : { restore: loaded.budget }),
      ...(loaded === undefined ? {} : { restoreSnapshotAtMs: Date.parse(loaded.updatedAt) }),
    });
    const deadline = createRunDeadline(budget, options.signal);
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
      if (loaded !== undefined) writeFindingsReportOnResume(options.runDir, loaded);
      const terminalizePreflightControl = async (
        outcome: DurableTerminalOutcome,
      ): Promise<DurableTerminalOutcome> => {
        // The run deadline/cancellation stops active inspection, but a
        // terminal checkpoint must not strand a half-recovered artifact
        // transaction or executing-tool workspace. Re-run the idempotent
        // integrity pass under the separate finite terminal safety bound,
        // deliberately ignoring the already-fired run signal. If this pass
        // cannot complete, refuse terminalization and leave the active
        // checkpoint for a later recovery attempt.
        const cleanupCheck = createTerminalResumeInspectionGuard(options, now, false);
        recoverAndInspectRun(options.runDir, configuration, loaded?.phase, cleanupCheck);
        if (loaded?.contract !== undefined) {
          ensureOutputContractFile(options.runDir, loaded.contract);
        }
        return state.terminalize(outcome);
      };
      try {
        recoverAndInspectRun(options.runDir, configuration, loaded?.phase, () =>
          state.assertActive(),
        );
        if (loaded?.contract !== undefined) {
          ensureOutputContractFile(options.runDir, loaded.contract);
        }
      } catch (error) {
        const deadlineError = wallDeadlineError(error, deadline.signal);
        if (deadlineError !== undefined) {
          return await terminalizePreflightControl(
            incompleteBudget(
              deadlineError.limit,
              state.finalText(),
              state.unresolved(),
              state.phase,
            ),
          );
        }
        if (isRoleBudgetExceededError(error)) {
          return await terminalizePreflightControl(
            incompleteBudget(error.limit, state.finalText(), state.unresolved(), state.phase),
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
            incompleteBudget(
              deadlineError.limit,
              state.finalText(),
              state.unresolved(),
              state.phase,
            ),
          );
        }
        if (isRoleBudgetExceededError(error)) {
          return await state.terminalize(
            incompleteBudget(error.limit, state.finalText(), state.unresolved(), state.phase),
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
            unresolved: [],
          });
        }
        if (error instanceof WorkerModelUnavailableError || isModelGenerationFailedError(error)) {
          return await state.terminalize({
            status: 'incomplete',
            during: state.phase,
            reason: 'worker_incomplete',
            detail: boundedDiagnostic(errorMessage(error)),
            finalText: state.finalText(),
            unresolved: state.unresolved(),
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
  private state: CoordinatorPhaseState;
  private revision: number;
  private verificationHistory: VerificationHistoryEntry[];
  private verifierCycles: number;
  private completionCheckFailures: number;
  private terminalizing = false;
  private suppressFinishReadyCheckpoint = false;
  private pendingFinishAnswered = false;
  private browserPrepared = false;
  private readonly busyRegistry: BusyResourceRegistry;

  constructor(
    private readonly options: RunAgentOptions,
    private readonly configuration: DurableRunConfiguration,
    private readonly store: Awaited<ReturnType<typeof openCheckpointStore>>,
    private readonly budget: RunBudgetTracker,
    loaded: Exclude<Checkpoint, { phase: 'terminal' }> | undefined,
    private readonly now: () => number,
    private readonly runSignal: AbortSignal,
  ) {
    this.revision = loaded?.revision ?? 0;
    this.verifierCycles = loaded?.progress.verifierCycles ?? 0;
    this.completionCheckFailures = loaded?.progress.completionCheckFailures ?? 0;
    this.verificationHistory =
      loaded?.phase === 'initializing' ? [] : structuredClone(loaded?.verificationHistory ?? []);
    this.busyRegistry = options.busyRegistry ?? createBusyResourceRegistry();
    if (loaded === undefined) {
      this.state = { phase: 'initializing' };
    } else if (loaded.phase === 'initializing') {
      this.state = {
        phase: 'initializing',
        ...(loaded.contract === undefined ? {} : { contract: loaded.contract }),
        ...(loaded.initializer === undefined
          ? {}
          : { initializer: restoreContractInitializerState(loaded.initializer) }),
      };
    } else {
      const active = {
        contract: loaded.contract,
        session: restoreWorker(loaded.worker, this.workerDeps(), this.workerConfig()),
      };
      switch (loaded.phase) {
        case 'ready_for_model':
          this.state = { phase: loaded.phase, ...active };
          break;
        case 'executing_tool':
          this.state = { phase: loaded.phase, ...active, pendingTurn: loaded.pendingTurn };
          break;
        case 'checking':
          this.state = { phase: loaded.phase, ...active, pendingFinish: loaded.pendingFinish };
          break;
        case 'verifying':
          this.state = {
            phase: loaded.phase,
            ...active,
            pendingFinish: loaded.pendingFinish,
            facts: loaded.pendingCheck.facts,
            structuralFindings: loaded.pendingCheck.structuralFindings ?? [],
          };
          break;
      }
    }
  }

  get phase(): Exclude<CheckpointPhase, 'terminal'> {
    return this.state.phase;
  }

  async run(): Promise<DurableTerminalOutcome> {
    // Browser-internal abandoned renderer work and tool-pipeline abandonment
    // must live in one ledger. Otherwise a later finish could see the tool
    // layer as idle while the controller is still mutating the same page.
    this.options.browser?.setBusyRegistry?.(this.busyRegistry);
    this.runSignal.throwIfAborted();
    if (this.phase === 'initializing') await this.initialize();

    for (;;) {
      this.runSignal.throwIfAborted();
      const state = this.state;

      if (state.phase === 'executing_tool') {
        await this.prepareBrowser();
        const outcome = await resumePendingToolTurn(state.session, state.pendingTurn);
        if (outcome.kind === 'incomplete') {
          return this.terminalize(
            workerIncomplete(
              outcome.reason,
              state.phase,
              this.finalText(),
              this.unresolved(),
              outcome.detail,
            ),
          );
        }
        this.state = readyState(state);
        continue;
      }

      if (state.phase === 'ready_for_model') {
        await this.prepareBrowser();
        const outcome = await runWorker(state.session);
        if (outcome.kind === 'incomplete') {
          return this.terminalize(
            workerIncomplete(
              outcome.reason,
              state.phase,
              this.finalText(),
              this.unresolved(),
              outcome.detail,
            ),
          );
        }
        // finishRequested already made the checking checkpoint durable.
        this.state = {
          phase: 'checking',
          contract: state.contract,
          session: state.session,
          pendingFinish: outcome.request,
        };
        continue;
      }

      if (state.phase === 'checking') {
        const request = state.pendingFinish;
        const resourcesSettled = await raceWithRunSignal(
          () => this.busyRegistry.waitUntilFree(BUSY_RESOURCE_GATE_TIMEOUT_MS, this.runSignal),
          this.runSignal,
        );
        this.runSignal.throwIfAborted();
        if (!resourcesSettled) {
          await appendFinishResult(
            state.session,
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
          this.state = readyState(state);
          continue;
        }
        const checks = runFinishChecks({
          runDir: this.options.runDir,
          contract: state.contract,
          finish: request.input,
          checkActive: () => this.assertActive(),
        });
        if (checks.status === 'failed') {
          // Every failed deterministic check is authoritative and bounces
          // raw to the worker, regardless of what it claims in unresolved.
          // A structural defect never reaches the verifier for
          // reinterpretation into a workaround.
          this.completionCheckFailures += 1;
          appendTranscriptEvent(this.options.runDir, {
            type: 'v3_finish_check_failed',
            turn: request.turn,
            attempt: this.completionCheckFailures,
            defects: checks.defects,
          });
          if (this.completionCheckFailures >= this.configuration.maxCompletionCheckFailures) {
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
              during: state.phase,
              reason: 'completion_check_attempts',
              detail: boundedDiagnostic(
                `deterministic finish checks failed ${this.completionCheckFailures} ` +
                  `time(s): ${formatDefects(checks.defects)}`,
              ),
              finalText: request.input.summary,
              unresolved: request.input.unresolved,
            });
          }
          await appendFinishResult(
            state.session,
            request,
            JSON.stringify({
              status: 'rejected',
              source: 'deterministic_finish_checks',
              defects: checks.defects,
            }),
          );
          this.state = readyState(state);
          continue;
        }

        this.verifierCycles += 1;
        const verifying: VerifyingCoordinatorState = {
          phase: 'verifying',
          contract: state.contract,
          session: state.session,
          pendingFinish: request,
          facts: checks.facts,
          structuralFindings: checks.defects,
        };
        await this.saveVerifying(verifying);
        this.state = verifying;
        continue;
      }

      if (state.phase === 'verifying') {
        const request = state.pendingFinish;
        const facts = state.facts;
        const surfacedArtifacts = collectSurfacedArtifacts(this.options.runDir);
        const surfacedEvidenceFingerprint = fingerprintSurfacedArtifacts(surfacedArtifacts);
        let verification: Awaited<ReturnType<typeof runVerifier>>;
        try {
          verification = await runVerifier({
            taskText: this.configuration.taskText,
            runDir: this.options.runDir,
            contract: state.contract,
            finish: facts.finish,
            surfacedArtifacts,
            settled: toSettledFacts(facts),
            outputs: facts.outputs,
            structuralFindings: state.structuralFindings,
            verificationHistory: this.verificationHistory,
            model: this.options.verifierModel,
            budget: this.budget,
            signal: this.runSignal,
            ...(this.options.onModelEvent === undefined
              ? {}
              : {
                  onEvent: (event) => this.options.onModelEvent?.('verifier', event),
                }),
            afterAccounting: async () => {
              await this.saveVerifying(state);
            },
            now: this.now,
          });

          // The verifier may consume more than one private model request.
          // Make that spend durable while retaining the `verifying` phase
          // before accepting its verdict. A deadline that fires after the
          // provider returns but before this boundary must still win.
          await this.saveVerifying(state);
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
                message: 'Verification stopped because the shared run budget was exhausted.',
              }),
            );
          }
          throw error;
        }

        if (verification.status === 'invalid_verdict') {
          // The model responded but never produced a valid verdict, even
          // after its one bounded protocol repair. This is not the same
          // failure as the provider/tool being unavailable; it terminates as
          // a truthful incomplete result rather than `verifier_unavailable`.
          await this.appendTerminalFinishFailure(
            request,
            JSON.stringify({
              status: 'unavailable',
              source: 'verifier',
              message:
                'Fresh-context verification could not produce a valid verdict, so completion was not accepted.',
            }),
          );
          return this.terminalize({
            status: 'incomplete',
            during: state.phase,
            reason: 'verification_incomplete',
            detail: boundedDiagnostic(
              `the evidence judge could not produce a valid verdict: ${verification.reason}`,
            ),
            finalText: request.input.summary,
            unresolved: request.input.unresolved,
          });
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
            during: state.phase,
            reason: 'verifier_unavailable',
            detail: boundedDiagnostic(verification.reason),
            finalText: request.input.summary,
            unresolved: request.input.unresolved,
          });
        }
        if (verification.status === 'verified') {
          // Success is terminal control state, not feedback the worker will
          // consume. Avoid a transient ready_for_model checkpoint and avoid
          // charging unused result bytes after verification has accepted.
          return this.terminalize({
            status: 'verified',
            finalText: request.input.summary,
          });
        }

        if (verification.status === 'incomplete' && request.input.unresolved.length > 0) {
          return this.terminalize(
            {
              status: 'incomplete',
              during: state.phase,
              reason: 'verification_incomplete',
              detail: boundedDiagnostic(
                `the evidence judge accepted the reported blocker(s): ${formatIncompleteFindings(
                  verification.findings,
                )}`,
              ),
              finalText: request.input.summary,
              unresolved: request.input.unresolved,
            },
            { kind: 'incomplete', findings: verification.findings },
          );
        }

        // Reached only for needs_correction, or incomplete with an empty
        // unresolved report (the worker claimed completion despite a
        // credible blocker). The latter becomes report_repair findings: the
        // harness never designs artifact contents, and this can only make
        // the worker's own summary/unresolved report more truthful.
        const correctionFindings: CorrectionFinding[] =
          verification.status === 'incomplete'
            ? verification.findings.map(
                (finding): CorrectionFinding => ({
                  kind: 'report_repair',
                  requirement: finding.requirement,
                  problem:
                    'The completion report claims the request is complete, but this blocker ' +
                    `remains and must be truthfully reported as unresolved: ${finding.assessment}`,
                }),
              )
            : verification.findings;

        this.budget.recordCorrection();
        const previous = this.verificationHistory.at(-1);
        if (
          request.input.unresolved.length > 0 &&
          previous !== undefined &&
          previous.surfacedEvidenceFingerprint === surfacedEvidenceFingerprint &&
          sameRequirementSet(previous.findings, correctionFindings) &&
          !hasNewDistinctAttempt(request.input.unresolved, previous.completionReport.unresolved)
        ) {
          return this.terminalize(
            {
              status: 'incomplete',
              during: state.phase,
              reason: 'verification_incomplete',
              detail: boundedDiagnostic(
                'the same requirement(s) remained unsupported after an equivalent retry with no ' +
                  `new surfaced evidence or new attempted approach: ${formatCorrectionFindings(
                    correctionFindings,
                  )}`,
              ),
              finalText: request.input.summary,
              unresolved: request.input.unresolved,
            },
            { kind: 'correction', findings: correctionFindings },
          );
        }
        const correctionLimit = this.budget.exceededLimit(['worker_turns']);
        if (correctionLimit !== undefined) {
          await this.appendTerminalFinishFailure(
            request,
            JSON.stringify({
              status: 'needs_correction',
              exhausted: true,
              budget_limit: correctionLimit,
              findings: renderFindingsForWorker(correctionFindings),
            }),
          );
          return this.terminalize(
            incompleteBudget(
              correctionLimit,
              request.input.summary,
              request.input.unresolved,
              state.phase,
            ),
            { kind: 'correction', findings: correctionFindings },
          );
        }
        this.verificationHistory.push({
          cycle: this.verifierCycles,
          completionReport: structuredClone(request.input),
          surfacedEvidenceFingerprint,
          findings: structuredClone(correctionFindings),
        });
        if (this.verificationHistory.length > VERIFICATION_HISTORY_LIMIT) {
          this.verificationHistory.splice(
            0,
            this.verificationHistory.length - VERIFICATION_HISTORY_LIMIT,
          );
        }
        await appendFinishResult(
          state.session,
          request,
          JSON.stringify({
            status: 'needs_correction',
            findings: renderFindingsForWorker(correctionFindings),
          }),
        );
        // The checkpoint save inside appendFinishResult's
        // finishResultAppended hook just made this cycle's pushed
        // verification-history entry durable; render the audit projection
        // from that same now-durable state before clearing per-cycle cargo.
        writeFindingsReportSafely(this.options.runDir, {
          phase: this.phase,
          completionReport: request.input,
          settledFacts: toSettledFacts(facts),
          structuralFindings: state.structuralFindings,
          surfacedArtifacts,
          currentFindings: { kind: 'correction', findings: correctionFindings },
          verificationHistory: this.verificationHistory,
        });
        this.state = readyState(state);
        continue;
      }
    }
  }

  async terminalize(
    outcome: DurableTerminalOutcome,
    // Typed findings the calling branch already has in hand (a credible
    // blocker's verifier findings, or the correction findings that just
    // converged/exhausted budget). Every other terminal path has no open
    // verifier findings to show; the terminal outcome's own `detail` string
    // already narrates those.
    currentFindings: FindingsReportCurrentFindings = { kind: 'none' },
  ): Promise<DurableTerminalOutcome> {
    if (this.terminalizing) throw new Error('recursive terminalization');
    this.terminalizing = true;
    const terminalState = this.state;

    // A timed-out executor is still a live effect, even though the model has
    // already received a timeout result. Never close pages, persist terminal
    // success, or finalize the manifest while such work may still mutate it.
    // The finite gate keeps the normal path bounded. If it expires, retain
    // the run lock and drain to a fixed point; releasing the lock while the
    // effect remains live would let a fresh coordinator overlap it.
    const resourcesSettled = await this.busyRegistry.waitUntilFree(
      terminalBusyResourceTimeout(this.options),
    );
    if (!resourcesSettled) {
      await this.busyRegistry.drainUntilFree();
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
        finalOutcome = incompleteBudget(limit, finalOutcome.finalText, [], this.phase);
      } else if (this.runSignal.aborted) {
        finalOutcome = {
          status: 'cancelled',
          during: this.phase,
          reason: abortReason(this.runSignal.reason),
        };
      }
    }

    const pendingFinish =
      terminalState.phase === 'checking' || terminalState.phase === 'verifying'
        ? terminalState.pendingFinish
        : undefined;
    if (
      finalOutcome.status !== 'verified' &&
      pendingFinish !== undefined &&
      !this.pendingFinishAnswered
    ) {
      await this.appendTerminalFinishFailure(
        pendingFinish,
        JSON.stringify({
          status: 'rejected',
          source: 'run_terminal',
          outcome: finalOutcome.status,
          message: formatOutcomeForDiagnostic(finalOutcome),
        }),
      );
    }

    await this.saveTerminal(finalOutcome, terminalState);
    const terminal = this.store.load();
    if (terminal?.phase !== 'terminal') {
      throw new Error('terminal checkpoint was not readable after its durable save');
    }
    repairTerminalProjections(this.options.runDir, terminal);
    if (finalOutcome.status === 'verified' || finalOutcome.status === 'incomplete') {
      writeFindingsReportSafely(this.options.runDir, {
        phase: 'terminal',
        outcome: finalOutcome,
        completionReport: {
          summary: finalOutcome.finalText,
          unresolved: finalOutcome.status === 'incomplete' ? finalOutcome.unresolved : [],
        },
        settledFacts:
          terminalState.phase === 'verifying' ? toSettledFacts(terminalState.facts) : [],
        structuralFindings:
          terminalState.phase === 'verifying' ? terminalState.structuralFindings : [],
        surfacedArtifacts: collectSurfacedArtifacts(this.options.runDir),
        currentFindings,
        verificationHistory: this.verificationHistory,
      });
    }
    return finalOutcome;
  }

  finalText(): string {
    return this.latestCompletionReport()?.summary ?? '';
  }

  unresolved(): FinishInput['unresolved'] {
    return structuredClone(this.latestCompletionReport()?.unresolved ?? []);
  }

  private latestCompletionReport(): FinishInput | undefined {
    const state = this.state;
    if (state.phase === 'checking' || state.phase === 'verifying') {
      return structuredClone(state.pendingFinish.input);
    }
    if (state.phase === 'initializing') return undefined;
    const messages = state.session.state.messages;
    for (let messageIndex = messages.length - 1; messageIndex >= 0; messageIndex -= 1) {
      const message = messages[messageIndex]!;
      if (message.role !== 'assistant') continue;
      for (let blockIndex = message.content.length - 1; blockIndex >= 0; blockIndex -= 1) {
        const block = message.content[blockIndex]!;
        if (block.type !== 'tool_use' || block.name !== 'finish') continue;
        const parsed = durableFinishInputSchema.safeParse(block.input);
        if (parsed.success) return parsed.data;
      }
    }
    return undefined;
  }

  assertActive(): void {
    this.runSignal.throwIfAborted();
    const limit = this.budget.exceededLimit(['worker_turns']);
    if (limit !== undefined) throw new RoleBudgetExceededError(limit);
  }

  isTerminalizing(): boolean {
    return this.terminalizing;
  }

  private async initialize(): Promise<void> {
    const initial = this.state;
    if (initial.phase !== 'initializing') return;
    if (initial.contract !== undefined) {
      ensureOutputContractFile(this.options.runDir, initial.contract);
      const ready = readyState({
        contract: initial.contract,
        session: this.newWorker(initial.contract),
      });
      await this.saveReady(ready);
      this.state = ready;
      return;
    }

    const state =
      initial.initializer ?? createContractInitializerState(this.configuration.taskText);
    if (this.revision === 0) await this.saveInitializing({ initializer: state });

    const budgetedCallModel = createBudgetedCallModel({
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
            onEvent: (event) => this.options.onModelEvent?.('initializer', event),
          }),
      now: this.now,
    });
    const callModel = initializerModelBoundary(budgetedCallModel, this.runSignal);
    let result;
    try {
      result = await runContractInitializer(state, callModel, {
        beforeRequest: async (snapshot) => {
          await this.saveInitializing({ initializer: snapshot });
        },
        afterAttempt: async (event) => {
          if (event.outcome === 'correction') {
            this.recordInitializerCorrectionResults(event.state);
          }
          if (event.outcome === 'accepted' && event.contract !== undefined) {
            await this.saveInitializing({ contract: event.contract });
            this.state = { phase: 'initializing', contract: event.contract };
            // The checkpoint is authoritative. Publishing this immutable
            // convenience copy after it means a crash can only leave a missing
            // file that resume reconstructs, never an orphan contract that was
            // not accepted durably.
            ensureOutputContractFile(this.options.runDir, event.contract);
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
    const ready = readyState({
      contract: result.contract,
      session: this.newWorker(result.contract),
    });
    await this.saveReady(ready);
    this.state = ready;
  }

  private newWorker(contract: OutputContract): Worker {
    return createWorker(this.configuration.taskText, this.workerDeps(), this.workerConfig(), {
      guidance: [formatContractGuidance(contract), formatRunCapabilityGuidance(this.configuration)],
    });
  }

  private workerDeps() {
    return {
      model: workerModelBoundary(this.options.workerModel, this.runSignal),
      registry: this.options.registry,
      runDir: this.options.runDir,
      busyRegistry: this.busyRegistry,
      ...(this.options.browser === undefined ? {} : { browser: this.options.browser }),
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
      maxContextTokens: ceilingFromCheckpoint(this.configuration.maxContextTokens),
    };
  }

  private recordInitializerCorrectionResults(state: ContractInitializerState): void {
    const trailing = state.messages.at(-1);
    if (trailing?.role !== 'user') return;
    const bytes = trailing.content.reduce((total, block) => {
      if (block.type !== 'tool_result') return total;
      const content =
        typeof block.content === 'string' ? block.content : JSON.stringify(block.content);
      return total + Buffer.byteLength(content, 'utf8');
    }, 0);
    this.budget.recordToolResultBytes(bytes);
    this.assertActive();
  }

  private lifecycle(): WorkerHooks {
    const transitionReady = async (snapshot: WorkerSnapshot): Promise<void> => {
      const ready = readyState(this.activeState());
      await this.saveReady(ready, snapshot);
      this.state = ready;
    };
    const transitionExecuting = async (pendingTurn: PendingToolTurn): Promise<void> => {
      const executing = {
        phase: 'executing_tool' as const,
        ...this.activeState(),
        pendingTurn,
      };
      await this.saveExecuting(executing);
      this.state = executing;
    };
    return {
      beforeModelRequest: async (event) => transitionReady(event.session),
      afterModelAccounting: async (event) => {
        // The response content is not accepted yet, but its known billable
        // usage is. Persist that monotone spend with the incremented turn so
        // a crash cannot retry the request from a pre-billing checkpoint.
        await transitionReady(event.session);
      },
      beforeCall: transitionExecuting,
      afterDispatch: transitionExecuting,
      afterResult: transitionExecuting,
      finishRequested: async (event) => {
        this.pendingFinishAnswered = false;
        const checking = {
          phase: 'checking' as const,
          ...this.activeState(),
          pendingFinish: event.request,
        };
        await this.saveChecking(checking, event.session);
        this.state = checking;
      },
      finishResultAppended: async (event) => {
        this.pendingFinishAnswered = true;
        if (this.suppressFinishReadyCheckpoint) return;
        await transitionReady(event.session);
      },
    };
  }

  private activeState(): ActiveCoordinatorState {
    const state = this.state;
    if (state.phase === 'initializing') {
      throw new Error('worker state is unavailable during initialization');
    }
    return { contract: state.contract, session: state.session };
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
        throw new Error('startUrl requires a BrowserController');
      }
      this.browserPrepared = true;
      return;
    }
    if (browser.prepareTaskPage === undefined) {
      throw new Error(
        'requires BrowserController.prepareTaskPage so task-page startup ' +
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
    request: FinishRequest,
    content: string,
  ): Promise<void> {
    this.suppressFinishReadyCheckpoint = true;
    try {
      await appendFinishResult(this.activeState().session, request, content);
      this.pendingFinishAnswered = true;
    } finally {
      this.suppressFinishReadyCheckpoint = false;
    }
  }

  private async saveInitializing(
    state:
      | { initializer: ContractInitializerState; contract?: never }
      | { contract: OutputContract; initializer?: never },
  ): Promise<void> {
    await this.save({
      phase: 'initializing',
      ...(state.contract === undefined
        ? { initializer: captureContractInitializerState(state.initializer) }
        : { contract: state.contract }),
    });
  }

  private async saveReady(
    state: ReadyCoordinatorState,
    snapshot: WorkerSnapshot = captureWorkerSnapshot(state.session),
  ): Promise<void> {
    await this.save({
      phase: state.phase,
      contract: state.contract,
      worker: snapshot,
      verificationHistory: this.verificationHistory,
    });
  }

  private async saveExecuting(state: ExecutingCoordinatorState): Promise<void> {
    await this.save({
      phase: state.phase,
      contract: state.contract,
      worker: captureWorkerSnapshot(state.session),
      verificationHistory: this.verificationHistory,
      pendingTurn: state.pendingTurn,
    });
  }

  private async saveChecking(
    state: CheckingCoordinatorState,
    worker: WorkerSnapshot,
  ): Promise<void> {
    await this.save({
      phase: state.phase,
      contract: state.contract,
      worker,
      verificationHistory: this.verificationHistory,
      pendingFinish: state.pendingFinish,
      pendingCheck: {
        status: 'pending',
        attempt: this.completionCheckFailures + 1,
      },
    });
  }

  private async saveVerifying(state: VerifyingCoordinatorState): Promise<void> {
    await this.save({
      phase: state.phase,
      contract: state.contract,
      worker: captureWorkerSnapshot(state.session),
      verificationHistory: this.verificationHistory,
      pendingFinish: state.pendingFinish,
      pendingCheck: {
        status: 'passed',
        attempt: this.completionCheckFailures + 1,
        facts: state.facts,
        structuralFindings: state.structuralFindings,
      },
      pendingVerifier: {
        cycle: this.verifierCycles,
        recovery: 'restart_read_only',
      },
    });
  }

  private async saveTerminal(
    outcome: DurableTerminalOutcome,
    state: CoordinatorPhaseState,
  ): Promise<void> {
    if (outcome.status === 'verified' && state.phase !== 'verifying') {
      throw new Error('verified terminal outcome requires verifying state');
    }
    await this.save({
      phase: 'terminal',
      ...(state.contract === undefined ? {} : { contract: state.contract }),
      ...(state.phase === 'initializing' ? {} : { worker: captureWorkerSnapshot(state.session) }),
      ...(outcome.status === 'verified' && state.phase === 'verifying'
        ? { finish: structuredClone(state.pendingFinish.input) }
        : {}),
      outcome,
    });
  }

  private async save(phaseState: CheckpointPhaseState): Promise<void> {
    const checkpoint = {
      version: CHECKPOINT_VERSION,
      revision: this.revision + 1,
      updatedAt: new Date(this.now()).toISOString(),
      configuration: this.configuration,
      budget: captureRunBudgetSnapshot(this.budget),
      progress: {
        verifierCycles: this.verifierCycles,
        completionCheckFailures: this.completionCheckFailures,
      },
      ...phaseState,
    } as Checkpoint;
    await this.store.save(checkpoint);
    this.revision = checkpoint.revision;
    await this.options.afterCheckpoint?.(structuredClone(checkpoint));
  }
}

class InitializerUnavailableError extends Error {
  override readonly name = 'InitializerUnavailableError';
}

class WorkerModelUnavailableError extends Error {
  override readonly name = 'WorkerModelUnavailableError';
}

function initializerModelBoundary(callModel: CallModel, signal: AbortSignal): CallModel {
  return async (messages) => {
    try {
      return await callModel(messages);
    } catch (error) {
      if (
        (isAbortError(error) && signal.aborted) ||
        isRoleBudgetExceededError(error) ||
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

function workerModelBoundary(model: ModelDriver, signal: AbortSignal): ModelDriver {
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
  configuration: DurableRunConfiguration,
  phase: CheckpointPhase | undefined,
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
          (defect.code === 'hash_mismatch' || defect.code === 'missing_recorded_file')
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
  configuration: DurableRunConfiguration,
  phase: CheckpointPhase | undefined,
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
  configuration: DurableRunConfiguration,
  phase: CheckpointPhase | undefined,
): void {
  if (manifest === undefined) return;
  if (manifest.task !== configuration.taskText) {
    throw new Error('manifest task does not match the durable configuration');
  }
  if (manifest.browserProvider !== configuration.browserProvider) {
    throw new Error('manifest browserProvider does not match the durable configuration');
  }
  if (phase !== 'terminal' && manifest.finishedAt !== undefined) {
    throw new Error('an active or fresh run cannot reuse an already-finalized manifest');
  }
}

function manifestIntegrityError(defects: readonly { code: string; message: string }[]): Error {
  return new Error(
    `run manifest integrity check failed:\n${defects
      .map((defect) => `- ${defect.code}: ${defect.message}`)
      .join('\n')}`,
  );
}

function ensureTerminalTranscriptEvent(runDir: string, outcome: DurableTerminalOutcome): void {
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
      if (JSON.stringify((event as Record<string, unknown>).outcome) !== JSON.stringify(outcome)) {
        throw new Error(
          `${TRANSCRIPT_FILENAME} contains a terminal outcome that disagrees with the checkpoint`,
        );
      }
      matchingEvents += 1;
    }
  }

  if (matchingEvents > 1) {
    throw new Error(`${TRANSCRIPT_FILENAME} contains ${matchingEvents} duplicate terminal events`);
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
  checkpoint: Extract<Checkpoint, { phase: 'terminal' }>,
): void {
  const errors: string[] = [];
  const attempts: Array<[string, () => void]> = [
    ['metrics', () => writeTerminalMetrics(runDir, checkpoint)],
    ['transcript', () => ensureTerminalTranscriptEvent(runDir, checkpoint.outcome)],
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
      `terminal projection repair failed after attempting every finalizer: ${errors.join('; ')}`,
    );
  }
}

/** Best-effort audit-projection write: a render or write failure is recorded
 * as a diagnostic transcript event and never changes the verification
 * outcome or aborts the run. */
function writeFindingsReportSafely(runDir: string, input: FindingsReportInput): void {
  try {
    writeFindingsReport(runDir, input);
  } catch (error) {
    try {
      appendTranscriptEvent(runDir, {
        type: 'v3_findings_report_failed',
        message: boundedDiagnostic(errorMessage(error)),
      });
    } catch {
      // The audit projection is diagnostic-only; even the diagnostic write
      // failing must never abort or alter the verification outcome.
    }
  }
}

/** Regenerate `harness/findings.md` from whatever a fresh process can read
 * off a resumed checkpoint alone; no in-memory verifying-cycle context
 * survives a restart. `verifiedFacts` is the caller's already re-run
 * deterministic finish-check facts for a resumed verified terminal
 * checkpoint (never freshly collected here); omit otherwise. */
function writeFindingsReportOnResume(
  runDir: string,
  checkpoint: Checkpoint,
  verifiedFacts?: FinishFacts,
): void {
  const input = buildFindingsReportInputFromCheckpoint(
    checkpoint,
    collectSurfacedArtifacts(runDir),
    verifiedFacts,
  );
  if (input !== undefined) writeFindingsReportSafely(runDir, input);
}

function budgetConfig(configuration: DurableRunConfiguration): RunBudgetConfig {
  const limits = configuration.budgetLimits;
  return {
    maxWorkerTurns: ceilingFromCheckpoint(limits.maxWorkerTurns),
    maxToolCalls: ceilingFromCheckpoint(limits.maxToolCalls),
    maxModelTokens: ceilingFromCheckpoint(limits.maxModelTokens),
    maxWallTimeMs: ceilingFromCheckpoint(limits.maxWallTimeMs),
  };
}

function formatRunCapabilityGuidance(configuration: DurableRunConfiguration): string {
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
  reason: WorkerIncompleteReason,
  during: Exclude<CheckpointPhase, 'terminal'>,
  finalText: string,
  unresolved: FinishInput['unresolved'],
  detail?: string,
): DurableTerminalOutcome {
  const budgetReasons: readonly WorkerIncompleteReason[] = [
    'worker_turns',
    'context_budget',
    'tool_calls',
    'model_tokens',
    'wall_time',
  ];
  return {
    status: 'incomplete',
    during,
    reason: budgetReasons.includes(reason) ? 'budget_exceeded' : 'worker_incomplete',
    detail: boundedDiagnostic(detail ?? `worker ended incomplete: ${reason}`),
    finalText,
    unresolved,
  };
}

function incompleteBudget(
  limit: string,
  finalText: string,
  unresolved: FinishInput['unresolved'],
  during: Exclude<CheckpointPhase, 'terminal'>,
): DurableTerminalOutcome {
  return {
    status: 'incomplete',
    during,
    reason: 'budget_exceeded',
    detail: `run budget limit exceeded: ${limit}`,
    finalText,
    unresolved,
  };
}

function writeMetricsAtomically(runDir: string, metrics: WorkerMetrics): void {
  writeFileDurablyAtomic(join(runDir, 'metrics.json'), `${JSON.stringify(metrics, null, 2)}\n`);
}

function writeTerminalMetrics(
  runDir: string,
  checkpoint: Extract<Checkpoint, { phase: 'terminal' }>,
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

function terminalBrowserCleanupTimeout(options: RunAgentOptions): number {
  return positiveTimeout(
    'terminalBrowserCleanupTimeoutMs',
    options.terminalBrowserCleanupTimeoutMs ?? TERMINAL_BROWSER_CLEANUP_TIMEOUT_MS,
  );
}

function terminalBusyResourceTimeout(options: RunAgentOptions): number {
  return positiveTimeout(
    'terminalBusyResourceTimeoutMs',
    options.terminalBusyResourceTimeoutMs ?? BUSY_RESOURCE_GATE_TIMEOUT_MS,
  );
}

function terminalResumeInspectionTimeout(options: RunAgentOptions): number {
  return positiveTimeout(
    'terminalResumeInspectionTimeoutMs',
    options.terminalResumeInspectionTimeoutMs ?? TERMINAL_RESUME_INSPECTION_TIMEOUT_MS,
  );
}

function positiveTimeout(name: string, timeoutMs: number): number {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error(`${name} must be finite and > 0, got ${timeoutMs}`);
  }
  return timeoutMs;
}

function createTerminalResumeInspectionGuard(
  options: RunAgentOptions,
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
      throw new Error(`terminal resume inspection exceeded its ${timeoutMs}ms safety bound`);
    }
  };
}

function withTimeout<T>(operation: Promise<T>, timeoutMs: number, label: string): Promise<T> {
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

function formatDefects(defects: readonly { code: string; message: string }[]): string {
  return defects.map((defect) => `${defect.code}: ${defect.message}`).join('; ');
}

function formatCorrectionFindings(
  findings: readonly { requirement: string; problem: string }[],
): string {
  return findings.map((finding) => `${finding.requirement}: ${finding.problem}`).join('; ');
}

function formatIncompleteFindings(
  findings: readonly { requirement: string; assessment: string }[],
): string {
  return findings.map((finding) => `${finding.requirement}: ${finding.assessment}`).join('; ');
}

/** Fixed harness-owned instruction attached to research findings only when
 * rendering the correction JSON for the worker. It is never model text and
 * never stored in the durable typed finding itself. */
const RESEARCH_FINDING_INSTRUCTION =
  'Continue evidence collection for this requirement using materially different applicable ' +
  'sources or navigation; do not fabricate, pad, or weaken artifacts. If it remains genuinely ' +
  'unobtainable after the applicable fallbacks, report it truthfully in unresolved.';

function renderFindingsForWorker(findings: readonly CorrectionFinding[]): unknown[] {
  return findings.map((finding) =>
    finding.kind === 'research'
      ? { ...finding, instruction: RESEARCH_FINDING_INSTRUCTION }
      : finding,
  );
}

function sameRequirementSet(
  previous: readonly CorrectionFinding[],
  current: readonly CorrectionFinding[],
): boolean {
  const previousRequirements = new Set(previous.map((finding) => finding.requirement));
  const currentRequirements = new Set(current.map((finding) => finding.requirement));
  if (previousRequirements.size !== currentRequirements.size) return false;
  for (const requirement of currentRequirements) {
    if (!previousRequirements.has(requirement)) return false;
  }
  return true;
}

/** Convergence input: a genuinely new distinct attempt string anywhere in
 * the current unresolved report counts as progress, even when it later
 * dead-ends without producing new surfaced evidence. */
function hasNewDistinctAttempt(
  current: FinishInput['unresolved'],
  previous: FinishInput['unresolved'],
): boolean {
  const previousAttempts = new Set(previous.flatMap((entry) => entry.attempts));
  return current.some((entry) => entry.attempts.some((attempt) => !previousAttempts.has(attempt)));
}

function collectSurfacedArtifacts(runDir: string): SurfacedArtifact[] {
  return readManifest(runDir)
    .artifacts.filter(
      (entry) =>
        entry.filename.startsWith('artifacts/') &&
        entry.roles?.some((role) => role === 'requested_output' || role === 'evidence') === true,
    )
    .map((entry) => ({
      filename: entry.filename,
      sha256: entry.sha256,
      roles: [...entry.roles!] as ('requested_output' | 'evidence')[],
      capturedAt: entry.capturedAt,
      ...(entry.sourceUrl === undefined ? {} : { sourceUrl: entry.sourceUrl }),
      ...(entry.publicationKind === undefined ? {} : { publicationKind: entry.publicationKind }),
      ...(entry.completionStatus === undefined ? {} : { completionStatus: entry.completionStatus }),
    }))
    .sort((left, right) => left.filename.localeCompare(right.filename));
}

function fingerprintSurfacedArtifacts(artifacts: readonly SurfacedArtifact[]): string {
  const stableEvidence = artifacts.map(
    ({ filename, sha256, sourceUrl, publicationKind, roles, completionStatus }) => ({
      filename,
      sha256,
      ...(sourceUrl === undefined ? {} : { sourceUrl }),
      ...(publicationKind === undefined ? {} : { publicationKind }),
      roles: [...roles].sort(),
      ...(completionStatus === undefined ? {} : { completionStatus }),
    }),
  );
  return createHash('sha256').update(JSON.stringify(stableEvidence), 'utf8').digest('hex');
}

function formatOutcomeForDiagnostic(outcome: DurableTerminalOutcome): string {
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
  return (
    Buffer.from(value, 'utf8')
      .subarray(0, maximum - 64)
      .toString('utf8') + '\n[diagnostic truncated]'
  );
}

function abortReason(error: unknown): string {
  const message = errorMessage(error).trim();
  return boundedDiagnostic(message === '' ? 'run cancelled' : message);
}

function wallDeadlineError(
  error: unknown,
  signal: AbortSignal,
): RoleBudgetExceededError | undefined {
  if (isRoleBudgetExceededError(error) && error.limit === 'wall_time') {
    return error;
  }
  return isRoleBudgetExceededError(signal.reason) && signal.reason.limit === 'wall_time'
    ? signal.reason
    : undefined;
}

function verifierBudgetError(
  error: unknown,
  signal: AbortSignal,
): RoleBudgetExceededError | undefined {
  if (isRoleBudgetExceededError(error)) return error;
  return isRoleBudgetExceededError(signal.reason) ? signal.reason : undefined;
}
