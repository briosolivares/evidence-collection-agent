import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  createOutputContractStore,
  type OutputContractStore,
} from '../contracts/outputContractStore.js';
import { initManifest } from '../run/artifacts.js';
import { createRunBudgetTracker, type RunBudgetConfig } from '../run/runBudget.js';
import { setOutputContractTool } from '../tools/setOutputContract/setOutputContract.js';
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

describe('WorkerSession contract-first gate', () => {
  /** A registry pairing the real contract tool with a recording `touch`
   * tool, so "did anything run?" is directly observable. */
  function gatedRegistry(touched: string[]): ToolRegistry {
    const touch: ToolDef<{ what: string }> = {
      name: 'touch',
      description: 'Record a side effect.',
      inputSchema: z.object({ what: z.string() }),
      readOnly: false,
      execute: async (input) => {
        touched.push(input.what);
        return `touched ${input.what}`;
      },
    };
    return createRegistry([setOutputContractTool as ToolDef, touch as ToolDef]);
  }

  const VALID_CONTRACT = {
    contract: {
      outputs: [
        {
          id: 'roster',
          kind: 'table',
          filename: 'roster.csv',
          format: 'csv',
          columns: [{ name: 'name', required: true, type: 'string' }],
          rules: [],
        },
      ],
    },
  };

  function contractSession(responses: ModelResponse[]): {
    session: WorkerSession;
    touched: string[];
    store: OutputContractStore;
  } {
    const touched: string[] = [];
    const store = createOutputContractStore(runDir);
    const { callModel } = scriptModel(responses);
    const session = createWorkerSession(
      TASK,
      { callModel, registry: gatedRegistry(touched), runDir, outputContracts: store },
      { budget: createRunBudgetTracker(UNBOUNDED), maxContextTokens: 1_000_000 },
    );
    return { session, touched, store };
  }

  function callsResponse(
    calls: Array<{ id: string; name: string; input: unknown }>,
  ): ModelResponse {
    return {
      content: calls.map((c) => ({ type: 'tool_use' as const, ...c })),
      stop_reason: 'tool_use',
      usage: { ...DEFAULT_USAGE },
    };
  }

  it('executes nothing when the first response skips the contract', async () => {
    const { session, touched, store } = contractSession([
      callsResponse([
        { id: 't1', name: 'touch', input: { what: 'page' } },
        { id: 't2', name: 'touch', input: { what: 'file' } },
      ]),
    ]);

    const outcome = await runWorkerTurn(session);

    expect(outcome).toEqual({ kind: 'working' });
    // The whole point: no side effect reached the tools.
    expect(touched).toEqual([]);
    expect(store.hasContract()).toBe(false);
    // Every attempted call still got exactly one result.
    const feedback = session.state.messages.at(-1)!;
    expect(feedback.role).toBe('user');
    expect(feedback.content).toHaveLength(2);
    for (const block of feedback.content) {
      expect(JSON.stringify(block)).toContain('output_contract_required');
    }
  });

  it('accepts a leading contract call and then runs the rest of the response', async () => {
    const { session, touched, store } = contractSession([
      callsResponse([
        { id: 'c1', name: 'set_output_contract', input: VALID_CONTRACT },
        { id: 't1', name: 'touch', input: { what: 'page' } },
      ]),
    ]);

    await runWorkerTurn(session);

    expect(store.hasContract()).toBe(true);
    expect(touched).toEqual(['page']);
  });

  it('blocks the rest of the response when the contract fails schema validation', async () => {
    // Empty outputs is caught by the pipeline's zod layer, before execute —
    // so the contract call never reaches the store at all.
    const { session, touched, store } = contractSession([
      callsResponse([
        { id: 'c1', name: 'set_output_contract', input: { contract: { outputs: [] } } },
        { id: 't1', name: 'touch', input: { what: 'page' } },
      ]),
    ]);

    await runWorkerTurn(session);

    expect(store.hasContract()).toBe(false);
    expect(touched).toEqual([]);
    const blocks = session.state.messages.at(-1)!.content;
    expect(JSON.stringify(blocks[0])).toMatch(/Invalid input for tool/);
    expect(JSON.stringify(blocks[1])).toContain('blocked_by_invalid_contract');
  });

  it('blocks the rest of the response when the contract fails a cross-field rule', async () => {
    // Two outputs sharing one id passes the schema but fails
    // validateContractRevision, so this exercises the store's own rejection
    // path and its "NOT stored" wording.
    const duplicateIds = {
      contract: {
        outputs: [
          VALID_CONTRACT.contract.outputs[0],
          { ...VALID_CONTRACT.contract.outputs[0], filename: 'other.csv' },
        ],
      },
    };
    const { session, touched, store } = contractSession([
      callsResponse([
        { id: 'c1', name: 'set_output_contract', input: duplicateIds },
        { id: 't1', name: 'touch', input: { what: 'page' } },
      ]),
    ]);

    await runWorkerTurn(session);

    expect(store.hasContract()).toBe(false);
    expect(touched).toEqual([]);
    const blocks = session.state.messages.at(-1)!.content;
    expect(JSON.stringify(blocks[0])).toMatch(/NOT stored/);
    expect(JSON.stringify(blocks[0])).toMatch(/duplicate output id/);
    expect(JSON.stringify(blocks[1])).toContain('blocked_by_invalid_contract');
  });

  it('stops gating once a contract exists', async () => {
    const { session, touched } = contractSession([
      callsResponse([{ id: 'c1', name: 'set_output_contract', input: VALID_CONTRACT }]),
      callsResponse([{ id: 't1', name: 'touch', input: { what: 'later' } }]),
    ]);

    await runWorkerTurn(session);
    await runWorkerTurn(session);

    expect(touched).toEqual(['later']);
  });

  it('leaves the gate off entirely for runs without a contract store', async () => {
    const touched: string[] = [];
    const { callModel } = scriptModel([
      callsResponse([{ id: 't1', name: 'touch', input: { what: 'ungated' } }]),
    ]);
    const session = createWorkerSession(
      TASK,
      { callModel, registry: gatedRegistry(touched), runDir },
      { budget: createRunBudgetTracker(UNBOUNDED), maxContextTokens: 1_000_000 },
    );

    await runWorkerTurn(session);
    expect(touched).toEqual(['ungated']);
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
