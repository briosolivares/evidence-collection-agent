import { z } from 'zod';
import { describe, expect, it } from 'vitest';

import { createBashTool, TOOL_ORDER, createToolRegistry } from './index.js';
import { toApiToolDefs, type ToolDef } from './registry.js';

describe('production tool schemas', () => {
  // The Claude API rejects any tool whose input_schema lacks a top-level
  // `type: "object"` — a zod union at the root converts to a bare `anyOf`
  // and 400s every run on turn 1 (download regressed this way, 2026-08-11).
  // registry.test.ts only checks stub tools; this guards the real ones.
  it('every registered tool converts to a top-level object schema', () => {
    const registry = createToolRegistry(
      new Map<string, ToolDef>([['bash', createBashTool({ secretEnvDenylist: [] }) as ToolDef]]),
    );
    const defs = toApiToolDefs(registry);
    expect(defs.length).toBeGreaterThan(0);
    for (const def of defs) {
      expect(def.input_schema, `tool "${def.name}"`).toMatchObject({ type: 'object' });
    }
  });
});

describe('the frozen tool order', () => {
  it('pins the exact frozen order', () => {
    // A snapshot in the strictest sense: prompt caching is a byte-exact prefix
    // match, so reordering these names silently invalidates every cached
    // prefix and re-pays the whole conversation at cache-WRITE rates. If this
    // assertion fails, the question is not "update the test" but "was the
    // reorder intended, and is the cache cost understood?"
    expect(TOOL_ORDER).toEqual([
      'set_output_contract',
      'update_table',
      'write_document',
      'observe',
      'browser_action',
      'handle_dialog',
      'execute_javascript',
      'capture_text',
      'inspect_document',
      'screenshot',
      'download',
      'read_file',
      'write_file',
      'edit_file',
      'grep',
      'bash',
      'ask_user_question',
      'submit_for_verification',
    ]);
  });

  it('puts the contract gate first and completion last', () => {
    // Structural, not cosmetic: set_output_contract gates every other call,
    // and submit_for_verification ends the run.
    expect(TOOL_ORDER[0]).toBe('set_output_contract');
    expect(TOOL_ORDER.at(-1)).toBe('submit_for_verification');
  });

  it('contains no duplicates', () => {
    expect(new Set(TOOL_ORDER).size).toBe(TOOL_ORDER.length);
  });

  it('builds a registry in frozen order, skipping tools a run cannot supply', () => {
    const registry = createToolRegistry();
    // Every statically-constructible tool, in frozen order — and nothing that
    // needs run-scoped state, which a caller must supply explicitly.
    expect([...registry.keys()]).toEqual([
      'set_output_contract',
      'observe',
      'browser_action',
      'handle_dialog',
      'download',
      'read_file',
      'write_file',
      'edit_file',
      'grep',
      'ask_user_question',
    ]);
  });

  it('omits the run-scoped tools until a caller supplies them', () => {
    // These need a table store, an evidence store, a content registry, or a
    // browser reader, so they cannot be constructed statically. Their absence
    // must be an omission, never a silently broken tool.
    const names = new Set(createToolRegistry().keys());
    for (const runScoped of [
      'update_table',
      'write_document',
      'execute_javascript',
      'capture_text',
      'inspect_document',
      // bash closes over the run's secret-env denylist and screenshot over the
      // output contract, so both must be supplied rather than built statically.
      'bash',
      'screenshot',
    ]) {
      expect(names.has(runScoped)).toBe(false);
    }
  });

  it('places a run-scoped tool at its frozen position, not where it was passed', () => {
    const fake = (name: string): ToolDef =>
      ({
        name,
        description: name,
        inputSchema: z.object({}).strict(),
        getAccess: () => ({ reads: [], writes: [] }),
        execute: async () => 'ok',
      }) as ToolDef;

    const registry = createToolRegistry(
      // Deliberately supplied in the WRONG order.
      new Map([
        ['submit_for_verification', fake('submit_for_verification')],
        ['set_output_contract', fake('set_output_contract')],
      ]),
    );
    const names = [...registry.keys()];
    expect(names[0]).toBe('set_output_contract');
    expect(names.at(-1)).toBe('submit_for_verification');
  });

  it('refuses a tool whose name is not in the frozen order', () => {
    const rogue = {
      name: 'surprise_tool',
      description: 'x',
      inputSchema: z.object({}).strict(),
      getAccess: () => ({ reads: [], writes: [] }),
      execute: async () => 'ok',
    } as ToolDef;
    expect(() => createToolRegistry(new Map([['surprise_tool', rogue]]))).toThrow(
      /not in TOOL_ORDER/,
    );
  });

  it('serializes its API definitions byte-identically across calls', () => {
    // The cached-prefix guarantee, asserted directly.
    const first = JSON.stringify(toApiToolDefs(createToolRegistry()));
    const second = JSON.stringify(toApiToolDefs(createToolRegistry()));
    expect(first).toBe(second);
  });
});
