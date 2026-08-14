/**
 * The harness cycle loop.
 *
 * Owns {@link runHarnessCycles} — the worker/judge loop shared by a fresh
 * `runTask` start (via {@link runVerificationHarness}) and `resumeTask`,
 * plus the feedback formatting it produces ({@link formatFindings},
 * {@link formatCheckFailures}) and the completion-check failure budget
 * default ({@link DEFAULT_MAX_COMPLETION_CHECK_FAILURES}) both `runTask` and
 * `runVerificationHarness` read. Split into its own file because the loop is
 * the largest single mechanism in the hub and the one most worth reading in
 * isolation from run setup and resume recovery.
 */
import { finalizeIncompleteRun } from '../completion/finalizeIncompleteRun.js';
import {
  runCompletionCheck,
  type CompletionFailure,
  type SettledFact,
} from '../completion/completionCheck.js';
import { INITIALIZER_MODEL } from '../harness/initializer.js';
import {
  writeHarnessDiagnostics,
  type HarnessCycleRecord,
  type HarnessOutcomeRecord,
} from '../harness/harness.js';
import {
  makeVerifierModelDriver,
  runVerifier,
  type VerificationFinding,
  type VerifierOutcome,
} from '../harness/verifier.js';
import type { CallModel } from '../loop/messages.js';
import {
  appendSubmissionResult,
  appendWorkerFeedback,
  createWorkerSession,
  recordWorkerSessionCrash,
  runWorkerTurn,
  writeWorkerSessionMetrics,
  type WorkerSession,
  type WorkerSessionDeps,
  type WorkerTurnOutcome,
} from '../loop/workerSession.js';
import type { CallModelConfig } from '../model/callModel.js';
import {
  withBudgetAccounting,
  type RunBudgetTracker,
} from '../run/runBudget.js';
import type { RunOutcome } from '../run/runOutcome.js';
import { appendTranscriptEvent, type CycleStartEvent } from '../run/transcript.js';
import { withCancellationGuard } from './cancellationGuard.js';
import type { RunCheckpointWriter } from './runCheckpoint.js';
import type { ToolCallCheckpointHooks } from './toolCallCheckpoint.js';
import type { HarnessConfig } from './runTask.js';

/** How many times the code checks may reject a submission before the run
 * ends incomplete. Separate from (and larger than) the verifier's budget:
 * a code-check failure is cheap, objective, and usually a one-line fix, so
 * spending a scarce verifier attempt on one would be waste. */
export const DEFAULT_MAX_COMPLETION_CHECK_FAILURES = 5;

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
export async function runHarnessCycles(args: {
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
    precomputedResult?: Extract<WorkerTurnOutcome, { kind: 'submitted' }>;
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
        // `contracts` is unconditional now that every run's output-contract
        // store is unconditional too — `current` stays `undefined` only in
        // the degenerate case of a submission that raced ahead of the
        // contract-first gate (see runWorkerTurn's submission-protocol
        // branch, which intercepts `submit_for_verification` before the gate
        // runs), which the verifier's own contract-vs-task check then
        // reports as a finding rather than this harness fabricating one.
        contracts: {
          current: contract,
          history: contract === undefined ? [] : contractStore!.contractHistory(),
        },
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
export async function runVerificationHarness(
  taskText: string,
  runDir: string,
  harnessConfig: HarnessConfig,
  maxWorkerCycles: number,
  loopDeps: WorkerSessionDeps,
  sessionConfig: { budget: RunBudgetTracker; maxContextTokens: number },
  checkpointWriter: RunCheckpointWriter,
  toolCheckpoint: ToolCallCheckpointHooks,
  createStream?: CallModelConfig['createStream'],
  signal?: AbortSignal,
): Promise<RunOutcome> {
  const verifierCallModel = withBudgetAccounting(
    harnessConfig.verifierCallModel ??
      withCancellationGuard(makeVerifierModelDriver({ createStream, signal }), signal),
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
