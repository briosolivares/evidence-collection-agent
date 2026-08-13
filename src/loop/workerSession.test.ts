import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { initManifest } from '../run/artifacts.js';
import { createRunBudgetTracker, type RunBudgetConfig } from '../run/runBudget.js';
import { createRegistry, type ToolDef, type ToolRegistry } from '../tools/registry.js';
import type { Message, ModelResponse, Usage } from './messages.js';
import {
  appendWorkerFeedback,
  createWorkerSession,
  METRICS_FILENAME,
  runWorkerCycle,
  runWorkerTurn,
  writeWorkerSessionMetrics,
  type RunMetrics,
  type WorkerSession,
} from './workerSession.js';

// Session-level tests for what T2 changes: one persistent conversation
// across correction cycles, and one shared unresettable budget. The loop's
// per-turn semantics (completion policy, guards, transcript, batch caps)
// stay covered by agentLoop.test.ts through the compatibility wrapper.

const TASK = 'Do the scripted thing.';
const DEFAULT_USAGE: Usage = { input_tokens: 10, output_tokens: 5 };

const UNBOUNDED: RunBudgetConfig = {
  maxWorkerTurns: Infinity,
  maxToolCalls: Infinity,
  maxModelTokens: Infinity,
  maxToolResultBytes: Infinity,
  maxWallTimeMs: Infinity,
  maxVerifierCorrections: Infinity,
};

function textResponse(text: string): ModelResponse {
  return {
    content: [{ type: 'text', text }],
    stop_reason: 'end_turn',
    usage: { ...DEFAULT_USAGE },
  };
}

function toolResponse(id: string): ModelResponse {
  return {
    content: [{ type: 'tool_use', id, name: 'echo', input: { message: id } }],
    stop_reason: 'tool_use',
    usage: { ...DEFAULT_USAGE },
  };
}

function scriptModel(responses: ModelResponse[]): {
  callModel: (messages: readonly Message[]) => Promise<ModelResponse>;
  requests: Message[][];
} {
  const requests: Message[][] = [];
  const callModel = async (messages: readonly Message[]): Promise<ModelResponse> => {
    requests.push(structuredClone(messages) as Message[]);
    const next = responses[requests.length - 1];
    if (next === undefined) throw new Error('script exhausted');
    return next;
  };
  return { callModel, requests };
}

function echoRegistry(): ToolRegistry {
  const echo: ToolDef<{ message: string }> = {
    name: 'echo',
    description: 'Echo the message back.',
    inputSchema: z.object({ message: z.string() }),
    readOnly: true,
    execute: async (input) => `echo: ${input.message}`,
  };
  return createRegistry([echo as ToolDef]);
}

let runDir: string;

beforeEach(() => {
  runDir = mkdtempSync(join(tmpdir(), 'worker-session-test-'));
  initManifest(runDir, TASK);
});

afterEach(() => {
  rmSync(runDir, { recursive: true, force: true });
});

function makeSession(
  responses: ModelResponse[],
  budgetOverrides: Partial<RunBudgetConfig> = {},
): { session: WorkerSession; requests: Message[][] } {
  const { callModel, requests } = scriptModel(responses);
  const budget = createRunBudgetTracker({ ...UNBOUNDED, ...budgetOverrides });
  const session = createWorkerSession(
    TASK,
    { callModel, registry: echoRegistry(), runDir },
    { budget, maxContextTokens: 1_000_000 },
  );
  return { session, requests };
}

describe('WorkerSession corrections', () => {
  it('a correction continues the same conversation: prior messages plus the feedback exactly once', async () => {
    const { session, requests } = makeSession([
      toolResponse('t1'),
      textResponse('First attempt.'),
      textResponse('Corrected attempt.'),
    ]);

    const first = await runWorkerCycle(session);
    expect(first).toEqual({ kind: 'completed', finalText: 'First attempt.' });
    expect(session.state.turnCount).toBe(2);

    appendWorkerFeedback(session, 'Judge feedback:\nFix the id column.');
    const second = await runWorkerCycle(session);
    expect(second).toEqual({ kind: 'completed', finalText: 'Corrected attempt.' });
    expect(session.state.turnCount).toBe(3);

    // The correction turn's request replays the entire prior exchange —
    // task, tool round-trip, first answer — then the feedback, once.
    const correctionRequest = requests[2]!;
    expect(correctionRequest).toHaveLength(5);
    expect(correctionRequest[0]).toEqual({
      role: 'user',
      content: [{ type: 'text', text: TASK }],
    });
    expect(correctionRequest[1]?.role).toBe('assistant'); // tool_use turn
    expect(correctionRequest[2]?.role).toBe('user'); // tool result
    expect(correctionRequest[3]?.role).toBe('assistant'); // first answer
    expect(correctionRequest[4]).toEqual({
      role: 'user',
      content: [{ type: 'text', text: 'Judge feedback:\nFix the id column.' }],
    });
    const feedbackCount = correctionRequest.filter(
      (message) =>
        message.role === 'user' &&
        message.content.some(
          (block) => block.type === 'text' && block.text.includes('Judge feedback:'),
        ),
    ).length;
    expect(feedbackCount).toBe(1);
  });

  it('a correction does not reset the whole-run turn budget', async () => {
    const { session } = makeSession(
      [toolResponse('t1'), textResponse('Done within budget.'), toolResponse('t2')],
      { maxWorkerTurns: 3 },
    );

    // Cycle 1 spends 2 turns and completes.
    expect(await runWorkerCycle(session)).toMatchObject({ kind: 'completed' });

    // The correction cycle inherits the spent budget: its first tool turn
    // is the run's third — the ceiling — so the guard ends it.
    appendWorkerFeedback(session, 'Do more.');
    const second = await runWorkerCycle(session);
    expect(second).toEqual({ kind: 'budget_exceeded', reason: 'max_turns' });
    expect(session.state.turnCount).toBe(3);
  });
});

describe('WorkerSession metrics', () => {
  it('writes aggregate fields old readers parse plus per-role usage', async () => {
    const { session } = makeSession([toolResponse('t1'), textResponse('Done.')]);
    // A verifier's usage recorded on the same tracker lands in the same
    // metrics file under its own role.
    session.config.budget.recordModelUsage(
      'verifier',
      { input_tokens: 7, output_tokens: 3 },
      120,
    );
    await runWorkerCycle(session);
    writeWorkerSessionMetrics(session, 'verified');

    const metrics = JSON.parse(
      readFileSync(join(runDir, METRICS_FILENAME), 'utf8'),
    ) as RunMetrics;
    expect(metrics.status).toBe('verified');
    expect(metrics.turns).toBe(2);
    // Aggregates include every role: 2 worker calls + the verifier call.
    expect(metrics.inputTokens).toBe(2 * DEFAULT_USAGE.input_tokens + 7);
    expect(metrics.outputTokens).toBe(2 * DEFAULT_USAGE.output_tokens + 3);
    expect(metrics.peakContextTokens).toBeGreaterThan(0);
    expect(metrics.wallClockMs).toBeGreaterThanOrEqual(0);
    expect(metrics.roles?.worker?.turns).toBe(2);
    expect(metrics.roles?.verifier).toMatchObject({
      turns: 1,
      inputTokens: 7,
      outputTokens: 3,
      wallClockMs: 120,
    });
  });
});

describe('WorkerSession configuration', () => {
  it('rejects NaN and negative context ceilings before any model call', () => {
    const budget = createRunBudgetTracker(UNBOUNDED);
    const deps = {
      callModel: scriptModel([]).callModel,
      registry: echoRegistry(),
      runDir,
    };
    expect(() =>
      createWorkerSession(TASK, deps, { budget, maxContextTokens: Number.NaN }),
    ).toThrow(/maxContextTokens/);
    expect(() =>
      createWorkerSession(TASK, deps, { budget, maxContextTokens: -1 }),
    ).toThrow(/maxContextTokens/);
  });

  it('runWorkerTurn ends a cycle on the shared token ceiling', async () => {
    const { session } = makeSession([toolResponse('t1')], {
      maxModelTokens: 10, // one 15-token response overruns it
    });
    const outcome = await runWorkerTurn(session);
    expect(outcome).toEqual({ kind: 'budget_exceeded', reason: 'model_tokens' });
  });
});
