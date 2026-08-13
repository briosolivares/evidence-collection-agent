import { SCRATCH_DIR, writeArtifact } from '../run/artifacts.js';
import {
  serializeContractRevision,
  validateContractRevision,
  type ContractRevisionValidation,
  type OutputContract,
  type OutputContractRevision,
} from './outputContract.js';

// The run's contract history. One store per run, owned by the runtime — not
// by the model. Every accepted revision is persisted immediately and never
// edited or replaced, so the verifier can always see how the requirements
// moved between revision 1 and now, and a run directory alone explains what
// was promised at each point.
//
// The store deliberately does NOT decide policy: it does not know whether
// the worker or the initializer authored a revision, and it applies no
// judgment about whether a change is reasonable. It validates
// (validateContractRevision), assigns the next number, writes, and appends.
// Whether a weakened requirement is acceptable is the verifier's call, which
// is exactly why history is handed to it intact.

/** Run-dir subdirectory holding the contract history — agent-owned working
 * state, so it lives under scratch/ and carries no manifest role. */
export const CONTRACT_DIR = `${SCRATCH_DIR}/output-contract`;

/** The run-dir-relative path revision N is stored at. */
export function contractRevisionPath(revision: number): string {
  return `${CONTRACT_DIR}/revision-${revision}.json`;
}

/** One run's append-only contract history. */
export interface OutputContractStore {
  /**
   * Validate and persist a proposed revision.
   *
   * @param input - raw `set_output_contract` input exactly as the model sent
   *   it; never trusted
   * @returns the validation outcome. On `ok`, the revision has already been
   *   written to `scratch/output-contract/revision-<n>.json` through
   *   `writeArtifact()` (so the manifest records its hash) and appended to
   *   history. On failure, nothing was written and history is unchanged —
   *   a rejected contract leaves no trace to confuse the verifier
   */
  setOutputContract(input: unknown): ContractRevisionValidation;
  /** The latest accepted revision, or undefined before the first one. */
  currentRevision(): OutputContractRevision | undefined;
  /** The current contract, or undefined before the first revision. */
  currentContract(): OutputContract | undefined;
  /** Every accepted revision in order, oldest first. Copies: mutating the
   * returned array cannot corrupt the history the verifier will read. */
  contractHistory(): OutputContractRevision[];
  /** True once any revision has been accepted. The contract-first protocol
   * gate (T4.3) reads this to decide whether a worker response may execute
   * anything other than `set_output_contract`. */
  hasContract(): boolean;
}

/**
 * Create the run's contract store.
 *
 * @param runDir - absolute path to the run directory; its manifest must
 *   already be initialized (writeArtifact throws otherwise, and the
 *   rejected revision is not appended)
 */
export function createOutputContractStore(runDir: string): OutputContractStore {
  const history: OutputContractRevision[] = [];

  return {
    setOutputContract(input: unknown): ContractRevisionValidation {
      const result = validateContractRevision(input, history.length + 1);
      if (!result.ok) return result;

      // Persist before appending: if the write fails, history must not claim
      // a revision that has no stored bytes. writeArtifact throws, which
      // surfaces as a tool execution error rather than a silent acceptance.
      writeArtifact(
        runDir,
        contractRevisionPath(result.revision.revision),
        Buffer.from(serializeContractRevision(result.revision), 'utf8'),
      );
      history.push(result.revision);
      return result;
    },

    currentRevision: () => history.at(-1),
    currentContract: () => history.at(-1)?.contract,
    contractHistory: () => [...history],
    hasContract: () => history.length > 0,
  };
}
