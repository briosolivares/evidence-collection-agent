import type { CallModel, ModelResponse } from '../../loop/messages.js';
import {
  knownModelUsageFromError,
  type ModelAttemptEvent,
  type ModelDriver,
} from '../../model/modelDriver.js';
import type {
  ModelRole,
  RunBudgetLimit,
  RunBudgetTracker,
} from '../../run/runBudget.js';
import { raceWithV3RunSignal } from '../run/runDeadline.js';
import {
  V3RoleBudgetExceededError,
  isV3RoleBudgetExceededError,
} from './budgetError.js';

export {
  V3RoleBudgetExceededError,
  isV3RoleBudgetExceededError,
} from './budgetError.js';

export interface V3BudgetedCallModelOptions {
  model: ModelDriver;
  budget: RunBudgetTracker;
  role: ModelRole;
  signal?: AbortSignal;
  onEvent?: (event: ModelAttemptEvent) => void;
  /** Charge control/tool calls found in a fully accepted response before
   * the durable attempt hook snapshots the shared budget. */
  onAcceptedResponse?: (
    response: ModelResponse,
  ) => void | Promise<void>;
  /** Awaited after each provider attempt settles and any known usage has
   * been charged. Durable coordinators use this to checkpoint spend before
   * a private role consumes or retries the response. */
  afterAttemptSettled?: () => void | Promise<void>;
  now?: () => number;
}

/**
 * Adapt the strict driver to a legacy CallModel consumer without losing v3's
 * aggregate accounting. The returned response carries only the accepted
 * attempt's usage, which is the correct per-request context measurement;
 * the shared budget receives aggregate known usage across discarded complete
 * attempts. Partial transport attempts remain uncountable unless the provider
 * reported a complete usage record.
 */
export function createV3BudgetedCallModel(
  options: V3BudgetedCallModelOptions,
): CallModel {
  const now = options.now ?? Date.now;
  return async (messages) => {
    options.signal?.throwIfAborted();
    throwIfRoleBudgetExceeded(options.budget);
    const startedMs = now();
    let accepted;
    try {
      accepted = await raceWithV3RunSignal(
        () =>
          options.model.generate({
            messages,
            ...(options.signal === undefined ? {} : { signal: options.signal }),
            ...(options.onEvent === undefined ? {} : { onEvent: options.onEvent }),
          }),
        options.signal,
      );
    } catch (error) {
      if (isV3RoleBudgetExceededError(error)) throw error;
      const usage = knownModelUsageFromError(error);
      if (usage !== undefined) {
        options.budget.recordModelUsage(
          options.role,
          usage,
          now() - startedMs,
        );
      }
      await options.afterAttemptSettled?.();
      // Persist any known billing before cancellation wins. Abort-shaped
      // failures normally carry no usage, but a provider that reports a
      // complete attempt must not make that spend disappear.
      options.signal?.throwIfAborted();
      if (isAbortError(error)) throw error;
      const exceeded = roleBudgetLimit(options.budget);
      if (exceeded !== undefined) {
        throw new V3RoleBudgetExceededError(exceeded, { cause: error });
      }
      throw error;
    }

    options.budget.recordModelUsage(
      options.role,
      accepted.usage,
      now() - startedMs,
    );
    await options.onAcceptedResponse?.(accepted.response);
    await options.afterAttemptSettled?.();
    // The provider completed and reported billable usage, so charge and
    // durably expose it; cancellation still wins before the response can
    // become a verdict.
    options.signal?.throwIfAborted();
    throwIfRoleBudgetExceeded(options.budget);
    return accepted.response;
  };
}

function throwIfRoleBudgetExceeded(budget: RunBudgetTracker): void {
  const limit = roleBudgetLimit(budget);
  if (limit !== undefined) throw new V3RoleBudgetExceededError(limit);
}

/** A verifier may lawfully run after the worker used its final allowed turn;
 * every other whole-run limit remains binding before and after each call. */
function roleBudgetLimit(budget: RunBudgetTracker): RunBudgetLimit | undefined {
  return budget.exceededLimit(['worker_turns']);
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}
