// Same ground truth as mit_sororities — the research is identical, only the
// deliverable differs. Re-exported rather than copied so the two tasks can
// never drift into disagreeing about which cohorts the web actually sources.
export { fetchOracle, MIT_SORORITIES } from '../../mit_sororities/oracle/oracle.js';
export type { MitSororitiesOracle, OptionalCohort } from '../../mit_sororities/oracle/oracle.js';
