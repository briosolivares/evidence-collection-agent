import { describe, expect, it } from 'vitest';

import { actionTools, evidenceTools, fileTools, observationTools } from './index.js';
import { createRegistry, toApiToolDefs } from './registry.js';

/** The full production tool set in runTask's registration order. */
function productionRegistry() {
  return createRegistry([
    ...fileTools,
    ...observationTools,
    ...actionTools,
    ...evidenceTools,
  ]);
}

describe('production tool schemas', () => {
  // The Claude API rejects any tool whose input_schema lacks a top-level
  // `type: "object"` — a zod union at the root converts to a bare `anyOf`
  // and 400s every run on turn 1 (download regressed this way, 2026-08-11).
  // registry.test.ts only checks stub tools; this guards the real ones.
  it('every registered tool converts to a top-level object schema', () => {
    const defs = toApiToolDefs(productionRegistry());
    expect(defs.length).toBeGreaterThan(0);
    for (const def of defs) {
      expect(def.input_schema, `tool "${def.name}"`).toMatchObject({
        type: 'object',
      });
    }
  });
});
