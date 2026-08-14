import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  createOutputContractStore,
  type OutputContractStore,
} from '../contracts/outputContractStore.js';
import { ModelResponseRejectedError } from '../model/modelDriver.js';
import { initManifest, MANIFEST_FILENAME, type Manifest } from '../run/artifacts.js';
import { createRunBudgetTracker, type RunBudgetConfig } from '../run/runBudget.js';
import { TRANSCRIPT_FILENAME } from '../run/transcript.js';
import { setOutputContractTool } from '../tools/setOutputContract/setOutputContract.js';
import { createRegistry, type ToolDef, type ToolRegistry } from '../tools/registry.js';
import { SUBMIT_FOR_VERIFICATION } from '../completion/workerResponseProtocol.js';
import type { Message, ModelResponse, Usage } from './messages.js';
import type { ToolCallLifecycleHooks } from './scheduler.js';
import {
  appendWorkerFeedback,
  captureWorkerSessionSnapshot,
  createWorkerSession,
  MAX_PROTOCOL_CORRECTIONS_PER_RUN,
  METRICS_FILENAME,
  recordWorkerSessionCrash,
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

/** A cycle-ending response under the single completion protocol: prose plus a
 * lone `submit_for_verification` call. `textResponse` alone no longer finishes
 * a cycle — a no-tool response is an invalid working response — so every
 * response that used to terminate a cycle is now one of these. */
function submitResponse(text: string, id = 'submit-1'): ModelResponse {
  return {
    content: [
      { type: 'text', text },
      { type: 'tool_use', id, name: SUBMIT_FOR_VERIFICATION, input: { summary: text } },
    ],
    stop_reason: 'tool_use',
    usage: { ...DEFAULT_USAGE },
  };
}

/** The outcome `submitResponse` produces, for exact `toEqual` assertions. */
function submitted(text: string, id = 'submit-1') {
  return {
    kind: 'submitted' as const,
    call: { id, name: SUBMIT_FOR_VERIFICATION, input: { summary: text } },
    input: { summary: text },
    finalText: text,
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
    getAccess: () => ({ reads: [], writes: [] }),
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
      submitResponse('First attempt.'),
      submitResponse('Corrected attempt.'),
    ]);

    const first = await runWorkerCycle(session);
    expect(first).toEqual(submitted('First attempt.'));
    expect(session.state.turnCount).toBe(2);

    appendWorkerFeedback(session, 'Judge feedback:\nFix the id column.');
    const second = await runWorkerCycle(session);
    expect(second).toEqual(submitted('Corrected attempt.'));
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
      [toolResponse('t1'), submitResponse('Done within budget.'), toolResponse('t2')],
      { maxWorkerTurns: 3 },
    );

    // Cycle 1 spends 2 turns and completes.
    expect(await runWorkerCycle(session)).toMatchObject({ kind: 'submitted' });

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
    const { session } = makeSession([toolResponse('t1'), submitResponse('Done.')]);
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
      getAccess: () => ({ reads: [], writes: [], exclusive: true }),
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

  it('tells a worker whose contract is already set not to restate it', () => {
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
          },
          { budget: createRunBudgetTracker(UNBOUNDED), maxContextTokens: 1_000_000 },
        ),
      };
    })();

    const opening = session.state.messages[0]!;
    // The task text stays the first block, verbatim and unwrapped.
    expect(opening.content[0]).toEqual({ type: 'text', text: TASK });
    const brief = (opening.content[1] as { text: string }).text;
    // Finding 3: it re-authored a contract that was already accepted.
    expect(brief).toContain('revision 1 is already set');
    expect(brief).toContain('scratch/output-contract/revision-1.json');
    expect(brief).toContain('Do not call set_output_contract to restate');
    expect(brief).toContain('revisionBasis');
    // The contract's actual requirements, so the worker need not go read them.
    expect(brief).toContain('roster (table, csv -> artifacts/roster.csv): columns name');
    // How to fill a table — named for the tool that exists.
    expect(brief).toContain('update_table');

    // The brief states only per-run facts. It used to spend three sentences
    // correcting SYSTEM_PROMPT — disregard its INTENT.md/CONTRACT.md paragraph,
    // and here is how to finish — but the prompt now describes the typed
    // contract and submit_for_verification itself. Two descriptions of one
    // protocol is how they drift apart, so the brief must not repeat either.
    expect(brief).not.toContain('INTENT.md');
    expect(brief).not.toContain('CONTRACT.md');
    expect(brief).not.toContain('disregard');
    expect(brief).not.toContain('submit_for_verification');
  });

  it('tells a worker with no contract yet to author one first', () => {
    const { session } = contractSession([]);
    const brief = (session.state.messages[0]!.content[1] as { text: string }).text;

    expect(brief).toContain('No contract is set yet');
    expect(brief).toContain('every other tool call is refused');
    expect(brief).not.toContain('already set');
  });

  it('adds no brief at all on the legacy prose path', () => {
    const { session } = makeSession([submitResponse('Done.')]);

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

// T-next threads scheduler.ToolCallLifecycleHooks (already built and already
// accepted by scheduleToolCalls) through WorkerSessionDeps down to every
// scheduleToolCalls call site inside runGatedCalls. These tests are about
// reachability, not about what a real checkpointing hook does with the
// calls it observes — recording call ids in firing order is enough to prove
// every call site wires the hooks through, and in the right order.
describe('WorkerSession toolHooks', () => {
  /** A single state-changing, ungated tool (no contract store involved),
   * isolating the plain (non-gated) scheduleToolCalls call site. */
  function writingRegistry(): ToolRegistry {
    const write: ToolDef<{ what: string }> = {
      name: 'write',
      description: 'Write something.',
      inputSchema: z.object({ what: z.string() }),
      getAccess: () => ({ reads: [], writes: [], exclusive: true }),
      execute: async (input) => `wrote ${input.what}`,
    };
    return createRegistry([write as ToolDef]);
  }

  /** Records each hook firing as `before:<id>` / `after:<id>:<ok|error>`, in
   * the order it actually happened — enough to assert both "did it fire"
   * and "in what order" without any real checkpointing logic. */
  function recordingHooks(): { hooks: ToolCallLifecycleHooks; events: string[] } {
    const events: string[] = [];
    const hooks: ToolCallLifecycleHooks = {
      beforeStateChangingCall: async (call) => {
        events.push(`before:${call.id}`);
      },
      afterCallResult: async (call, result) => {
        events.push(`after:${call.id}:${result.isError === true ? 'error' : 'ok'}`);
      },
    };
    return { hooks, events };
  }

  function multiCallResponse(
    calls: Array<{ id: string; name: string; input: unknown }>,
  ): ModelResponse {
    return {
      content: calls.map((c) => ({ type: 'tool_use' as const, ...c })),
      stop_reason: 'tool_use',
      usage: { ...DEFAULT_USAGE },
    };
  }

  it('fires beforeStateChangingCall and afterCallResult for each state-changing call, in order', async () => {
    const { hooks, events } = recordingHooks();
    const { callModel } = scriptModel([
      multiCallResponse([
        { id: 'w1', name: 'write', input: { what: 'a' } },
        { id: 'w2', name: 'write', input: { what: 'b' } },
      ]),
    ]);
    const session = createWorkerSession(
      TASK,
      { callModel, registry: writingRegistry(), runDir, toolHooks: hooks },
      { budget: createRunBudgetTracker(UNBOUNDED), maxContextTokens: 1_000_000 },
    );

    await runWorkerTurn(session);

    // `write` declares an explicit EXCLUSIVE_ACCESS, which conflicts with
    // everything, including itself — so the scheduler runs them as two
    // serial groups, not overlapped.
    // Interleaved hook firing (both befores before either after) would mean
    // a resume could not trust "before" seen without a matching "after" to
    // mean "this call's effect is unconfirmed".
    expect(events).toEqual(['before:w1', 'after:w1:ok', 'before:w2', 'after:w2:ok']);
  });

  it('fires hooks for both the contract-establishing call and the calls that run after it is accepted', async () => {
    const { hooks, events } = recordingHooks();
    const touched: string[] = [];
    const touch: ToolDef<{ what: string }> = {
      name: 'touch',
      description: 'Record a side effect.',
      inputSchema: z.object({ what: z.string() }),
      getAccess: () => ({ reads: [], writes: [], exclusive: true }),
      execute: async (input) => {
        touched.push(input.what);
        return `touched ${input.what}`;
      },
    };
    const store = createOutputContractStore(runDir);
    const validContract = {
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
    const { callModel } = scriptModel([
      multiCallResponse([
        { id: 'c1', name: 'set_output_contract', input: validContract },
        { id: 't1', name: 'touch', input: { what: 'page' } },
      ]),
    ]);
    const session = createWorkerSession(
      TASK,
      {
        callModel,
        registry: createRegistry([setOutputContractTool as ToolDef, touch as ToolDef]),
        runDir,
        outputContracts: store,
        toolHooks: hooks,
      },
      { budget: createRunBudgetTracker(UNBOUNDED), maxContextTokens: 1_000_000 },
    );

    await runWorkerTurn(session);

    expect(store.hasContract()).toBe(true);
    expect(touched).toEqual(['page']);
    // runGatedCalls's contract-establishing branch calls scheduleToolCalls
    // TWICE — once for the lone contract call, once for the accepted rest —
    // so a naive one-line fix threading hooks into only one of those calls
    // (or only into the ungated branch) would silently miss half of this
    // response: c1 would fire without t1, or the reverse.
    expect(events).toEqual(['before:c1', 'after:c1:ok', 'before:t1', 'after:t1:ok']);
  });

  it('a session with no toolHooks still executes tool calls normally (regression guard)', async () => {
    const { callModel } = scriptModel([
      multiCallResponse([{ id: 'w1', name: 'write', input: { what: 'a' } }]),
      submitResponse('Done.'),
    ]);
    const session = createWorkerSession(
      TASK,
      { callModel, registry: writingRegistry(), runDir },
      { budget: createRunBudgetTracker(UNBOUNDED), maxContextTokens: 1_000_000 },
    );

    const first = await runWorkerTurn(session);
    expect(first).toEqual({ kind: 'working' });
    const resultBlock = session.state.messages.at(-1)!.content[0] as { content: string };
    expect(resultBlock.content).toBe('wrote a');

    const second = await runWorkerTurn(session);
    expect(second).toEqual(submitted('Done.'));
  });
});

// T-next threads WorkerSessionDeps.abortSignal down to the ToolCtx every
// tool call receives. The bug this closes: runTask passed abortSignal
// through a conditional SPREAD, which TypeScript exempts from
// excess-property checking, so the field type-checked its way onto deps and
// was then silently dropped when runWorkerTurn assembled ToolCtx by hand —
// every `bash` command on every worker path was uncancellable despite the
// signal looking present in the deps object.
describe('WorkerSession abortSignal', () => {
  /** A tool that records exactly the ctx.abortSignal it was handed, so the
   * assertion can check object identity — not merely "is defined" — which a
   * bug that substituted some OTHER signal would still pass. */
  function abortSignalProbeRegistry(): {
    registry: ToolRegistry;
    captured: (AbortSignal | undefined)[];
  } {
    const captured: (AbortSignal | undefined)[] = [];
    const probe: ToolDef<{ ok: boolean }> = {
      name: 'probe',
      description: 'Record the abort signal ctx received.',
      inputSchema: z.object({ ok: z.boolean() }),
      getAccess: () => ({ reads: [], writes: [] }),
      execute: async (_input, ctx) => {
        captured.push(ctx.abortSignal);
        return 'probed';
      },
    };
    return { registry: createRegistry([probe as ToolDef]), captured };
  }

  function probeResponse(id: string): ModelResponse {
    return {
      content: [{ type: 'tool_use', id, name: 'probe', input: { ok: true } }],
      stop_reason: 'tool_use',
      usage: { ...DEFAULT_USAGE },
    };
  }

  it('passes the exact same AbortSignal instance from deps through to the tool\'s ToolCtx', async () => {
    const { registry, captured } = abortSignalProbeRegistry();
    const controller = new AbortController();
    const { callModel } = scriptModel([probeResponse('p1')]);
    const session = createWorkerSession(
      TASK,
      { callModel, registry, runDir, abortSignal: controller.signal },
      { budget: createRunBudgetTracker(UNBOUNDED), maxContextTokens: 1_000_000 },
    );

    await runWorkerTurn(session);

    expect(captured).toHaveLength(1);
    // Identity, not equality: a fresh AbortSignal never fires, so a session
    // that wired up an unrelated signal would still look "not undefined".
    expect(captured[0]).toBe(controller.signal);
  });

  it('leaves ctx.abortSignal undefined when the session has none (regression guard)', async () => {
    const { registry, captured } = abortSignalProbeRegistry();
    const { callModel } = scriptModel([probeResponse('p1')]);
    const session = createWorkerSession(
      TASK,
      { callModel, registry, runDir },
      { budget: createRunBudgetTracker(UNBOUNDED), maxContextTokens: 1_000_000 },
    );

    await runWorkerTurn(session);

    expect(captured).toEqual([undefined]);
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
    const { session } = makeSession([toolResponse('t1'), submitResponse('First attempt.')]);
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
    const { callModel } = scriptModel([submitResponse('Done.')]);
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
    const { session } = makeSession([submitResponse('Done.')]);
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
    const { session } = makeSession([toolResponse('t1'), submitResponse('First attempt.')]);
    await runWorkerCycle(session);
    const snapshot = captureWorkerSessionSnapshot(session);

    const { callModel: resumedCallModel, requests: resumedRequests } = scriptModel([
      submitResponse('Continued after restore.'),
    ]);
    const restored = restoreWorkerSession(
      snapshot,
      { callModel: resumedCallModel, registry: echoRegistry(), runDir },
      { budget: createRunBudgetTracker(UNBOUNDED), maxContextTokens: 1_000_000 },
    );

    appendWorkerFeedback(restored, 'Resume feedback.');
    const outcome = await runWorkerTurn(restored);
    expect(outcome).toEqual(submitted('Continued after restore.'));

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

// The following describe blocks were ported from the deleted
// src/loop/agentLoop.ts's own test file (agentLoop.test.ts). agentLoop.ts
// was a thin compatibility wrapper over runWorkerCycle/runWorkerTurn with no
// logic of its own beyond LoopResult mapping and config validation (both
// covered elsewhere), so most of its test file duplicated coverage this file
// already had through runWorkerCycle/runWorkerTurn. These blocks are the
// exception: each one exercises real runWorkerTurn logic that no other test
// file (this one, scheduler.test.ts, contextView.test.ts, capResult.test.ts,
// runBudget.test.ts, modelDriver.test.ts, runTask's own suites) actually
// covers. See the comment on each block for exactly what would go dark
// without it.

// Content, never stop_reason, decides whether a response completes a cycle
// — a documented invariant (see runWorkerTurn's own doc comment) that
// nothing else in this file exercises, since every other test here scripts
// truthful stop_reason values.
describe('WorkerSession completion policy: content decides, not stop_reason', () => {
  it('a stop_reason claiming end_turn while content has tool_use continues', async () => {
    const lyingToolResponse: ModelResponse = {
      content: [{ type: 'tool_use', id: 't1', name: 'echo', input: { message: 'hi' } }],
      stop_reason: 'end_turn',
      usage: { ...DEFAULT_USAGE },
    };
    const { session, requests } = makeSession([lyingToolResponse, submitResponse('Done.')]);

    const outcome = await runWorkerCycle(session);

    expect(outcome).toEqual(submitted('Done.'));
    expect(requests).toHaveLength(2);
  });

  it('a stop_reason claiming tool_use with no tool_use content does not finish the run', async () => {
    // The point is unchanged: CONTENT decides, never stop_reason. What changed
    // is what content-with-no-tool-call means — it is an invalid working
    // response now, so the run continues and the model is told to submit.
    const lyingTextResponse: ModelResponse = {
      content: [
        { type: 'text', text: 'First.' },
        { type: 'text', text: 'Second.' },
      ],
      stop_reason: 'tool_use',
      usage: { ...DEFAULT_USAGE },
    };
    const { session, requests } = makeSession([
      lyingTextResponse,
      submitResponse('Actually finished.'),
    ]);

    const outcome = await runWorkerCycle(session);

    expect(outcome).toEqual(submitted('Actually finished.'));
    // Two requests: the lying response did not end the cycle.
    expect(requests).toHaveLength(2);
  });

  it('an unrecognized tool call comes back as is_error and the run continues', async () => {
    const badCall: ModelResponse = {
      content: [{ type: 'tool_use', id: 't1', name: 'no_such_tool', input: {} }],
      stop_reason: 'tool_use',
      usage: { ...DEFAULT_USAGE },
    };
    const { session, requests } = makeSession([badCall, submitResponse('Recovered.')]);

    const outcome = await runWorkerCycle(session);

    expect(outcome).toEqual(submitted('Recovered.'));
    const feedback = requests[1]![2]!;
    expect(feedback.role).toBe('user');
    expect(feedback.content[0]).toMatchObject({
      type: 'tool_result',
      tool_use_id: 't1',
      is_error: true,
    });
    expect((feedback.content[0] as { content: string }).content).toContain('no_such_tool');
  });
});

// The per-request context ceiling is the run's other terminating guard
// (alongside maxWorkerTurns) and the one that makes maxTurns: Infinity safe
// — the architectural guarantee runTask.ts's own module comments lean on.
// Nothing else exercises the actual runtime check (contextTokens vs
// config.maxContextTokens inside runWorkerTurn): WorkerSession
// configuration's own test only proves the ceiling is VALIDATED at
// construction, never that it is ENFORCED turn to turn.
describe('WorkerSession context ceiling guard', () => {
  function contextToolResponse(id: string, usage: Usage): ModelResponse {
    return {
      content: [{ type: 'tool_use', id, name: 'echo', input: { message: id } }],
      stop_reason: 'tool_use',
      usage,
    };
  }

  function contextTextResponse(text: string, usage: Usage): ModelResponse {
    return { content: [{ type: 'text', text }], stop_reason: 'end_turn', usage };
  }

  /** A cycle-ending response with caller-chosen usage. Separate from
   * `contextTextResponse` because a bare text response no longer ends a
   * cycle — these tests are about the context guard, not the protocol. */
  function contextSubmitResponse(text: string, usage: Usage): ModelResponse {
    return {
      content: [
        { type: 'text', text },
        { type: 'tool_use', id: 'submit-1', name: SUBMIT_FOR_VERIFICATION, input: { summary: text } },
      ],
      stop_reason: 'tool_use',
      usage,
    };
  }

  function makeContextSession(
    responses: ModelResponse[],
    maxContextTokens: number,
  ): { session: WorkerSession; requests: Message[][] } {
    const { callModel, requests } = scriptModel(responses);
    const budget = createRunBudgetTracker(UNBOUNDED);
    const session = createWorkerSession(
      TASK,
      { callModel, registry: echoRegistry(), runDir },
      { budget, maxContextTokens },
    );
    return { session, requests };
  }

  it('one response whose context strictly exceeds the cap ends the run context_budget', async () => {
    // Per-request context = input + cache_creation + cache_read + output.
    // Turn 1 sits at 15 and passes; turn 2 reaches 30 against a 29 cap.
    const { session, requests } = makeContextSession(
      [
        contextToolResponse('t1', { ...DEFAULT_USAGE }),
        contextToolResponse('t2', { input_tokens: 20, output_tokens: 10 }),
        contextTextResponse('Never reached.', { ...DEFAULT_USAGE }),
      ],
      29,
    );

    const outcome = await runWorkerCycle(session);

    expect(outcome).toEqual({ kind: 'budget_exceeded', reason: 'context_budget' });
    expect(requests).toHaveLength(2);
  });

  it('a response sitting exactly at the context cap continues — the cap is spendable in full', async () => {
    // Turn 1's context is exactly 30 against a 30 cap: turn 2 must happen.
    const { session, requests } = makeContextSession(
      [
        contextToolResponse('t1', { input_tokens: 20, output_tokens: 10 }),
        contextSubmitResponse('Made it.', { ...DEFAULT_USAGE }),
      ],
      30,
    );

    const outcome = await runWorkerCycle(session);

    expect(outcome).toEqual(submitted('Made it.'));
    expect(requests).toHaveLength(2);
  });

  it("cache reads and cache writes count toward a response's context", async () => {
    // 10 in + 5 out + 20 cache reads + 10 cache writes = 45 > 44; without
    // the cache fields it would be 15 and the cycle would (wrongly) ask for
    // an unscripted second response.
    const { session, requests } = makeContextSession(
      [
        contextToolResponse('t1', {
          input_tokens: 10,
          output_tokens: 5,
          cache_read_input_tokens: 20,
          cache_creation_input_tokens: 10,
        }),
      ],
      44,
    );

    const outcome = await runWorkerCycle(session);

    expect(outcome).toEqual({ kind: 'budget_exceeded', reason: 'context_budget' });
    expect(requests).toHaveLength(1);
  });

  it('a run whose cumulative tokens far exceed the cap completes when every request stays under', async () => {
    // Five turns at 15 context each: cumulative 75 against a 20 cap. A
    // cumulative guard would die on turn 2; the per-request guard never
    // trips because no single request exceeds the cap.
    const { session, requests } = makeContextSession(
      [
        contextToolResponse('t1', { ...DEFAULT_USAGE }),
        contextToolResponse('t2', { ...DEFAULT_USAGE }),
        contextToolResponse('t3', { ...DEFAULT_USAGE }),
        contextToolResponse('t4', { ...DEFAULT_USAGE }),
        contextSubmitResponse('Deep run finished.', { ...DEFAULT_USAGE }),
      ],
      20,
    );

    const outcome = await runWorkerCycle(session);

    expect(outcome).toEqual(submitted('Deep run finished.'));
    expect(requests).toHaveLength(5);
  });

  it('a submission is honored even when it blows the context cap', async () => {
    const { session } = makeContextSession(
      [contextSubmitResponse('Done.', { input_tokens: 999, output_tokens: 999 })],
      10,
    );

    const outcome = await runWorkerCycle(session);

    // The submission is in hand — it is honored before the guards run.
    expect(outcome).toEqual(submitted('Done.'));
  });
});

// maxWorkerTurns boundary behavior at the runWorkerTurn integration level:
// runBudget.test.ts proves the tracker's own ceiling math, and this file's
// 'a correction does not reset the whole-run turn budget' proves the guard
// fires across a correction — but neither proves the specific loop-order
// guarantee runTask.ts's docs promise: a cycle may *complete* exactly on the
// final allowed turn, and Infinity never trips across an arbitrarily deep
// trajectory.
describe('WorkerSession maxWorkerTurns guard', () => {
  it('maxWorkerTurns ends a run that would otherwise loop forever', async () => {
    const { session, requests } = makeSession(
      [toolResponse('t1'), toolResponse('t2'), toolResponse('t3')],
      { maxWorkerTurns: 3 },
    );

    const outcome = await runWorkerCycle(session);

    expect(outcome).toEqual({ kind: 'budget_exceeded', reason: 'max_turns' });
    expect(requests).toHaveLength(3);
  });

  it('completing exactly at the turn ceiling is a completion, not budget_exceeded', async () => {
    const { session, requests } = makeSession(
      [toolResponse('t1'), toolResponse('t2'), submitResponse('Finished on the last allowed turn.')],
      { maxWorkerTurns: 3 },
    );

    const outcome = await runWorkerCycle(session);

    expect(outcome).toEqual(submitted('Finished on the last allowed turn.'));
    expect(requests).toHaveLength(3);
  });

  it('maxWorkerTurns: Infinity never trips — the run follows its trajectory to completion', async () => {
    const responses = [
      ...Array.from({ length: 12 }, (_, i) => toolResponse(`t${i + 1}`)),
      submitResponse('Trajectory complete.'),
    ];
    const { session, requests } = makeSession(responses, { maxWorkerTurns: Infinity });

    const outcome = await runWorkerCycle(session);

    expect(outcome).toEqual(submitted('Trajectory complete.'));
    expect(requests).toHaveLength(13);
  });
});

// runWorkerTurn's ModelResponseRejectedError handling (T1's strict-driver
// rejection recovery: bounded protocol corrections, context_exhausted
// mapping, and refusal propagation) has no other test anywhere in this
// codebase — modelDriver.test.ts covers only the error's own construction
// and detection, never a consumer's reaction to it.
describe('WorkerSession rejected model responses', () => {
  function rejection(
    reason: ConstructorParameters<typeof ModelResponseRejectedError>[0],
    feedback = 'Your previous response was discarded. Adjust and continue.',
  ): ModelResponseRejectedError {
    return new ModelResponseRejectedError(reason, `scripted ${reason} rejection`, feedback, {
      input_tokens: 7,
      output_tokens: 3,
    });
  }

  function sessionWithRejections(
    script: Array<ModelResponse | ModelResponseRejectedError>,
  ): { session: WorkerSession; requests: Message[][] } {
    const requests: Message[][] = [];
    const callModel = async (messages: readonly Message[]): Promise<ModelResponse> => {
      requests.push(structuredClone(messages) as Message[]);
      const next = script[requests.length - 1];
      if (next === undefined) throw new Error('script exhausted');
      if (next instanceof ModelResponseRejectedError) throw next;
      return next;
    };
    const budget = createRunBudgetTracker(UNBOUNDED);
    const session = createWorkerSession(
      TASK,
      { callModel, registry: echoRegistry(), runDir },
      { budget, maxContextTokens: 1_000_000 },
    );
    return { session, requests };
  }

  it('a protocol-correctable rejection appends only the correction — never the rejected content', async () => {
    const feedback = 'Too many tool calls; use fewer per turn.';
    const { session, requests } = sessionWithRejections([
      rejection('too_many_tool_calls', feedback),
      submitResponse('Recovered.'),
    ]);

    const outcome = await runWorkerCycle(session);

    expect(outcome).toEqual(submitted('Recovered.'));
    // The retry request holds the task and the correction — no assistant
    // message exists for the rejected attempt.
    expect(requests[1]).toEqual([
      { role: 'user', content: [{ type: 'text', text: TASK }] },
      { role: 'user', content: [{ type: 'text', text: feedback }] },
    ]);
    const transcript = readFileSync(join(runDir, TRANSCRIPT_FILENAME), 'utf8');
    expect(transcript).toContain('model_response_rejected');
    // The rejected attempt's usage still counts toward the run totals.
    writeWorkerSessionMetrics(session, 'completed');
    const metrics = JSON.parse(readFileSync(join(runDir, METRICS_FILENAME), 'utf8')) as RunMetrics;
    expect(metrics.inputTokens).toBe(7 + DEFAULT_USAGE.input_tokens);
    expect(metrics.outputTokens).toBe(3 + DEFAULT_USAGE.output_tokens);
  });

  it('context exhaustion ends the run as budget_exceeded, not completed', async () => {
    const { session } = sessionWithRejections([rejection('context_exhausted')]);

    const outcome = await runWorkerCycle(session);

    expect(outcome).toEqual({ kind: 'budget_exceeded', reason: 'context_budget' });
  });

  it('a refusal cannot complete the run — it propagates out of the cycle', async () => {
    const { session } = sessionWithRejections([rejection('refusal')]);

    await expect(runWorkerCycle(session)).rejects.toMatchObject({
      name: 'ModelResponseRejectedError',
      reason: 'refusal',
    });
  });

  it('corrections are bounded: the rejection after the cap propagates', async () => {
    const script = Array.from(
      { length: MAX_PROTOCOL_CORRECTIONS_PER_RUN + 1 },
      () => rejection('malformed_tool_call'),
    );
    const { session, requests } = sessionWithRejections(script);

    await expect(runWorkerCycle(session)).rejects.toMatchObject({ reason: 'malformed_tool_call' });
    expect(requests).toHaveLength(MAX_PROTOCOL_CORRECTIONS_PER_RUN + 1);
  });
});

// recordWorkerSessionCrash is exported specifically for callers (runTask.ts's
// runHarnessCycles) to invoke from their own catch block — but nothing
// anywhere else in this codebase's test suite actually drives it.
describe('WorkerSession crash bookkeeping', () => {
  it('a genuine crash records failed metrics and a run_error transcript event', async () => {
    const scripted = scriptModel([toolResponse('t1')]);
    const boom = new Error('overloaded_error: upstream fell over mid-stream');
    let modelCalls = 0;
    const callModel = async (messages: readonly Message[]): Promise<ModelResponse> => {
      modelCalls += 1;
      if (modelCalls === 2) throw boom;
      return scripted.callModel(messages);
    };
    const budget = createRunBudgetTracker(UNBOUNDED);
    const session = createWorkerSession(
      TASK,
      { callModel, registry: echoRegistry(), runDir },
      { budget, maxContextTokens: 1_000_000 },
    );

    await runWorkerTurn(session); // turn 1 succeeds
    await expect(runWorkerTurn(session)).rejects.toBe(boom); // turn 2 crashes
    recordWorkerSessionCrash(session, boom);

    const metrics = JSON.parse(readFileSync(join(runDir, METRICS_FILENAME), 'utf8')) as RunMetrics;
    expect(metrics).toMatchObject({
      status: 'failed',
      turns: 2, // the crash happened on turn 2
      inputTokens: 10, // turn 1's usage only — turn 2 never reported any
      outputTokens: 5,
      peakContextTokens: 15,
    });

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

  it('an AbortError gets no crash bookkeeping — cancelled is "stopped", not "crashed"', async () => {
    const { session } = makeSession([toolResponse('t1')]);
    await runWorkerTurn(session); // some transcript content to check against

    const cancelled = Object.assign(new Error('run cancelled'), { name: 'AbortError' });
    recordWorkerSessionCrash(session, cancelled);

    expect(existsSync(join(runDir, METRICS_FILENAME))).toBe(false);
    const transcript = readFileSync(join(runDir, TRANSCRIPT_FILENAME), 'utf8');
    expect(transcript).not.toContain('run_error');
  });
});

// The cache-miss tripwire (cache_read_input_tokens === 0 from turn 2 onward)
// has no other test anywhere in this codebase.
describe('WorkerSession cache-miss warning', () => {
  it('appends cache_miss_warning for turns >= 2 with zero cache reads — and only those', async () => {
    // Turn 1 never warns (nothing is cached yet); turn 2 reads cache and
    // stays quiet; turn 3 reports zero reads — the prefix broke — and the
    // warning lands even though the run completes there.
    const { session } = makeSession([
      toolResponse('t1'),
      {
        content: [{ type: 'tool_use', id: 't2', name: 'echo', input: { message: 't2' } }],
        stop_reason: 'tool_use',
        usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 40 },
      },
      submitResponse('Done.'),
    ]);

    await runWorkerCycle(session);

    const warnings = readFileSync(join(runDir, TRANSCRIPT_FILENAME), 'utf8')
      .trimEnd()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((event) => event.type === 'cache_miss_warning');
    expect(warnings).toEqual([{ type: 'cache_miss_warning', turn: 3 }]);
  });
});

// capResultBatch — the per-MESSAGE combined tool-result byte cap — is a
// private function inside workerSession.ts with no test coverage anywhere
// else: capResult.test.ts covers only the per-RESULT cap it builds on.
describe('WorkerSession per-message batch cap', () => {
  /** A registry with one read-only `blob` tool returning `size` bytes of x —
   * each result legal under the 50k per-result cap, so only the batch cap
   * can touch them. */
  function blobRegistry(): ToolRegistry {
    const blob: ToolDef<{ size: number }> = {
      name: 'blob',
      description: 'Return size bytes of filler.',
      inputSchema: z.object({ size: z.number().int().positive() }),
      getAccess: () => ({ reads: [], writes: [] }),
      execute: async (input) => 'x'.repeat(input.size),
    };
    return createRegistry([blob as ToolDef]);
  }

  function blobToolResponse(sizes: number[]): ModelResponse {
    return {
      content: sizes.map((size, index) => ({
        type: 'tool_use' as const,
        id: `t${index + 1}`,
        name: 'blob',
        input: { size },
      })),
      stop_reason: 'tool_use',
      usage: { ...DEFAULT_USAGE },
    };
  }

  function makeBlobSession(
    responses: ModelResponse[],
  ): { session: WorkerSession; requests: Message[][] } {
    const { callModel, requests } = scriptModel(responses);
    const budget = createRunBudgetTracker(UNBOUNDED);
    const session = createWorkerSession(
      TASK,
      { callModel, registry: blobRegistry(), runDir },
      { budget, maxContextTokens: 1_000_000 },
    );
    return { session, requests };
  }

  it('a batch at or under 200k bytes passes through untouched', async () => {
    const { session, requests } = makeBlobSession([
      blobToolResponse([45_000, 45_000, 45_000, 45_000]), // 180k combined
      submitResponse('Done.'),
    ]);

    await runWorkerCycle(session);

    const feedback = requests[1]![2]!;
    expect(feedback.content).toHaveLength(4);
    for (const block of feedback.content) {
      expect((block as { content: string }).content).toBe('x'.repeat(45_000));
    }
  });

  it('offloads the largest results first until the batch fits, previews and hashes preserved', async () => {
    // 45k + 44k + 4×40k = 249k > 200k. One offload leaves ~206k (still
    // over), so the two largest go to disk — largest first — and the four
    // 40k results stay inline.
    const { session, requests } = makeBlobSession([
      blobToolResponse([45_000, 44_000, 40_000, 40_000, 40_000, 40_000]),
      submitResponse('Done.'),
    ]);

    await runWorkerCycle(session);

    const feedback = requests[1]![2]!;
    const contents = feedback.content.map((block) => (block as { content: string }).content);

    const first = JSON.parse(contents[0]!) as { preview: string; offloadedTo: string; note: string };
    const second = JSON.parse(contents[1]!) as { preview: string; offloadedTo: string; note: string };
    expect(first.offloadedTo).toBe('scratch/tool-output/blob-1.txt');
    expect(second.offloadedTo).toBe('scratch/tool-output/blob-2.txt');
    expect(first.note).toContain('combined limit');
    expect(first.preview.length).toBeGreaterThan(0);
    expect(readFileSync(join(runDir, first.offloadedTo), 'utf8')).toBe('x'.repeat(45_000));
    expect(readFileSync(join(runDir, second.offloadedTo), 'utf8')).toBe('x'.repeat(44_000));
    for (const content of contents.slice(2)) {
      expect(content).toBe('x'.repeat(40_000));
    }
    const combined = contents.reduce((sum, content) => sum + content.length, 0);
    expect(combined).toBeLessThanOrEqual(200_000);
    const manifest = JSON.parse(readFileSync(join(runDir, MANIFEST_FILENAME), 'utf8')) as Manifest;
    for (const relPath of [first.offloadedTo, second.offloadedTo]) {
      expect(manifest.artifacts.some((artifact) => artifact.filename === relPath)).toBe(true);
    }
    const toolResults = readFileSync(join(runDir, TRANSCRIPT_FILENAME), 'utf8')
      .trimEnd()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, any>)
      .filter((event) => event.type === 'tool_result');
    expect(toolResults[0]!.result.content).toBe(contents[0]);
    expect(toolResults[2]!.result.content).toBe(contents[2]);
  });

  it('offloads many individually small results with note-only replacements rather than returning an over-limit message', async () => {
    // 130 × 1.9k = 247k, every result under the 2k preview size — the excess
    // offloads with compact path/note replacements (no preview) rather than
    // returning an over-limit message.
    const sizes = Array.from({ length: 130 }, () => 1_900);
    const { session, requests } = makeBlobSession([blobToolResponse(sizes), submitResponse('Done.')]);

    await runWorkerCycle(session);

    const feedback = requests[1]![2]!;
    const contents = feedback.content.map((block) => (block as { content: string }).content);
    const combined = contents.reduce(
      (sum, content) => sum + Buffer.byteLength(content, 'utf8'),
      0,
    );
    expect(combined).toBeLessThanOrEqual(200_000);

    const offloadedContents = contents.filter((content) => content.startsWith('{'));
    expect(offloadedContents.length).toBeGreaterThan(0);
    const first = JSON.parse(offloadedContents[0]!) as {
      preview: string;
      offloadedTo: string;
      note: string;
    };
    expect(first.preview).toBe('');
    expect(first.note).toContain('combined limit');
    expect(readFileSync(join(runDir, first.offloadedTo), 'utf8')).toBe('x'.repeat(1_900));
    const untouched = contents.filter((content) => !content.startsWith('{'));
    for (const content of untouched) expect(content).toBe('x'.repeat(1_900));
  });
});
