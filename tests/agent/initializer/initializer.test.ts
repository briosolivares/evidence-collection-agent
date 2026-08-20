import { describe, expect, it, vi } from 'vitest';

import type { CallModel, ModelResponse, ToolUseBlock } from '../../../src/model/messages.js';
import { ModelResponseRejectedError } from '../../../src/model/modelDriver.js';
import { contractPrompt } from '../../../src/prompts/index.js';
import type { OutputContract } from '../../../src/agent/initializer/outputContract.schema.js';
import {
  CONTRACT_INITIALIZER_API_TOOL_DEFS,
  INITIALIZER_MAX_ATTEMPTS,
  captureContractInitializerState,
  createContractInitializerModelDriver,
  createContractInitializerState,
  formatContractGuidance,
  restoreContractInitializerState,
  runContractInitializer,
} from '../../../src/agent/initializer/initializer.js';

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

const ENUM_CONTRACT: OutputContract = {
  outputs: [
    {
      id: 'report',
      kind: 'table',
      filename: 'report.csv',
      format: 'csv',
      columns: [
        { name: 'name', required: true, type: 'string' },
        {
          name: 'chapter',
          required: true,
          type: 'enum',
          values: ['Alpha', 'Beta', 'Gamma'],
        },
      ],
      rules: [{ type: 'minimum_row_count', value: 1 }],
    },
  ],
  contentExpectations: [
    'Cover every enumerated chapter (Alpha, Beta, Gamma), or report it as credibly blocked.',
  ],
};

function response(content: ModelResponse['content']): ModelResponse {
  return {
    content,
    stop_reason: 'tool_use',
    usage: { input_tokens: 10, output_tokens: 5 },
  };
}

function contractCall(id = 'contract-1', contract: OutputContract = CONTRACT): ToolUseBlock {
  return {
    type: 'tool_use',
    id,
    name: 'set_output_contract',
    input: { contract },
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

describe('contract initializer static prefix', () => {
  it('offers exactly one strict contract tool behind run-invariant instructions', () => {
    expect(CONTRACT_INITIALIZER_API_TOOL_DEFS).toHaveLength(1);
    expect(CONTRACT_INITIALIZER_API_TOOL_DEFS[0]).toMatchObject({
      name: 'set_output_contract',
      input_schema: { type: 'object', additionalProperties: false },
    });
    expect(Object.isFrozen(CONTRACT_INITIALIZER_API_TOOL_DEFS)).toBe(true);
    const schema = CONTRACT_INITIALIZER_API_TOOL_DEFS[0]!.input_schema as {
      properties?: Record<string, unknown>;
    };
    expect(Object.keys(schema.properties ?? {})).toEqual(['contract']);
    const contractSchema = schema.properties?.contract as {
      properties?: Record<string, unknown>;
    };
    expect(Object.keys(contractSchema.properties ?? {})).not.toContain('assumptions');
    expect(contractPrompt).not.toContain('report.csv');
    expect(contractPrompt).toContain('one immutable output contract');
    expect(contractPrompt).toContain('original user request remains authoritative');
    expect(contractPrompt).toContain('declare the matching column as type enum');
  });

  it('builds the strict driver with validated finite output limits', () => {
    expect(() => createContractInitializerModelDriver({ maxOutputTokens: 0 })).toThrow(
      /maxOutputTokens/,
    );
  });
});

describe('runContractInitializer', () => {
  it('accepts exactly one valid immutable contract', async () => {
    const state = createContractInitializerState('Create report.csv.');
    const afterAttempt = vi.fn(async () => undefined);

    const outcome = await runContractInitializer(state, scripted([response([contractCall()])]), {
      afterAttempt,
    });

    expect(outcome).toEqual({ ok: true, contract: CONTRACT });
    expect(state.attempts).toBe(1);
    expect(state.messages.at(-1)?.role).toBe('assistant');
    expect(afterAttempt).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'accepted', contract: CONTRACT }),
    );
  });

  it('rejects a retired table-rule shape and accepts one bounded repair', async () => {
    const invalid = contractCall('invalid-contract');
    invalid.input = {
      contract: {
        ...CONTRACT,
        outputs: [
          {
            ...CONTRACT.outputs[0]!,
            rules: [
              {
                type: 'matches_expected_values',
                column: 'name',
                expected: ['Chapter A', 'Chapter B'],
                source: { kind: 'original_task' },
              },
            ],
          },
        ],
      },
    };
    const state = createContractInitializerState('Create report.csv.');
    const callModel = vi.fn<CallModel>(async (messages) => {
      if (messages.length === 1) return response([invalid]);
      expect(JSON.stringify(messages.at(-1))).toContain('contract.outputs.0.rules.0.type');
      return response([contractCall('repaired-contract')]);
    });

    await expect(runContractInitializer(state, callModel)).resolves.toEqual({
      ok: true,
      contract: CONTRACT,
    });
    expect(callModel).toHaveBeenCalledTimes(2);
  });

  it('accepts an enum column with contentExpectations scope in place of a presence gate', async () => {
    const state = createContractInitializerState('Create report.csv.');

    const outcome = await runContractInitializer(
      state,
      scripted([response([contractCall('enum-contract', ENUM_CONTRACT)])]),
    );

    expect(outcome).toEqual({ ok: true, contract: ENUM_CONTRACT });
  });

  it('answers every invalid call, then accepts one bounded repair', async () => {
    const state = createContractInitializerState('Create report.csv.');
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

    await expect(runContractInitializer(state, callModel)).resolves.toEqual({
      ok: true,
      contract: CONTRACT,
    });
    expect(state.attempts).toBe(INITIALIZER_MAX_ATTEMPTS);
    expect(callModel).toHaveBeenCalledTimes(2);
  });

  it('returns a stable failure after the second invalid accepted response', async () => {
    const state = createContractInitializerState('Create report.csv.');
    const outcome = await runContractInitializer(
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
    await expect(runContractInitializer(state, scripted([]))).resolves.toEqual(outcome);
  });

  it('uses one repair for a correctable whole-response rejection', async () => {
    const state = createContractInitializerState('Create report.csv.');
    const rejected = new ModelResponseRejectedError(
      'malformed_tool_call',
      'malformed',
      'Issue one well-formed contract call.',
      { input_tokens: 3, output_tokens: 1 },
    );

    await expect(
      runContractInitializer(state, scripted([rejected, response([contractCall()])])),
    ).resolves.toEqual({ ok: true, contract: CONTRACT });
    expect(state.messages[1]).toEqual({
      role: 'user',
      content: [{ type: 'text', text: 'Issue one well-formed contract call.' }],
    });
  });
});

describe('initializer durability helpers', () => {
  it('deep-copies snapshots and restores the bounded state', () => {
    const state = createContractInitializerState('Create report.csv.');
    state.attempts = 1;
    state.lastProblem = 'first response was invalid';
    const snapshot = captureContractInitializerState(state);
    state.messages[0]!.content[0] = { type: 'text', text: 'mutated' };

    const restored = restoreContractInitializerState(snapshot);
    expect(restored.messages[0]?.content[0]).toEqual({
      type: 'text',
      text: 'Create report.csv.',
    });
    expect(restored).not.toBe(snapshot);
    expect(() =>
      restoreContractInitializerState({
        messages: snapshot.messages,
        attempts: 3,
      }),
    ).toThrow(/initializer attempts/);
  });

  it('renders deterministic immutable per-run worker guidance', () => {
    const first = formatContractGuidance(CONTRACT);
    const second = formatContractGuidance(structuredClone(CONTRACT));
    expect(second).toBe(first);
    expect(first).toContain('# Immutable output contract');
    expect(first).toContain('"filename": "report.csv"');
    expect(first).toContain('original user request is authoritative');
  });
});
