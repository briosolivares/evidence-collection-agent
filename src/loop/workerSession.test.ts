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
  captureWorkerSessionSnapshot,
  createWorkerSession,
  METRICS_FILENAME,
  restoreWorkerSession,
  runWorkerCycle,
  runWorkerTurn,
  writeWorkerSessionMetrics,
  type RunMetrics,
  type WorkerSession,
  type WorkerSessionSnapshot,
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

  it("tells a worker whose contract is already set not to restate it, and that the prose files do not exist", () => {
    const store = createOutputContractStore(runDir);
    expect(store.setOutputContract(VALID_CONTRACT).ok).toBe(true);
    const { session } = (() => {
      const { callModel } = scriptModel([]);
      return {
        session: createWorkerSession(
          TASK,
          {
            callModel,
            registry: gatedRegistry([]),
            runDir,
            outputContracts: store,
            submissionProtocol: true,
          },
          { budget: createRunBudgetTracker(UNBOUNDED), maxContextTokens: 1_000_000 },
        ),
      };
    })();

    const opening = session.state.messages[0]!;
    // The task text stays the first block, verbatim and unwrapped.
    expect(opening.content[0]).toEqual({ type: 'text', text: TASK });
    const brief = (opening.content[1] as { text: string }).text;
    // Finding 4: the system prompt promises INTENT.md/CONTRACT.md, which this
    // protocol never writes — the worker went looking for them.
    expect(brief).toContain('no INTENT.md and no CONTRACT.md');
    // Finding 3: it re-authored a contract that was already accepted.
    expect(brief).toContain('revision 1 is already set');
    expect(brief).toContain('scratch/output-contract/revision-1.json');
    expect(brief).toContain('Do not call set_output_contract to restate');
    expect(brief).toContain('revisionBasis');
    // The contract's actual requirements, so the worker need not go read them.
    expect(brief).toContain('roster (table, csv -> artifacts/roster.csv): columns name');
    expect(brief).toContain('submit_for_verification');
  });

  it('tells a worker with no contract yet to author one first', () => {
    const { session } = contractSession([]);
    const brief = (session.state.messages[0]!.content[1] as { text: string }).text;

    expect(brief).toContain('No contract is set yet');
    expect(brief).toContain('every other tool call is refused');
    expect(brief).not.toContain('already set');
    // No submission protocol on this session, so nothing claims one.
    expect(brief).not.toContain('submit_for_verification');
  });

  it('adds no brief at all on the legacy prose path', () => {
    const { session } = makeSession([textResponse('Done.')]);

    expect(session.state.messages[0]).toEqual({
      role: 'user',
      content: [{ type: 'text', text: TASK }],
    });
  });

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

// A run has exactly ONE persistent worker conversation; a later checkpoint
// step needs to serialize it and rebuild a live session from that snapshot
// plus freshly-supplied deps/config (callModel, registry, browser, budget —
// none of that is plainly serializable). These tests are about that
// round-trip, not about anything the checkpoint step itself will do.
describe('WorkerSession snapshot/restore', () => {
  it('capture -> restore round-trips messages, turn count, peak context, protocol corrections, and startedMs exactly', async () => {
    const { session } = makeSession([toolResponse('t1'), textResponse('First attempt.')]);
    await runWorkerCycle(session);
    // Simulate a run that has already spent some protocol corrections and
    // seen a larger context window than its first two turns produced.
    session.protocolCorrections = 2;
    session.peakContextTokens = 12_345;

    const snapshot = captureWorkerSessionSnapshot(session);
    expect(snapshot.messages).toEqual(session.state.messages);
    expect(snapshot.turnCount).toBe(session.state.turnCount);
    expect(snapshot.peakContextTokens).toBe(12_345);
    expect(snapshot.protocolCorrections).toBe(2);
    expect(snapshot.startedMs).toBe(session.startedMs);

    const restored = restoreWorkerSession(
      snapshot,
      { callModel: scriptModel([]).callModel, registry: echoRegistry(), runDir },
      { budget: createRunBudgetTracker(UNBOUNDED), maxContextTokens: 1_000_000 },
    );

    expect(restored.state.messages).toEqual(snapshot.messages);
    expect(restored.state.turnCount).toBe(snapshot.turnCount);
    expect(restored.peakContextTokens).toBe(12_345);
    expect(restored.protocolCorrections).toBe(2);
    expect(restored.startedMs).toBe(snapshot.startedMs);
  });

  it('a restored session does not duplicate the opening message or the protocol brief', () => {
    const store = createOutputContractStore(runDir);
    const { callModel } = scriptModel([textResponse('Done.')]);
    const session = createWorkerSession(
      TASK,
      { callModel, registry: echoRegistry(), runDir, outputContracts: store },
      { budget: createRunBudgetTracker(UNBOUNDED), maxContextTokens: 1_000_000 },
    );
    // The opening message already carries the task plus the protocol brief
    // as its two content blocks — that is the run's real history.
    const snapshot = captureWorkerSessionSnapshot(session);
    expect(snapshot.messages).toHaveLength(1);
    expect(snapshot.messages[0]?.content).toHaveLength(2);

    const restored = restoreWorkerSession(
      snapshot,
      { callModel: scriptModel([]).callModel, registry: echoRegistry(), runDir, outputContracts: store },
      { budget: createRunBudgetTracker(UNBOUNDED), maxContextTokens: 1_000_000 },
    );

    // Restoring must not rebuild the opening message or re-append the brief
    // as if this were turn one — that would duplicate protocol text the
    // worker already saw and has already acted on.
    expect(restored.state.messages).toHaveLength(1);
    expect(restored.state.messages[0]?.content).toHaveLength(2);
    expect(restored.state.messages).toEqual(snapshot.messages);
  });

  it('mutating the session after capture does not alter the captured snapshot', () => {
    const { session } = makeSession([textResponse('Done.')]);
    const snapshot = captureWorkerSessionSnapshot(session);
    const originalLength = snapshot.messages.length;

    appendWorkerFeedback(session, 'more feedback');
    session.state.messages[0]!.content.push({ type: 'text', text: 'mutated!' });

    expect(snapshot.messages).toHaveLength(originalLength);
    expect(JSON.stringify(snapshot.messages)).not.toContain('mutated!');
    expect(JSON.stringify(snapshot.messages)).not.toContain('more feedback');
  });

  describe('restoreWorkerSession validation', () => {
    const validSnapshot: WorkerSessionSnapshot = {
      messages: [{ role: 'user', content: [{ type: 'text', text: TASK }] }],
      turnCount: 1,
      peakContextTokens: 10,
      protocolCorrections: 0,
      startedMs: 1_000,
    };
    const deps = () => ({ callModel: scriptModel([]).callModel, registry: echoRegistry(), runDir });
    const config = () => ({ budget: createRunBudgetTracker(UNBOUNDED), maxContextTokens: 1_000 });

    it('rejects an empty messages array — a restored session must be a real prior conversation', () => {
      expect(() => restoreWorkerSession({ ...validSnapshot, messages: [] }, deps(), config())).toThrow(
        /messages/,
      );
    });

    it('rejects a negative turn count', () => {
      expect(() => restoreWorkerSession({ ...validSnapshot, turnCount: -1 }, deps(), config())).toThrow(
        /turnCount/,
      );
    });

    it('rejects a negative startedMs', () => {
      expect(() => restoreWorkerSession({ ...validSnapshot, startedMs: -1 }, deps(), config())).toThrow(
        /startedMs/,
      );
    });

    it('rejects NaN and negative context ceilings, same as createWorkerSession', () => {
      expect(() =>
        restoreWorkerSession(validSnapshot, deps(), { ...config(), maxContextTokens: Number.NaN }),
      ).toThrow(/maxContextTokens/);
      expect(() =>
        restoreWorkerSession(validSnapshot, deps(), { ...config(), maxContextTokens: -1 }),
      ).toThrow(/maxContextTokens/);
    });
  });

  it("a restored session's next turn continues the conversation: prior history plus the new exchange", async () => {
    const { session } = makeSession([toolResponse('t1'), textResponse('First attempt.')]);
    await runWorkerCycle(session);
    const snapshot = captureWorkerSessionSnapshot(session);

    const { callModel: resumedCallModel, requests: resumedRequests } = scriptModel([
      textResponse('Continued after restore.'),
    ]);
    const restored = restoreWorkerSession(
      snapshot,
      { callModel: resumedCallModel, registry: echoRegistry(), runDir },
      { budget: createRunBudgetTracker(UNBOUNDED), maxContextTokens: 1_000_000 },
    );

    appendWorkerFeedback(restored, 'Resume feedback.');
    const outcome = await runWorkerTurn(restored);
    expect(outcome).toEqual({ kind: 'completed', finalText: 'Continued after restore.' });

    // The request replays the pre-restore history (task, tool round-trip,
    // first answer) plus the resume feedback, exactly once.
    const request = resumedRequests[0]!;
    expect(request).toHaveLength(5);
    expect(request[0]).toEqual({ role: 'user', content: [{ type: 'text', text: TASK }] });
    expect(request[1]?.role).toBe('assistant'); // tool_use turn
    expect(request[2]?.role).toBe('user'); // tool result
    expect(request[3]?.role).toBe('assistant'); // first answer
    expect(request[4]).toEqual({
      role: 'user',
      content: [{ type: 'text', text: 'Resume feedback.' }],
    });
  });
});
