import type Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';

import type { ModelResponse } from '../../src/model/messages.js';
import {
  createAnthropicModelDriver,
  DEFAULT_MAX_TOOL_CALLS_PER_TURN,
  isModelResponseRejectedError,
  isProtocolCorrectableRejection,
  validateModelResponseForExecution,
  type ModelAttemptEvent,
} from '../../src/model/modelDriver.js';
import type { ModelStreamEvent } from '../../src/model/streamAssembly.js';

// Driver tests run against scripted wire streams — no live API. Fixtures
// use the compact cast style of tests/tui/streamFixtures.ts; the SDK-typed
// fixtures in streamAssembly.test.ts already pin the exact wire shapes.

const USAGE = {
  input_tokens: 100,
  output_tokens: 20,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
};

function response(content: ModelResponse['content'], stopReason: string | null): ModelResponse {
  return { content, stop_reason: stopReason, usage: USAGE };
}

function toolUse(
  id: string,
  name = 'read_file',
  input: unknown = {},
): {
  type: 'tool_use';
  id: string;
  name: string;
  input: unknown;
} {
  return { type: 'tool_use', id, name, input };
}

const LIMITS = { maxToolCallsPerTurn: 3 };

/** The wire events of one complete streamed response. */
function scriptedStream(text: string, stopReason: string): ModelStreamEvent[] {
  return [
    {
      type: 'message_start',
      message: { usage: { input_tokens: 100, output_tokens: 0, cache_read_input_tokens: 0 } },
    },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
    { type: 'content_block_stop', index: 0 },
    {
      type: 'message_delta',
      delta: { stop_reason: stopReason },
      usage: { input_tokens: null, output_tokens: 20 },
    },
    { type: 'message_stop' },
  ] as unknown as ModelStreamEvent[];
}

async function* replay(events: readonly ModelStreamEvent[]): AsyncIterable<ModelStreamEvent> {
  for (const event of events) yield event;
}

/** A createStream seam serving one scripted response per call, recording
 * each call's params. */
function streamFactory(responses: ModelStreamEvent[][]) {
  const calls: Anthropic.Messages.MessageStreamParams[] = [];
  let next = 0;
  return {
    calls,
    createStream: (params: Anthropic.Messages.MessageStreamParams) => {
      calls.push(params);
      const events = responses[next];
      if (events === undefined) throw new Error(`stream exhausted after ${next} calls`);
      next += 1;
      return replay(events);
    },
  };
}

const DRIVER_BASE = {
  system: 'You are a test.',
  apiToolDefs: [],
  maxOutputTokens: 1000,
};

describe('validateModelResponseForExecution', () => {
  it('accepts end_turn, tool_use, and stop_sequence with well-formed content', () => {
    for (const stop of ['end_turn', 'tool_use', 'stop_sequence'] as const) {
      const accepted = validateModelResponseForExecution(
        response([{ type: 'text', text: 'ok' }, toolUse('tu_1')], stop),
        LIMITS,
      );
      expect(accepted.stopReason).toBe(stop);
      expect(accepted.response.content).toHaveLength(2);
    }
  });

  it.each([
    [null, 'missing_stop_reason'],
    ['max_tokens', 'max_tokens'],
    ['refusal', 'refusal'],
    ['model_context_window_exceeded', 'context_exhausted'],
    // pause_turn documents that a real Anthropic stop reason is still deliberately
    // unaccepted; any other unrecognized label takes the same branch.
    ['pause_turn', 'unknown_stop_reason'],
  ])('rejects stop_reason %s as %s', (stop, reason) => {
    try {
      validateModelResponseForExecution(
        response([{ type: 'text', text: 'x' }], stop as string | null),
        LIMITS,
      );
      expect.unreachable('should have rejected');
    } catch (error) {
      expect(isModelResponseRejectedError(error)).toBe(true);
      if (!isModelResponseRejectedError(error)) throw error;
      expect(error.reason).toBe(reason);
      // Usage rides on the rejection so budgets can still charge for it.
      expect(error.usage).toEqual(USAGE);
      expect(error.protocolFeedback.length).toBeGreaterThan(0);
    }
  });

  it.each([
    ['empty id', toolUse('')],
    ['empty name', toolUse('tu_1', '')],
    ['null input', toolUse('tu_1', 'read_file', null)],
    ['array input', toolUse('tu_1', 'read_file', [1, 2])],
    ['string input', toolUse('tu_1', 'read_file', 'raw')],
  ])('rejects a tool call with %s as malformed', (_label, block) => {
    expect(() =>
      validateModelResponseForExecution(response([block], 'tool_use'), LIMITS),
    ).toThrowError(expect.objectContaining({ reason: 'malformed_tool_call' }));
  });

  it('rejects duplicate tool_use ids as malformed', () => {
    expect(() =>
      validateModelResponseForExecution(
        response([toolUse('tu_dup'), toolUse('tu_dup')], 'tool_use'),
        LIMITS,
      ),
    ).toThrowError(expect.objectContaining({ reason: 'malformed_tool_call' }));
  });

  it('rejects a response over maxToolCallsPerTurn', () => {
    expect(() =>
      validateModelResponseForExecution(
        response([toolUse('a'), toolUse('b'), toolUse('c'), toolUse('d')], 'tool_use'),
        LIMITS,
      ),
    ).toThrowError(expect.objectContaining({ reason: 'too_many_tool_calls' }));
    // Exactly at the cap is fine.
    expect(
      validateModelResponseForExecution(
        response([toolUse('a'), toolUse('b'), toolUse('c')], 'tool_use'),
        LIMITS,
      ).stopReason,
    ).toBe('tool_use');
  });

  // One non-integer plus zero cover both disjuncts of the limit guard.
  it.each([[Number.NaN], [0]])('refuses to compare against invalid limit %s', (limit) => {
    expect(() =>
      validateModelResponseForExecution(response([], 'end_turn'), {
        maxToolCallsPerTurn: limit,
      }),
    ).toThrow(/maxToolCallsPerTurn/);
  });

  it('classifies protocol-correctable reasons', () => {
    expect(isProtocolCorrectableRejection('too_many_tool_calls')).toBe(true);
    expect(isProtocolCorrectableRejection('malformed_tool_call')).toBe(true);
    expect(isProtocolCorrectableRejection('max_tokens')).toBe(true);
    expect(isProtocolCorrectableRejection('refusal')).toBe(false);
    expect(isProtocolCorrectableRejection('context_exhausted')).toBe(false);
    expect(isProtocolCorrectableRejection('unknown_stop_reason')).toBe(false);
  });
});

describe('createAnthropicModelDriver construction', () => {
  // Each field gets one non-integer case and one boundary case; NaN, Infinity, and
  // fractional values all fail the same integer check.
  it.each([
    ['maxOutputTokens NaN', { maxOutputTokens: Number.NaN }],
    ['maxOutputTokens 0', { maxOutputTokens: 0 }],
    ['retry allowance not larger', { maxTokensRetryOutputTokens: 1000 }],
    ['retry allowance NaN', { maxTokensRetryOutputTokens: Number.NaN }],
    ['maxToolCallsPerTurn 0', { maxToolCallsPerTurn: 0 }],
    ['maxToolCallsPerTurn NaN', { maxToolCallsPerTurn: Number.NaN }],
  ])('throws at construction for %s', (_label, overrides) => {
    expect(() => createAnthropicModelDriver({ ...DRIVER_BASE, ...overrides })).toThrow();
  });

  it('exposes a sane default tool-call cap', () => {
    expect(Number.isInteger(DEFAULT_MAX_TOOL_CALLS_PER_TURN)).toBe(true);
    expect(DEFAULT_MAX_TOOL_CALLS_PER_TURN).toBeGreaterThanOrEqual(5);
  });
});

describe('createAnthropicModelDriver.generate', () => {
  it('accepts a complete response and reports attempt events in order', async () => {
    const factory = streamFactory([scriptedStream('Answer.', 'end_turn')]);
    const driver = createAnthropicModelDriver({
      ...DRIVER_BASE,
      createStream: factory.createStream,
    });
    const events: ModelAttemptEvent[] = [];

    const accepted = await driver.generate({
      messages: [{ role: 'user', content: [{ type: 'text', text: 'q' }] }],
      onEvent: (event) => events.push(event),
    });

    expect(accepted.stopReason).toBe('end_turn');
    expect(accepted.attempts).toBe(1);
    expect(accepted.usage).toEqual({
      input_tokens: 100,
      output_tokens: 20,
      cache_read_input_tokens: 0,
    });
    expect(accepted.response.content).toEqual([{ type: 'text', text: 'Answer.' }]);
    expect(events).toEqual([
      { type: 'attempt_start', attemptId: 1 },
      { type: 'text_delta', attemptId: 1, text: 'Answer.' },
      { type: 'attempt_accepted', attemptId: 1, usage: accepted.response.usage },
    ]);
    expect(factory.calls).toHaveLength(1);
    expect(factory.calls[0]?.max_tokens).toBe(1000);
  });

  it('re-asks one max_tokens overflow with the larger allowance and discards the first attempt', async () => {
    const factory = streamFactory([
      scriptedStream('cut off mid-thou', 'max_tokens'),
      scriptedStream('Full answer.', 'end_turn'),
    ]);
    const driver = createAnthropicModelDriver({
      ...DRIVER_BASE,
      maxTokensRetryOutputTokens: 4000,
      createStream: factory.createStream,
    });
    const events: ModelAttemptEvent[] = [];

    const accepted = await driver.generate({
      messages: [{ role: 'user', content: [{ type: 'text', text: 'q' }] }],
      onEvent: (event) => events.push(event),
    });

    // Same request, larger output allowance; identical messages.
    expect(factory.calls).toHaveLength(2);
    expect(factory.calls[0]?.max_tokens).toBe(1000);
    expect(factory.calls[1]?.max_tokens).toBe(4000);
    expect(factory.calls[0]?.messages).toEqual(factory.calls[1]?.messages);

    // The overflowing attempt is rejected and never surfaces as content.
    expect(accepted.attempts).toBe(2);
    expect(accepted.response.content).toEqual([{ type: 'text', text: 'Full answer.' }]);
    expect(accepted.usage).toEqual({
      input_tokens: 200,
      output_tokens: 40,
      cache_read_input_tokens: 0,
    });
    expect(events.filter((event) => event.type === 'attempt_rejected')).toEqual([
      {
        type: 'attempt_rejected',
        attemptId: 1,
        reason: 'max_tokens',
        message: expect.stringContaining('output-token limit'),
      },
    ]);
    expect(events.at(-1)).toEqual({
      type: 'attempt_accepted',
      attemptId: 2,
      usage: accepted.usage,
    });
  });

  it('rejects after a second max_tokens overflow — the re-ask happens at most once', async () => {
    const factory = streamFactory([
      scriptedStream('cut', 'max_tokens'),
      scriptedStream('cut again', 'max_tokens'),
      scriptedStream('never requested', 'end_turn'),
    ]);
    const driver = createAnthropicModelDriver({
      ...DRIVER_BASE,
      createStream: factory.createStream,
    });

    await expect(
      driver.generate({ messages: [{ role: 'user', content: [{ type: 'text', text: 'q' }] }] }),
    ).rejects.toMatchObject({
      name: 'ModelResponseRejectedError',
      reason: 'max_tokens',
      usage: {
        input_tokens: 200,
        output_tokens: 40,
        cache_read_input_tokens: 0,
      },
    });
    expect(factory.calls).toHaveLength(2);
  });

  it('preserves known usage when the enlarged re-ask fails before reporting usage', async () => {
    const boom = new Error('second transport failed');
    let streams = 0;
    const driver = createAnthropicModelDriver({
      ...DRIVER_BASE,
      createStream: () => {
        streams += 1;
        if (streams === 1) return replay(scriptedStream('cut', 'max_tokens'));
        throw boom;
      },
    });

    await expect(
      driver.generate({
        messages: [{ role: 'user', content: [{ type: 'text', text: 'q' }] }],
      }),
    ).rejects.toMatchObject({
      name: 'ModelGenerationFailedError',
      cause: boom,
      usage: {
        input_tokens: 100,
        output_tokens: 20,
        cache_read_input_tokens: 0,
      },
    });
    expect(streams).toBe(2);
  });

  it('rejects a refusal immediately without a re-ask', async () => {
    const factory = streamFactory([
      scriptedStream('cannot help', 'refusal'),
      scriptedStream('never requested', 'end_turn'),
    ]);
    const driver = createAnthropicModelDriver({
      ...DRIVER_BASE,
      createStream: factory.createStream,
    });
    const events: ModelAttemptEvent[] = [];

    await expect(
      driver.generate({
        messages: [{ role: 'user', content: [{ type: 'text', text: 'q' }] }],
        onEvent: (event) => events.push(event),
      }),
    ).rejects.toMatchObject({ name: 'ModelResponseRejectedError', reason: 'refusal' });
    expect(factory.calls).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({ type: 'attempt_rejected', reason: 'refusal' });
  });

  it('retries a truncated stream through the transport retry policy', async () => {
    const complete = scriptedStream('Recovered.', 'end_turn');
    const truncated = complete.slice(0, 3); // dies mid-text, no terminal events
    const factory = streamFactory([truncated, complete]);
    const driver = createAnthropicModelDriver({
      ...DRIVER_BASE,
      createStream: factory.createStream,
    });
    const events: ModelAttemptEvent[] = [];

    const accepted = await driver.generate({
      messages: [{ role: 'user', content: [{ type: 'text', text: 'q' }] }],
      onEvent: (event) => events.push(event),
    });

    expect(accepted.attempts).toBe(2);
    expect(accepted.response.content).toEqual([{ type: 'text', text: 'Recovered.' }]);
    const retries = events.filter((event) => event.type === 'retry');
    expect(retries).toHaveLength(1);
    expect(retries[0]).toMatchObject({ attemptId: 1, attempt: 2 });
  }, 15_000);

  it('cancellation interrupts a hanging stream without retrying', async () => {
    const controller = new AbortController();
    let streams = 0;
    async function* hanging(): AsyncIterable<ModelStreamEvent> {
      streams += 1;
      yield scriptedStream('x', 'end_turn')[0]!;
      await new Promise((_resolve, reject) => {
        const abort = (): void =>
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        if (controller.signal.aborted) abort();
        else controller.signal.addEventListener('abort', abort, { once: true });
      });
    }
    const driver = createAnthropicModelDriver({ ...DRIVER_BASE, createStream: () => hanging() });

    const pending = driver.generate({
      messages: [{ role: 'user', content: [{ type: 'text', text: 'q' }] }],
      signal: controller.signal,
    });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(streams).toBe(1);
  });
});
