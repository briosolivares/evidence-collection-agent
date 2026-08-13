/** Ground truth for the stub task: the deliverable the run must contain. */
export interface StubOracle {
  /** Run-dir-relative path of the file the grader expects to find. */
  expectedFile: string;
}

/**
 * Fetch the stub task's oracle data. The stub's "ground truth" is static —
 * this exists to exercise the oracle-at-grading-time call path that real
 * Tier A oracles (live APIs) plug into.
 *
 * @returns the expected deliverable's run-dir-relative path
 */
export async function fetchOracle(): Promise<StubOracle> {
  return { expectedFile: 'artifacts/answer.md' };
}
