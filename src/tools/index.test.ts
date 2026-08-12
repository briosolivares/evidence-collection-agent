import { describe, expect, it } from 'vitest';

import { createProductionRegistry } from './index.js';
import { toApiToolDefs } from './registry.js';

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

  it('keeps the fourteen core tools stable and appends browser_batch only in its explicit profile', () => {
    const atomicNames = [...createProductionRegistry().keys()];
    expect(atomicNames).toEqual([
      'read_file',
      'write_file',
      'grep',
      'navigate',
      'inspect_page',
      'click',
      'type',
      'scroll',
      'screenshot',
      'download',
      'TaskCreate',
      'TaskList',
      'TaskGet',
      'TaskUpdate',
    ]);

    const atomic = createProductionRegistry();
    expect(new Set(atomicNames).size).toBe(atomicNames.length);
    expect(atomic.get('TaskCreate')?.readOnly).toBe(false);
    expect(atomic.get('TaskList')?.readOnly).toBe(true);
    expect(atomic.get('TaskGet')?.readOnly).toBe(true);
    expect(atomic.get('TaskUpdate')?.readOnly).toBe(false);

    const batchEnabled = createProductionRegistry('batch-enabled');
    expect([...batchEnabled.keys()]).toEqual([...atomicNames, 'browser_batch']);
    expect(new Set(batchEnabled.keys()).size).toBe(batchEnabled.size);
    expect(batchEnabled.get('browser_batch')?.readOnly).toBe(false);
    const rebuilt = toApiToolDefs(createProductionRegistry('batch-enabled'));
    expect(JSON.stringify(rebuilt)).toBe(JSON.stringify(toApiToolDefs(batchEnabled)));
  });
});
