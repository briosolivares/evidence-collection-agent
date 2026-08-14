import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { accessesConflict, accessKey, createRegistry, toApiToolDefs, type ToolDef } from './registry.js';

/** A small two-tool registry exercising distinct schema shapes. */
function makeTools(): ToolDef[] {
  const echo: ToolDef<{ message: string }> = {
    name: 'echo',
    description: 'Echo the message back.',
    inputSchema: z.object({ message: z.string() }),
    readOnly: true,
    execute: async (input) => `echo: ${input.message}`,
  };
  const save: ToolDef<{ path: string; content: string }> = {
    name: 'save',
    description: 'Save content to a path.',
    inputSchema: z.object({ path: z.string(), content: z.string() }),
    readOnly: false,
    execute: async () => 'saved',
  };
  return [echo, save];
}

describe('createRegistry', () => {
  it('contains exactly the given tools in registration order', () => {
    const registry = createRegistry(makeTools());
    expect([...registry.keys()]).toEqual(['echo', 'save']);
    expect(registry.get('echo')?.readOnly).toBe(true);
    expect(registry.get('save')?.readOnly).toBe(false);
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
