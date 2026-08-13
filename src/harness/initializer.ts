import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { AssistantContentBlock, CallModel, Message, TextBlock } from '../loop/messages.js';
import { SET_OUTPUT_CONTRACT } from '../contracts/contractFirstGate.js';
import type { OutputContractStore } from '../contracts/outputContractStore.js';
import { makeCallModel, type ProgressEvent } from '../model/callModel.js';
import { setOutputContractTool } from '../tools/setOutputContract/setOutputContract.js';
import { createRegistry, toApiToolDefs, type ToolDef } from '../tools/registry.js';

// The initializer is the harness's first role (see
// .agents/planning/2026-08-12-research-quality-harness/judge-design.md): from
// the user's task text alone — no browser, no tools, no evidence collection
// — it writes the run's two governing documents, INTENT.md and CONTRACT.md,
// at the run-dir root. The worker reads them at run start and consults the
// contract while producing output; the judge reads them (plus the worker's
// evidence) to verify the worker's proposed completion. A run that starts
// without a usable contract must fail loudly rather than silently proceed
// judge-less — see runInitializer's throw on the second malformed response
// — so this module has no best-effort fallback path.

/** Model the initializer runs on. Sonnet tier: turning task prose into an
 * exhaustive, precisely-worded contract is worth the larger model even
 * though the call itself is small and one-shot (plus at most one retry). */
export const INITIALIZER_MODEL = 'claude-sonnet-5';

/** Filename of the intent document at the run-dir root (initializer-owned,
 * read-only to the worker — see judge-design.md's durable-workspace table). */
export const INTENT_FILENAME = 'INTENT.md';

/** Filename of the contract document at the run-dir root (initializer-owned,
 * read-only to the worker — see judge-design.md's durable-workspace table). */
export const CONTRACT_FILENAME = 'CONTRACT.md';

/** The exact top-level header introducing the INTENT section. Matched
 * verbatim (after trimming the line) when parsing a response. */
const INTENT_HEADER = '# INTENT';

/** The exact top-level header introducing the CONTRACT section. Matched
 * verbatim (after trimming the line) when parsing a response. */
const CONTRACT_HEADER = '# CONTRACT';

/**
 * Dedicated system prompt for the initializer's call. Deliberately generic
 * protocol only: per the design's eval-integrity guardrail (judge-design.md,
 * "Eval integrity" — nobody inside a run sees oracles or graders), nothing
 * here may name a specific task, website, dataset, or grading method. The
 * same prompt runs unchanged across every task, hidden or not.
 */
export const INITIALIZER_SYSTEM_PROMPT = `You are the initializer for an evidence-collection agent run. You see only the user's task text below — you have no browser and you collect no evidence yourself. From that text alone, produce the run's two governing documents.

Respond with exactly two top-level sections, in this order, and nothing else at the top level: a line reading exactly "# INTENT" followed by its body, then a line reading exactly "# CONTRACT" followed by its body. Do not add any other top-level heading, preamble before the first header, or closing remark after the last section.

Under "# INTENT", state the user's goal in your own words, the constraints they specified (scope, sources, exclusions, time bounds, or anything else they required), and any non-goals — things a literal reading of the task text might suggest but the user did not actually ask for. This section orients whoever reads it toward what the user wants, without inventing intent the text does not support.

Under "# CONTRACT", list every objectively checkable acceptance criterion you can derive from the task text: the exact output structure (files, sections, rows), the exact columns or fields and their order, field-level rules (for example, an enum-like value must be copied verbatim from the source with nothing added, omitted, or normalized), required formats and units, counts, and any other structural constraint the task states or clearly implies. Do not invent criteria the task text does not support, and do not soften or generalize a criterion the text states precisely — copy exact wording (column names, value sets, formats) verbatim into the contract. For EVERY criterion, also state how the finished run must prove it: what a reviewer would need to find in the run's published artifacts to confirm that criterion was met (for example, a specific file existing with a specific structure, a field's value matching an enumerated set, a count matching a stated number). A criterion without a stated proof requirement is incomplete — always pair the two.

Never mention any specific website, task family, dataset, grading method, or oracle, and never rely on outside knowledge of how such tasks are usually graded. This prompt is generic protocol, reused unchanged across all tasks; base the contract only on what this task's text says.`;

/** The two governing documents the initializer produces: the parsed,
 * trimmed, non-empty body of each section. Neither field carries the
 * section's header line. */
export interface InitializerResult {
  /** Body of the "# INTENT" section: goal, constraints, non-goals. */
  intent: string;
  /** Body of the "# CONTRACT" section: checkable criteria, each paired with
   * how the finished run must prove it. */
  contract: string;
}

/** A response that parsed cleanly into both sections. */
interface ParseSuccess {
  ok: true;
  intent: string;
  contract: string;
}

/** A response that failed to parse, with a human-readable reason naming
 * exactly what was wrong — fed verbatim into the corrective follow-up. */
interface ParseFailure {
  ok: false;
  reason: string;
}

type ParseOutcome = ParseSuccess | ParseFailure;

/**
 * Parse a model response's text into the two sections.
 *
 * @param text - the response's joined text blocks (see extractText)
 * @returns ok:true with both bodies trimmed and non-empty, or ok:false with
 *   a reason naming the first problem found, checked in this order: the
 *   "# INTENT" header is missing; the "# CONTRACT" header is missing (or
 *   appears at or before "# INTENT"); the INTENT body is empty; the
 *   CONTRACT body is empty. Header lines are matched exactly after
 *   trimming surrounding whitespace; everything strictly between the two
 *   header lines is the INTENT body, and everything strictly after the
 *   CONTRACT header line is the CONTRACT body (to end of text).
 */
function parseSections(text: string): ParseOutcome {
  const lines = text.split('\n');
  const intentIndex = lines.findIndex((line) => line.trim() === INTENT_HEADER);
  if (intentIndex === -1) {
    return { ok: false, reason: `the response is missing the "${INTENT_HEADER}" header` };
  }
  const contractIndex = lines.findIndex(
    (line, index) => index > intentIndex && line.trim() === CONTRACT_HEADER,
  );
  if (contractIndex === -1) {
    return {
      ok: false,
      reason: `the response is missing the "${CONTRACT_HEADER}" header after "${INTENT_HEADER}"`,
    };
  }

  const intent = lines.slice(intentIndex + 1, contractIndex).join('\n').trim();
  const contract = lines.slice(contractIndex + 1).join('\n').trim();

  if (intent.length === 0) {
    return { ok: false, reason: `the "${INTENT_HEADER}" section body is empty` };
  }
  if (contract.length === 0) {
    return { ok: false, reason: `the "${CONTRACT_HEADER}" section body is empty` };
  }
  return { ok: true, intent, contract };
}

/**
 * A response's prose: its text blocks joined with newlines ("" if none).
 * Deliberately duplicated from agentLoop.ts's private extractText (not
 * exported there, and this module has no other reason to import from the
 * loop) — same one-line contract, kept in sync by inspection since neither
 * side is expected to change.
 */
function extractText(content: readonly AssistantContentBlock[]): string {
  return content
    .filter((block): block is TextBlock => block.type === 'text')
    .map((block) => block.text)
    .join('\n');
}

/**
 * Build the corrective follow-up user message sent after a malformed
 * response: states exactly what was wrong (per ParseFailure.reason) and
 * re-asks for the two sections, so the model gets one concrete, actionable
 * chance to fix it rather than a generic "try again".
 */
function correctiveMessage(reason: string): Message {
  return {
    role: 'user',
    content: [
      {
        type: 'text',
        text: `Your previous response was malformed: ${reason}. Respond again with exactly two top-level sections and nothing else: a line reading exactly "${INTENT_HEADER}" followed by its (non-empty) body, then a line reading exactly "${CONTRACT_HEADER}" followed by its (non-empty) body.`,
      },
    ],
  };
}

/**
 * Run the initializer: one call to derive INTENT.md and CONTRACT.md from
 * the task text alone.
 *
 * @param taskText - the user's task, sent as the sole content of the
 *   conversation's first (and only, absent a retry) user message — no
 *   system framing beyond `callModel`'s bound system prompt
 * @param callModel - the initializer's bound model call (see
 *   makeInitializerCallModel for the production binding); a scripted fake
 *   drops in unchanged for tests, matching every other CallModel consumer
 *   in this codebase
 * @returns the parsed, trimmed, non-empty INTENT and CONTRACT bodies
 * @throws if the response is still malformed after one corrective
 *   follow-up (see parseSections for what counts as malformed) — named
 *   with the specific problem found on the second attempt. A run without a
 *   contract must fail loudly here rather than let the harness silently
 *   degrade to judge-less behavior.
 */
export async function runInitializer(
  taskText: string,
  callModel: CallModel,
): Promise<InitializerResult> {
  const messages: Message[] = [{ role: 'user', content: [{ type: 'text', text: taskText }] }];

  const firstResponse = await callModel(messages);
  const firstOutcome = parseSections(extractText(firstResponse.content));
  if (firstOutcome.ok) {
    return { intent: firstOutcome.intent, contract: firstOutcome.contract };
  }

  // One corrective retry: replay the malformed assistant response, then
  // name exactly what was wrong and re-ask — same shape as the loop's own
  // tool_result feedback, just for a parsing failure instead of a tool error.
  messages.push({ role: 'assistant', content: firstResponse.content });
  messages.push(correctiveMessage(firstOutcome.reason));

  const secondResponse = await callModel(messages);
  const secondOutcome = parseSections(extractText(secondResponse.content));
  if (secondOutcome.ok) {
    return { intent: secondOutcome.intent, contract: secondOutcome.contract };
  }

  throw new Error(
    `Initializer failed after one corrective retry: ${secondOutcome.reason}. A run without a contract must not proceed judge-less.`,
  );
}

/**
 * Write the initializer's output to the run-dir root, synchronously.
 *
 * @param runDir - absolute path to the run directory; must already exist
 * @param result - the parsed INTENT and CONTRACT bodies (see
 *   runInitializer)
 * @returns nothing; writes `<runDir>/INTENT.md` and `<runDir>/CONTRACT.md`
 *   (each body plus one trailing newline) directly with `writeFileSync` —
 *   at the run-dir root, never under `artifacts/` or `scratch/`, so the
 *   existing role enforcement (which governs only those two subtrees)
 *   leaves both files writable by the harness and read-only to the worker's
 *   tools for free (see judge-design.md's durable-workspace table)
 */
export function writeInitializerFiles(runDir: string, result: InitializerResult): void {
  writeFileSync(join(runDir, INTENT_FILENAME), `${result.intent}\n`, 'utf8');
  writeFileSync(join(runDir, CONTRACT_FILENAME), `${result.contract}\n`, 'utf8');
}

/** Config for the production initializer CallModel: only what the caller
 * may reasonably want to override (see makeInitializerCallModel). */
export interface InitializerCallModelConfig {
  /** max_tokens for the initializer's response; defaults to 4096, ample for
   * an intent/contract pair derived from task text. */
  maxOutputTokens?: number;
  /** Optional live-progress callback, forwarded to makeCallModel unchanged
   * (see ProgressEvent) — lets interactive surfaces show the initializer's
   * single turn the same way they show worker turns. */
  onProgress?: (event: ProgressEvent) => void;
}

/**
 * Build the production initializer CallModel.
 *
 * @param config - see InitializerCallModelConfig
 * @returns a CallModel bound to INITIALIZER_MODEL and
 *   INITIALIZER_SYSTEM_PROMPT via makeCallModel, with an empty
 *   `apiToolDefs` array: the initializer never calls tools, so its prompt
 *   prefix carries no tool definitions at all (an empty array is a
 *   structurally valid `ApiToolDef[]` and `makeCallModel`/`buildRequestParams`
 *   place no minimum on it — they simply map it into the request's `tools`
 *   field, which the Anthropic SDK types as an optional, unconstrained
 *   array)
 */
export function makeInitializerCallModel(config: InitializerCallModelConfig): CallModel {
  return makeCallModel({
    model: INITIALIZER_MODEL,
    system: INITIALIZER_SYSTEM_PROMPT,
    apiToolDefs: [],
    maxOutputTokens: config.maxOutputTokens ?? 4096,
    onProgress: config.onProgress,
  });
}

// --- T4: contract-authoring initializer -------------------------------------
//
// The initializer's V2 role. Instead of writing prose INTENT.md/CONTRACT.md
// for something downstream to re-parse, it makes exactly one
// `set_output_contract` call against the run's contract store — the same
// tool, schema, validator, and stored bytes the worker-authored mode uses.
// That symmetry is the point: a comparison between the two modes measures
// the authoring decision and nothing else, and no code downstream can tell
// which one ran.

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
    messages.push({
      role: 'user',
      content: [
        {
          type: 'text',
          text: `${problem}\n\nRespond again with a single valid ${SET_OUTPUT_CONTRACT} call.`,
        },
      ],
    });
  }

  // Unreachable: the loop returns on every path of both attempts.
  return { ok: false, reason: 'contract initializer ended without an outcome' };
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
  });
}
