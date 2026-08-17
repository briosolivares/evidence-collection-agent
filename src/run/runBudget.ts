import type { Usage } from '../loop/messages.js';

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
  /** Charge tool-result bytes made visible to a model role (integer >= 0). */
  recordToolResultBytes(bytes: number): void;
  /** Charge one verifier correction round. */
  recordCorrection(): void;
  /** Corrections charged so far. */
  correctionsUsed(): number;
  /** Worker turns charged so far. */
  workerTurnsUsed(): number;
  /** Total model tokens charged so far, all roles. */
  totalModelTokens(): number;
  /** Wall-clock milliseconds elapsed since the run started. A restored
   * tracker includes downtime when its caller supplies the absolute time at
   * which the restored snapshot was captured (see
   * `createRunBudgetTracker`). */
  elapsedWallTimeMs(): number;
  /** Milliseconds left before the whole-run wall deadline. Infinity stays
   * explicit; a finite result is clamped at zero and is safe to pass to a
   * deadline scheduler. */
  remainingWallTimeMs(): number;
  /** The first exhausted ceiling, or undefined while all headroom remains.
   * Deterministic order: worker_turns, tool_calls, model_tokens,
   * wall_time, verifier_corrections. */
  /** The first exhausted ceiling, optionally ignoring limits that the caller
   * has already consumed lawfully at a phase boundary (for example a worker
   * finishing on its final allowed turn before the verifier runs). */
  exceededLimit(ignore?: readonly RunBudgetLimit[]): RunBudgetLimit | undefined;
  /** Per-role usage snapshot (copies — mutating them changes nothing). */
  roleUsage(): Partial<Record<ModelRole, RunRoleUsage>>;
}

/**
 * The tracker's plainly serializable state, for a later checkpoint/resume
 * step. `roles` mirrors `roleUsage()`'s shape exactly (copies, not the
 * internal Map) so this snapshot can never alias — and be silently mutated
 * through — the tracker's own bookkeeping.
 */
export interface RunBudgetSnapshot {
  elapsedWallTimeMs: number;
  roles: Partial<Record<ModelRole, RunRoleUsage>>;
  toolCalls: number;
  toolResultBytes: number;
  corrections: number;
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
  assertBudgetField('maxWallTimeMs', config.maxWallTimeMs, 1);
  assertBudgetField('maxVerifierCorrections', config.maxVerifierCorrections, 0);
}

const ROLE_USAGE_NUMERIC_FIELDS = [
  'turns',
  'inputTokens',
  'outputTokens',
  'cacheReadInputTokens',
  'cacheCreationInputTokens',
  'wallClockMs',
] as const;

function assertSnapshotField(name: string, value: number): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`RunBudgetSnapshot.${name} must be a finite number >= 0, got ${value}`);
  }
}

/**
 * Validate a restore snapshot before it seeds a tracker; throws naming the
 * first bad field. A malformed snapshot (negative, NaN, Infinity) must fail
 * loudly here rather than silently seed a tracker that under-counts —
 * which would hand a resumed run headroom the original run never had.
 */
function assertValidRunBudgetSnapshot(snapshot: RunBudgetSnapshot): void {
  assertSnapshotField('elapsedWallTimeMs', snapshot.elapsedWallTimeMs);
  assertSnapshotField('toolCalls', snapshot.toolCalls);
  assertSnapshotField('toolResultBytes', snapshot.toolResultBytes);
  assertSnapshotField('corrections', snapshot.corrections);
  for (const [role, usage] of Object.entries(snapshot.roles)) {
    if (usage === undefined) continue;
    for (const field of ROLE_USAGE_NUMERIC_FIELDS) {
      assertSnapshotField(`roles.${role}.${field}`, usage[field]);
    }
  }
}

/** Keyed by tracker identity so `captureRunBudgetSnapshot` can read the
 * counters (`toolCalls`, `toolResultBytes`, `corrections`) that stay
 * closure-local to `createRunBudgetTracker` and are deliberately NOT
 * promoted to ad-hoc accessors on the public interface — every other
 * consumer reads totals through `roleUsage()` / `exceededLimit()`, and
 * checkpointing is the one seam that needs the raw numbers. */
const snapshotCapturers = new WeakMap<RunBudgetTracker, () => RunBudgetSnapshot>();

/**
 * Capture a tracker's serializable state for a later checkpoint/resume step.
 *
 * Reuses `roleUsage()` for the `roles` field rather than reaching into the
 * tracker's internal Map — it already returns per-role copies, so this
 * snapshot cannot drift as the run continues to record against the live
 * tracker.
 */
export function captureRunBudgetSnapshot(tracker: RunBudgetTracker): RunBudgetSnapshot {
  const capture = snapshotCapturers.get(tracker);
  if (capture === undefined) {
    throw new Error('captureRunBudgetSnapshot: tracker was not created by createRunBudgetTracker');
  }
  return capture();
}

/**
 * Create the run's single budget tracker. Wall time counts from this call.
 * A restore always preserves the elapsed duration stored in its snapshot; if
 * `opts.restoreSnapshotAtMs` is also supplied, it additionally charges the
 * real downtime between that absolute checkpoint time and this construction.
 *
 * @param config - validated ceilings (see RunBudgetConfig; throws on any
 *   invalid field before anything else starts)
 * @param opts.now - test seam for the clock; defaults to Date.now
 * @param opts.restore - a snapshot from `captureRunBudgetSnapshot`, taken on
 *   a prior (crashed or checkpointed) instance of this same run's tracker.
 *   Validated before anything else starts; a malformed snapshot throws
 *   rather than silently under-counting.
 * @param opts.restoreSnapshotAtMs - absolute `now()` time at which `restore`
 *   was captured. Supplying it makes a resumed tracker's elapsed wall time
 *   continue from the original run baseline, including process downtime. It
 *   must use the same clock as `opts.now`; an invalid or future value throws
 *   rather than granting ambiguous headroom. Omit only for legacy snapshots
 *   that did not durably record an absolute checkpoint time.
 */
export function createRunBudgetTracker(
  config: RunBudgetConfig,
  opts: {
    now?: () => number;
    restore?: RunBudgetSnapshot;
    restoreSnapshotAtMs?: number;
  } = {},
): RunBudgetTracker {
  validateRunBudgetConfig(config);
  const restore = opts.restore;
  if (restore !== undefined) assertValidRunBudgetSnapshot(restore);
  const now = opts.now ?? Date.now;
  const createdAtMs = now();
  const restoreSnapshotAtMs = opts.restoreSnapshotAtMs;
  if (restoreSnapshotAtMs !== undefined) {
    if (restore === undefined) {
      throw new Error(
        'restoreSnapshotAtMs requires a RunBudgetSnapshot in opts.restore',
      );
    }
    if (!Number.isFinite(restoreSnapshotAtMs) || restoreSnapshotAtMs < 0) {
      throw new Error(
        `restoreSnapshotAtMs must be a finite number >= 0, got ${restoreSnapshotAtMs}`,
      );
    }
    if (restoreSnapshotAtMs > createdAtMs) {
      throw new Error(
        `restoreSnapshotAtMs (${restoreSnapshotAtMs}) must not be later than ` +
          `the current clock (${createdAtMs})`,
      );
    }
  }

  // A duration-only legacy restore starts from the saved elapsed value. A
  // durable restore also adds the time the process was down, reconstructing
  // the original wall-clock baseline exactly:
  //
  //   createdAt - (savedElapsed + createdAt - snapshotAt)
  //   === snapshotAt - savedElapsed === original startedAt
  //
  // Future timestamps fail above instead of being clamped: an unexplained
  // clock reversal cannot safely prove how much budget remains.
  const restoredElapsedMs =
    restore === undefined
      ? 0
      : restore.elapsedWallTimeMs +
        (restoreSnapshotAtMs === undefined
          ? 0
          : createdAtMs - restoreSnapshotAtMs);
  if (!Number.isFinite(restoredElapsedMs)) {
    throw new Error(
      `restored wall time must remain finite, got ${restoredElapsedMs}`,
    );
  }
  const startedAt = createdAtMs - restoredElapsedMs;

  const roles = new Map<ModelRole, RunRoleUsage>();
  if (restore !== undefined) {
    for (const [role, usage] of Object.entries(restore.roles)) {
      if (usage !== undefined) roles.set(role as ModelRole, { ...usage });
    }
  }
  let toolCalls = restore?.toolCalls ?? 0;
  let toolResultBytes = restore?.toolResultBytes ?? 0;
  let corrections = restore?.corrections ?? 0;

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

  const tracker: RunBudgetTracker = {
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
    elapsedWallTimeMs: () => now() - startedAt,
    remainingWallTimeMs: () => {
      if (config.maxWallTimeMs === Infinity) return Infinity;
      return Math.max(0, config.maxWallTimeMs - (now() - startedAt));
    },

    exceededLimit(ignore = []): RunBudgetLimit | undefined {
      const ignored = new Set(ignore);
      if (
        !ignored.has('worker_turns') &&
        (roles.get('worker')?.turns ?? 0) >= config.maxWorkerTurns
      ) {
        return 'worker_turns';
      }
      if (!ignored.has('tool_calls') && toolCalls > config.maxToolCalls) {
        return 'tool_calls';
      }
      if (!ignored.has('model_tokens') && totalTokens() > config.maxModelTokens) {
        return 'model_tokens';
      }
      if (!ignored.has('wall_time') && now() - startedAt >= config.maxWallTimeMs) {
        return 'wall_time';
      }
      if (
        !ignored.has('verifier_corrections') &&
        corrections > config.maxVerifierCorrections
      ) {
        return 'verifier_corrections';
      }
      return undefined;
    },

    roleUsage(): Partial<Record<ModelRole, RunRoleUsage>> {
      const snapshot: Partial<Record<ModelRole, RunRoleUsage>> = {};
      for (const [role, usage] of roles) snapshot[role] = { ...usage };
      return snapshot;
    },
  };

  snapshotCapturers.set(tracker, () => ({
    elapsedWallTimeMs: tracker.elapsedWallTimeMs(),
    roles: tracker.roleUsage(),
    toolCalls,
    toolResultBytes,
    corrections,
  }));

  return tracker;
}
