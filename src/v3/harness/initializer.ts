import type Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';

import {
  outputContractSchema,
  validateContractRevision,
  type OutputContract,
} from '../../contracts/outputContract.js';
import { SET_OUTPUT_CONTRACT } from '../../contracts/contractFirstGate.js';
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

/** Static contract-only instructions. Task and checkpoint facts stay in the
 * conversation so this prefix remains byte-stable across runs. */
export const V3_CONTRACT_INITIALIZER_SYSTEM_PROMPT = `You derive one immutable output contract from a task description before any browsing happens.

Your only job is to call set_output_contract exactly once, stating precisely what the finished run must contain: every required output file or capture, its format, its exact columns or required sections in the order the task implies, and the checkable rules that follow from the request.

Rules:
- Describe the END STATE only. Never include a research plan, browsing steps, preferred sites, or how the work should be carried out.
- Copy exact column headers, filenames, formats, enumerated values, sections, and counts from the task wherever it states them. Do not rename or improve them.
- State a row count only when the task itself fixes one. When the population is unknown until research, do not invent an exact count.
- When the task names the complete entities to cover, add an exhaustive matches_expected_values rule listing them. Leave exhaustive off for examples or a population the run must discover.
- Put judgment requirements in contentExpectations and only material choices in assumptions.
- Do not invent outputs the task did not ask for, and do not include revisionBasis: v3 accepts one immutable initial contract.

Respond with the set_output_contract call and nothing else.`;

const v3SetOutputContractInputSchema = z.strictObject({
  contract: outputContractSchema,
});

/** Initializer-only definition: unlike the retired worker tool, this schema
 * cannot advertise or accept revisionBasis or later mutation. */
const v3SetOutputContractTool: ToolDef<{ contract: OutputContract }> = {
  name: SET_OUTPUT_CONTRACT,
  description:
    'Return the one immutable typed output contract for this run. Describe only the ' +
    'required finished artifacts, exact shapes, and mechanically checkable rules. This ' +
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
 * live only in the returned value/checkpoint; no worker-visible revision
 * files or mutable contract store are created. */
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
      const validation = validateContractRevision(contractCalls[0]!.input, 1);
      if (validation.ok) {
        const contract = validation.revision.contract;
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
    'The initializer validated this exact contract. It cannot be revised during the run.',
    'Satisfy every requirement with published artifacts and use these exact filenames and shapes.',
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
