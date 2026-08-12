/** Structural ground truth for the X task. X offers no unauthenticated,
 * independent completeness oracle, so tweet authorship and completeness
 * remain part of the standing human overlay. */
export interface ElonTweetsOracle {
  accountHandle: 'elonmusk';
  minRows: number;
  maxRows: number;
  acceptedTimeZones: readonly string[];
}

export async function fetchOracle(): Promise<ElonTweetsOracle> {
  return {
    accountHandle: 'elonmusk',
    minRows: 1,
    maxRows: 200,
    // X can render dates in the browser's local zone while source timestamps
    // are commonly recorded in UTC. Accept either boundary at run time.
    acceptedTimeZones: ['America/Los_Angeles', 'UTC'],
  };
}
