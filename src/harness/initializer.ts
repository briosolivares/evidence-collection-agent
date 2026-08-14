import type { CallModel, Message } from '../loop/messages.js';
import { SET_OUTPUT_CONTRACT } from '../contracts/contractFirstGate.js';
import type { OutputContractStore } from '../contracts/outputContractStore.js';
import { makeCallModel, type CallModelConfig, type ProgressEvent } from '../model/callModel.js';
import { setOutputContractTool } from '../tools/setOutputContract/setOutputContract.js';
import { createRegistry, toApiToolDefs, type ToolDef } from '../tools/registry.js';

// The initializer is the harness's first role (see
// .agents/planning/2026-08-12-research-quality-harness/judge-design.md): from
// the user's task text alone — no browser, no tools, no evidence collection
// — it states the run's typed output contract via a single forced
// `set_output_contract` call (see runContractInitializer below). The worker
// reads the accepted contract at run start; the verifier reads it (plus the
// worker's evidence) to verify the worker's submission. A run that starts
// without a usable contract must fail loudly rather than silently proceed —
// see runContractInitializer's `ok: false` outcome on a second bad
// response — so this module has no best-effort fallback path.
//
// A prose INTENT.md/CONTRACT.md authoring mode used to live here too, before
// the typed contract protocol became the run's only completion protocol; it
// is gone, along with the judge-less path it served. INTENT_FILENAME and
// CONTRACT_FILENAME survive below only because src/harness/verifierTools.ts
// still names them as a fallback source for a verifier opening message when
// no typed contract is supplied — a path this codebase's own production
// caller (runTask.ts) no longer takes, since it always supplies one.

/** Model the initializer runs on. Sonnet tier: turning task prose into an
 * exhaustive, precisely-worded contract is worth the larger model even
 * though the call itself is small and one-shot (plus at most one retry). */
export const INITIALIZER_MODEL = 'claude-sonnet-5';

/** Filename of the intent document at the run-dir root. No longer written by
 * this module (see the module comment); kept only because
 * harness/verifierTools.ts still reads it on its no-typed-contract fallback
 * path. */
export const INTENT_FILENAME = 'INTENT.md';

/** Filename of the contract document at the run-dir root. Same status as
 * INTENT_FILENAME above. */
export const CONTRACT_FILENAME = 'CONTRACT.md';

/** Config for the production initializer CallModel: only what the caller
 * may reasonably want to override (see makeContractInitializerModelDriver). */
export interface InitializerCallModelConfig {
  /** max_tokens for the initializer's response; defaults to 4096, ample for
   * a one-shot set_output_contract call. */
  maxOutputTokens?: number;
  /** Optional live-progress callback, forwarded to makeCallModel unchanged
   * (see ProgressEvent) — lets interactive surfaces show the initializer's
   * single turn the same way they show worker turns. */
  onProgress?: (event: ProgressEvent) => void;
  /**
   * Stream factory seam, forwarded to makeCallModel unchanged.
   *
   * Exists so a test can assert what these bindings actually PUT ON THE WIRE.
   * Without it the only testable claim is that re-deriving the same constants
   * yields the same params, which stays true even when the binding itself is
   * wrong — and a binding offering the wrong tools is precisely the failure
   * that reached a live run.
   */
  createStream?: CallModelConfig['createStream'];
  /**
   * Cancellation, forwarded to makeCallModel unchanged.
   *
   * Without this, aborting a run could not reach an in-flight initializer
   * request — only tool execution and the worker's own client would ever
   * see it — and, more subtly, a `createStream` test fixture written to
   * settle only once it observes the signal (e.g. rejecting on 'abort')
   * would hang forever here, since it would always be called with
   * `signal: undefined`.
   */
  signal?: CallModelConfig['signal'];
}

// --- The contract-authoring initializer -------------------------------------
//
// The initializer's only role: it makes exactly one `set_output_contract`
// call against the run's contract store — the same tool, schema, validator,
// and stored bytes a worker-authored contract uses. That symmetry is the
// point: a comparison between the two authoring choices (see ContractAuthor
// below) measures the authoring decision and nothing else, and no code
// downstream can tell which one ran.

/** Which role states the run's output contract. Preserved as a
 * configuration choice, not an architectural fork: both modes feed the same
 * store, the same code checks, and the same verifier. */
export type ContractAuthor = 'worker' | 'initializer';

/** System prompt for the contract-authoring initializer. Deliberately
 * generic protocol only — it must never name a task, site, or dataset. */
export const CONTRACT_INITIALIZER_SYSTEM_PROMPT = `You derive one output contract from a task description, before any browsing happens.

Your only job is to call set_output_contract exactly once, stating precisely what the finished run must contain: every required output file or capture, its format, its exact columns or required sections in the order the task implies, and the checkable rules that follow from the request.

Rules:
- Describe the END STATE only. Never include a research plan, browsing steps, preferred sites, or how the work should be carried out.
- Copy exact column headers, filenames, formats, and enumerated values from the task wherever it states them. Do not rename or "improve" them.
- State a row count only when the task itself fixes one. If the task implies a population whose size is unknown until the run looks, use a minimum the task clearly supports, or state no count rule at all.
- When the task itself names the entities to cover, add a matches_expected_values rule listing them and set exhaustive: true. That makes them the complete set of rows, so code — not a reviewer — catches both a missing entity and an invented one. Leave exhaustive off when the task names only examples, or when the population is whatever the run finds.
- Put requirements that need judgment in contentExpectations. Put choices you had to make that materially change the result in assumptions.
- Do not invent outputs the task did not ask for.

Respond with the set_output_contract call and nothing else.`;

/** How the contract initializer finished. */
export type ContractInitializerOutcome =
  | { ok: true; revision: number }
  | { ok: false; reason: string };

/**
 * Run the contract-authoring initializer: one forced `set_output_contract`
 * call, validated and persisted through the run's store.
 *
 * @param taskText - the user's task, the sole content of the opening message
 * @param callModel - the initializer's bound model call (see
 *   makeContractInitializerModelDriver); a scripted fake drops in unchanged
 * @param store - the run's contract store; the accepted revision is
 *   persisted here exactly as a worker-authored one would be
 * @returns `ok` with the accepted revision number, or the reason it failed.
 *   One bounded repair is allowed: a response carrying no contract call, or
 *   one the validator rejected, is re-asked once with the exact problem
 *   named. A second failure returns `ok: false` — a run whose requirements
 *   were never validated must not proceed as if they had been
 */
export async function runContractInitializer(
  taskText: string,
  callModel: CallModel,
  store: OutputContractStore,
): Promise<ContractInitializerOutcome> {
  const messages: Message[] = [{ role: 'user', content: [{ type: 'text', text: taskText }] }];

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const response = await callModel(messages);
    messages.push({ role: 'assistant', content: response.content });

    const calls = response.content.filter(
      (block): block is Extract<typeof block, { type: 'tool_use' }> =>
        block.type === 'tool_use',
    );
    const contractCalls = calls.filter((call) => call.name === SET_OUTPUT_CONTRACT);

    let problem: string;
    if (contractCalls.length === 0) {
      problem = `Your response made no ${SET_OUTPUT_CONTRACT} call. Prose is not read.`;
    } else if (contractCalls.length > 1 || calls.length > 1) {
      problem = `Respond with exactly one ${SET_OUTPUT_CONTRACT} call and no other tool calls.`;
    } else {
      const result = store.setOutputContract(contractCalls[0]!.input);
      if (result.ok) return { ok: true, revision: result.revision.revision };
      problem =
        'The contract was rejected and NOT stored. Fix all of these:\n' +
        result.errors.map((error) => `- ${error}`).join('\n');
    }

    if (attempt === 2) return { ok: false, reason: problem };
    messages.push(contractCorrectionMessage(problem, calls));
  }

  // Unreachable: the loop returns on every path of both attempts.
  return { ok: false, reason: 'contract initializer ended without an outcome' };
}

/**
 * Build the corrective user turn that answers a rejected contract attempt.
 *
 * Every replayed `tool_use` MUST be answered by a `tool_result` carrying its
 * id: the API rejects a conversation whose tool_use is followed by anything
 * else with a 400, and the assistant turn has already been replayed by the
 * time we know the contract was bad. Delivering the problem as plain text
 * instead is what took the retry down in a live run — the first attempt's
 * rejection was recoverable, and the recovery itself was the fatal error.
 *
 * A response with no tool_use at all (possible only if tool choice was not
 * forced) takes plain text, which is then the correct shape.
 */
function contractCorrectionMessage(
  problem: string,
  calls: readonly { id: string }[],
): Message {
  const instruction = `${problem}\n\nRespond again with a single valid ${SET_OUTPUT_CONTRACT} call.`;
  if (calls.length === 0) {
    return { role: 'user', content: [{ type: 'text', text: instruction }] };
  }
  return {
    role: 'user',
    content: [
      // One result per call, in order, so no id is left unanswered even when
      // the problem was that the model made too many calls.
      ...calls.map((call) => ({
        type: 'tool_result' as const,
        tool_use_id: call.id,
        content: problem,
        is_error: true,
      })),
      { type: 'text' as const, text: instruction },
    ],
  };
}

/**
 * Build the production contract-initializer model binding: offered ONLY the
 * `set_output_contract` tool, with tool choice forced to it, so the single
 * call is the response's structural obligation rather than a request the
 * model may narrate its way around.
 */
export function makeContractInitializerModelDriver(
  config: InitializerCallModelConfig = {},
): CallModel {
  return makeCallModel({
    model: INITIALIZER_MODEL,
    system: CONTRACT_INITIALIZER_SYSTEM_PROMPT,
    apiToolDefs: toApiToolDefs(createRegistry([setOutputContractTool as ToolDef])),
    toolChoice: { type: 'tool', name: SET_OUTPUT_CONTRACT },
    maxOutputTokens: config.maxOutputTokens ?? 4096,
    onProgress: config.onProgress,
    ...(config.createStream === undefined ? {} : { createStream: config.createStream }),
    ...(config.signal === undefined ? {} : { signal: config.signal }),
  });
}
