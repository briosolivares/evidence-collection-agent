import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { initManifest } from '../run/artifacts.js';
import { DEFAULT_MAX_RESULT_BYTES, type OffloadedResult } from './capResult.js';
import { executeToolCall } from './pipeline.js';
import { createRegistry, type ToolCtx, type ToolDef } from './registry.js';

// Tool executions in these tests never touch the filesystem, so any
// syntactically valid absolute path serves as the run directory.
const ctx: ToolCtx = { runDir: '/tmp/fake-run-dir' };

const echo: ToolDef<{ message: string }> = {
  name: 'echo',
  description: 'Echo the message back.',
  inputSchema: z.object({ message: z.string() }),
  readOnly: true,
  execute: async (input) => `echo: ${input.message}`,
};

const inventory: ToolDef<{ item: string }> = {
  name: 'inventory',
  description: 'Look up an item, returning structured data.',
  inputSchema: z.object({ item: z.string() }),
  readOnly: true,
  execute: async (input) => ({ item: input.item, count: 3 }),
};

const explode: ToolDef<Record<string, never>> = {
  name: 'explode',
  description: 'Always throws.',
  inputSchema: z.object({}),
  readOnly: true,
  execute: async () => {
    throw new Error('boiler pressure too high');
  },
};

const registry = createRegistry([echo, inventory, explode]);

describe('executeToolCall', () => {
  it('round-trips a valid call: input reaches the executor, output comes back normalized', async () => {
    const result = await executeToolCall(
      registry,
      { id: 'call-1', name: 'echo', input: { message: 'hello' } },
      ctx,
    );
    expect(result).toEqual({
      toolCallId: 'call-1',
      isError: false,
      content: 'echo: hello',
    });
  });

  it('serializes non-string executor output as JSON the model can read', async () => {
    const result = await executeToolCall(
      registry,
      { id: 'call-2', name: 'inventory', input: { item: 'rivets' } },
      ctx,
    );
    expect(result.isError).toBe(false);
    expect(JSON.parse(result.content)).toEqual({ item: 'rivets', count: 3 });
  });

  it('returns a structured unknown-tool error naming the missing tool', async () => {
    const result = await executeToolCall(
      registry,
      { id: 'call-3', name: 'teleport', input: {} },
      ctx,
    );
    expect(result).toMatchObject({
      toolCallId: 'call-3',
      isError: true,
      errorKind: 'unknown_tool',
    });
    // The message must name the problem tool (and it helps to list real ones).
    expect(result.content).toContain('teleport');
    expect(result.content).toContain('echo');
  });

  it('returns a structured invalid-input error that says what was malformed', async () => {
    const result = await executeToolCall(
      registry,
      { id: 'call-4', name: 'echo', input: { message: 42 } },
      ctx,
    );
    expect(result).toMatchObject({
      toolCallId: 'call-4',
      isError: true,
      errorKind: 'invalid_input',
    });
    // zod's issue list must reach the model: the offending field and what
    // was expected of it.
    expect(result.content).toContain('echo');
    expect(result.content).toContain('message');
    expect(result.content).toMatch(/string/i);
  });

  it('returns a structured execution error when the executor throws', async () => {
    const result = await executeToolCall(
      registry,
      { id: 'call-5', name: 'explode', input: {} },
      ctx,
    );
    expect(result).toMatchObject({
      toolCallId: 'call-5',
      isError: true,
      errorKind: 'execution_error',
    });
    expect(result.content).toContain('explode');
    expect(result.content).toContain('boiler pressure too high');
  });
});

describe('executeToolCall result capping (stage 5)', () => {
  // These tests offload to disk, so they need a real run directory with an
  // initialized manifest.
  let runDir: string;
  let cappedCtx: ToolCtx;

  beforeEach(() => {
    runDir = mkdtempSync(join(tmpdir(), 'pipeline-cap-test-'));
    initManifest(runDir, 'test task');
    cappedCtx = { runDir };
  });

  afterEach(() => {
    rmSync(runDir, { recursive: true, force: true });
  });

  /** A tool that emits `bytes` bytes of ASCII output, optionally declaring
   * its own result cap. */
  function makeFlood(maxBytes?: number): ToolDef<{ bytes: number }> {
    return {
      name: 'flood',
      description: 'Emit the requested number of bytes.',
      inputSchema: z.object({ bytes: z.number() }),
      readOnly: true,
      ...(maxBytes !== undefined ? { maxBytes } : {}),
      execute: async (input) => 'x'.repeat(input.bytes),
    };
  }

  it('offloads output over the default cap: the model gets a preview + path, the disk gets it all', async () => {
    const floodRegistry = createRegistry([makeFlood()]);
    const result = await executeToolCall(
      floodRegistry,
      { id: 'call-6', name: 'flood', input: { bytes: DEFAULT_MAX_RESULT_BYTES + 1 } },
      cappedCtx,
    );

    expect(result.isError).toBe(false);
    const replacement = JSON.parse(result.content) as OffloadedResult;
    expect(replacement.offloadedTo).toBeDefined();
    expect(replacement.note).toContain(replacement.offloadedTo);
    const offloadPath = join(runDir, replacement.offloadedTo);
    expect(existsSync(offloadPath)).toBe(true);
    expect(readFileSync(offloadPath, 'utf8')).toBe('x'.repeat(DEFAULT_MAX_RESULT_BYTES + 1));
  });

  it("honors a tool's own declared maxBytes over the default", async () => {
    const floodRegistry = createRegistry([makeFlood(64)]);
    const result = await executeToolCall(
      floodRegistry,
      { id: 'call-7', name: 'flood', input: { bytes: 65 } },
      cappedCtx,
    );

    expect(result.isError).toBe(false);
    const replacement = JSON.parse(result.content) as OffloadedResult;
    expect(readFileSync(join(runDir, replacement.offloadedTo), 'utf8')).toBe('x'.repeat(65));
  });

  it('passes at-cap output through byte-identical — capping is invisible under the limit', async () => {
    const floodRegistry = createRegistry([makeFlood(64)]);
    const result = await executeToolCall(
      floodRegistry,
      { id: 'call-8', name: 'flood', input: { bytes: 64 } },
      cappedCtx,
    );

    expect(result).toEqual({
      toolCallId: 'call-8',
      isError: false,
      content: 'x'.repeat(64),
    });
  });
});

describe('executeToolCall permission gate', () => {
  function makeInteractiveTool(executed: unknown[]): ToolDef<{ question: string }> {
    return {
      name: 'interactive',
      description: 'Requires a user decision before running.',
      inputSchema: z.object({ question: z.string() }),
      readOnly: false,
      requiresUserInteraction: true,
      execute: async (input) => {
        executed.push(input);
        return `ran with: ${JSON.stringify(input)}`;
      },
    };
  }

  it('fails closed when the environment provides no requestPermission', async () => {
    const executed: unknown[] = [];
    const gateRegistry = createRegistry([makeInteractiveTool(executed)]);

    const result = await executeToolCall(
      gateRegistry,
      { id: 'gate-1', name: 'interactive', input: { question: 'proceed?' } },
      ctx,
    );

    expect(result).toMatchObject({
      toolCallId: 'gate-1',
      isError: true,
      errorKind: 'permission_denied',
    });
    expect(result.content).toContain('does not support');
    expect(result.content).toContain('Proceed without it');
    expect(executed).toEqual([]);
  });

  it('returns deny feedback as the error content without executing', async () => {
    const executed: unknown[] = [];
    const gateRegistry = createRegistry([makeInteractiveTool(executed)]);

    const result = await executeToolCall(
      gateRegistry,
      { id: 'gate-2', name: 'interactive', input: { question: 'proceed?' } },
      {
        ...ctx,
        requestPermission: async () => ({
          behavior: 'deny',
          feedback: 'The user dismissed the question.',
        }),
      },
    );

    expect(result).toMatchObject({
      toolCallId: 'gate-2',
      isError: true,
      errorKind: 'permission_denied',
      content: 'The user dismissed the question.',
    });
    expect(executed).toEqual([]);
  });

  it('hands the executor the decision updatedInput, not the original', async () => {
    const executed: unknown[] = [];
    const gateRegistry = createRegistry([makeInteractiveTool(executed)]);
    const requests: unknown[] = [];

    const result = await executeToolCall(
      gateRegistry,
      { id: 'gate-3', name: 'interactive', input: { question: 'proceed?' } },
      {
        ...ctx,
        requestPermission: async (request) => {
          requests.push(request);
          return {
            behavior: 'allow',
            updatedInput: { question: 'proceed?', answers: { chosen: ['Yes'] } },
          };
        },
      },
    );

    // The gate saw the validated input…
    expect(requests).toEqual([
      { toolName: 'interactive', input: { question: 'proceed?' } },
    ]);
    // …and the executor received the trusted updated input unchanged.
    expect(executed).toEqual([
      { question: 'proceed?', answers: { chosen: ['Yes'] } },
    ]);
    expect(result.isError).toBe(false);
  });

  it('validates before gating: invalid input never reaches the user', async () => {
    const gateRegistry = createRegistry([makeInteractiveTool([])]);
    let asked = false;

    const result = await executeToolCall(
      gateRegistry,
      { id: 'gate-4', name: 'interactive', input: { question: 42 } },
      {
        ...ctx,
        requestPermission: async () => {
          asked = true;
          return { behavior: 'allow', updatedInput: {} };
        },
      },
    );

    expect(result).toMatchObject({ isError: true, errorKind: 'invalid_input' });
    expect(asked).toBe(false);
  });

  it('bypasses the gate entirely for non-interactive tools', async () => {
    let asked = false;

    const result = await executeToolCall(
      registry,
      { id: 'gate-5', name: 'echo', input: { message: 'hi' } },
      {
        ...ctx,
        requestPermission: async () => {
          asked = true;
          return { behavior: 'deny', feedback: 'never consulted' };
        },
      },
    );

    expect(result).toEqual({
      toolCallId: 'gate-5',
      isError: false,
      content: 'echo: hi',
    });
    expect(asked).toBe(false);
  });
});

describe('executeToolCall execution deadline', () => {
  /** A tool that never returns — the failure mode this deadline exists for.
   * Measured live 2026-08-13: a browser_action fill stopped returning and the
   * run sat dead for ten minutes, because every budget guard is checked only
   * AFTER a call completes. */
  const wedged: ToolDef<Record<string, never>> = {
    name: 'wedged',
    description: 'Never returns.',
    inputSchema: z.object({}).strict(),
    readOnly: true,
    timeoutMs: 40,
    execute: () => new Promise<never>(() => undefined),
  };

  it('reports a hung tool as a timeout instead of hanging the run', async () => {
    const result = await executeToolCall(
      createRegistry([wedged as ToolDef]),
      { id: 'hang-1', name: 'wedged', input: {} },
      ctx,
    );

    expect(result.isError).toBe(true);
    expect(result.isError === true && result.errorKind).toBe('timeout');
    // The model must not read this as "nothing happened" — a fill that hung
    // may well have filled the field before wedging.
    expect(result.content).toContain('may have taken effect');
    expect(result.content).toContain('40ms');
  });

  it('does not let a late rejection from abandoned work escape', async () => {
    // The abandoned promise cannot be cancelled, so it may reject long after
    // its call was reported. Unhandled, that would take the process down in
    // some later, unrelated turn.
    let rejectLate: ((error: Error) => void) | undefined;
    const lateThrow: ToolDef<Record<string, never>> = {
      name: 'late_throw',
      description: 'Rejects after its deadline.',
      inputSchema: z.object({}).strict(),
      readOnly: true,
      timeoutMs: 20,
      execute: () => new Promise<never>((_resolve, reject) => { rejectLate = reject; }),
    };
    const unhandled: unknown[] = [];
    const onUnhandled = (error: unknown): void => { unhandled.push(error); };
    process.on('unhandledRejection', onUnhandled);
    try {
      const result = await executeToolCall(
        createRegistry([lateThrow as ToolDef]),
        { id: 'hang-2', name: 'late_throw', input: {} },
        ctx,
      );
      expect(result.isError === true && result.errorKind).toBe('timeout');
      rejectLate?.(new Error('too late to matter'));
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('leaves a tool that returns in time completely untouched', async () => {
    const result = await executeToolCall(
      registry,
      { id: 'fast-1', name: 'echo', input: { message: 'hi' } },
      ctx,
    );
    expect(result).toEqual({ toolCallId: 'fast-1', isError: false, content: 'echo: hi' });
  });

  it('lets a tool opt out of the deadline entirely', async () => {
    // Infinity is for waiting that is legitimately unbounded. Proven by a
    // tool that resolves well past a deadline it does not have.
    const patient: ToolDef<Record<string, never>> = {
      name: 'patient',
      description: 'Slow but legitimate.',
      inputSchema: z.object({}).strict(),
      readOnly: true,
      timeoutMs: Infinity,
      execute: async () => {
        await new Promise((resolve) => setTimeout(resolve, 60));
        return 'worth the wait';
      },
    };
    const result = await executeToolCall(
      createRegistry([patient as ToolDef]),
      { id: 'patient-1', name: 'patient', input: {} },
      ctx,
    );
    expect(result).toEqual({
      toolCallId: 'patient-1',
      isError: false,
      content: 'worth the wait',
    });
  });
});
