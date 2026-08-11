import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { initManifest } from '../run/artifacts.js';
import type { ToolCall } from '../tools/pipeline.js';
import { createRegistry, type ToolCtx, type ToolDef } from '../tools/registry.js';
import { MAX_CONCURRENT_READS, scheduleToolCalls } from './scheduler.js';

// The scheduler's contract is about time — what overlaps, what doesn't, and
// that results still land in request order. Every test drives instrumented
// fake tools that log "start <label>" / "finish <label>" events (plus
// millisecond timestamps) into a shared timeline; assertions read event
// order, which is deterministic, rather than comparing raw clock values.

const sleep = (ms: number): Promise<void> => new Promise((wake) => setTimeout(wake, ms));

/** Flush timers and microtasks so every runnable call has actually started. */
const tick = (): Promise<void> => new Promise((wake) => setTimeout(wake, 0));

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
    expect(started).toHaveLength(MAX_CONCURRENT_READS);
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
