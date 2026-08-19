import { describe, expect, it } from 'vitest';

import { toApiToolDefs, type ApiToolDef } from './registry.js';
import {
  V3_API_TOOL_DEFS,
  V3_TOOL_ORDER,
  createV3ToolRegistry,
} from './index.js';

const exactOrder = [
  'browser_execute',
  'publish_artifact',
  'read_file',
  'write_file',
  'edit_file',
  'bash',
  'ask_user',
  'finish',
];

describe('v3 tool registry', () => {
  it('pins the exact complete model-visible order without duplicates', () => {
    expect(V3_TOOL_ORDER).toEqual(exactOrder);
    expect(new Set(V3_TOOL_ORDER).size).toBe(V3_TOOL_ORDER.length);

    const registry = createV3ToolRegistry({
      javascriptPolicy: 'allow',
      secretEnvDenylist: ['TOKEN_'],
    });
    expect([...registry.keys()]).toEqual(exactOrder);
    expect([...registry.values()].map((tool) => tool.name)).toEqual(exactOrder);
  });

  it('rebuilds only the run-scoped code-execution definitions per run', () => {
    const first = createV3ToolRegistry({
      javascriptPolicy: 'allow',
      secretEnvDenylist: ['FIRST_SECRET'],
    });
    const second = createV3ToolRegistry({
      javascriptPolicy: 'deny',
      secretEnvDenylist: ['SECOND_SECRET'],
    });

    expect(first.get('browser_execute')).not.toBe(second.get('browser_execute'));
    expect(first.get('bash')).not.toBe(second.get('bash'));
    for (const staticName of [
      'publish_artifact',
      'read_file',
      'write_file',
      'edit_file',
      'ask_user',
      'finish',
    ]) {
      expect(first.get(staticName)).toBe(second.get(staticName));
    }
  });

  it('serializes every real schema as a strict top-level object', () => {
    expect(V3_API_TOOL_DEFS.map((definition) => definition.name)).toEqual(
      exactOrder,
    );
    for (const definition of V3_API_TOOL_DEFS) {
      expect(
        definition.input_schema,
        `tool ${JSON.stringify(definition.name)}`,
      ).toMatchObject({ type: 'object', additionalProperties: false });
      expect(definition.input_schema).not.toHaveProperty('anyOf');
      expect(definition.input_schema).not.toHaveProperty('oneOf');
    }

    expect(V3_API_TOOL_DEFS[0]?.description).toContain(
      'small multi-line browser program, not a single browser action',
    );
    expect(JSON.stringify(V3_API_TOOL_DEFS[0]?.input_schema)).toContain(
      'items.slice(0, 20)',
    );
  });

  it('produces byte-identical API definitions across policies, runs, and denylists', () => {
    const first = JSON.stringify(
      toApiToolDefs(
        createV3ToolRegistry({
          javascriptPolicy: 'allow',
          secretEnvDenylist: [],
        }),
      ),
    );
    const second = JSON.stringify(
      toApiToolDefs(
        createV3ToolRegistry({
          javascriptPolicy: 'deny',
          secretEnvDenylist: ['ANTHROPIC_', 'BROWSERBASE_API_KEY'],
        }),
      ),
    );

    expect(second).toBe(first);
    expect(JSON.stringify(V3_API_TOOL_DEFS)).toBe(first);
  });

  it('requires an explicit valid policy at registry construction', () => {
    expect(() =>
      // @ts-expect-error javascriptPolicy is intentionally required.
      createV3ToolRegistry({
        secretEnvDenylist: [],
      }),
    ).toThrow(
      'browser_execute requires an explicit javascriptPolicy of "allow" or "deny".',
    );
  });

  it('deep-freezes the shared process-wide API definitions', () => {
    expect(Object.isFrozen(V3_API_TOOL_DEFS)).toBe(true);
    expect(Object.isFrozen(V3_API_TOOL_DEFS[0])).toBe(true);
    expect(Object.isFrozen(V3_API_TOOL_DEFS[0]?.input_schema)).toBe(true);

    expect(() =>
      (V3_API_TOOL_DEFS as ApiToolDef[]).push({
        name: 'mutated',
        description: 'mutated',
        input_schema: { type: 'object' },
      }),
    ).toThrow();
    expect(() => {
      V3_API_TOOL_DEFS[0]!.input_schema.type = 'mutated';
    }).toThrow();
  });
});
