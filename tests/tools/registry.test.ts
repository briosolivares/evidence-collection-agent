import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import {
  accessesConflict,
  accessKey,
  createBusyResourceRegistry,
  createRegistry,
  deriveAccess,
  EXCLUSIVE_ACCESS,
  toApiToolDefs,
  type ToolDef,
} from '../../src/tools/registry.js';

/** A small two-tool registry exercising distinct schema shapes. */
function makeTools(): ToolDef[] {
  const echo: ToolDef<{ message: string }> = {
    name: 'echo',
    description: 'Echo the message back.',
    inputSchema: z.object({ message: z.string() }),
    getAccess: () => ({ reads: [], writes: [] }),
    execute: async (input) => `echo: ${input.message}`,
  };
  const save: ToolDef<{ path: string; content: string }> = {
    name: 'save',
    description: 'Save content to a path.',
    inputSchema: z.object({ path: z.string(), content: z.string() }),
    getAccess: (input) => ({ reads: [], writes: [accessKey.file(input.path)] }),
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

describe('accessesConflict', () => {
  // Non-file keys stay exact-match: two different pages, tables, or origins
  // never conflict, even though they share no path semantics to reason about.
  it('does not conflict on unrelated non-file keys', () => {
    expect(
      accessesConflict(
        { reads: [], writes: [accessKey.page('p1')] },
        { reads: [], writes: [accessKey.page('p2')] },
      ),
    ).toBe(false);
  });

  it('conflicts when a write reads a directory-scoped key AND a nested file write key', () => {
    // This is grep(path: '.') — reads: [accessKey.file('.')] — racing a
    // write_file('artifacts/report.csv') that writes inside the tree grep is
    // scanning. Exact-string matching would miss this (the keys are
    // "file:." and "file:artifacts/report.csv"), which is exactly the unsafe
    // parallelism this check exists to close.
    expect(
      accessesConflict(
        { reads: [accessKey.file('.')], writes: [] },
        { reads: [], writes: [accessKey.file('artifacts/report.csv')] },
      ),
    ).toBe(true);
  });

  it('conflicts when a directory read key is a strict ancestor of a nested write key', () => {
    expect(
      accessesConflict(
        { reads: [accessKey.file('artifacts')], writes: [] },
        { reads: [], writes: [accessKey.file('artifacts/sub/report.csv')] },
      ),
    ).toBe(true);
    // Symmetric: the narrower call may be declared on either side.
    expect(
      accessesConflict(
        { reads: [], writes: [accessKey.file('artifacts/sub/report.csv')] },
        { reads: [accessKey.file('artifacts')], writes: [] },
      ),
    ).toBe(true);
  });

  it('does not conflict on a directory key that merely shares a string prefix, not a path segment', () => {
    // "artifacts" must not be treated as an ancestor of "artifacts-old/x" —
    // that is a name collision, not a containment relationship.
    expect(
      accessesConflict(
        { reads: [accessKey.file('artifacts')], writes: [] },
        { reads: [], writes: [accessKey.file('artifacts-old/x.csv')] },
      ),
    ).toBe(false);
  });

  it('does not conflict between sibling directories or sibling files', () => {
    expect(
      accessesConflict(
        { reads: [accessKey.file('artifacts/a')], writes: [] },
        { reads: [], writes: [accessKey.file('artifacts/b')] },
      ),
    ).toBe(false);
  });

  it('treats "./foo" and "foo/" as the same key as "foo"', () => {
    expect(
      accessesConflict(
        { reads: [accessKey.file('./foo')], writes: [] },
        { reads: [], writes: [accessKey.file('foo/')] },
      ),
    ).toBe(true);
  });

  it('never conflicts on read/read, even for overlapping directory keys', () => {
    expect(
      accessesConflict(
        { reads: [accessKey.file('.')], writes: [] },
        { reads: [accessKey.file('artifacts/report.csv')], writes: [] },
      ),
    ).toBe(false);
  });
});

describe('deriveAccess', () => {
  // getAccess is mandatory on ToolDef (T16), so "no getAccess" is no longer
  // a state this function can be called with — the type system rules it out
  // at the call site, not this function. The only remaining fallback is a
  // declaration that THROWS, which must still degrade to EXCLUSIVE_ACCESS.
  it('degrades to EXCLUSIVE_ACCESS when getAccess throws, never to unsafe parallelism', () => {
    const tool: ToolDef = {
      name: 'buggy',
      description: '',
      inputSchema: z.object({}),
      getAccess: () => {
        throw new Error('boom');
      },
      execute: () => undefined,
    };
    expect(deriveAccess(tool, {})).toBe(EXCLUSIVE_ACCESS);
  });

  it("returns the tool's own declared access, derived from the given input", () => {
    const tool: ToolDef<{ pageId: string }> = {
      name: 'paged',
      description: '',
      inputSchema: z.object({ pageId: z.string() }),
      getAccess: (input) => ({ reads: [], writes: [accessKey.page(input.pageId)] }),
      execute: () => undefined,
    };
    expect(deriveAccess(tool, { pageId: 'p1' })).toEqual({
      reads: [],
      writes: [accessKey.page('p1')],
    });
  });
});

describe('createBusyResourceRegistry', () => {
  it('reports free immediately when nothing is marked abandoned', async () => {
    const registry = createBusyResourceRegistry();
    await expect(
      registry.waitUntilFree({ reads: [], writes: [accessKey.page('p1')] }, 50),
    ).resolves.toBe(true);
  });

  it('does not block a non-conflicting access', async () => {
    const registry = createBusyResourceRegistry();
    registry.markAbandoned({ reads: [], writes: [accessKey.page('p1')] }, new Promise(() => undefined));
    await expect(
      registry.waitUntilFree({ reads: [], writes: [accessKey.page('p2')] }, 50),
    ).resolves.toBe(true);
  });

  it('never blocks a conflicting READ — only a write conflicts with an abandoned read', () => {
    const registry = createBusyResourceRegistry();
    registry.markAbandoned({ reads: [accessKey.page('p1')], writes: [] }, new Promise(() => undefined));
    return expect(
      registry.waitUntilFree({ reads: [accessKey.page('p1')], writes: [] }, 50),
    ).resolves.toBe(true);
  });

  it('blocks a conflicting write until the abandoned call actually settles, then frees it', async () => {
    const registry = createBusyResourceRegistry();
    let resolveAbandoned: (() => void) | undefined;
    const abandoned = new Promise<void>((resolve) => {
      resolveAbandoned = resolve;
    });
    registry.markAbandoned({ reads: [], writes: [accessKey.page('p1')] }, abandoned);

    let settled = false;
    const waiting = registry
      .waitUntilFree({ reads: [], writes: [accessKey.page('p1')] }, 5_000)
      .then((free) => {
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
      registry.markAbandoned(
        { reads: [], writes: [accessKey.page('p1')] },
        abandoned,
      );

      const waiting = registry.waitUntilFree(
        { reads: [], writes: [accessKey.page('p1')] },
        120_000,
      );
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
      registry.markAbandoned(
        { reads: [], writes: [accessKey.page('p1')] },
        new Promise(() => undefined),
      );
      const abort = new AbortController();
      const reason = new Error('run deadline');
      const waiting = registry.waitUntilFree(
        { reads: [], writes: [accessKey.page('p1')] },
        120_000,
        abort.signal,
      );

      abort.abort(reason);

      await expect(waiting).rejects.toBe(reason);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('times out and reports not-free when the abandoned call never settles in time', async () => {
    const registry = createBusyResourceRegistry();
    registry.markAbandoned({ reads: [], writes: [accessKey.page('p1')] }, new Promise(() => undefined));
    await expect(
      registry.waitUntilFree({ reads: [], writes: [accessKey.page('p1')] }, 20),
    ).resolves.toBe(false);
  });

  it('clears the entry once settled via REJECTION too, not only resolution', async () => {
    const registry = createBusyResourceRegistry();
    let rejectAbandoned: ((error: Error) => void) | undefined;
    const abandoned = new Promise<never>((_resolve, reject) => {
      rejectAbandoned = reject;
    });
    registry.markAbandoned({ reads: [], writes: [accessKey.page('p1')] }, abandoned);
    rejectAbandoned!(new Error('the abandoned work eventually failed'));

    // Give the internal cleanup .then() a microtask to run.
    await new Promise((resolve) => setTimeout(resolve, 0));

    await expect(
      registry.waitUntilFree({ reads: [], writes: [accessKey.page('p1')] }, 50),
    ).resolves.toBe(true);
  });

  it('drains to a fixed point when another conflicting effect appears mid-wait', async () => {
    const registry = createBusyResourceRegistry();
    let releaseFirst!: () => void;
    let releaseSecond!: () => void;
    const first = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const second = new Promise<void>((resolve) => {
      releaseSecond = resolve;
    });
    const access = { reads: [], writes: [accessKey.page('p1')] };
    registry.markAbandoned(access, first);

    let drained = false;
    const draining = registry.drainUntilFree(access).then(() => {
      drained = true;
    });
    registry.markAbandoned(access, second);
    releaseFirst();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(drained).toBe(false);

    releaseSecond();
    await draining;
    expect(drained).toBe(true);
  });
});
