import { describe, expect, it, vi } from 'vitest';

import type {
  CallModel,
  ModelResponse,
  ToolUseBlock,
} from '../../loop/messages.js';
import { ModelResponseRejectedError } from '../../model/modelDriver.js';
import type { OutputContract } from '../../contracts/outputContract.js';
import {
  V3_CONTRACT_INITIALIZER_API_TOOL_DEFS,
  V3_CONTRACT_INITIALIZER_SYSTEM_PROMPT,
  V3_INITIALIZER_MAX_ATTEMPTS,
  captureV3ContractInitializerState,
  createV3ContractInitializerModelDriver,
  createV3ContractInitializerState,
  formatV3ContractGuidance,
  restoreV3ContractInitializerState,
  runV3ContractInitializer,
} from './initializer.js';

const CONTRACT: OutputContract = {
  outputs: [
    {
      id: 'report',
      kind: 'table',
      filename: 'report.csv',
      format: 'csv',
      columns: [
        { name: 'name', required: true, type: 'string' },
        { name: 'value', required: true, type: 'integer' },
      ],
      rules: [{ type: 'minimum_row_count', value: 1 }],
    },
  ],
  contentExpectations: ['Use source-backed current values.'],
};

function response(content: ModelResponse['content']): ModelResponse {
  return {
    content,
    stop_reason: 'tool_use',
    usage: { input_tokens: 10, output_tokens: 5 },
  };
}

function contractCall(id = 'contract-1'): ToolUseBlock {
  return {
    type: 'tool_use',
    id,
    name: 'set_output_contract',
    input: { contract: CONTRACT },
  };
}

function scripted(responses: Array<ModelResponse | Error>): CallModel & {
  calls: ReturnType<typeof vi.fn>;
} {
  const calls = vi.fn(async () => {
    const next = responses.shift();
    if (next === undefined) throw new Error('initializer script exhausted');
    if (next instanceof Error) throw next;
    return next;
  });
  return Object.assign(calls, { calls });
}

describe('v3 contract initializer static prefix', () => {
  it('offers exactly one strict contract tool behind run-invariant instructions', () => {
    expect(V3_CONTRACT_INITIALIZER_API_TOOL_DEFS).toHaveLength(1);
    expect(V3_CONTRACT_INITIALIZER_API_TOOL_DEFS[0]).toMatchObject({
      name: 'set_output_contract',
      input_schema: { type: 'object', additionalProperties: false },
    });
    expect(Object.isFrozen(V3_CONTRACT_INITIALIZER_API_TOOL_DEFS)).toBe(true);
    const schema = V3_CONTRACT_INITIALIZER_API_TOOL_DEFS[0]!.input_schema as {
      properties?: Record<string, unknown>;
    };
    expect(Object.keys(schema.properties ?? {})).toEqual(['contract']);
    expect(V3_CONTRACT_INITIALIZER_SYSTEM_PROMPT).not.toContain('report.csv');
    expect(V3_CONTRACT_INITIALIZER_SYSTEM_PROMPT).toContain(
      'one immutable output contract',
    );
  });

  it('builds the strict driver with validated finite output limits', () => {
    expect(() =>
      createV3ContractInitializerModelDriver({ maxOutputTokens: 0 }),
    ).toThrow(/maxOutputTokens/);
  });
});

describe('runV3ContractInitializer', () => {
  it('accepts exactly one valid immutable contract', async () => {
    const state = createV3ContractInitializerState('Create report.csv.');
    const afterAttempt = vi.fn(async () => undefined);

    const outcome = await runV3ContractInitializer(
      state,
      scripted([response([contractCall()])]),
      { afterAttempt },
    );

    expect(outcome).toEqual({ ok: true, contract: CONTRACT });
    expect(state.attempts).toBe(1);
    expect(state.messages.at(-1)?.role).toBe('assistant');
    expect(afterAttempt).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'accepted', contract: CONTRACT }),
    );
  });

  it('feeds contract validation errors back for one bounded repair', async () => {
    const invalid = contractCall('invalid-contract');
    invalid.input = {
      contract: {
        ...CONTRACT,
        outputs: [{ ...CONTRACT.outputs[0]!, filename: 'nested/report.csv' }],
      },
    };
    const state = createV3ContractInitializerState('Create report.csv.');
    const callModel = vi.fn<CallModel>(async (messages) => {
      if (messages.length === 1) return response([invalid]);
      expect(JSON.stringify(messages.at(-1))).toContain('bare filename');
      return response([contractCall('repaired-contract')]);
    });

    await expect(runV3ContractInitializer(state, callModel)).resolves.toEqual({
      ok: true,
      contract: CONTRACT,
    });
    expect(callModel).toHaveBeenCalledTimes(2);
  });

  it('answers every invalid call, then accepts one bounded repair', async () => {
    const state = createV3ContractInitializerState('Create report.csv.');
    const callModel = vi.fn<CallModel>(async (messages) => {
      if (messages.length === 1) {
        return response([
          contractCall('first-contract'),
          {
            type: 'tool_use',
            id: 'extra-call',
            name: 'read_file',
            input: { file_path: 'scratch/x' },
          },
        ]);
      }
      const correction = messages.at(-1)!;
      expect(correction.role).toBe('user');
      expect(
        correction.content
          .filter((block) => block.type === 'tool_result')
          .map((block) => block.tool_use_id),
      ).toEqual(['first-contract', 'extra-call']);
      return response([contractCall('repaired-contract')]);
    });

    await expect(
      runV3ContractInitializer(state, callModel),
    ).resolves.toEqual({ ok: true, contract: CONTRACT });
    expect(state.attempts).toBe(V3_INITIALIZER_MAX_ATTEMPTS);
    expect(callModel).toHaveBeenCalledTimes(2);
  });

  it('returns a stable failure after the second invalid accepted response', async () => {
    const state = createV3ContractInitializerState('Create report.csv.');
    const outcome = await runV3ContractInitializer(
      state,
      scripted([
        response([{ type: 'text', text: 'I will explain instead.' }]),
        response([{ type: 'text', text: 'Still no call.' }]),
      ]),
    );

    expect(outcome).toMatchObject({
      ok: false,
      reason: expect.stringContaining('made no set_output_contract call'),
    });
    expect(state.attempts).toBe(2);
    await expect(
      runV3ContractInitializer(state, scripted([])),
    ).resolves.toEqual(outcome);
  });

  it('uses one repair for a correctable whole-response rejection', async () => {
    const state = createV3ContractInitializerState('Create report.csv.');
    const rejected = new ModelResponseRejectedError(
      'malformed_tool_call',
      'malformed',
      'Issue one well-formed contract call.',
      { input_tokens: 3, output_tokens: 1 },
    );

    await expect(
      runV3ContractInitializer(
        state,
        scripted([rejected, response([contractCall()])]),
      ),
    ).resolves.toEqual({ ok: true, contract: CONTRACT });
    expect(state.messages[1]).toEqual({
      role: 'user',
      content: [
        { type: 'text', text: 'Issue one well-formed contract call.' },
      ],
    });
  });
});

describe('v3 initializer durability helpers', () => {
  it('deep-copies snapshots and restores the bounded state', () => {
    const state = createV3ContractInitializerState('Create report.csv.');
    state.attempts = 1;
    state.lastProblem = 'first response was invalid';
    const snapshot = captureV3ContractInitializerState(state);
    state.messages[0]!.content[0] = { type: 'text', text: 'mutated' };

    const restored = restoreV3ContractInitializerState(snapshot);
    expect(restored.messages[0]?.content[0]).toEqual({
      type: 'text',
      text: 'Create report.csv.',
    });
    expect(restored).not.toBe(snapshot);
    expect(() =>
      restoreV3ContractInitializerState({
        messages: snapshot.messages,
        attempts: 3,
      }),
    ).toThrow(/initializer attempts/);
  });

  it('renders deterministic immutable per-run worker guidance', () => {
    const first = formatV3ContractGuidance(CONTRACT);
    const second = formatV3ContractGuidance(structuredClone(CONTRACT));
    expect(second).toBe(first);
    expect(first).toContain('# Immutable output contract');
    expect(first).toContain('"filename": "report.csv"');
    expect(first).toContain('cannot be revised');
  });
});
