import type { ToolCall } from '../tools/pipeline.js';

// The contract-first gate. Until a valid output contract exists, a worker
// response may do exactly one thing: call `set_output_contract`. Anything
// else — a navigation, a write, a screenshot — is refused before execution,
// so a run can never collect evidence against requirements nobody validated.
//
// The gate is a pure decision over the response's calls; the session applies
// it. It never executes anything itself, which is what lets it guarantee the
// "zero side effects" half of its contract: when it says `refuse`, the
// session returns the supplied results and runs nothing at all.
//
// Every attempted call still receives exactly one tool result, even the ones
// that never ran. The API requires each tool_use answered, and a silently
// dropped call would leave the conversation structurally invalid.

/** Machine-stable codes the gate returns to the model. */
export const OUTPUT_CONTRACT_REQUIRED = 'output_contract_required';
export const BLOCKED_BY_INVALID_CONTRACT = 'blocked_by_invalid_contract';

/** The gate's verdict on one worker response. */
export type ContractGateDecision =
  /** Nothing is blocked; execute the response's calls normally. */
  | { kind: 'execute' }
  /**
   * Execute nothing. `results` holds one entry per attempted call, in the
   * response's own order, ready to return as tool results.
   */
  | { kind: 'refuse'; results: Array<{ toolCallId: string; content: string; isError: true }> };

/** Name of the tool that states the contract. */
export const SET_OUTPUT_CONTRACT = 'set_output_contract';

/**
 * Decide whether a worker response may execute, given whether a valid
 * contract already exists.
 *
 * @param calls - the response's tool calls, in the model's order
 * @param hasContract - whether the run already has an accepted contract
 *   revision (`OutputContractStore.hasContract()`)
 * @returns `execute` when a contract already exists, or when this response's
 *   FIRST call is `set_output_contract` (letting the contract call itself run
 *   — and, since it is the first call, letting the session re-check the gate
 *   for the remaining calls afterwards). Otherwise `refuse` with one
 *   `output_contract_required` result per attempted call and no execution
 *
 * Note the deliberate asymmetry: a response whose first call states the
 * contract is allowed to proceed, because refusing it would make progress
 * impossible. A response that buries the contract call after other work is
 * refused wholesale — accepting it would mean executing pre-contract side
 * effects in the order the model happened to choose.
 */
export function decideContractGate(
  calls: readonly ToolCall[],
  hasContract: boolean,
): ContractGateDecision {
  if (hasContract) return { kind: 'execute' };
  if (calls.length === 0) return { kind: 'execute' };
  if (calls[0]!.name === SET_OUTPUT_CONTRACT) return { kind: 'execute' };

  const named = calls.some((call) => call.name === SET_OUTPUT_CONTRACT);
  const reason = named
    ? `${OUTPUT_CONTRACT_REQUIRED}: ${SET_OUTPUT_CONTRACT} must be the FIRST call of your ` +
      'response, before any other tool. Nothing in this response ran. Call it alone first, ' +
      'then continue.'
    : `${OUTPUT_CONTRACT_REQUIRED}: this run has no output contract yet, so no tool may run. ` +
      `Nothing in this response ran. Call ${SET_OUTPUT_CONTRACT} first to state exactly what ` +
      'this run must produce, then continue.';

  return {
    kind: 'refuse',
    results: calls.map((call) => ({
      toolCallId: call.id,
      content: reason,
      isError: true as const,
    })),
  };
}

/**
 * Results for the calls that follow a `set_output_contract` call which the
 * store rejected. The contract call keeps its own schema-error result (the
 * pipeline produced it); every later call in the same response is blocked,
 * because it was written against requirements that were never accepted.
 *
 * @param calls - the response's calls after the leading contract call
 */
export function blockedByInvalidContractResults(
  calls: readonly ToolCall[],
): Array<{ toolCallId: string; content: string; isError: true }> {
  return calls.map((call) => ({
    toolCallId: call.id,
    content:
      `${BLOCKED_BY_INVALID_CONTRACT}: your ${SET_OUTPUT_CONTRACT} call in this response was ` +
      'rejected, so this call did not run. Fix the contract first; the run still has no ' +
      'accepted requirements.',
    isError: true as const,
  }));
}
