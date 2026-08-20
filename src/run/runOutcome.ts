// The truthful top-level outcome of a verification-harness run. Success has
// exactly one shape: the verifier accepted the work. Everything that used to
// masquerade as success — judge crash, correction-limit exhaustion, budget
// exhaustion — is an explicit incomplete reason instead, with the run's
// artifacts preserved for review. Crashes and cancellation are not outcomes:
// they propagate as errors, exactly as the worker loop has always thrown.

/** Why a run ended without verification. */
export type IncompleteRunReason =
  /** The contract initializer could not produce one trustworthy immutable
   * contract within its bounded attempts. */
  | 'initializer_unavailable'
  /** The worker ended for a non-budget reason after preserving its run. */
  | 'worker_incomplete'
  /** Deterministic finish defects persisted through the configured repair
   * attempts, so the verifier was never allowed to accept the run. */
  | 'completion_check_attempts'
  /** The verifier itself failed — crashed, returned nothing usable after its
   * bounded repair, or was unreachable. The worker's output may well be
   * fine; nobody trustworthy said so. */
  | 'verifier_unavailable'
  /** The judge accepted a credible reported blocker, or correction dialogue
   * made no progress with unchanged surfaced evidence. */
  | 'verification_incomplete'
  /** A whole-run budget guard (turns, tokens, tool calls, bytes, wall time,
   * or the per-request context ceiling) ended the run first. */
  | 'budget_exceeded';

/** Public, human-relevant part of a worker-reported unresolved requirement. */
export interface UnresolvedRequirement {
  requirement: string;
  reason: string;
  attempts: readonly string[];
}

/** Used only when a run ended before the worker submitted any completion
 * report. It is deliberately factual and does not invent an explanation. */
export const NO_COMPLETION_REPORT_TEXT =
  'The assistant stopped before it could prepare a final response.';

/** Keep a worker-authored response when one exists, otherwise supply the
 * deterministic involuntary-stop fallback used by public interfaces. */
export function incompleteFinalText(finalText: string): string {
  return finalText.trim() === '' ? NO_COMPLETION_REPORT_TEXT : finalText;
}

/** The outcome of a harness-mode run. */
export type RunOutcome =
  | {
      status: 'verified';
      /** The worker's final prose from the accepted cycle. */
      finalText: string;
    }
  | {
      status: 'incomplete';
      reason: IncompleteRunReason;
      /** Human-readable specifics: which budget tripped, what the verifier
       * failure was, how many attempts were spent. */
      detail: string;
      /** The worker's final prose when its last cycle completed ("" when
       * the run ended mid-cycle at the durable core boundary). Public
       * adapters replace an empty value with NO_COMPLETION_REPORT_TEXT. */
      finalText: string;
      /** Worker-reported unresolved request parts from its latest completion
       * report. Empty when no report was submitted. Attempts remain available
       * programmatically but presentation surfaces normally omit them. */
      unresolved: readonly UnresolvedRequirement[];
    };
