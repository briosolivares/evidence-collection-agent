// The truthful top-level outcome of a verification-harness run. Success has
// exactly one shape: the verifier accepted the work. Everything that used to
// masquerade as success — judge crash, correction-limit exhaustion, budget
// exhaustion — is an explicit incomplete reason instead, with the run's
// artifacts preserved for review. Crashes and cancellation are not outcomes:
// they propagate as errors, exactly as the worker loop has always thrown.

/** Why a run ended without verification. */
export type IncompleteRunReason =
  /** The verifier itself failed — crashed, returned nothing usable after its
   * bounded repair, or was unreachable. The worker's output may well be
   * fine; nobody trustworthy said so. */
  | 'verifier_unavailable'
  /** The verifier kept requesting corrections until the correction budget
   * ran out. The last cycle's output stands, unverified. */
  | 'verification_attempts'
  /** A whole-run budget guard (turns, tokens, tool calls, bytes, wall time,
   * or the per-request context ceiling) ended the run first. */
  | 'budget_exceeded';

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
       * the run ended mid-cycle). Preserved because incomplete runs keep
       * their artifacts — graders and humans still review them. */
      finalText: string;
    };
