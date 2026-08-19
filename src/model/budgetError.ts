import type { RunBudgetLimit } from '../run/runBudget.js';

export class RoleBudgetExceededError extends Error {
  readonly limit: RunBudgetLimit;

  constructor(limit: RunBudgetLimit, options: { cause?: unknown } = {}) {
    super(`role model call stopped at run budget limit: ${limit}`, options);
    this.name = 'RoleBudgetExceededError';
    this.limit = limit;
  }
}

export function isRoleBudgetExceededError(
  error: unknown,
): error is RoleBudgetExceededError {
  return error instanceof RoleBudgetExceededError;
}
