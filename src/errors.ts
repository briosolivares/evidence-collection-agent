/** Render an unknown thrown value without assuming it is an Error. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Whether an Error carries the conventional cancellation name. */
export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}
