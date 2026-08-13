import { setOutputContractInputSchema } from '../../contracts/outputContract.js';
import { contractRevisionPath } from '../../contracts/outputContractStore.js';
import type { ToolDef } from '../registry.js';

// The model's only way to state what the run must produce. Everything
// downstream — the code-based completion checks, the renderers, the
// verifier — reads the stored contract, never model prose, so this tool is
// the single narrow gate between "what the model thinks was asked" and
// "what the runtime will enforce".
//
// Two properties matter and are tested directly:
//
//  1. One schema, one validator, one stored form, whichever author ran. The
//     worker-authored and initializer-authored policies differ only in WHO
//     calls this tool, never in what validation or storage happens — so a
//     comparison between the two modes measures the authoring decision and
//     nothing else.
//  2. Rejection is informative and total. A rejected call reports every
//     problem at once (see validateContractRevision) and writes nothing, so
//     one follow-up call can fix the whole contract and a rejected attempt
//     leaves no partial state behind.

/** The result a successful call returns to the model. */
export interface SetOutputContractResult {
  /** The revision number just accepted (1-based). */
  revision: number;
  /** Where the run stored it, for the model's own reference. */
  storedAt: string;
  /** Ids of the outputs this contract now requires, in contract order —
   * echoed back so the model can see exactly which ids later tool calls
   * must use. */
  outputIds: string[];
}

/**
 * `set_output_contract`: state (or revise) the run's output contract.
 *
 * Not read-only — it advances run state that every later check depends on,
 * so the scheduler must serialize it against everything else.
 *
 * @returns the accepted revision summary (see SetOutputContractResult).
 *   Throws on a validation failure with every problem named, and on a
 *   missing contract store (a registry misconfiguration, not something the
 *   model can fix); the pipeline converts either into a structured error
 *   result the model reads and retries against
 */
export const setOutputContractTool: ToolDef<
  import('../../contracts/outputContract.js').SetOutputContractInput
> = {
  name: 'set_output_contract',
  description:
    'State exactly what this run must produce, as a validated contract: every required ' +
    'output file or capture, its format, its exact columns or required sections, and the ' +
    'checkable rules that apply. Call this FIRST, before any other tool. The runtime ' +
    'enforces this contract with code and shows it to the verifier, so it must describe ' +
    'the finished deliverables only — never a research plan or browsing steps. Revise it ' +
    'later only when evidence, a corrected assumption, or the user requires it, supplying ' +
    'revisionBasis; the full history is kept and reviewed.',
  inputSchema: setOutputContractInputSchema,
  readOnly: false,
  execute: (input, ctx): SetOutputContractResult => {
    const store = ctx.outputContracts;
    if (store === undefined) {
      // A registry offering this tool without a store is a wiring bug. Fail
      // loudly rather than accept a contract nothing will ever enforce.
      throw new Error(
        'set_output_contract is unavailable: this run has no output-contract store.',
      );
    }

    const result = store.setOutputContract(input);
    if (!result.ok) {
      // Every problem in one message: the model should need exactly one
      // follow-up call, not a round trip per defect.
      throw new Error(
        `The output contract was rejected and NOT stored. Fix all of these and call ` +
          `set_output_contract again:\n${result.errors.map((error) => `- ${error}`).join('\n')}`,
      );
    }

    return {
      revision: result.revision.revision,
      storedAt: contractRevisionPath(result.revision.revision),
      outputIds: result.revision.contract.outputs.map((output) => output.id),
    };
  },
};
