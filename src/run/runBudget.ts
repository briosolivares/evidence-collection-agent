import type { CallModel, Usage } from '../loop/messages.js';
import { isModelResponseRejectedError } from '../model/modelDriver.js';

// One finite budget for the entire run, shared by every model role. The old
// shape — each worker cycle getting a fresh runAgentLoop with fresh guards —
// let corrections silently multiply spend; the tracker makes the whole-run
// ceiling explicit and unresettable. Roles record into the same instance, so
// "starting a correction" cannot restore any headroom, and the final metrics
// can break usage down by role without a second accounting system.

/** The model roles a run may spend budget on. `repair` is reserved for
 * later bounded schema-repair calls (T3+). */
export type ModelRole = 'initializer' | 'worker' | 'verifier' | 'repair';

/** Per-role usage totals as written to metrics.json under `roles`. */
export interface RunRoleUsage {
  /** Model calls this role made (accepted or rejected — both billed). */
  turns: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  /** Wall-clock milliseconds attributed to this role's model calls. */
  wallClockMs: number;
}

/**
 * The run's hard ceilings. Every field accepts either Infinity (explicitly
 * unbounded — the caller opted out of that guard) or a finite integer in
 * the documented range; NaN, negatives, and fractions are configuration
 * errors caught at construction, before any browser or model starts.
 */
export interface RunBudgetConfig {
  /** Worker model calls across ALL cycles/corrections; integer >= 1. */
  maxWorkerTurns: number;
  /** Attempted tool calls across the run (attempted, not merely executed —
   * a rejected batch still counts); integer >= 0. */
  maxToolCalls: number;
  /** Total model tokens (input + output + cache read + cache creation)
   * summed over every role; integer >= 1. */
  maxModelTokens: number;
  /** Cumulative tool-result bytes returned to the worker; integer >= 0. */
  maxToolResultBytes: number;
  /** Wall time from tracker creation; integer >= 1 (milliseconds). */
  maxWallTimeMs: number;
  /** Verifier correction rounds the run may spend; integer >= 0. */
  maxVerifierCorrections: number;
}

/** Which ceiling a budget check found exhausted. */
export type RunBudgetLimit =
  | 'worker_turns'
  | 'tool_calls'
  | 'model_tokens'
  | 'tool_result_bytes'
  | 'wall_time'
  | 'verifier_corrections';

/** One shared budget for a run. Recording is monotone — nothing resets. */
export interface RunBudgetTracker {
  readonly config: Readonly<RunBudgetConfig>;
  /** Charge one model call's usage (and its wall time) to a role. Counts
   * the call as one turn for that role. */
  recordModelUsage(role: ModelRole, usage: Usage, wallClockMs?: number): void;
  /** Charge attempted tool calls (integer >= 0). */
  recordToolCalls(count: number): void;
  /** Charge tool-result bytes returned to the worker (integer >= 0). */
  recordToolResultBytes(bytes: number): void;
  /** Charge one verifier correction round. */
  recordCorrection(): void;
  /** Corrections charged so far. */
  correctionsUsed(): number;
  /** Worker turns charged so far. */
  workerTurnsUsed(): number;
  /** Total model tokens charged so far, all roles. */
  totalModelTokens(): number;
  /** The first exhausted ceiling, or undefined while all headroom remains.
   * Deterministic order: worker_turns, tool_calls, model_tokens,
   * tool_result_bytes, wall_time, verifier_corrections. */
  exceededLimit(): RunBudgetLimit | undefined;
  /** Per-role usage snapshot (copies — mutating them changes nothing). */
  roleUsage(): Partial<Record<ModelRole, RunRoleUsage>>;
}

function assertBudgetField(name: string, value: number, minimum: number): void {
  if (value === Infinity) return;
  // Number.isInteger rejects NaN and ±Infinity, so no nonsense value can
  // survive to bypass a >= comparison mid-run.
  if (!Number.isInteger(value) || value < minimum) {
    throw new Error(
      `RunBudgetConfig.${name} must be Infinity or a finite integer >= ${minimum}, got ${value}`,
    );
  }
}

/** Validate a budget configuration; throws naming the first bad field. */
export function validateRunBudgetConfig(config: RunBudgetConfig): void {
  assertBudgetField('maxWorkerTurns', config.maxWorkerTurns, 1);
  assertBudgetField('maxToolCalls', config.maxToolCalls, 0);
  assertBudgetField('maxModelTokens', config.maxModelTokens, 1);
  assertBudgetField('maxToolResultBytes', config.maxToolResultBytes, 0);
  assertBudgetField('maxWallTimeMs', config.maxWallTimeMs, 1);
  assertBudgetField('maxVerifierCorrections', config.maxVerifierCorrections, 0);
}

/**
 * Create the run's single budget tracker. Wall time counts from this call.
 *
 * @param config - validated ceilings (see RunBudgetConfig; throws on any
 *   invalid field before anything else starts)
 * @param opts.now - test seam for the clock; defaults to Date.now
 */
export function createRunBudgetTracker(
  config: RunBudgetConfig,
  opts: { now?: () => number } = {},
): RunBudgetTracker {
  validateRunBudgetConfig(config);
  const now = opts.now ?? Date.now;
  const startedAt = now();

  const roles = new Map<ModelRole, RunRoleUsage>();
  let toolCalls = 0;
  let toolResultBytes = 0;
  let corrections = 0;

  const roleEntry = (role: ModelRole): RunRoleUsage => {
    let entry = roles.get(role);
    if (entry === undefined) {
      entry = {
        turns: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        wallClockMs: 0,
      };
      roles.set(role, entry);
    }
    return entry;
  };

  const totalTokens = (): number => {
    let sum = 0;
    for (const usage of roles.values()) {
      sum +=
        usage.inputTokens +
        usage.outputTokens +
        usage.cacheReadInputTokens +
        usage.cacheCreationInputTokens;
    }
    return sum;
  };

  return {
    config: Object.freeze({ ...config }),

    recordModelUsage(role, usage, wallClockMs = 0): void {
      const entry = roleEntry(role);
      entry.turns += 1;
      entry.inputTokens += usage.input_tokens;
      entry.outputTokens += usage.output_tokens;
      entry.cacheReadInputTokens += usage.cache_read_input_tokens ?? 0;
      entry.cacheCreationInputTokens += usage.cache_creation_input_tokens ?? 0;
      entry.wallClockMs += wallClockMs;
    },

    recordToolCalls(count): void {
      if (!Number.isInteger(count) || count < 0) {
        throw new Error(`recordToolCalls count must be an integer >= 0, got ${count}`);
      }
      toolCalls += count;
    },

    recordToolResultBytes(bytes): void {
      if (!Number.isInteger(bytes) || bytes < 0) {
        throw new Error(`recordToolResultBytes bytes must be an integer >= 0, got ${bytes}`);
      }
      toolResultBytes += bytes;
    },

    recordCorrection(): void {
      corrections += 1;
    },

    correctionsUsed: () => corrections,
    workerTurnsUsed: () => roles.get('worker')?.turns ?? 0,
    totalModelTokens: totalTokens,

    exceededLimit(): RunBudgetLimit | undefined {
      if ((roles.get('worker')?.turns ?? 0) >= config.maxWorkerTurns) return 'worker_turns';
      if (toolCalls > config.maxToolCalls) return 'tool_calls';
      if (totalTokens() > config.maxModelTokens) return 'model_tokens';
      if (toolResultBytes > config.maxToolResultBytes) return 'tool_result_bytes';
      if (now() - startedAt > config.maxWallTimeMs) return 'wall_time';
      if (corrections > config.maxVerifierCorrections) return 'verifier_corrections';
      return undefined;
    },

    roleUsage(): Partial<Record<ModelRole, RunRoleUsage>> {
      const snapshot: Partial<Record<ModelRole, RunRoleUsage>> = {};
      for (const [role, usage] of roles) snapshot[role] = { ...usage };
      return snapshot;
    },
  };
}

/**
 * Wrap a CallModel so every call — accepted or rejected — charges the
 * shared budget under the given role. This is how initializer and verifier
 * calls join the run's accounting without their runners knowing about the
 * tracker: a rejected response's usage (carried on
 * ModelResponseRejectedError) is recorded before the rejection propagates.
 */
export function withBudgetAccounting(
  callModel: CallModel,
  tracker: RunBudgetTracker,
  role: ModelRole,
): CallModel {
  return async (messages) => {
    const startedMs = Date.now();
    try {
      const response = await callModel(messages);
      tracker.recordModelUsage(role, response.usage, Date.now() - startedMs);
      return response;
    } catch (error) {
      if (isModelResponseRejectedError(error) && error.usage !== undefined) {
        tracker.recordModelUsage(role, error.usage, Date.now() - startedMs);
      }
      throw error;
    }
  };
}
