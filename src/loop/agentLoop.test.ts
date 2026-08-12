import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
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
const ROOMY: LoopConfig = { maxTurns: 10, maxContextTokens: 1_000_000 };

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
      { maxTurns: 3, maxContextTokens: 1_000_000 },
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
      { maxTurns: 3, maxContextTokens: 1_000_000 },
    );

    expect(result).toEqual({ status: 'completed', finalText: 'Finished on the last allowed turn.' });
    expect(requests).toHaveLength(3);
  });

  it('one response whose context strictly exceeds the cap ends the run context_budget', async () => {
    // Per-request context = input + cache_creation + cache_read + output.
    // Turn 1 sits at 15 and passes; turn 2 reaches 30 against a 29 cap.
    const { callModel, requests } = scriptModel([
      toolResponse([{ id: 't1', name: 'echo', input: { message: 'a' } }]),
      toolResponse([{ id: 't2', name: 'echo', input: { message: 'b' } }], {
        usage: { input_tokens: 20, output_tokens: 10 },
      }),
      textResponse('Never reached.'),
    ]);
    const result = await runAgentLoop(
      TASK,
      { callModel, registry: echoRegistry([]), runDir },
      { maxTurns: 10, maxContextTokens: 29 },
    );

    expect(result).toEqual({ status: 'budget_exceeded', reason: 'context_budget' });
    expect(requests).toHaveLength(2);
  });

  it('a response sitting exactly at the context cap continues — the cap is spendable in full', async () => {
    // Turn 1's context is exactly 30 against a 30 cap: turn 2 must happen.
    const { callModel, requests } = scriptModel([
      toolResponse([{ id: 't1', name: 'echo', input: { message: 'a' } }], {
        usage: { input_tokens: 20, output_tokens: 10 },
      }),
      textResponse('Made it.'),
    ]);
    const result = await runAgentLoop(
      TASK,
      { callModel, registry: echoRegistry([]), runDir },
      { maxTurns: 10, maxContextTokens: 30 },
    );

    expect(result).toEqual({ status: 'completed', finalText: 'Made it.' });
    expect(requests).toHaveLength(2);
  });

  it("cache reads and cache writes count toward a response's context", async () => {
    // 10 in + 5 out + 20 cache reads + 10 cache writes = 45 > 44; without
    // the cache fields it would be 15 and the loop would (wrongly) ask for
    // an unscripted second response.
    const { callModel, requests } = scriptModel([
      toolResponse([{ id: 't1', name: 'echo', input: { message: 'a' } }], {
        usage: {
          input_tokens: 10,
          output_tokens: 5,
          cache_read_input_tokens: 20,
          cache_creation_input_tokens: 10,
        },
      }),
    ]);
    const result = await runAgentLoop(
      TASK,
      { callModel, registry: echoRegistry([]), runDir },
      { maxTurns: 10, maxContextTokens: 44 },
    );

    expect(result).toEqual({ status: 'budget_exceeded', reason: 'context_budget' });
    expect(requests).toHaveLength(1);
  });

  it('a run whose cumulative tokens far exceed the cap completes when every request stays under', async () => {
    // Five turns at 15 context each: cumulative 75 against a 20 cap. The
    // old cumulative guard would have died on turn 2; the per-request
    // guard never trips because no single request exceeds the cap.
    const { callModel, requests } = scriptModel([
      toolResponse([{ id: 't1', name: 'echo', input: { message: 'a' } }]),
      toolResponse([{ id: 't2', name: 'echo', input: { message: 'b' } }]),
      toolResponse([{ id: 't3', name: 'echo', input: { message: 'c' } }]),
      toolResponse([{ id: 't4', name: 'echo', input: { message: 'd' } }]),
      textResponse('Deep run finished.'),
    ]);
    const result = await runAgentLoop(
      TASK,
      { callModel, registry: echoRegistry([]), runDir },
      { maxTurns: 10, maxContextTokens: 20 },
    );

    expect(result).toEqual({ status: 'completed', finalText: 'Deep run finished.' });
    expect(requests).toHaveLength(5);
  });

  it('a final response with no tool calls completes even when it blows the context cap', async () => {
    const { callModel } = scriptModel([
      textResponse('Done.', { usage: { input_tokens: 999, output_tokens: 999 } }),
    ]);
    const result = await runAgentLoop(
      TASK,
      { callModel, registry: echoRegistry([]), runDir },
      { maxTurns: 10, maxContextTokens: 10 },
    );

    // The answer is in hand — completion is checked before the guards.
    expect(result).toEqual({ status: 'completed', finalText: 'Done.' });
  });

  it('maxTurns: Infinity never trips — the run follows its trajectory to completion', async () => {
    // Twelve tool turns then a completion: a finite-only guard would have
    // rejected the config or cut the run; uncapped, the context ceiling is
    // what guarantees termination (context grows every turn).
    const executed: string[] = [];
    const { callModel, requests } = scriptModel([
      ...Array.from({ length: 12 }, (_, i) =>
        toolResponse([{ id: `t${i + 1}`, name: 'echo', input: { message: `m${i + 1}` } }]),
      ),
      textResponse('Trajectory complete.'),
    ]);
    const result = await runAgentLoop(
      TASK,
      { callModel, registry: echoRegistry(executed), runDir },
      { maxTurns: Infinity, maxContextTokens: 1_000_000 },
    );

    expect(result).toEqual({ status: 'completed', finalText: 'Trajectory complete.' });
    expect(requests).toHaveLength(13);
    expect(executed).toHaveLength(12);
  });

  it('rejects a nonsensical config outright instead of running with it', async () => {
    const { callModel } = scriptModel([]);
    const deps = { callModel, registry: echoRegistry([]), runDir };
    await expect(runAgentLoop(TASK, deps, { maxTurns: 0, maxContextTokens: 100 })).rejects.toThrow(
      /maxTurns/,
    );
    await expect(runAgentLoop(TASK, deps, { maxTurns: 5, maxContextTokens: -1 })).rejects.toThrow(
      /maxContextTokens/,
    );
  });
});

describe('runAgentLoop transcript and metrics', () => {
  it('the transcript replays the full event sequence with turn stamps', async () => {
    const { callModel } = scriptModel([
      toolResponse([{ id: 't1', name: 'echo', input: { message: 'hi' } }]),
      // Turn 2 reports cache reads (as a healthy prefix would) so the
      // sequence stays free of cache_miss_warning events — those have
      // their own test below.
      textResponse('Done.', {
        usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 40 },
      }),
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
        usage: {
          input_tokens: 11,
          output_tokens: 7,
          cache_read_input_tokens: 3,
          cache_creation_input_tokens: 9,
        },
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
      cacheCreationInputTokens: 9,
      // Turn 1's context (11 + 9 + 3 + 7 = 30) beats turn 2's (13 + 2 = 15).
      peakContextTokens: 30,
    });
    expect(metrics.wallClockMs).toBeGreaterThanOrEqual(0);
  });

  it('appends cache_miss_warning for turns >= 2 with zero cache reads — and only those', async () => {
    // Turn 1 never warns (nothing is cached yet); turn 2 reads cache and
    // stays quiet; turn 3 reports zero reads — the prefix broke — and the
    // warning lands in the transcript even though the run completes there.
    const { callModel } = scriptModel([
      toolResponse([{ id: 't1', name: 'echo', input: { message: 'a' } }]),
      toolResponse([{ id: 't2', name: 'echo', input: { message: 'b' } }], {
        usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 40 },
      }),
      textResponse('Done.'),
    ]);
    await runAgentLoop(TASK, { callModel, registry: echoRegistry([]), runDir }, ROOMY);

    const warnings = readFileSync(join(runDir, TRANSCRIPT_FILENAME), 'utf8')
      .trimEnd()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((event) => event.type === 'cache_miss_warning');
    expect(warnings).toEqual([{ type: 'cache_miss_warning', turn: 3 }]);
  });

  it('a mid-run crash writes failed metrics, logs run_error, and rethrows unchanged', async () => {
    // Crash bookkeeping, not a retry loop: the run that spent turn 1's
    // budget must not vanish from metrics because turn 2's model call blew
    // up — and every caller still sees exactly the original rejection.
    const scripted = scriptModel([
      toolResponse([{ id: 't1', name: 'echo', input: { message: 'hi' } }]),
    ]);
    const boom = new Error('overloaded_error: upstream fell over mid-stream');
    let modelCalls = 0;
    const callModel = async (messages: readonly Message[]): Promise<ModelResponse> => {
      modelCalls += 1;
      if (modelCalls === 2) throw boom;
      return scripted.callModel(messages);
    };

    await expect(
      runAgentLoop(TASK, { callModel, registry: echoRegistry([]), runDir }, ROOMY),
    ).rejects.toBe(boom);

    // Metrics carry the crash status and everything the run earned before it.
    const metrics = JSON.parse(readFileSync(join(runDir, METRICS_FILENAME), 'utf8')) as RunMetrics;
    expect(metrics).toMatchObject({
      status: 'failed',
      turns: 2, // the crash happened on turn 2
      inputTokens: 10, // turn 1's usage only — turn 2 never reported any
      outputTokens: 5,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      peakContextTokens: 15,
    });
    expect(metrics.wallClockMs).toBeGreaterThanOrEqual(0);

    // The transcript ends with the run_error event.
    const events = readFileSync(join(runDir, TRANSCRIPT_FILENAME), 'utf8')
      .trimEnd()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(events.at(-1)).toEqual({
      type: 'run_error',
      turn: 2,
      message: 'overloaded_error: upstream fell over mid-stream',
    });
  });

  it('an abort gets no crash bookkeeping — cancelled is "stopped", not "crashed"', async () => {
    // The design's cancellation artifact contract: a cancelled run keeps
    // its finalized manifest but no metrics.json, so the /runs browser can
    // tell a stop from a crash. The bridge normalizes post-abort failures
    // to this error name.
    const cancelled = Object.assign(new Error('run cancelled'), { name: 'AbortError' });
    const callModel = (): Promise<ModelResponse> => Promise.reject(cancelled);

    await expect(
      runAgentLoop(TASK, { callModel, registry: echoRegistry([]), runDir }, ROOMY),
    ).rejects.toBe(cancelled);

    expect(existsSync(join(runDir, METRICS_FILENAME))).toBe(false);
    const transcript = readFileSync(join(runDir, TRANSCRIPT_FILENAME), 'utf8');
    expect(transcript).not.toContain('run_error');
  });
});

describe('runAgentLoop per-message batch cap', () => {
  /** A registry with one read-only `blob` tool returning `size` bytes of x —
   * each result legal under the 50k per-result cap, so only the batch cap
   * can touch them. */
  function blobRegistry(): ToolRegistry {
    const blob: ToolDef<{ size: number }> = {
      name: 'blob',
      description: 'Return size bytes of filler.',
      inputSchema: z.object({ size: z.number().int().positive() }),
      readOnly: true,
      execute: async (input) => 'x'.repeat(input.size),
    };
    return createRegistry([blob as ToolDef]);
  }

  function blobCalls(sizes: number[]): Array<{ id: string; name: string; input: unknown }> {
    return sizes.map((size, index) => ({ id: `t${index + 1}`, name: 'blob', input: { size } }));
  }

  it('a batch at or under 200k bytes passes through untouched', async () => {
    const { callModel, requests } = scriptModel([
      toolResponse(blobCalls([45_000, 45_000, 45_000, 45_000])), // 180k combined
      textResponse('Done.'),
    ]);
    await runAgentLoop(TASK, { callModel, registry: blobRegistry(), runDir }, ROOMY);

    const feedback = requests[1][2];
    expect(feedback.content).toHaveLength(4);
    for (const block of feedback.content) {
      expect((block as { content: string }).content).toBe('x'.repeat(45_000));
    }
  });

  it('offloads the largest results first until the batch fits, previews and hashes preserved', async () => {
    // 45k + 44k + 4×40k = 249k > 200k. One offload leaves ~206k (still
    // over), so the two largest go to disk — largest first — and the four
    // 40k results stay inline.
    const { callModel, requests } = scriptModel([
      toolResponse(blobCalls([45_000, 44_000, 40_000, 40_000, 40_000, 40_000])),
      textResponse('Done.'),
    ]);
    await runAgentLoop(TASK, { callModel, registry: blobRegistry(), runDir }, ROOMY);

    const feedback = requests[1][2];
    const contents = feedback.content.map((block) => (block as { content: string }).content);

    // The two largest were replaced by capResult-shaped offload previews,
    // largest first (the 45k result claimed the first offload file)...
    const first = JSON.parse(contents[0]) as { preview: string; offloadedTo: string; note: string };
    const second = JSON.parse(contents[1]) as { preview: string; offloadedTo: string; note: string };
    expect(first.offloadedTo).toBe('tool-output/blob-1.txt');
    expect(second.offloadedTo).toBe('tool-output/blob-2.txt');
    expect(first.note).toContain('combined limit');
    expect(first.preview.length).toBeGreaterThan(0);
    // ...each offloaded file holds the complete original output...
    expect(readFileSync(join(runDir, first.offloadedTo), 'utf8')).toBe('x'.repeat(45_000));
    expect(readFileSync(join(runDir, second.offloadedTo), 'utf8')).toBe('x'.repeat(44_000));
    // ...the smaller results passed through untouched...
    for (const content of contents.slice(2)) {
      expect(content).toBe('x'.repeat(40_000));
    }
    // ...the batch the model sees now fits...
    const combined = contents.reduce((sum, content) => sum + content.length, 0);
    expect(combined).toBeLessThanOrEqual(200_000);
    // ...the manifest hashed both offloaded files...
    const manifest = JSON.parse(readFileSync(join(runDir, MANIFEST_FILENAME), 'utf8')) as Manifest;
    for (const relPath of [first.offloadedTo, second.offloadedTo]) {
      expect(manifest.artifacts.some((artifact) => artifact.filename === relPath)).toBe(true);
    }
    // ...and the transcript recorded results as the model sees them.
    const toolResults = readFileSync(join(runDir, TRANSCRIPT_FILENAME), 'utf8')
      .trimEnd()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, any>)
      .filter((event) => event.type === 'tool_result');
    expect(toolResults[0].result.content).toBe(contents[0]);
    expect(toolResults[2].result.content).toBe(contents[2]);
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
