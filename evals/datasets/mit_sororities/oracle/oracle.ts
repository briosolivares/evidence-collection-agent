export const MIT_SORORITIES = [
  'Alpha Chi Omega',
  'Alpha Phi',
  'Delta Phi Epsilon',
  'Kappa Alpha Theta',
  'Pi Beta Phi',
  'Sigma Kappa',
] as const;

/** Structural oracle. The chapter rosters and the private Google Sheet do
 * not expose a stable unauthenticated API; identity/content fidelity is
 * therefore confirmed by the standing human overlay. */
export interface MitSororitiesOracle {
  affiliations: typeof MIT_SORORITIES;
  classes: readonly [2026, 2027];
  minRows: number;
  maxRows: number;
  minMajorCoverage: number;
  minEnrichmentCoverage: number;
}

export async function fetchOracle(): Promise<MitSororitiesOracle> {
  return {
    affiliations: MIT_SORORITIES,
    classes: [2026, 2027],
    minRows: 12,
    maxRows: 400,
    minMajorCoverage: 0.5,
    minEnrichmentCoverage: 0.25,
  };
}
