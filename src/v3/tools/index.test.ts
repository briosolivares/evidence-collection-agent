import { describe, expect, it } from 'vitest';

import { toApiToolDefs, type ApiToolDef } from '../../tools/registry.js';
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

    const registry = createV3ToolRegistry({ secretEnvDenylist: ['TOKEN_'] });
    expect([...registry.keys()]).toEqual(exactOrder);
    expect([...registry.values()].map((tool) => tool.name)).toEqual(exactOrder);
  });

  it('rebuilds only the run-scoped code-execution definitions per run', () => {
    const first = createV3ToolRegistry({ secretEnvDenylist: ['FIRST_SECRET'] });
    const second = createV3ToolRegistry({ secretEnvDenylist: ['SECOND_SECRET'] });

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
  });

  it('produces byte-identical API definitions across runs and denylists', () => {
    const first = JSON.stringify(
      toApiToolDefs(createV3ToolRegistry({ secretEnvDenylist: [] })),
    );
    const second = JSON.stringify(
      toApiToolDefs(
        createV3ToolRegistry({
          secretEnvDenylist: ['ANTHROPIC_', 'BROWSERBASE_API_KEY'],
        }),
      ),
    );

    expect(second).toBe(first);
    expect(JSON.stringify(V3_API_TOOL_DEFS)).toBe(first);
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
