import type Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';

import {
  outputContractSchema,
  validateOutputContract,
  type OutputContract,
} from '../../contracts/outputContract.js';
import type { CallModel, Message, ToolUseBlock } from '../../loop/messages.js';
import {
  createAnthropicModelDriver,
  isModelResponseRejectedError,
  isProtocolCorrectableRejection,
  type ModelDriver,
  type ModelDriverConfig,
} from '../../model/modelDriver.js';
import {
  createRegistry,
  toApiToolDefs,
  type ApiToolDef,
  type ToolDef,
} from '../../tools/registry.js';

export const V3_INITIALIZER_MODEL = 'claude-sonnet-5';
export const V3_INITIALIZER_MAX_ATTEMPTS = 2;
const SET_OUTPUT_CONTRACT = 'set_output_contract';

/** Static contract-only instructions. Task and checkpoint facts stay in the
 * conversation so this prefix remains byte-stable across runs. */
export const V3_CONTRACT_INITIALIZER_SYSTEM_PROMPT = `You derive one immutable output contract from a task description before any browsing happens.

Your only job is to call set_output_contract exactly once with a thin projection of requirements explicitly stated in the user's request: requested artifacts and formats, exact columns and ordering, explicit counts, requested scope, and explicit evidence requirements.

Rules:
- Describe the END STATE only. Never include a research plan, browsing steps, preferred sites, or how the work should be carried out.
- Copy exact column headers, filenames, formats, sections, and counts only where the request states them. Do not rename, improve, or infer them.
- State count, uniqueness, required-cell, type, enum, source, and evidence constraints only when the request explicitly states them. Unknown research populations do not imply a count or identity rule.
- When the request explicitly enumerates a value set (for example specific organizations, categories, or class years), declare the matching column as type enum with exactly that allowed set, and put required coverage of the enumerated values in contentExpectations for the judge to assess as covered or credibly blocked. Never emit a matches_expected_values rule for an enumerated set: it must not become a deterministic presence gate, or a truthful partial result becomes structurally impossible.
- Put explicitly requested scope and other judgment requirements in contentExpectations so the judge can assess them against surfaced evidence.
- When the request explicitly asks to create, update, or submit something on an external service (for example a Google Sheets spreadsheet, a submitted form, a posted message), declare an external_action output: copy the requested action verbatim into description, and set proof.sourceUrlPattern to the destination's URL pattern (with a proof screenshot count and mustShow when visible confirmation is the natural evidence). A local table or document output never substitutes for a requested external destination; add one only if the request also asks for a file.
- If the request explicitly asks for a deliverable that no output kind can express, preserve that requirement verbatim in contentExpectations. Never silently narrow a requested deliverable to the nearest expressible output.
- Do not add assumptions, inferred expected-value sets or entity lists, availability claims, domain heuristics, or requirements that merely seem desirable.
- Do not invent outputs the task did not ask for. V3 accepts one immutable initial contract.
- The original user request remains authoritative if this projection is incomplete or conflicts with it.

Respond with the set_output_contract call and nothing else.`;

const v3InitializerOutputContractSchema = outputContractSchema.omit({
  assumptions: true,
});

const v3SetOutputContractInputSchema = z.strictObject({
  contract: v3InitializerOutputContractSchema,
});

/** Initializer-only definition for the run's one immutable contract. */
const v3SetOutputContractTool: ToolDef<{ contract: OutputContract }> = {
  name: SET_OUTPUT_CONTRACT,
  description:
    'Return the one immutable typed output contract for this run. Describe only the ' +
    'explicitly requested artifacts, exact shapes, counts, scope, and evidence needs. This ' +
    'contract is accepted once before work begins and is final after acceptance.',
  inputSchema: v3SetOutputContractInputSchema,
  getAccess: () => ({ reads: [], writes: [], exclusive: true }),
  execute() {
    throw new Error('the v3 initializer result is intercepted and never executed');
  },
};

export const V3_CONTRACT_INITIALIZER_API_TOOL_DEFS: readonly ApiToolDef[] =
  deepFreeze(
    toApiToolDefs(
      createRegistry([v3SetOutputContractTool as ToolDef]),
    ),
  );

export interface V3ContractInitializerModelConfig {
  model?: string;
  maxOutputTokens?: number;
  maxTokensRetryOutputTokens?: number;
  createStream?: ModelDriverConfig['createStream'];
}

export function createV3ContractInitializerModelDriver(
  config: V3ContractInitializerModelConfig = {},
): ModelDriver {
  return createAnthropicModelDriver({
    model: config.model ?? V3_INITIALIZER_MODEL,
    system: V3_CONTRACT_INITIALIZER_SYSTEM_PROMPT,
    apiToolDefs: V3_CONTRACT_INITIALIZER_API_TOOL_DEFS,
    maxOutputTokens: config.maxOutputTokens ?? 4_096,
    maxToolCallsPerTurn: 1,
    toolChoice: {
      type: 'tool',
      name: SET_OUTPUT_CONTRACT,
    } satisfies Anthropic.Messages.ToolChoice,
    ...(config.maxTokensRetryOutputTokens === undefined
      ? {}
      : { maxTokensRetryOutputTokens: config.maxTokensRetryOutputTokens }),
    ...(config.createStream === undefined
      ? {}
      : { createStream: config.createStream }),
  });
}

export interface V3ContractInitializerState {
  messages: Message[];
  attempts: number;
  lastProblem?: string;
}

export interface V3ContractInitializerHooks {
  beforeRequest?(state: V3ContractInitializerState): Promise<void>;
  afterAttempt?(event: {
    state: V3ContractInitializerState;
    outcome: 'correction' | 'accepted' | 'failed';
    contract?: OutputContract;
  }): Promise<void>;
}

export type V3ContractInitializerOutcome =
  | { ok: true; contract: OutputContract }
  | { ok: false; reason: string };

export function createV3ContractInitializerState(
  taskText: string,
): V3ContractInitializerState {
  return {
    messages: [
      { role: 'user', content: [{ type: 'text', text: taskText }] },
    ],
    attempts: 0,
  };
}

export function captureV3ContractInitializerState(
  state: V3ContractInitializerState,
): V3ContractInitializerState {
  return structuredClone(state);
}

export function restoreV3ContractInitializerState(
  snapshot: V3ContractInitializerState,
): V3ContractInitializerState {
  if (
    !Number.isInteger(snapshot.attempts) ||
    snapshot.attempts < 0 ||
    snapshot.attempts > V3_INITIALIZER_MAX_ATTEMPTS
  ) {
    throw new Error(
      `initializer attempts must be an integer from 0 to ${V3_INITIALIZER_MAX_ATTEMPTS}`,
    );
  }
  if (snapshot.messages.length === 0) {
    throw new Error('initializer messages must contain the original task');
  }
  if (
    snapshot.lastProblem !== undefined &&
    snapshot.lastProblem.trim().length === 0
  ) {
    throw new Error('initializer lastProblem must be nonblank when present');
  }
  return structuredClone(snapshot);
}

/** Run or resume the bounded contract initializer. Accepted contract bytes
 * live only in the returned value/checkpoint; no worker-visible mutable
 * contract store is created. */
export async function runV3ContractInitializer(
  state: V3ContractInitializerState,
  callModel: CallModel,
  hooks: V3ContractInitializerHooks = {},
): Promise<V3ContractInitializerOutcome> {
  if (state.attempts >= V3_INITIALIZER_MAX_ATTEMPTS) {
    return {
      ok: false,
      reason:
        state.lastProblem ??
        'contract initializer exhausted its attempts without an accepted contract',
    };
  }

  while (state.attempts < V3_INITIALIZER_MAX_ATTEMPTS) {
    await hooks.beforeRequest?.(captureV3ContractInitializerState(state));

    let response;
    try {
      response = await callModel(state.messages);
    } catch (error) {
      if (
        isModelResponseRejectedError(error) &&
        isProtocolCorrectableRejection(error.reason)
      ) {
        state.attempts += 1;
        state.lastProblem = error.protocolFeedback;
        if (state.attempts < V3_INITIALIZER_MAX_ATTEMPTS) {
          state.messages.push({
            role: 'user',
            content: [{ type: 'text', text: error.protocolFeedback }],
          });
          await hooks.afterAttempt?.({
            state: captureV3ContractInitializerState(state),
            outcome: 'correction',
          });
          continue;
        }
        await hooks.afterAttempt?.({
          state: captureV3ContractInitializerState(state),
          outcome: 'failed',
        });
        return { ok: false, reason: error.protocolFeedback };
      }
      throw error;
    }

    state.attempts += 1;
    state.messages.push({
      role: 'assistant',
      content: structuredClone(response.content),
    });
    const calls = response.content.filter(
      (block): block is ToolUseBlock => block.type === 'tool_use',
    );
    const contractCalls = calls.filter(
      (call) => call.name === SET_OUTPUT_CONTRACT,
    );

    let problem: string;
    if (contractCalls.length === 0) {
      problem = `Your response made no ${SET_OUTPUT_CONTRACT} call. Prose is not read.`;
    } else if (contractCalls.length > 1 || calls.length > 1) {
      problem =
        `Respond with exactly one ${SET_OUTPUT_CONTRACT} call and no other tool calls.`;
    } else {
      const validation = validateInitialContractCall(contractCalls[0]!.input);
      if (validation.ok) {
        const contract = validation.contract;
        delete state.lastProblem;
        await hooks.afterAttempt?.({
          state: captureV3ContractInitializerState(state),
          outcome: 'accepted',
          contract: structuredClone(contract),
        });
        return { ok: true, contract };
      }
      problem =
        'The contract was rejected and was not stored. Fix all of these:\n' +
        validation.errors.map((message) => `- ${message}`).join('\n');
    }

    state.lastProblem = problem;
    if (state.attempts >= V3_INITIALIZER_MAX_ATTEMPTS) {
      await hooks.afterAttempt?.({
        state: captureV3ContractInitializerState(state),
        outcome: 'failed',
      });
      return { ok: false, reason: problem };
    }

    state.messages.push(contractCorrectionMessage(problem, calls));
    await hooks.afterAttempt?.({
      state: captureV3ContractInitializerState(state),
      outcome: 'correction',
    });
  }

  return {
    ok: false,
    reason: state.lastProblem ?? 'contract initializer ended without an outcome',
  };
}

/** Per-run immutable guidance appended after the user's task in the worker's
 * opening message. */
export function formatV3ContractGuidance(contract: OutputContract): string {
  const parsed = outputContractSchema.parse(contract);
  return [
    '# Immutable output contract',
    'The initializer produced this immutable projection of the user request.',
    'The original user request is authoritative if this projection omits or conflicts with it.',
    'Preserve its explicitly requested filenames, shapes, counts, scope, and evidence requirements.',
    '```json',
    JSON.stringify(parsed, null, 2),
    '```',
  ].join('\n');
}

function contractCorrectionMessage(
  problem: string,
  calls: readonly ToolUseBlock[],
): Message {
  const instruction =
    `${problem}\n\nRespond again with a single valid ${SET_OUTPUT_CONTRACT} call.`;
  if (calls.length === 0) {
    return { role: 'user', content: [{ type: 'text', text: instruction }] };
  }
  return {
    role: 'user',
    content: [
      ...calls.map((call) => ({
        type: 'tool_result' as const,
        tool_use_id: call.id,
        content: problem,
        is_error: true,
      })),
      { type: 'text', text: instruction },
    ],
  };
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}

function validateInitialContractCall(
  input: unknown,
): ReturnType<typeof validateOutputContract> {
  const parsed = v3SetOutputContractInputSchema.safeParse(input);
  if (parsed.success) {
    const validation = validateOutputContract(parsed.data.contract);
    if (!validation.ok) return validation;

    // A matches_expected_values rule is a deterministic presence gate: it
    // demands every expected value literally appear, which makes a truthful
    // partial result structurally impossible when a source is unreachable.
    // New contracts express an enumerated set as an enum column (fabrication
    // and shape) plus contentExpectations scope (verifier-judged coverage).
    const presenceGateRules = validation.contract.outputs.flatMap((output) =>
      output.kind === 'table'
        ? output.rules.filter((rule) => rule.type === 'matches_expected_values')
        : [],
    );
    if (presenceGateRules.length > 0) {
      return {
        ok: false,
        errors: [
          'matches_expected_values rules are not allowed in a newly initialized contract: ' +
            'enumerated sets must be declared as enum columns plus contentExpectations scope, ' +
            'never a deterministic presence rule',
        ],
      };
    }
    return validation;
  }

  const errors = parsed.error.issues.map((issue) => {
    const path = issue.path.length > 0 ? issue.path.map(String).join('.') : '(input)';
    return `at ${path}: ${issue.message}`;
  });
  return { ok: false, errors: [errors[0]!, ...errors.slice(1)] };
}
