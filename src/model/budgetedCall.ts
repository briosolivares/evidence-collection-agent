import type { CallModel, Message, ModelResponse, Usage } from './messages.js';
import { isAbortError } from '../errors.js';
import {
  knownModelUsageFromError,
  type AcceptedModelResponse,
  type ModelAttemptEvent,
  type ModelDriver,
} from './modelDriver.js';
import {
  RoleBudgetExceededError,
  isRoleBudgetExceededError,
  type ModelRole,
  type RunBudgetLimit,
  type RunBudgetTracker,
} from '../run/runBudget.js';
import { raceWithRunSignal } from '../run/runDeadline.js';

export interface BudgetedCallModelOptions {
  model: ModelDriver;
  budget: RunBudgetTracker;
  role: ModelRole;
  signal?: AbortSignal;
  onEvent?: (event: ModelAttemptEvent) => void;
  /** Charge control/tool calls found in a fully accepted response before
   * the durable attempt hook snapshots the shared budget. */
  onAcceptedResponse?: (response: ModelResponse) => void | Promise<void>;
  /** Awaited after each provider attempt settles and any known usage has
   * been charged. Durable coordinators use this to checkpoint spend before
   * a private role consumes or retries the response. */
  afterAttemptSettled?: () => void | Promise<void>;
  now?: () => number;
}

export interface AccountedModelCallOptions {
  model: ModelDriver;
  messages: readonly Message[];
  budget: RunBudgetTracker;
  role: ModelRole;
  signal?: AbortSignal;
  onEvent?: (event: ModelAttemptEvent) => void;
  /** Runs after accepted-response side effects have been charged, but before
   * the durable usage hook and cancellation boundary. */
  onAcceptedResponse?: (response: ModelResponse) => void | Promise<void>;
  /** Runs after known usage has been charged for either outcome. */
  afterUsageRecorded?: (usage: Usage, outcome: 'accepted' | 'failed') => void | Promise<void>;
  /** Optional settlement hook for failures whose provider reported no usage. */
  afterUnknownFailure?: (error: unknown) => void | Promise<void>;
  now?: () => number;
}

/** Run one strict model call, charge every known provider usage record, then
 * persist accounting before cancellation can win the response boundary. */
export async function runAccountedModelCall(
  options: AccountedModelCallOptions,
): Promise<AcceptedModelResponse> {
  const now = options.now ?? Date.now;
  const startedMs = now();
  let accepted: AcceptedModelResponse;
  try {
    accepted = await raceWithRunSignal(
      () =>
        options.model.generate({
          messages: options.messages,
          ...(options.signal === undefined ? {} : { signal: options.signal }),
          ...(options.onEvent === undefined ? {} : { onEvent: options.onEvent }),
        }),
      options.signal,
    );
  } catch (error) {
    const usage = knownModelUsageFromError(error);
    if (usage === undefined) {
      await options.afterUnknownFailure?.(error);
    } else {
      options.budget.recordModelUsage(options.role, usage, now() - startedMs);
      await options.afterUsageRecorded?.(usage, 'failed');
    }
    options.signal?.throwIfAborted();
    throw error;
  }

  options.budget.recordModelUsage(options.role, accepted.usage, now() - startedMs);
  await options.onAcceptedResponse?.(accepted.response);
  await options.afterUsageRecorded?.(accepted.usage, 'accepted');
  options.signal?.throwIfAborted();
  return accepted;
}

/**
 * Adapt the strict driver to a legacy CallModel consumer without losing the
 * runtime's aggregate accounting. The returned response carries only the accepted
 * attempt's usage, which is the correct per-request context measurement;
 * the shared budget receives aggregate known usage across discarded complete
 * attempts. Partial transport attempts remain uncountable unless the provider
 * reported a complete usage record.
 */
export function createBudgetedCallModel(options: BudgetedCallModelOptions): CallModel {
  return async (messages) => {
    options.signal?.throwIfAborted();
    throwIfRoleBudgetExceeded(options.budget);
    let accepted;
    try {
      accepted = await runAccountedModelCall({
        model: options.model,
        messages,
        budget: options.budget,
        role: options.role,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        ...(options.onEvent === undefined ? {} : { onEvent: options.onEvent }),
        ...(options.onAcceptedResponse === undefined
          ? {}
          : { onAcceptedResponse: options.onAcceptedResponse }),
        ...(options.afterAttemptSettled === undefined
          ? {}
          : {
              afterUsageRecorded: options.afterAttemptSettled,
              afterUnknownFailure: (error: unknown) =>
                isRoleBudgetExceededError(error) ? undefined : options.afterAttemptSettled?.(),
            }),
        ...(options.now === undefined ? {} : { now: options.now }),
      });
    } catch (error) {
      if (isRoleBudgetExceededError(error)) throw error;
      if (isAbortError(error)) throw error;
      const exceeded = roleBudgetLimit(options.budget);
      if (exceeded !== undefined) {
        throw new RoleBudgetExceededError(exceeded, { cause: error });
      }
      throw error;
    }

    throwIfRoleBudgetExceeded(options.budget);
    return accepted.response;
  };
}

function throwIfRoleBudgetExceeded(budget: RunBudgetTracker): void {
  const limit = roleBudgetLimit(budget);
  if (limit !== undefined) throw new RoleBudgetExceededError(limit);
}

/** A verifier may lawfully run after the worker used its final allowed turn;
 * every other whole-run limit remains binding before and after each call. */
function roleBudgetLimit(budget: RunBudgetTracker): RunBudgetLimit | undefined {
  return budget.exceededLimit(['worker_turns']);
}
