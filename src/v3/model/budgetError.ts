import type { RunBudgetLimit } from '../../run/runBudget.js';

export class V3RoleBudgetExceededError extends Error {
  readonly limit: RunBudgetLimit;

  constructor(limit: RunBudgetLimit, options: { cause?: unknown } = {}) {
    super(`v3 role model call stopped at run budget limit: ${limit}`, options);
    this.name = 'V3RoleBudgetExceededError';
    this.limit = limit;
  }
}

export function isV3RoleBudgetExceededError(
  error: unknown,
): error is V3RoleBudgetExceededError {
  return error instanceof V3RoleBudgetExceededError;
}
