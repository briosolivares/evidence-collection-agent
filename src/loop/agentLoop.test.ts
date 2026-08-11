import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { initManifest, MANIFEST_FILENAME, type Manifest } from '../run/artifacts.js';
import { TRANSCRIPT_FILENAME } from '../run/transcript.js';
import { fileTools } from '../tools/index.js';
import { createRegistry, type ToolDef, type ToolRegistry } from '../tools/registry.js';
import {
  METRICS_FILENAME,
  runAgentLoop,
  type LoopConfig,
  type RunMetrics,
} from './agentLoop.js';
import type { Message, ModelResponse, Usage } from './messages.js';

// Every test drives the loop with a scripted fake callModel — zero real API
// calls anywhere in this file (hermetic-suite convention).

const TASK = 'Do the scripted thing.';

/** Ample guards for tests that are not probing them. */
const ROOMY: LoopConfig = { maxTurns: 10, maxTokens: 1_000_000 };

/** Default per-response usage: 15 tokens per turn (10 in + 5 out). */
const DEFAULT_USAGE: Usage = { input_tokens: 10, output_tokens: 5 };

/** A terminal response: text only, no tool_use. */
function textResponse(
  text: string,
  opts: { stopReason?: string; usage?: Usage } = {},
): ModelResponse {
  return {
    content: [{ type: 'text', text }],
    stop_reason: opts.stopReason ?? 'end_turn',
    usage: opts.usage ?? { ...DEFAULT_USAGE },
  };
}

/** A continuing response: one tool_use block per requested call. */
function toolResponse(
  calls: Array<{ id: string; name: string; input: unknown }>,
  opts: { stopReason?: string; usage?: Usage } = {},
): ModelResponse {
  return {
    content: calls.map((call) => ({ type: 'tool_use' as const, ...call })),
    stop_reason: opts.stopReason ?? 'tool_use',
    usage: opts.usage ?? { ...DEFAULT_USAGE },
  };
}

/**
 * A scripted callModel: serves the given responses in order, snapshotting
 * the messages of each request into `requests`. Calling it more times than
 * scripted throws — a loop that fails to stop fails its test loudly.
 */
function scriptModel(responses: ModelResponse[]): {
  callModel: (messages: readonly Message[]) => Promise<ModelResponse>;
  requests: Message[][];
} {
  const requests: Message[][] = [];
  const callModel = async (messages: readonly Message[]): Promise<ModelResponse> => {
    // Snapshot: the loop mutates its messages array between turns.
    requests.push(structuredClone(messages) as Message[]);
    const next = responses[requests.length - 1];
    if (next === undefined) {
      throw new Error(
        `fake model called ${requests.length} times but only ${responses.length} responses scripted`,
      );
    }
    return next;
  };
  return { callModel, requests };
}

/** A registry with one scripted `echo` tool that records each execution. */
function echoRegistry(executed: string[]): ToolRegistry {
  const echo: ToolDef<{ message: string }> = {
    name: 'echo',
    description: 'Echo the message back.',
    inputSchema: z.object({ message: z.string() }),
    readOnly: true,
    execute: async (input) => {
      executed.push(input.message);
      return `echo: ${input.message}`;
    },
  };
  return createRegistry([echo as ToolDef]);
}

let runDir: string;

beforeEach(() => {
  runDir = mkdtempSync(join(tmpdir(), 'agent-loop-test-'));
  initManifest(runDir, TASK);
});

afterEach(() => {
  rmSync(runDir, { recursive: true, force: true });
});

describe('runAgentLoop completion policy', () => {
  it('a response without tool_use ends the run with its text as finalText', async () => {
    const { callModel, requests } = scriptModel([textResponse('All done.')]);
    const result = await runAgentLoop(TASK, { callModel, registry: echoRegistry([]), runDir }, ROOMY);

    expect(result).toEqual({ status: 'completed', finalText: 'All done.' });
    // Exactly one model call, and it received the task as the first message.
    expect(requests).toEqual([[{ role: 'user', content: [{ type: 'text', text: TASK }] }]]);
  });

  it('a response with tool_use executes the tool and feeds the result back', async () => {
    const executed: string[] = [];
    const { callModel, requests } = scriptModel([
      toolResponse([{ id: 't1', name: 'echo', input: { message: 'hi' } }]),
      textResponse('Done.'),
    ]);
    const result = await runAgentLoop(TASK, { callModel, registry: echoRegistry(executed), runDir }, ROOMY);

    expect(result).toEqual({ status: 'completed', finalText: 'Done.' });
    expect(executed).toEqual(['hi']);
    // The second request replays the whole exchange: task, the assistant's
    // tool_use, then one user message carrying the tool_result.
    expect(requests[1]).toEqual([
      { role: 'user', content: [{ type: 'text', text: TASK }] },
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 't1', name: 'echo', input: { message: 'hi' } }],
      },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'echo: hi' }] },
    ]);
  });

  it('a stop_reason claiming end_turn while content has tool_use continues — content decides', async () => {
    const executed: string[] = [];
    const { callModel, requests } = scriptModel([
      toolResponse([{ id: 't1', name: 'echo', input: { message: 'hi' } }], { stopReason: 'end_turn' }),
      textResponse('Done.'),
    ]);
    const result = await runAgentLoop(TASK, { callModel, registry: echoRegistry(executed), runDir }, ROOMY);

    // The lying label did not end the run: the tool ran and a second turn happened.
    expect(result).toEqual({ status: 'completed', finalText: 'Done.' });
    expect(executed).toEqual(['hi']);
    expect(requests).toHaveLength(2);
  });

  it('a stop_reason claiming tool_use with no tool_use content completes — content decides', async () => {
    const { callModel, requests } = scriptModel([
      {
        content: [
          { type: 'text', text: 'First.' },
          { type: 'text', text: 'Second.' },
        ],
        stop_reason: 'tool_use',
        usage: { ...DEFAULT_USAGE },
      },
    ]);
    const result = await runAgentLoop(TASK, { callModel, registry: echoRegistry([]), runDir }, ROOMY);

    // The lying label did not extend the run — and finalText joins the text
    // blocks with newlines.
    expect(result).toEqual({ status: 'completed', finalText: 'First.\nSecond.' });
    expect(requests).toHaveLength(1);
  });

  it('a failing tool call comes back as is_error and the run continues', async () => {
    const { callModel, requests } = scriptModel([
      toolResponse([{ id: 't1', name: 'no_such_tool', input: {} }]),
      textResponse('Recovered.'),
    ]);
    const result = await runAgentLoop(TASK, { callModel, registry: echoRegistry([]), runDir }, ROOMY);

    expect(result).toEqual({ status: 'completed', finalText: 'Recovered.' });
    const feedback = requests[1][2];
    expect(feedback.role).toBe('user');
    expect(feedback.content[0]).toMatchObject({
      type: 'tool_result',
      tool_use_id: 't1',
      is_error: true,
    });
    expect((feedback.content[0] as { content: string }).content).toContain('no_such_tool');
  });

  it('several tool calls in one response run sequentially, results in request order', async () => {
    const executed: string[] = [];
    const { callModel, requests } = scriptModel([
      toolResponse([
        { id: 't1', name: 'echo', input: { message: 'first' } },
        { id: 't2', name: 'echo', input: { message: 'second' } },
      ]),
      textResponse('Done.'),
    ]);
    await runAgentLoop(TASK, { callModel, registry: echoRegistry(executed), runDir }, ROOMY);

    expect(executed).toEqual(['first', 'second']);
    expect(requests[1][2]).toEqual({
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 't1', content: 'echo: first' },
        { type: 'tool_result', tool_use_id: 't2', content: 'echo: second' },
      ],
    });
  });
});

describe('runAgentLoop guards', () => {
  it('maxTurns ends a run that would otherwise loop forever', async () => {
    const executed: string[] = [];
    const { callModel, requests } = scriptModel([
      toolResponse([{ id: 't1', name: 'echo', input: { message: 'a' } }]),
      toolResponse([{ id: 't2', name: 'echo', input: { message: 'b' } }]),
      toolResponse([{ id: 't3', name: 'echo', input: { message: 'c' } }]),
    ]);
    const result = await runAgentLoop(
      TASK,
      { callModel, registry: echoRegistry(executed), runDir },
      { maxTurns: 3, maxTokens: 1_000_000 },
    );

    expect(result).toEqual({ status: 'budget_exceeded', reason: 'max_turns' });
    expect(requests).toHaveLength(3);
    // Per the design's loop order, the final turn's tools still executed
    // before the guard ended the run.
    expect(executed).toEqual(['a', 'b', 'c']);
    // metrics.json is written on budget_exceeded endings too.
    const metrics = JSON.parse(readFileSync(join(runDir, METRICS_FILENAME), 'utf8')) as RunMetrics;
    expect(metrics).toMatchObject({ status: 'budget_exceeded', turns: 3 });
  });

  it('completing exactly at maxTurns is a completion, not budget_exceeded', async () => {
    const { callModel, requests } = scriptModel([
      toolResponse([{ id: 't1', name: 'echo', input: { message: 'a' } }]),
      toolResponse([{ id: 't2', name: 'echo', input: { message: 'b' } }]),
      textResponse('Finished on the last allowed turn.'),
    ]);
    const result = await runAgentLoop(
      TASK,
      { callModel, registry: echoRegistry([]), runDir },
      { maxTurns: 3, maxTokens: 1_000_000 },
    );

    expect(result).toEqual({ status: 'completed', finalText: 'Finished on the last allowed turn.' });
    expect(requests).toHaveLength(3);
  });

  it('one token over the budget ends the run budget_exceeded', async () => {
    // 15 tokens per turn: cumulative 30 after turn 2, one over a 29 budget.
    const { callModel, requests } = scriptModel([
      toolResponse([{ id: 't1', name: 'echo', input: { message: 'a' } }]),
      toolResponse([{ id: 't2', name: 'echo', input: { message: 'b' } }]),
      textResponse('Never reached.'),
    ]);
    const result = await runAgentLoop(
      TASK,
      { callModel, registry: echoRegistry([]), runDir },
      { maxTurns: 10, maxTokens: 29 },
    );

    expect(result).toEqual({ status: 'budget_exceeded', reason: 'token_budget' });
    expect(requests).toHaveLength(2);
  });

  it('sitting exactly at the token budget continues — the budget is spendable in full', async () => {
    // Same 15-per-turn script, budget exactly 30: turn 3 must still happen.
    const { callModel, requests } = scriptModel([
      toolResponse([{ id: 't1', name: 'echo', input: { message: 'a' } }]),
      toolResponse([{ id: 't2', name: 'echo', input: { message: 'b' } }]),
      textResponse('Made it.'),
    ]);
    const result = await runAgentLoop(
      TASK,
      { callModel, registry: echoRegistry([]), runDir },
      { maxTurns: 10, maxTokens: 30 },
    );

    expect(result).toEqual({ status: 'completed', finalText: 'Made it.' });
    expect(requests).toHaveLength(3);
  });

  it('cache_read_input_tokens count toward the budget', async () => {
    // 10 + 5 + 20 cache reads = 35 > 34; without cache reads it would be 15
    // and the loop would (wrongly) ask for an unscripted second response.
    const { callModel, requests } = scriptModel([
      toolResponse([{ id: 't1', name: 'echo', input: { message: 'a' } }], {
        usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 20 },
      }),
    ]);
    const result = await runAgentLoop(
      TASK,
      { callModel, registry: echoRegistry([]), runDir },
      { maxTurns: 10, maxTokens: 34 },
    );

    expect(result).toEqual({ status: 'budget_exceeded', reason: 'token_budget' });
    expect(requests).toHaveLength(1);
  });

  it('a final response with no tool calls completes even when it blows the budget', async () => {
    const { callModel } = scriptModel([
      textResponse('Done.', { usage: { input_tokens: 999, output_tokens: 999 } }),
    ]);
    const result = await runAgentLoop(
      TASK,
      { callModel, registry: echoRegistry([]), runDir },
      { maxTurns: 10, maxTokens: 10 },
    );

    // The answer is in hand — completion is checked before the guards.
    expect(result).toEqual({ status: 'completed', finalText: 'Done.' });
  });

  it('rejects a nonsensical config outright instead of running with it', async () => {
    const { callModel } = scriptModel([]);
    const deps = { callModel, registry: echoRegistry([]), runDir };
    await expect(runAgentLoop(TASK, deps, { maxTurns: 0, maxTokens: 100 })).rejects.toThrow(
      /maxTurns/,
    );
    await expect(runAgentLoop(TASK, deps, { maxTurns: 5, maxTokens: -1 })).rejects.toThrow(
      /maxTokens/,
    );
  });
});

describe('runAgentLoop transcript and metrics', () => {
  it('the transcript replays the full event sequence with turn stamps', async () => {
    const { callModel } = scriptModel([
      toolResponse([{ id: 't1', name: 'echo', input: { message: 'hi' } }]),
      textResponse('Done.'),
    ]);
    await runAgentLoop(TASK, { callModel, registry: echoRegistry([]), runDir }, ROOMY);

    const events = readFileSync(join(runDir, TRANSCRIPT_FILENAME), 'utf8')
      .trimEnd()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, any>);

    expect(events.map((event) => [event.type, event.turn])).toEqual([
      ['model_request', 1],
      ['model_response', 1],
      ['tool_call', 1],
      ['tool_result', 1],
      ['model_request', 2],
      ['model_response', 2],
    ]);
    // Each event carries its payload: the request the model saw, the call
    // as requested, the result as returned.
    expect(events[0].messages).toEqual([{ role: 'user', content: [{ type: 'text', text: TASK }] }]);
    expect(events[2].call).toEqual({ id: 't1', name: 'echo', input: { message: 'hi' } });
    expect(events[3].result).toEqual({ toolCallId: 't1', isError: false, content: 'echo: hi' });
    expect(events[4].messages).toHaveLength(3);
    expect(events[5].response.content).toEqual([{ type: 'text', text: 'Done.' }]);
  });

  it('metrics.json totals match the usage the fake model reported', async () => {
    const { callModel } = scriptModel([
      toolResponse([{ id: 't1', name: 'echo', input: { message: 'hi' } }], {
        usage: { input_tokens: 11, output_tokens: 7, cache_read_input_tokens: 3 },
      }),
      textResponse('Done.', { usage: { input_tokens: 13, output_tokens: 2 } }),
    ]);
    const result = await runAgentLoop(TASK, { callModel, registry: echoRegistry([]), runDir }, ROOMY);
    expect(result.status).toBe('completed');

    const metrics = JSON.parse(readFileSync(join(runDir, METRICS_FILENAME), 'utf8')) as RunMetrics;
    expect(metrics).toMatchObject({
      status: 'completed',
      turns: 2,
      inputTokens: 24,
      outputTokens: 9,
      cacheReadInputTokens: 3,
    });
    expect(metrics.wallClockMs).toBeGreaterThanOrEqual(0);
  });
});

describe('runAgentLoop with the real file tools', () => {
  const HAIKU = 'evidence gathered\nhashes pin each byte in place\nthe manifest knows\n';

  it('write_file lands on disk and in the manifest through the real pipeline', async () => {
    const { callModel, requests } = scriptModel([
      toolResponse([
        { id: 'w1', name: 'write_file', input: { file_path: 'haiku.txt', content: HAIKU } },
      ]),
      textResponse('Haiku written.'),
    ]);
    const result = await runAgentLoop(
      TASK,
      { callModel, registry: createRegistry(fileTools), runDir },
      ROOMY,
    );
    expect(result).toEqual({ status: 'completed', finalText: 'Haiku written.' });

    // The deliverable exists with the exact content...
    expect(readFileSync(join(runDir, 'haiku.txt'), 'utf8')).toBe(HAIKU);
    // ...its manifest entry records the correct hash...
    const manifest = JSON.parse(readFileSync(join(runDir, MANIFEST_FILENAME), 'utf8')) as Manifest;
    const entry = manifest.artifacts.find((artifact) => artifact.filename === 'haiku.txt');
    expect(entry?.sha256).toBe(createHash('sha256').update(HAIKU).digest('hex'));
    // ...and the model heard back through the pipeline's success result.
    const feedback = requests[1][2];
    expect(feedback.content[0]).toMatchObject({ type: 'tool_result', tool_use_id: 'w1' });
    expect((feedback.content[0] as { content: string }).content).toContain('haiku.txt');
  });
});
