/**
 * Resume-time recovery mechanics.
 *
 * Owns the checks and reconstructions {@link resumeTask} runs before and
 * while it hands an interrupted run back to the harness loop: cross-checking
 * a caller's optional overrides against the checkpoint
 * ({@link assertScalarConfigMatches}), narrowing a stored terminal outcome
 * ({@link validateStoredOutcome}), rebuilding the one worker turn a
 * `'verifying'` checkpoint left unanswered
 * ({@link reconstructPendingResult}, via {@link extractAssistantText}),
 * describing an interrupted tool batch to the resumed model
 * ({@link describeInterruptedBatch}), and the one-time notice text
 * ({@link RECOVERY_NOTICE}) that goes with it. Split out because each of
 * these has exactly one call site — inside `resumeTask` — and together they
 * account for a large share of what makes that function long without being
 * part of its own control flow.
 */
import { SUBMIT_FOR_VERIFICATION } from '../completion/workerResponseProtocol.js';
import type { AssistantContentBlock, TextBlock } from '../loop/messages.js';
import type { WorkerSession, WorkerTurnOutcome } from '../loop/workerSession.js';
import {
  ceilingFromCheckpoint,
  type RunCheckpointV1,
} from '../run/runCheckpointStore.js';
import type { RunOutcome } from '../run/runOutcome.js';
import type { ResumeTaskConfig } from './runTask.js';

/** Cross-check every scalar the caller chose to repeat against what the
 * checkpoint recorded; throws one Error listing every mismatch (never just
 * the first) if any disagree. Fields the caller omits are trusted from the
 * checkpoint without comment — see ResumeTaskConfig's module note on why
 * none of these are required. */
export function assertScalarConfigMatches(
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
export function validateStoredOutcome(outcome: unknown, runDir: string): RunOutcome {
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
 * boundary: after `runWorkerCycle` returns a `'submitted'` result and any
 * completion checks already passed, but BEFORE anything else touches the
 * conversation. So the restored session's LAST message is exactly that
 * cycle's final assistant turn: an unanswered `submit_for_verification`
 * tool_use.
 */
export function reconstructPendingResult(
  session: WorkerSession,
): Extract<WorkerTurnOutcome, { kind: 'submitted' }> {
  const lastMessage = session.state.messages.at(-1);
  if (lastMessage === undefined || lastMessage.role !== 'assistant') {
    throw new Error(
      "cannot resume a 'verifying' checkpoint: the restored conversation does not end with " +
        'the assistant turn that finished this cycle',
    );
  }
  const finalText = extractAssistantText(lastMessage.content);
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

/** Describe an interrupted tool batch for the resumed model, or undefined
 * when the checkpoint records no calls worth warning about.
 *
 * A call left `'running'` is the one that matters: its side effects may or may
 * not have landed, and only the model can check. Calls already `'finished'`
 * are named too, because their results died with the process — the resumed
 * conversation has no record of them, so the model would otherwise have no
 * way to know it already did that work. */
export function describeInterruptedBatch(
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
export const RECOVERY_NOTICE =
  'This run was recovered after an interruption. Your scratch files and published ' +
  'artifacts survived exactly as they were. The browser session was recreated: any page ' +
  'or element refs from before the interruption are no longer valid — call outline (or ' +
  'navigate) again to get fresh refs before interacting with the page.';
