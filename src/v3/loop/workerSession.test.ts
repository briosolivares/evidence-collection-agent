import {
  mkdtempSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import type {
  Message,
  ToolResultBlock,
  Usage,
} from '../../loop/messages.js';
import {
  ModelGenerationFailedError,
  ModelResponseRejectedError,
  type AcceptedModelResponse,
  type ModelDriver,
  type ModelGenerateOptions,
} from '../../model/modelDriver.js';
import { initManifest, readManifest } from '../../run/artifacts.js';
import {
  captureRunBudgetSnapshot,
  createRunBudgetTracker,
  type RunBudgetConfig,
} from '../../run/runBudget.js';
import {
  createRegistry,
  type ToolCtx,
  type ToolDef,
} from '../../tools/registry.js';
import { finishTool, type FinishInput } from '../tools/finish.js';
import {
  V3_MAX_PROTOCOL_CORRECTIONS,
  V3_NO_TOOL_CONTINUATION,
  appendV3FinishResult,
  appendV3WorkerFeedback,
  captureV3WorkerSessionSnapshot,
  createV3WorkerSession,
  dropV3UnansweredAssistantTurn,
  readV3WorkerMetrics,
  restoreV3WorkerSession,
  runV3WorkerTurn,
  writeV3WorkerMetrics,
  type V3WorkerSession,
  type V3WorkerSessionDeps,
} from './workerSession.js';

let runDir: string;

beforeEach(() => {
  runDir = mkdtempSync(join(tmpdir(), 'sherlock-v3-worker-'));
  initManifest(runDir, 'test the v3 sequential worker');
});

afterEach(() => {
  rmSync(runDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

const UNBOUNDED: RunBudgetConfig = {
  maxWorkerTurns: Infinity,
  maxToolCalls: Infinity,
  maxModelTokens: Infinity,
  maxToolResultBytes: Infinity,
  maxWallTimeMs: Infinity,
  maxVerifierCorrections: Infinity,
};

const USAGE: Usage = {
  input_tokens: 10,
  output_tokens: 5,
  cache_read_input_tokens: 2,
  cache_creation_input_tokens: 1,
};

const VALID_FINISH: FinishInput = {
  summary: 'The requested report and evidence were published.',
  artifacts: ['artifacts/report.csv'],
  limitations: [],
};

function accepted(
  content: AcceptedModelResponse['response']['content'],
  options: {
    usage?: Usage;
    aggregateUsage?: Usage;
    stopReason?: AcceptedModelResponse['stopReason'];
  } = {},
): AcceptedModelResponse {
  const usage = options.usage ?? USAGE;
  const stopReason = options.stopReason ?? 'end_turn';
  return {
    response: { content, stop_reason: stopReason, usage },
    stopReason,
    attempts: 1,
    usage: options.aggregateUsage ?? usage,
  };
}

function scriptedDriver(
  steps: Array<
    | AcceptedModelResponse
    | Error
    | ((options: ModelGenerateOptions) => AcceptedModelResponse | Promise<AcceptedModelResponse>)
  >,
): ModelDriver & { generate: ReturnType<typeof vi.fn> } {
  const generate = vi.fn(async (options: ModelGenerateOptions) => {
    const step = steps.shift();
    if (step === undefined) throw new Error('scripted model exhausted');
    if (step instanceof Error) throw step;
    return typeof step === 'function' ? await step(options) : step;
  });
  return { generate };
}

function tool(
  name: string,
  execute: ToolDef<{ label?: string }>['execute'],
  maxBytes?: number,
): ToolDef<{ label?: string }> {
  return {
    name,
    description: `${name} test tool`,
    inputSchema: z.strictObject({ label: z.string().optional() }),
    getAccess: () => ({ reads: [], writes: [], exclusive: true }),
    ...(maxBytes === undefined ? {} : { maxBytes }),
    execute,
  };
}

function session(
  model: ModelDriver,
  tools: readonly ToolDef[] = [],
  options: {
    budget?: Partial<RunBudgetConfig>;
    maxContextTokens?: number;
    deps?: Partial<V3WorkerSessionDeps>;
    budgetNow?: () => number;
  } = {},
): V3WorkerSession {
  const budget = createRunBudgetTracker(
    { ...UNBOUNDED, ...options.budget },
    options.budgetNow === undefined ? {} : { now: options.budgetNow },
  );
  return createV3WorkerSession(
    'Collect the requested evidence.',
    {
      model,
      registry: createRegistry(tools),
      runDir,
      ...options.deps,
    },
    {
      budget,
      maxContextTokens: options.maxContextTokens ?? Infinity,
    },
    { guidance: ['Expected output: artifacts/report.csv'] },
  );
}

function lastResults(worker: V3WorkerSession): ToolResultBlock[] {
  const message = worker.state.messages.at(-1);
  if (message?.role !== 'user') throw new Error('expected trailing user result message');
  return message.content.filter(
    (block): block is ToolResultBlock => block.type === 'tool_result',
  );
}

function transcript(): Array<Record<string, unknown>> {
  return readFileSync(join(runDir, 'transcript.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe('v3 ordinary response execution', () => {
  it('uses content rather than stop_reason and executes every call serially in result order', async () => {
    const events: string[] = [];
    let active = false;
    const exploding = tool('explode', () => {
      events.push('explode');
      throw new Error('expected failure');
    });
    const ordered = tool('ordered', async (input) => {
      expect(active).toBe(false);
      active = true;
      events.push(`start:${input.label}`);
      await Promise.resolve();
      events.push(`end:${input.label}`);
      active = false;
      return `result:${input.label}`;
    });
    const model = scriptedDriver([
      accepted(
        [
          { type: 'tool_use', id: 'one', name: 'explode', input: {} },
          {
            type: 'tool_use',
            id: 'two',
            name: 'ordered',
            input: { label: 'two' },
          },
          {
            type: 'tool_use',
            id: 'three',
            name: 'ordered',
            input: { label: 'three' },
          },
        ],
        { stopReason: 'end_turn' },
      ),
    ]);
    const worker = session(model, [exploding, ordered]);

    await expect(runV3WorkerTurn(worker)).resolves.toEqual({ kind: 'working' });

    expect(events).toEqual([
      'explode',
      'start:two',
      'end:two',
      'start:three',
      'end:three',
    ]);
    const results = lastResults(worker);
    expect(results.map((result) => result.tool_use_id)).toEqual([
      'one',
      'two',
      'three',
    ]);
    expect(results[0]).toMatchObject({ is_error: true });
    expect(results[1]?.content).toBe('result:two');
    expect(results[2]?.content).toBe('result:three');
    expect(
      transcript().filter((event) => event.type === 'tool_result'),
    ).toHaveLength(3);
  });

  it('treats a prose-only response as working even when stop_reason says tool_use', async () => {
    const worker = session(
      scriptedDriver([
        accepted([{ type: 'text', text: 'I am still researching.' }], {
          stopReason: 'tool_use',
        }),
      ]),
    );

    await expect(runV3WorkerTurn(worker)).resolves.toEqual({ kind: 'working' });

    expect(worker.state.messages.at(-1)).toEqual({
      role: 'user',
      content: [{ type: 'text', text: V3_NO_TOOL_CONTINUATION }],
    });
  });
});

describe('v3 finish protocol', () => {
  it('rejects mixed finish without executing anything and answers every call', async () => {
    const execute = vi.fn(() => 'must not run');
    const ordinary = tool('ordinary', execute);
    const worker = session(
      scriptedDriver([
        accepted([
          { type: 'tool_use', id: 'before', name: 'ordinary', input: {} },
          {
            type: 'tool_use',
            id: 'finish',
            name: 'finish',
            input: VALID_FINISH,
          },
          { type: 'tool_use', id: 'after', name: 'ordinary', input: {} },
        ]),
      ]),
      [ordinary, finishTool],
    );

    await expect(runV3WorkerTurn(worker)).resolves.toEqual({ kind: 'working' });

    expect(execute).not.toHaveBeenCalled();
    const results = lastResults(worker);
    expect(results.map((result) => result.tool_use_id)).toEqual([
      'before',
      'finish',
      'after',
    ]);
    expect(results.every((result) => result.is_error === true)).toBe(true);
    expect(results[1]?.content).toContain('finish must be the only tool call');
    expect(
      transcript().filter((event) => event.type === 'tool_call'),
    ).toHaveLength(3);
    const budget = captureRunBudgetSnapshot(worker.config.budget);
    expect(budget.toolCalls).toBe(3);
    expect(budget.toolResultBytes).toBeGreaterThan(0);
  });

  it('returns invalid finish input as a bounded invalid_input result', async () => {
    const worker = session(
      scriptedDriver([
        accepted([
          {
            type: 'tool_use',
            id: 'bad-finish',
            name: 'finish',
            input: { summary: '', artifacts: [], limitations: [] },
          },
        ]),
      ]),
      [finishTool],
    );

    await expect(runV3WorkerTurn(worker)).resolves.toEqual({ kind: 'working' });

    expect(lastResults(worker)).toEqual([
      expect.objectContaining({
        tool_use_id: 'bad-finish',
        is_error: true,
        content: expect.stringContaining('Invalid input for tool "finish"'),
      }),
    ]);
  });

  it('intercepts valid exclusive finish and appends check/verifier feedback to that call', async () => {
    const worker = session(
      scriptedDriver([
        accepted([
          { type: 'text', text: 'Ready for review.' },
          {
            type: 'tool_use',
            id: 'finish-1',
            name: 'finish',
            input: VALID_FINISH,
          },
        ]),
      ]),
      [finishTool],
    );

    const outcome = await runV3WorkerTurn(worker);
    expect(outcome).toMatchObject({
      kind: 'finish_requested',
      request: {
        turn: 1,
        input: VALID_FINISH,
        assistantText: 'Ready for review.',
      },
    });
    if (outcome.kind !== 'finish_requested') throw new Error('expected finish');

    await appendV3FinishResult(
      worker,
      outcome.request,
      'Verifier found one missing source URL.',
    );

    expect(lastResults(worker)).toEqual([
      {
        type: 'tool_result',
        tool_use_id: 'finish-1',
        content: 'Verifier found one missing source URL.',
        is_error: true,
      },
    ]);
    expect(captureRunBudgetSnapshot(worker.config.budget)).toMatchObject({
      toolCalls: 1,
      toolResultBytes: Buffer.byteLength(
        'Verifier found one missing source URL.',
      ),
    });
  });
});

describe('v3 rejection and guards', () => {
  it('charges known usage on a fatal retry failure without accepting content', async () => {
    const fatal = new ModelGenerationFailedError(
      new Error('replacement transport failed'),
      { input_tokens: 7, output_tokens: 3 },
    );
    const worker = session(scriptedDriver([fatal]));

    await expect(runV3WorkerTurn(worker)).rejects.toBe(fatal);
    expect(worker.config.budget.roleUsage().worker).toMatchObject({
      turns: 1,
      inputTokens: 7,
      outputTokens: 3,
    });
    expect(worker.state.messages).toHaveLength(1);
  });

  it('allows exactly three correctable model rejections, then ends incomplete', async () => {
    const rejections = Array.from(
      { length: V3_MAX_PROTOCOL_CORRECTIONS + 1 },
      () =>
        new ModelResponseRejectedError(
          'malformed_tool_call',
          'malformed call',
          'Issue a valid tool call.',
          { input_tokens: 2, output_tokens: 1 },
        ),
    );
    const worker = session(scriptedDriver(rejections));

    for (let index = 0; index < V3_MAX_PROTOCOL_CORRECTIONS; index += 1) {
      await expect(runV3WorkerTurn(worker)).resolves.toEqual({ kind: 'working' });
    }
    await expect(runV3WorkerTurn(worker)).resolves.toMatchObject({
      kind: 'incomplete',
      reason: 'model_rejection_limit',
      modelRejection: 'malformed_tool_call',
    });

    expect(worker.protocolCorrections).toBe(V3_MAX_PROTOCOL_CORRECTIONS);
    expect(worker.state.messages).toHaveLength(1 + V3_MAX_PROTOCOL_CORRECTIONS);
    expect(worker.config.budget.roleUsage().worker?.turns).toBe(4);
    expect(
      worker.state.messages.some((message) => message.role === 'assistant'),
    ).toBe(false);
  });

  it.each([
    {
      name: 'turn',
      budget: { maxWorkerTurns: 1 },
      maxContextTokens: Infinity,
      usage: USAGE,
      reason: 'max_turns',
    },
    {
      name: 'model-token',
      budget: { maxModelTokens: 1 },
      maxContextTokens: Infinity,
      usage: { input_tokens: 1, output_tokens: 1 },
      reason: 'model_tokens',
    },
    {
      name: 'context',
      budget: {},
      maxContextTokens: 1,
      usage: { input_tokens: 1, output_tokens: 1 },
      reason: 'context_budget',
    },
  ])('enforces the $name guard after an accepted no-tool turn', async (entry) => {
    const worker = session(
      scriptedDriver([
        accepted([{ type: 'text', text: 'continuing' }], { usage: entry.usage }),
      ]),
      [],
      {
        budget: entry.budget,
        maxContextTokens: entry.maxContextTokens,
      },
    );

    await expect(runV3WorkerTurn(worker)).resolves.toEqual({
      kind: 'incomplete',
      reason: entry.reason,
    });
  });

  it.each([
    { budget: { maxToolCalls: 0 }, reason: 'tool_calls' },
    { budget: { maxToolResultBytes: 0 }, reason: 'tool_result_bytes' },
  ])('returns every result before enforcing $reason', async ({ budget, reason }) => {
    const worker = session(
      scriptedDriver([
        accepted([{ type: 'tool_use', id: 'call', name: 'small', input: {} }]),
      ]),
      [tool('small', () => 'one result')],
      { budget },
    );

    await expect(runV3WorkerTurn(worker)).resolves.toEqual({
      kind: 'incomplete',
      reason,
    });
    expect(lastResults(worker)).toHaveLength(1);
  });

  it('enforces elapsed wall time without resetting the shared clock', async () => {
    let clock = 0;
    const worker = session(
      scriptedDriver([
        () => {
          clock = 2;
          return accepted([{ type: 'text', text: 'continuing' }]);
        },
      ]),
      [],
      {
        budget: { maxWallTimeMs: 1 },
        budgetNow: () => clock,
        deps: { now: () => clock },
      },
    );

    await expect(runV3WorkerTurn(worker)).resolves.toEqual({
      kind: 'incomplete',
      reason: 'wall_time',
    });
  });

  it('charges aggregate driver usage while measuring context from the accepted response only', async () => {
    const worker = session(
      scriptedDriver([
        accepted([{ type: 'text', text: 'continuing' }], {
          usage: { input_tokens: 2, output_tokens: 3 },
          aggregateUsage: { input_tokens: 102, output_tokens: 53 },
        }),
      ]),
      [],
      { maxContextTokens: 10 },
    );

    await expect(runV3WorkerTurn(worker)).resolves.toEqual({ kind: 'working' });
    expect(worker.peakContextTokens).toBe(5);
    expect(worker.config.budget.totalModelTokens()).toBe(155);
  });
});

describe('v3 result bounds, cancellation, and lifecycle', () => {
  it('freezes both per-result and combined offloads in stored history', async () => {
    const smallCap = tool('small_cap', () => 's'.repeat(2_000), 100);
    const large = tool('large', () => 'x'.repeat(45_000));
    const calls = [
      { type: 'tool_use' as const, id: 'small', name: 'small_cap', input: {} },
      ...Array.from({ length: 5 }, (_, index) => ({
        type: 'tool_use' as const,
        id: `large-${index}`,
        name: 'large',
        input: {},
      })),
    ];
    const worker = session(scriptedDriver([accepted(calls)]), [smallCap, large]);

    await expect(runV3WorkerTurn(worker)).resolves.toEqual({ kind: 'working' });

    const results = lastResults(worker);
    expect(results).toHaveLength(6);
    expect(
      results.filter(
        (result) =>
          typeof result.content === 'string' &&
          result.content.includes('"offloadedTo"'),
      ).length,
    ).toBeGreaterThanOrEqual(2);
    expect(
      results.reduce(
        (sum, result) =>
          sum + Buffer.byteLength(result.content as string, 'utf8'),
        0,
      ),
    ).toBeLessThanOrEqual(200_000);
    expect(
      readManifest(runDir).artifacts.filter((entry) =>
        entry.filename.startsWith('scratch/tool-output/'),
      ).length,
    ).toBeGreaterThanOrEqual(2);

    const frozen = structuredClone(worker.state.messages);
    expect(worker.state.messages).toEqual(frozen);
  });

  it('passes one AbortSignal to model and tool and stops before later calls', async () => {
    const controller = new AbortController();
    let startTool!: () => void;
    const toolStarted = new Promise<void>((resolve) => {
      startTool = resolve;
    });
    let receivedToolSignal: AbortSignal | undefined;
    const cancellable = tool('cancellable', async (_input, ctx) => {
      receivedToolSignal = ctx.abortSignal;
      startTool();
      await new Promise<never>((_resolve, reject) => {
        ctx.abortSignal?.addEventListener(
          'abort',
          () => reject(ctx.abortSignal?.reason),
          { once: true },
        );
      });
    });
    const later = vi.fn(() => 'later');
    const model = scriptedDriver([
      (options) => {
        expect(options.signal).toBe(controller.signal);
        return accepted([
          { type: 'tool_use', id: 'first', name: 'cancellable', input: {} },
          { type: 'tool_use', id: 'later', name: 'later', input: {} },
        ]);
      },
    ]);
    const worker = session(model, [cancellable, tool('later', later)], {
      deps: { signal: controller.signal },
    });

    const running = runV3WorkerTurn(worker);
    await toolStarted;
    controller.abort();

    await expect(running).rejects.toMatchObject({ name: 'AbortError' });
    expect(receivedToolSignal).toBe(controller.signal);
    expect(later).not.toHaveBeenCalled();
  });

  it('awaits lifecycle boundaries around every call and converts a pre-dispatch failure only', async () => {
    const events: string[] = [];
    const execute = vi.fn((input: { label?: string }) => {
      events.push(`execute:${input.label}`);
      return `done:${input.label}`;
    });
    const worker = session(
      scriptedDriver([
        accepted([
          { type: 'tool_use', id: 'one', name: 'work', input: { label: 'one' } },
          { type: 'tool_use', id: 'two', name: 'work', input: { label: 'two' } },
        ]),
      ]),
      [tool('work', execute)],
      {
        deps: {
          lifecycle: {
            beforeCall: async (pending) => {
              events.push(`before:${pending.nextCallIndex}:${pending.effect}`);
              if (pending.nextCallIndex === 0) throw new Error('checkpoint unavailable');
            },
            afterDispatch: async (pending) => {
              events.push(`dispatch:${pending.nextCallIndex}:${pending.effect}`);
            },
            afterResult: async (pending) => {
              events.push(`result:${pending.nextCallIndex}:${pending.completedResults.length}`);
            },
          },
        },
      },
    );

    await expect(runV3WorkerTurn(worker)).resolves.toEqual({ kind: 'working' });

    expect(events).toEqual([
      'before:0:not_started',
      'result:1:1',
      'before:1:not_started',
      'dispatch:1:uncertain',
      'execute:two',
      'result:2:2',
    ]);
    expect(execute).toHaveBeenCalledOnce();
    expect(lastResults(worker)[0]).toMatchObject({ is_error: true });
  });

  it('propagates post-effect persistence failure and does not run the next call', async () => {
    const execute = vi.fn((input: { label?: string }) => `done:${input.label}`);
    const worker = session(
      scriptedDriver([
        accepted([
          { type: 'tool_use', id: 'one', name: 'work', input: { label: 'one' } },
          { type: 'tool_use', id: 'two', name: 'work', input: { label: 'two' } },
        ]),
      ]),
      [tool('work', execute)],
      {
        deps: {
          lifecycle: {
            afterResult: async () => {
              throw new Error('checkpoint write failed');
            },
          },
        },
      },
    );

    await expect(runV3WorkerTurn(worker)).rejects.toThrow('checkpoint write failed');
    expect(execute).toHaveBeenCalledOnce();
    expect(worker.state.messages.at(-1)?.role).toBe('assistant');
  });
});

describe('v3 snapshots and metrics', () => {
  it('deep-copies capture/restore state and can drop a trailing unanswered turn', async () => {
    const worker = session(
      scriptedDriver([
        accepted([
          {
            type: 'tool_use',
            id: 'finish',
            name: 'finish',
            input: VALID_FINISH,
          },
        ]),
      ]),
      [finishTool],
    );
    await runV3WorkerTurn(worker);
    const snapshot = captureV3WorkerSessionSnapshot(worker);

    appendV3WorkerFeedback(worker, 'later mutation');
    expect(JSON.stringify(snapshot.messages)).not.toContain('later mutation');

    const restored = restoreV3WorkerSession(snapshot, worker.deps, worker.config);
    expect(dropV3UnansweredAssistantTurn(restored)).toBe(true);
    expect(restored.state.turnCount).toBe(1);
    expect(dropV3UnansweredAssistantTurn(restored)).toBe(false);
    expect(snapshot.messages.at(-1)?.role).toBe('assistant');
  });

  it('reports and writes aggregate metrics from the persistent budget', async () => {
    let clock = 100;
    const worker = session(
      scriptedDriver([
        accepted([{ type: 'text', text: 'continuing' }]),
      ]),
      [],
      { deps: { now: () => clock } },
    );
    await runV3WorkerTurn(worker);
    clock = 175;

    const metrics = readV3WorkerMetrics(worker, 'incomplete');
    expect(metrics).toMatchObject({
      status: 'incomplete',
      turns: 1,
      inputTokens: 10,
      outputTokens: 5,
      peakContextTokens: 18,
      wallClockMs: 75,
    });

    writeV3WorkerMetrics(worker, 'incomplete');
    expect(
      JSON.parse(readFileSync(join(runDir, 'metrics.json'), 'utf8')),
    ).toEqual(metrics);
  });
});
