import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import {
  createBusyResourceRegistry,
  createRegistry,
  toApiToolDefs,
  type ToolDef,
} from '../../src/tools/registry.js';

/** A small two-tool registry exercising distinct schema shapes. */
function makeTools(): ToolDef[] {
  const echo: ToolDef<{ message: string }> = {
    name: 'echo',
    description: 'Echo the message back.',
    inputSchema: z.object({ message: z.string() }),
    execute: async (input) => `echo: ${input.message}`,
  };
  const save: ToolDef<{ path: string; content: string }> = {
    name: 'save',
    description: 'Save content to a path.',
    inputSchema: z.object({ path: z.string(), content: z.string() }),
    execute: async () => 'saved',
  };
  return [echo, save];
}

describe('createRegistry', () => {
  it('contains exactly the given tools in registration order', () => {
    const registry = createRegistry(makeTools());
    expect([...registry.keys()]).toEqual(['echo', 'save']);
  });

  it('throws on a duplicate tool name', () => {
    const [echo] = makeTools();
    expect(() => createRegistry([echo, echo])).toThrow(/echo/);
  });
});

describe('toApiToolDefs', () => {
  it('produces one entry per tool with name, description, and a JSON Schema', () => {
    const defs = toApiToolDefs(createRegistry(makeTools()));
    expect(defs.map((d) => d.name)).toEqual(['echo', 'save']);
    for (const def of defs) {
      expect(def.description).not.toBe('');
      // The API needs an object schema describing the tool's parameters.
      expect(def.input_schema).toMatchObject({ type: 'object' });
    }
    // The echo schema must describe its one parameter.
    expect(defs[0].input_schema).toMatchObject({
      properties: { message: { type: 'string' } },
      required: ['message'],
    });
  });

  it('serializes byte-identically across repeated calls (stable prompt prefix)', () => {
    const registry = createRegistry(makeTools());
    const first = JSON.stringify(toApiToolDefs(registry));
    const second = JSON.stringify(toApiToolDefs(registry));
    expect(second).toBe(first);

    // Also stable across independently built registries of the same tools —
    // process restarts must reproduce the same prefix.
    const rebuilt = JSON.stringify(toApiToolDefs(createRegistry(makeTools())));
    expect(rebuilt).toBe(first);
  });
});

describe('createBusyResourceRegistry', () => {
  it('reports free immediately when nothing is marked abandoned', async () => {
    const registry = createBusyResourceRegistry();
    await expect(registry.waitUntilFree(50)).resolves.toBe(true);
  });

  it('blocks globally until abandoned work actually settles', async () => {
    const registry = createBusyResourceRegistry();
    let resolveAbandoned: (() => void) | undefined;
    const abandoned = new Promise<void>((resolve) => {
      resolveAbandoned = resolve;
    });
    registry.markAbandoned(abandoned);

    let settled = false;
    const waiting = registry.waitUntilFree(5_000).then((free) => {
      settled = true;
      return free;
    });

    // Still pending immediately after starting the wait — proves this is a
    // real wait, not an accidental instant resolve.
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(settled).toBe(false);

    resolveAbandoned!();
    await expect(waiting).resolves.toBe(true);
  });

  it('clears its losing timeout when abandoned work settles first', async () => {
    vi.useFakeTimers();
    try {
      const registry = createBusyResourceRegistry();
      let resolveAbandoned!: () => void;
      const abandoned = new Promise<void>((resolve) => {
        resolveAbandoned = resolve;
      });
      registry.markAbandoned(abandoned);

      const waiting = registry.waitUntilFree(120_000);
      expect(vi.getTimerCount()).toBe(1);
      resolveAbandoned();
      await expect(waiting).resolves.toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('cancels a busy wait and clears its timeout', async () => {
    vi.useFakeTimers();
    try {
      const registry = createBusyResourceRegistry();
      registry.markAbandoned(new Promise(() => undefined));
      const abort = new AbortController();
      const reason = new Error('run deadline');
      const waiting = registry.waitUntilFree(120_000, abort.signal);

      abort.abort(reason);

      await expect(waiting).rejects.toBe(reason);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('times out and reports not-free when the abandoned call never settles in time', async () => {
    const registry = createBusyResourceRegistry();
    registry.markAbandoned(new Promise(() => undefined));
    await expect(registry.waitUntilFree(20)).resolves.toBe(false);
  });

  it('clears the entry once settled via REJECTION too, not only resolution', async () => {
    const registry = createBusyResourceRegistry();
    let rejectAbandoned: ((error: Error) => void) | undefined;
    const abandoned = new Promise<never>((_resolve, reject) => {
      rejectAbandoned = reject;
    });
    registry.markAbandoned(abandoned);
    rejectAbandoned!(new Error('the abandoned work eventually failed'));

    // Give the internal cleanup .then() a microtask to run.
    await new Promise((resolve) => setTimeout(resolve, 0));

    await expect(registry.waitUntilFree(50)).resolves.toBe(true);
  });

  it.each(['wait', 'drain'] as const)(
    '%s reaches a fixed point when another effect appears mid-wait',
    async (mode) => {
      const registry = createBusyResourceRegistry();
      let releaseFirst!: () => void;
      let releaseSecond!: () => void;
      const first = new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      const second = new Promise<void>((resolve) => {
        releaseSecond = resolve;
      });
      registry.markAbandoned(first);

      let drained = false;
      const draining = (
        mode === 'wait' ? registry.waitUntilFree(5_000) : registry.drainUntilFree()
      ).then(() => {
        drained = true;
      });
      registry.markAbandoned(second);
      releaseFirst();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(drained).toBe(false);

      releaseSecond();
      await draining;
      expect(drained).toBe(true);
    },
  );
});
