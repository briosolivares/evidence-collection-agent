import { z } from 'zod';
import { describe, expect, it } from 'vitest';

import { createProductionRegistry,
  createBashTool,
  V2_TOOL_ORDER,
  createV2Registry,
} from './index.js';
import { toApiToolDefs, type ToolDef } from './registry.js';

describe('production tool schemas', () => {
  // The Claude API rejects any tool whose input_schema lacks a top-level
  // `type: "object"` — a zod union at the root converts to a bare `anyOf`
  // and 400s every run on turn 1 (download regressed this way, 2026-08-11).
  // registry.test.ts only checks stub tools; this guards the real ones.
  it('every registered tool converts to a top-level object schema', () => {
    for (const profile of ['atomic', 'batch-enabled'] as const) {
      const defs = toApiToolDefs(createProductionRegistry(profile));
      expect(defs.length).toBeGreaterThan(0);
      for (const def of defs) {
        expect(def.input_schema, `${profile} tool "${def.name}"`).toMatchObject({
          type: 'object',
        });
      }
    }
  });

  it('omits bash when the caller supplies no run-scoped bash tool', () => {
    // bash closes over the run's secret-env denylist, so it cannot be a static
    // definition. A registry built without it is missing bash rather than
    // carrying a broken one — the same rule createV2Registry follows.
    expect([...createProductionRegistry().keys()]).not.toContain('bash');
  });

  it('keeps atomic stable and appends browser_batch only in its explicit profile', () => {
    const bashTool = createBashTool({ secretEnvDenylist: [] });
    const atomicNames = [...createProductionRegistry('atomic', { bash: bashTool }).keys()];
    expect(atomicNames).toEqual([
      'read_file',
      'write_file',
      'edit_file',
      'grep',
      'bash',
      'navigate',
      'inspect_page',
      'click',
      'type',
      'scroll',
      'screenshot',
      'download',
      'fill_credentials',
      'ask_user_question',
    ]);

    const batchEnabled = createProductionRegistry('batch-enabled', { bash: bashTool });
    expect([...batchEnabled.keys()]).toEqual([...atomicNames, 'browser_batch']);
    expect(batchEnabled.get('browser_batch')?.readOnly).toBe(false);
    const rebuilt = toApiToolDefs(
      createProductionRegistry('batch-enabled', { bash: bashTool }),
    );
    expect(JSON.stringify(rebuilt)).toBe(JSON.stringify(toApiToolDefs(batchEnabled)));
  });
});

// --- T16: the frozen V2 tool order -------------------------------------------

describe('V2 tool order', () => {
  it('pins the exact frozen order', () => {
    // A snapshot in the strictest sense: prompt caching is a byte-exact prefix
    // match, so reordering these names silently invalidates every cached
    // prefix and re-pays the whole conversation at cache-WRITE rates. If this
    // assertion fails, the question is not "update the test" but "was the
    // reorder intended, and is the cache cost understood?"
    expect(V2_TOOL_ORDER).toEqual([
      'set_output_contract',
      'upsert_output_rows',
      'delete_output_rows',
      'set_table_completeness',
      'write_document',
      'observe',
      'browser_action',
      'switch_page',
      'handle_dialog',
      'execute_javascript',
      'read_resource',
      'capture_text',
      'inspect_document',
      'screenshot',
      'download',
      'read_file',
      'write_file',
      'edit_file',
      'grep',
      'bash',
      'fill_credentials',
      'ask_user_question',
      'run_research_jobs',
      'submit_for_verification',
    ]);
  });

  it('puts the contract gate first and completion last', () => {
    // Structural, not cosmetic: set_output_contract gates every other call,
    // and submit_for_verification ends the run.
    expect(V2_TOOL_ORDER[0]).toBe('set_output_contract');
    expect(V2_TOOL_ORDER.at(-1)).toBe('submit_for_verification');
  });

  it('contains no duplicates', () => {
    expect(new Set(V2_TOOL_ORDER).size).toBe(V2_TOOL_ORDER.length);
  });

  it('builds a registry in frozen order, skipping tools a run cannot supply', () => {
    const registry = createV2Registry();
    // Every statically-constructible tool, in V2 order — and nothing that
    // needs run-scoped state, which a caller must supply explicitly.
    expect([...registry.keys()]).toEqual([
      'set_output_contract',
      'observe',
      'browser_action',
      'switch_page',
      'handle_dialog',
      'screenshot',
      'download',
      'read_file',
      'write_file',
      'edit_file',
      'grep',
      'fill_credentials',
      'ask_user_question',
    ]);
  });

  it('omits the run-scoped tools until a caller supplies them', () => {
    // These need a table store, an evidence store, a content registry, or a
    // browser reader, so they cannot be constructed statically. Their absence
    // must be an omission, never a silently broken tool.
    const names = new Set(createV2Registry().keys());
    for (const runScoped of [
      'upsert_output_rows',
      'delete_output_rows',
      'set_table_completeness',
      'write_document',
      'execute_javascript',
      'read_resource',
      'capture_text',
      'inspect_document',
      'run_research_jobs',
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
        readOnly: true,
        execute: async () => 'ok',
      }) as ToolDef;

    const registry = createV2Registry(
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
      readOnly: true,
      execute: async () => 'ok',
    } as ToolDef;
    expect(() => createV2Registry(new Map([['surprise_tool', rogue]]))).toThrow(
      /not in V2_TOOL_ORDER/,
    );
  });

  it('serializes its API definitions byte-identically across calls', () => {
    // The cached-prefix guarantee, asserted directly.
    const first = JSON.stringify(toApiToolDefs(createV2Registry()));
    const second = JSON.stringify(toApiToolDefs(createV2Registry()));
    expect(first).toBe(second);
  });
});
