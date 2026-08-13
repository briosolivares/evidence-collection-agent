import type { ToolCall } from '../tools/pipeline.js';

// What a worker response is allowed to be. Two rules, both of which close
// holes the old loop left open:
//
//  1. A clean no-tool response is NOT completion. Under the old policy the
//     worker finished a run simply by saying nothing — so a model that ran
//     out of ideas, narrated a summary, or hallucinated that it was done
//     produced a "completed" run indistinguishable from a real one. Now
//     finishing requires an explicit `submit_for_verification` call, and a
//     no-tool response is an invalid working response that gets concise
//     protocol feedback instead.
//  2. Submission is exclusive. It may be the response's only tool call, so
//     it can never be mixed with writes whose effects would land after the
//     run had already claimed to be finished.

/** The name of the control tool that ends a working cycle. */
export const SUBMIT_FOR_VERIFICATION = 'submit_for_verification';

/** What the session should do with one worker response. */
export type WorkerResponseDisposition =
  /** Ordinary progress: execute these calls (none of them submission). */
  | { kind: 'work'; calls: readonly ToolCall[] }
  /** A valid submission: run the code checks, then the verifier. Carries the
   * submission call so its result can be returned to the same worker. */
  | { kind: 'submit'; call: ToolCall }
  /**
   * The response broke the protocol. Nothing executes; `feedback` is
   * returned to the same worker, and `results` (when present) answers each
   * attempted tool call so the conversation stays structurally valid.
   */
  | {
      kind: 'invalid';
      feedback: string;
      results: Array<{ toolCallId: string; content: string; isError: true }>;
    };

/**
 * Classify one worker response.
 *
 * @param calls - the response's tool calls, in the model's order
 * @param finalText - the response's prose, used only to make the feedback
 *   concrete when a no-tool response looks like a completion claim
 * @returns the disposition (see WorkerResponseDisposition). A response
 *   mixing submission with any other call is invalid and executes NOTHING —
 *   not even the other calls, since the model's intent is ambiguous and
 *   half-running it would be the worst reading
 */
export function validateWorkerResponse(
  calls: readonly ToolCall[],
  finalText = '',
): WorkerResponseDisposition {
  const submissions = calls.filter((call) => call.name === SUBMIT_FOR_VERIFICATION);

  if (submissions.length === 0) {
    if (calls.length > 0) return { kind: 'work', calls };
    // A no-tool response: the old implicit completion, now refused.
    const claimed = /\b(done|complete|finished|submitted)\b/i.test(finalText);
    return {
      kind: 'invalid',
      feedback:
        (claimed
          ? 'Your response claimed the work was finished but called no tool. '
          : 'Your response made no tool call, which does not advance or finish the run. ') +
        `Nothing happened. When the deliverables are genuinely ready, call ` +
        `${SUBMIT_FOR_VERIFICATION} as your only tool call; otherwise continue working.`,
      results: [],
    };
  }

  if (submissions.length > 1 || calls.length > 1) {
    return {
      kind: 'invalid',
      feedback:
        `${SUBMIT_FOR_VERIFICATION} must be the ONLY tool call in its response. ` +
        'Nothing in this response ran. Finish any remaining work in its own turns, then ' +
        'submit alone.',
      results: calls.map((call) => ({
        toolCallId: call.id,
        content:
          `Not executed: ${SUBMIT_FOR_VERIFICATION} must be the only tool call in its ` +
          'response, so this whole response was rejected.',
        isError: true as const,
      })),
    };
  }

  return { kind: 'submit', call: submissions[0]! };
}
