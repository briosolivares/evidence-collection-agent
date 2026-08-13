export const MIT_SORORITIES = [
  'Alpha Chi Omega',
  'Alpha Phi',
  'Delta Phi Epsilon',
  'Kappa Alpha Theta',
  'Pi Beta Phi',
  'Sigma Kappa',
] as const;

/** A sorority/class cohort the live web does not source, so its absence
 * from the CSV must not fail the grade. */
export interface OptionalCohort {
  affiliation: (typeof MIT_SORORITIES)[number];
  classYear: number;
}

/** Structural oracle. The chapter rosters and the private Google Sheet do
 * not expose a stable unauthenticated API; identity/content fidelity is
 * therefore confirmed by the standing human overlay. */
export interface MitSororitiesOracle {
  affiliations: typeof MIT_SORORITIES;
  classes: readonly [2026, 2027];
  /** Cohorts the official sites do not publish (website answers are the
   * ground truth). Verified 2026-08-13: mit.pibetaphi.org/members lists
   * Class of 2027/2028/2029 tables only — no 2026 (senior) table — and
   * the Wayback Machine has no capture of the URL to consult a prior
   * version. An agent cannot source Pi Beta Phi seniors, so that cohort
   * is optional; re-check the live page before tightening this again. */
  optionalCohorts: readonly OptionalCohort[];
  minRows: number;
  maxRows: number;
  minMajorCoverage: number;
  minEnrichmentCoverage: number;
}

export async function fetchOracle(): Promise<MitSororitiesOracle> {
  return {
    affiliations: MIT_SORORITIES,
    classes: [2026, 2027],
    optionalCohorts: [{ affiliation: 'Pi Beta Phi', classYear: 2026 }],
    // One member per required cohort: 12 cohorts minus the optional one.
    minRows: 11,
    maxRows: 400,
    minMajorCoverage: 0.5,
    minEnrichmentCoverage: 0.25,
  };
}
