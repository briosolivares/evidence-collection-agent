import type Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';

import { outputContractSchema, type OutputContract } from './outputContract.schema.js';
import { validateOutputContract } from './validate.js';
import { contractPrompt } from '../../prompts/index.js';
import type { CallModel, Message, ToolUseBlock } from '../../model/messages.js';
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

export const INITIALIZER_MODEL = 'claude-sonnet-5';
export const INITIALIZER_MAX_ATTEMPTS = 2;
const SET_OUTPUT_CONTRACT = 'set_output_contract';

const initializerOutputContractSchema = outputContractSchema.omit({
  assumptions: true,
});

const setOutputContractInputSchema = z.strictObject({
  contract: initializerOutputContractSchema,
});

/** Initializer-only definition for the run's one immutable contract. */
const setOutputContractTool: ToolDef<{ contract: OutputContract }> = {
  name: SET_OUTPUT_CONTRACT,
  description:
    'Return the one immutable typed output contract for this run. Describe only the ' +
    'explicitly requested artifacts, exact shapes, counts, scope, and evidence needs. This ' +
    'contract is accepted once before work begins and is final after acceptance.',
  inputSchema: setOutputContractInputSchema,
  getAccess: () => ({ reads: [], writes: [], exclusive: true }),
  execute() {
    throw new Error('the initializer result is intercepted and never executed');
  },
};

export const CONTRACT_INITIALIZER_API_TOOL_DEFS: readonly ApiToolDef[] = deepFreeze(
  toApiToolDefs(createRegistry([setOutputContractTool as ToolDef])),
);

export interface ContractInitializerModelConfig {
  model?: string;
  maxOutputTokens?: number;
  maxTokensRetryOutputTokens?: number;
  createStream?: ModelDriverConfig['createStream'];
}

export function createContractInitializerModelDriver(
  config: ContractInitializerModelConfig = {},
): ModelDriver {
  return createAnthropicModelDriver({
    model: config.model ?? INITIALIZER_MODEL,
    system: contractPrompt,
    apiToolDefs: CONTRACT_INITIALIZER_API_TOOL_DEFS,
    maxOutputTokens: config.maxOutputTokens ?? 4_096,
    maxToolCallsPerTurn: 1,
    toolChoice: {
      type: 'tool',
      name: SET_OUTPUT_CONTRACT,
    } satisfies Anthropic.Messages.ToolChoice,
    ...(config.maxTokensRetryOutputTokens === undefined
      ? {}
      : { maxTokensRetryOutputTokens: config.maxTokensRetryOutputTokens }),
    ...(config.createStream === undefined ? {} : { createStream: config.createStream }),
  });
}

export interface ContractInitializerState {
  messages: Message[];
  attempts: number;
  lastProblem?: string;
}

export interface ContractInitializerHooks {
  beforeRequest?(state: ContractInitializerState): Promise<void>;
  afterAttempt?(event: {
    state: ContractInitializerState;
    outcome: 'correction' | 'accepted' | 'failed';
    contract?: OutputContract;
  }): Promise<void>;
}

export type ContractInitializerOutcome =
  | { ok: true; contract: OutputContract }
  | { ok: false; reason: string };

export function createContractInitializerState(taskText: string): ContractInitializerState {
  return {
    messages: [{ role: 'user', content: [{ type: 'text', text: taskText }] }],
    attempts: 0,
  };
}

export function captureContractInitializerState(
  state: ContractInitializerState,
): ContractInitializerState {
  return structuredClone(state);
}

export function restoreContractInitializerState(
  snapshot: ContractInitializerState,
): ContractInitializerState {
  if (
    !Number.isInteger(snapshot.attempts) ||
    snapshot.attempts < 0 ||
    snapshot.attempts > INITIALIZER_MAX_ATTEMPTS
  ) {
    throw new Error(
      `initializer attempts must be an integer from 0 to ${INITIALIZER_MAX_ATTEMPTS}`,
    );
  }
  if (snapshot.messages.length === 0) {
    throw new Error('initializer messages must contain the original task');
  }
  if (snapshot.lastProblem !== undefined && snapshot.lastProblem.trim().length === 0) {
    throw new Error('initializer lastProblem must be nonblank when present');
  }
  return structuredClone(snapshot);
}

/** Run or resume the bounded contract initializer. Accepted contract bytes
 * live only in the returned value/checkpoint; no worker-visible mutable
 * contract store is created. */
export async function runContractInitializer(
  state: ContractInitializerState,
  callModel: CallModel,
  hooks: ContractInitializerHooks = {},
): Promise<ContractInitializerOutcome> {
  if (state.attempts >= INITIALIZER_MAX_ATTEMPTS) {
    return {
      ok: false,
      reason:
        state.lastProblem ??
        'contract initializer exhausted its attempts without an accepted contract',
    };
  }

  while (state.attempts < INITIALIZER_MAX_ATTEMPTS) {
    await hooks.beforeRequest?.(captureContractInitializerState(state));

    let response;
    try {
      response = await callModel(state.messages);
    } catch (error) {
      if (isModelResponseRejectedError(error) && isProtocolCorrectableRejection(error.reason)) {
        state.attempts += 1;
        state.lastProblem = error.protocolFeedback;
        if (state.attempts < INITIALIZER_MAX_ATTEMPTS) {
          state.messages.push({
            role: 'user',
            content: [{ type: 'text', text: error.protocolFeedback }],
          });
          await hooks.afterAttempt?.({
            state: captureContractInitializerState(state),
            outcome: 'correction',
          });
          continue;
        }
        await hooks.afterAttempt?.({
          state: captureContractInitializerState(state),
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
    const contractCalls = calls.filter((call) => call.name === SET_OUTPUT_CONTRACT);

    let problem: string;
    if (contractCalls.length === 0) {
      problem = `Your response made no ${SET_OUTPUT_CONTRACT} call. Prose is not read.`;
    } else if (contractCalls.length > 1 || calls.length > 1) {
      problem = `Respond with exactly one ${SET_OUTPUT_CONTRACT} call and no other tool calls.`;
    } else {
      const validation = validateInitialContractCall(contractCalls[0]!.input);
      if (validation.ok) {
        const contract = validation.contract;
        delete state.lastProblem;
        await hooks.afterAttempt?.({
          state: captureContractInitializerState(state),
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
    if (state.attempts >= INITIALIZER_MAX_ATTEMPTS) {
      await hooks.afterAttempt?.({
        state: captureContractInitializerState(state),
        outcome: 'failed',
      });
      return { ok: false, reason: problem };
    }

    state.messages.push(contractCorrectionMessage(problem, calls));
    await hooks.afterAttempt?.({
      state: captureContractInitializerState(state),
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
export function formatContractGuidance(contract: OutputContract): string {
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

function contractCorrectionMessage(problem: string, calls: readonly ToolUseBlock[]): Message {
  const instruction = `${problem}\n\nRespond again with a single valid ${SET_OUTPUT_CONTRACT} call.`;
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

function validateInitialContractCall(input: unknown): ReturnType<typeof validateOutputContract> {
  const parsed = setOutputContractInputSchema.safeParse(input);
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
