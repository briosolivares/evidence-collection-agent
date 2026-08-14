import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { initManifest } from '../run/artifacts.js';
import type { ToolCall, ToolCallResult } from '../tools/pipeline.js';
import { createRegistry, type ToolCtx, type ToolDef, type ToolAccess } from '../tools/registry.js';
import {
  MAX_CONCURRENT_CALLS,
  scheduleToolCalls,
  validateToolCallsForScheduling,
  type ToolCallLifecycleHooks,
} from './scheduler.js';

// The scheduler's contract is about time — what overlaps, what doesn't, and
// that results still land in request order. Every test drives instrumented
// fake tools that log "start <label>" / "finish <label>" events (plus
// millisecond timestamps) into a shared timeline; assertions read event
// order, which is deterministic, rather than comparing raw clock values.

const sleep = (ms: number): Promise<void> => new Promise((wake) => setTimeout(wake, ms));

/** Flush timers and microtasks so every runnable call has actually started. */
const tick = (): Promise<void> => new Promise((wake) => setTimeout(wake, 0));

/**
 * Tick until `condition` holds, or fail loudly after a bounded number of
 * attempts.
 *
 * Prefer this over counting `tick()` calls whenever the thing being waited on
 * sits behind an unknown number of scheduler, validation, and tool hops: a
 * fixed count encodes today's hop count into the test and breaks the moment a
 * layer is added, while the failure it produces ("expected [...] to include
 * ...") says nothing about why.
 */
async function until(
  condition: () => boolean,
  { attempts = 50, what = 'condition' }: { attempts?: number; what?: string } = {},
): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (condition()) return;
    await tick();
  }
  throw new Error(`${what} did not hold within ${attempts} ticks`);
}

/** One instrumented execution record. */
interface Timeline {
  /** "start <label>" and "finish <label>" entries, in the order they happened. */
  events: string[];
  startedAtMs: Map<string, number>;
  finishedAtMs: Map<string, number>;
}

const probeInput = z.object({
  label: z.string(),
  delayMs: z.number().default(0),
  fail: z.boolean().default(false),
});
type ProbeInput = z.infer<typeof probeInput>;

/** A probe tool: logs start, idles delayMs, logs finish, then returns
 * "done <label>" — or throws "<label> exploded" when told to fail. */
function probeTool(name: string, readOnly: boolean, timeline: Timeline): ToolDef {
  const tool: ToolDef<ProbeInput> = {
    name,
    description: `Instrumented ${readOnly ? 'read-only' : 'state-changing'} probe.`,
    inputSchema: probeInput,
    readOnly,
    execute: async ({ label, delayMs, fail }) => {
      timeline.events.push(`start ${label}`);
      timeline.startedAtMs.set(label, Date.now());
      await sleep(delayMs);
      timeline.finishedAtMs.set(label, Date.now());
      timeline.events.push(`finish ${label}`);
      if (fail) throw new Error(`${label} exploded`);
      return `done ${label}`;
    },
  };
  return tool as ToolDef;
}

/** Shorthand for one probe call; the call id doubles as "id-<label>". */
function probeCall(name: string, label: string, delayMs = 0, fail = false): ToolCall {
  return { id: `id-${label}`, name, input: { label, delayMs, fail } };
}

/** Index of an event in the timeline; fails the test if it never happened. */
function at(timeline: Timeline, event: string): number {
  const index = timeline.events.indexOf(event);
  expect(index, `expected event "${event}" in ${JSON.stringify(timeline.events)}`).toBeGreaterThanOrEqual(0);
  return index;
}

let runDir: string;
let timeline: Timeline;
let ctx: ToolCtx;

beforeEach(() => {
  runDir = mkdtempSync(join(tmpdir(), 'scheduler-test-'));
  initManifest(runDir, 'scheduler test');
  timeline = { events: [], startedAtMs: new Map(), finishedAtMs: new Map() };
  ctx = { runDir };
});

afterEach(() => {
  rmSync(runDir, { recursive: true, force: true });
});

describe('scheduleToolCalls', () => {
  it('two state-changing calls never overlap and finish in request order', async () => {
    // w1 is much slower than w2: parallel (or reordered) execution would
    // interleave the events or finish w2 first.
    const registry = createRegistry([probeTool('write', false, timeline)]);
    const results = await scheduleToolCalls(
      [probeCall('write', 'w1', 40), probeCall('write', 'w2', 5)],
      registry,
      ctx,
    );

    expect(timeline.events).toEqual(['start w1', 'finish w1', 'start w2', 'finish w2']);
    expect(results.map((result) => result.content)).toEqual(['done w1', 'done w2']);
  });

  it('six read-only calls: at most 5 in flight, the 6th starts only after a slot frees', async () => {
    // Deterministic gating instead of timers: each gated read blocks until
    // the test opens its gate, so "in flight" is directly observable.
    const gates = new Map<string, () => void>();
    const gatedRead: ToolDef<{ label: string }> = {
      name: 'gated_read',
      description: 'Read-only probe that waits for the test to open its gate.',
      inputSchema: z.object({ label: z.string() }),
      readOnly: true,
      execute: async ({ label }) => {
        timeline.events.push(`start ${label}`);
        await new Promise<void>((open) => gates.set(label, open));
        timeline.events.push(`finish ${label}`);
        return `done ${label}`;
      },
    };
    const registry = createRegistry([gatedRead as ToolDef]);
    const labels = ['r1', 'r2', 'r3', 'r4', 'r5', 'r6'];
    const pending = scheduleToolCalls(
      labels.map((label) => ({ id: `id-${label}`, name: 'gated_read', input: { label } })),
      registry,
      ctx,
    );

    // All six were requested at once, but only the cap's worth may start.
    await tick();
    const started = timeline.events.filter((event) => event.startsWith('start '));
    expect(started).toHaveLength(MAX_CONCURRENT_CALLS);
    expect(started).toEqual(['start r1', 'start r2', 'start r3', 'start r4', 'start r5']);
    expect(timeline.events).not.toContain('start r6');

    // Freeing one slot — any slot — lets exactly the waiting 6th read start.
    gates.get('r2')!();
    await tick();
    expect(at(timeline, 'start r6')).toBeGreaterThan(at(timeline, 'finish r2'));

    for (const label of labels) gates.get(label)?.();
    const results = await pending;
    expect(results.map((result) => result.content)).toEqual(labels.map((label) => `done ${label}`));
  });

  it('a mixed batch returns results in request order even when a slow read finishes last', async () => {
    const registry = createRegistry([
      probeTool('read', true, timeline),
      probeTool('write', false, timeline),
    ]);
    const results = await scheduleToolCalls(
      [
        probeCall('write', 'w1', 5),
        probeCall('read', 'slow-read', 50),
        probeCall('read', 'fast-read', 5),
      ],
      registry,
      ctx,
    );

    // The reads genuinely overlapped, and the slow read completed last...
    expect(at(timeline, 'start fast-read')).toBeLessThan(at(timeline, 'finish slow-read'));
    expect(timeline.events[timeline.events.length - 1]).toBe('finish slow-read');
    // ...yet each result sits in its call's slot, in request order.
    expect(results.map((result) => result.toolCallId)).toEqual(['id-w1', 'id-slow-read', 'id-fast-read']);
    expect(results.map((result) => result.content)).toEqual(['done w1', 'done slow-read', 'done fast-read']);
  });

  it('a state-changing call is a barrier: no read crosses it in either direction', async () => {
    // The documented interleaving semantics: [read, write, read] runs the
    // first read to completion, then the write, then the second read — the
    // later read is meant to observe the write's effect, so it must not be
    // hoisted into the earlier parallel batch.
    const registry = createRegistry([
      probeTool('read', true, timeline),
      probeTool('write', false, timeline),
    ]);
    await scheduleToolCalls(
      [
        probeCall('read', 'before', 30),
        probeCall('write', 'the-write', 5),
        probeCall('read', 'after', 5),
      ],
      registry,
      ctx,
    );

    expect(at(timeline, 'start the-write')).toBeGreaterThan(at(timeline, 'finish before'));
    expect(at(timeline, 'start after')).toBeGreaterThan(at(timeline, 'finish the-write'));
  });

  it('one failing call yields a structured error in its slot without aborting the others', async () => {
    const registry = createRegistry([
      probeTool('read', true, timeline),
      probeTool('write', false, timeline),
    ]);
    const results = await scheduleToolCalls(
      [
        probeCall('read', 'r-ok', 5),
        probeCall('read', 'r-boom', 5, true),
        probeCall('write', 'w-ok', 5),
      ],
      registry,
      ctx,
    );

    // Every call ran to completion, failure included...
    for (const label of ['r-ok', 'r-boom', 'w-ok']) at(timeline, `finish ${label}`);
    // ...and the failure occupies exactly its own slot, model-readable.
    expect(results[0]).toEqual({ toolCallId: 'id-r-ok', isError: false, content: 'done r-ok' });
    expect(results[1]).toMatchObject({ toolCallId: 'id-r-boom', isError: true });
    expect(results[1].content).toContain('r-boom exploded');
    expect(results[2]).toEqual({ toolCallId: 'id-w-ok', isError: false, content: 'done w-ok' });
  });
});

// --- T13: input-aware scheduling ---------------------------------------------

describe('access-aware scheduling', () => {
  /** A tool that declares access derived from its input, recording overlap. */
  function accessTool(
    name: string,
    access: (input: { key: string; ms?: number }) => ToolAccess,
    live: { count: number; peak: number },
  ): ToolDef {
    const def: ToolDef<{ key: string; ms?: number }> = {
      name,
      description: name,
      inputSchema: z.object({ key: z.string(), ms: z.number().optional() }),
      readOnly: false,
      getAccess: access,
      execute: async (input) => {
        live.count += 1;
        live.peak = Math.max(live.peak, live.count);
        await new Promise((resolve) => setTimeout(resolve, input.ms ?? 10));
        live.count -= 1;
        return `${name}:${input.key}`;
      },
    };
    return def as ToolDef;
  }

  function keyCall(name: string, key: string, ms = 10) {
    return { id: `${name}-${key}`, name, input: { key, ms } };
  }

  it('overlaps writes to DIFFERENT resources', async () => {
    // The whole gain over readOnly batching: two state-changing calls that
    // cannot touch each other now run together.
    const live = { count: 0, peak: 0 };
    const registry = createRegistry([
      accessTool('act', (input) => ({ reads: [], writes: [`page:${input.key}`] }), live),
    ]);

    await scheduleToolCalls([keyCall('act', 'p1'), keyCall('act', 'p2')], registry, ctx);
    expect(live.peak).toBe(2);
  });

  it('serializes writes to the SAME resource', async () => {
    const live = { count: 0, peak: 0 };
    const registry = createRegistry([
      accessTool('act', (input) => ({ reads: [], writes: [`page:${input.key}`] }), live),
    ]);

    await scheduleToolCalls([keyCall('act', 'p1'), keyCall('act', 'p1')], registry, ctx);
    expect(live.peak).toBe(1);
  });

  it('serializes a read against a write of the same resource', async () => {
    const live = { count: 0, peak: 0 };
    const registry = createRegistry([
      accessTool('look', (input) => ({ reads: [`page:${input.key}`], writes: [] }), live),
      accessTool('act', (input) => ({ reads: [], writes: [`page:${input.key}`] }), live),
    ]);

    await scheduleToolCalls([keyCall('look', 'p1'), keyCall('act', 'p1')], registry, ctx);
    expect(live.peak).toBe(1);
  });

  it('overlaps two reads of the same resource', async () => {
    const live = { count: 0, peak: 0 };
    const registry = createRegistry([
      accessTool('look', (input) => ({ reads: [`page:${input.key}`], writes: [] }), live),
    ]);

    await scheduleToolCalls([keyCall('look', 'p1'), keyCall('look', 'p1')], registry, ctx);
    expect(live.peak).toBe(2);
  });

  it('runs a tool whose getAccess throws entirely alone', async () => {
    const live = { count: 0, peak: 0 };
    const registry = createRegistry([
      accessTool(
        'broken',
        () => {
          throw new Error('bad declaration');
        },
        live,
      ),
      accessTool('look', (input) => ({ reads: [`page:${input.key}`], writes: [] }), live),
    ]);

    await scheduleToolCalls(
      [keyCall('look', 'p1'), keyCall('broken', 'p2'), keyCall('look', 'p3')],
      registry,
      ctx,
    );
    // A buggy declaration degrades to serial, never to unsafe parallelism.
    expect(live.peak).toBe(1);
  });

  it('commits results in call order even when a later call finishes first', async () => {
    const live = { count: 0, peak: 0 };
    const registry = createRegistry([
      accessTool('act', (input) => ({ reads: [], writes: [`page:${input.key}`] }), live),
    ]);

    const results = await scheduleToolCalls(
      [keyCall('act', 'slow', 40), keyCall('act', 'fast', 1)],
      registry,
      ctx,
    );
    expect(results.map((result) => result.content)).toEqual(['act:slow', 'act:fast']);
  });
});

describe('validateToolCallsForScheduling', () => {
  it('marks an unknown tool exclusive without executing anything', () => {
    const registry = createRegistry([
      probeTool('read', true, { events: [], startedAtMs: new Map(), finishedAtMs: new Map() }),
    ]);
    const validated = validateToolCallsForScheduling(
      [{ id: 'x', name: 'nope', input: {} }],
      registry,
    );
    expect(validated[0]?.tool).toBeUndefined();
    expect(validated[0]?.access.exclusive).toBe(true);
  });

  it('marks an invalid input exclusive and records the error', () => {
    const tool: ToolDef<{ key: string }> = {
      name: 'strict',
      description: 'strict',
      inputSchema: z.object({ key: z.string() }),
      readOnly: true,
      getAccess: () => ({ reads: [], writes: [] }),
      execute: async () => 'ok',
    };
    const validated = validateToolCallsForScheduling(
      [{ id: 'x', name: 'strict', input: { key: 42 } }],
      createRegistry([tool as ToolDef]),
    );
    expect(validated[0]?.access.exclusive).toBe(true);
    expect(validated[0]?.validationError).toBeDefined();
    // Access was never derived from unvalidated input.
    expect(validated[0]?.input).toBeUndefined();
  });

  it('derives access from the validated input', () => {
    const tool: ToolDef<{ page: string }> = {
      name: 'act',
      description: 'act',
      inputSchema: z.object({ page: z.string() }),
      readOnly: false,
      getAccess: (input) => ({ reads: [], writes: [`page:${input.page}`] }),
      execute: async () => 'ok',
    };
    const validated = validateToolCallsForScheduling(
      [{ id: 'x', name: 'act', input: { page: 'p7' } }],
      createRegistry([tool as ToolDef]),
    );
    expect(validated[0]?.access.writes).toEqual(['page:p7']);
  });
});

// --- lifecycle hooks (checkpoint/resume seam) --------------------------------

describe('scheduleToolCalls lifecycle hooks', () => {
  it('beforeStateChangingCall fires for a write and for an unknown tool, not for a pure read', async () => {
    const registry = createRegistry([
      probeTool('read', true, timeline),
      probeTool('write', false, timeline),
    ]);
    const seen: Array<{ call: ToolCall; access: ToolAccess }> = [];
    const hooks: ToolCallLifecycleHooks = {
      beforeStateChangingCall: async (call, access) => {
        seen.push({ call, access });
      },
    };

    await scheduleToolCalls(
      [
        probeCall('read', 'r1'),
        probeCall('write', 'w1'),
        { id: 'id-unknown', name: 'nope', input: {} },
      ],
      registry,
      ctx,
      hooks,
    );

    expect(seen.map((entry) => entry.call.name)).toEqual(['write', 'nope']);
    // The unknown tool's fail-closed EXCLUSIVE_ACCESS is exactly why it
    // fired: an unclassifiable call is treated as state-changing.
    expect(seen[1]?.access.exclusive).toBe(true);
  });

  it('afterCallResult fires once per call, including error results, matching what is returned', async () => {
    const registry = createRegistry([
      probeTool('read', true, timeline),
      probeTool('write', false, timeline),
    ]);
    const seen: ToolCallResult[] = [];
    const hooks: ToolCallLifecycleHooks = {
      afterCallResult: async (_call, result) => {
        seen.push(result);
      },
    };

    const results = await scheduleToolCalls(
      [probeCall('read', 'r-ok'), probeCall('read', 'r-boom', 0, true), probeCall('write', 'w-ok')],
      registry,
      ctx,
      hooks,
    );

    expect(seen).toHaveLength(3);
    const byId = new Map(seen.map((result) => [result.toolCallId, result]));
    for (const result of results) {
      expect(byId.get(result.toolCallId)).toEqual(result);
    }
  });

  it('beforeStateChangingCall is awaited: a pending hook delays the call from starting', async () => {
    const registry = createRegistry([probeTool('write', false, timeline)]);
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const hooks: ToolCallLifecycleHooks = {
      beforeStateChangingCall: async () => {
        await gate;
      },
    };

    const pending = scheduleToolCalls([probeCall('write', 'w1')], registry, ctx, hooks);
    await tick();
    expect(timeline.events).not.toContain('start w1');

    release();
    await pending;
    expect(timeline.events).toContain('start w1');
  });

  it('afterCallResult is awaited: scheduleToolCalls does not resolve before a pending hook does', async () => {
    const registry = createRegistry([probeTool('read', true, timeline)]);
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let hookResolved = false;
    const hooks: ToolCallLifecycleHooks = {
      afterCallResult: async () => {
        await gate;
        hookResolved = true;
      },
    };

    const pending = scheduleToolCalls([probeCall('read', 'r1')], registry, ctx, hooks);
    // Wait for the CONDITION, not for a fixed number of macrotasks: reaching
    // `finish r1` crosses the semaphore, zod validation, the deadline wrapper,
    // and the probe's own sleep(0), whose timer is queued after any tick()
    // registered here — so a tick count that happens to work is luck, and this
    // assertion is about the hook's effect, not about how many hops precede it.
    await until(() => timeline.events.includes('finish r1'));
    // The tool call itself already finished...
    expect(timeline.events).toContain('finish r1');
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    await tick();
    // ...but the batch has not, because the hook is still pending.
    expect(settled).toBe(false);

    release();
    await pending;
    expect(hookResolved).toBe(true);
  });

  it('omitting hooks reproduces the existing grouping, concurrency, and result order exactly', async () => {
    // Same scenario as "a mixed batch returns results in request order even
    // when a slow read finishes last" above, run with `hooks` left
    // undefined — the fourth parameter must be a no-op when absent.
    const registry = createRegistry([
      probeTool('read', true, timeline),
      probeTool('write', false, timeline),
    ]);
    const results = await scheduleToolCalls(
      [
        probeCall('write', 'w1', 5),
        probeCall('read', 'slow-read', 50),
        probeCall('read', 'fast-read', 5),
      ],
      registry,
      ctx,
    );

    expect(at(timeline, 'start fast-read')).toBeLessThan(at(timeline, 'finish slow-read'));
    expect(results.map((result) => result.toolCallId)).toEqual([
      'id-w1',
      'id-slow-read',
      'id-fast-read',
    ]);
  });

  it('a throwing beforeStateChangingCall fails only its own call, never corrupting the batch', async () => {
    const registry = createRegistry([
      probeTool('read', true, timeline),
      probeTool('write', false, timeline),
    ]);
    const hooks: ToolCallLifecycleHooks = {
      beforeStateChangingCall: async (call) => {
        if (call.id === 'id-w-boom') throw new Error('hook exploded');
      },
    };

    const results = await scheduleToolCalls(
      [probeCall('read', 'r-ok'), probeCall('write', 'w-boom'), probeCall('write', 'w-ok')],
      registry,
      ctx,
      hooks,
    );

    expect(results).toHaveLength(3);
    expect(results.map((result) => result.toolCallId)).toEqual(['id-r-ok', 'id-w-boom', 'id-w-ok']);
    expect(results[0]).toMatchObject({ toolCallId: 'id-r-ok', isError: false });
    expect(results[1]).toMatchObject({ toolCallId: 'id-w-boom', isError: true });
    expect(results[1]!.content).toContain('hook exploded');
    expect(results[2]).toMatchObject({ toolCallId: 'id-w-ok', isError: false });
    // The underlying write never ran because its hook failed first.
    expect(timeline.events).not.toContain('start w-boom');
    expect(timeline.events).toContain('start w-ok');
  });

  it('a throwing afterCallResult still returns a dense, correctly ordered array', async () => {
    const registry = createRegistry([probeTool('read', true, timeline)]);
    const hooks: ToolCallLifecycleHooks = {
      afterCallResult: async (call) => {
        if (call.id === 'id-r2') throw new Error('after hook exploded');
      },
    };

    const results = await scheduleToolCalls(
      [probeCall('read', 'r1'), probeCall('read', 'r2'), probeCall('read', 'r3')],
      registry,
      ctx,
      hooks,
    );

    expect(results.map((result) => result.toolCallId)).toEqual(['id-r1', 'id-r2', 'id-r3']);
    expect(results[0]).toMatchObject({ isError: false, content: 'done r1' });
    // Documented choice: a post-hoc hook failure overwrites the (otherwise
    // successful) result — see hookFailureResult's comment in scheduler.ts.
    expect(results[1]).toMatchObject({ isError: true });
    expect(results[1]!.content).toContain('after hook exploded');
    expect(results[2]).toMatchObject({ isError: false, content: 'done r3' });
  });
});
