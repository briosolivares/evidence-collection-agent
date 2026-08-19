import { describe, expect, it } from 'vitest';

import { toApiToolDefs, type ApiToolDef } from './registry.js';
import {
  WORKER_API_TOOL_DEFS,
  WORKER_TOOL_ORDER,
  createWorkerToolRegistry,
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

describe('tool registry', () => {
  it('pins the exact complete model-visible order without duplicates', () => {
    expect(WORKER_TOOL_ORDER).toEqual(exactOrder);
    expect(new Set(WORKER_TOOL_ORDER).size).toBe(WORKER_TOOL_ORDER.length);

    const registry = createWorkerToolRegistry({
      javascriptPolicy: 'allow',
      secretEnvDenylist: ['TOKEN_'],
    });
    expect([...registry.keys()]).toEqual(exactOrder);
    expect([...registry.values()].map((tool) => tool.name)).toEqual(exactOrder);
  });

  it('rebuilds only the run-scoped code-execution definitions per run', () => {
    const first = createWorkerToolRegistry({
      javascriptPolicy: 'allow',
      secretEnvDenylist: ['FIRST_SECRET'],
    });
    const second = createWorkerToolRegistry({
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
    expect(WORKER_API_TOOL_DEFS.map((definition) => definition.name)).toEqual(
      exactOrder,
    );
    for (const definition of WORKER_API_TOOL_DEFS) {
      expect(
        definition.input_schema,
        `tool ${JSON.stringify(definition.name)}`,
      ).toMatchObject({ type: 'object', additionalProperties: false });
      expect(definition.input_schema).not.toHaveProperty('anyOf');
      expect(definition.input_schema).not.toHaveProperty('oneOf');
    }

    expect(WORKER_API_TOOL_DEFS[0]?.description).toContain(
      'small multi-line browser program, not a single browser action',
    );
    expect(JSON.stringify(WORKER_API_TOOL_DEFS[0]?.input_schema)).toContain(
      'items.slice(0, 20)',
    );
  });

  it('produces byte-identical API definitions across policies, runs, and denylists', () => {
    const first = JSON.stringify(
      toApiToolDefs(
        createWorkerToolRegistry({
          javascriptPolicy: 'allow',
          secretEnvDenylist: [],
        }),
      ),
    );
    const second = JSON.stringify(
      toApiToolDefs(
        createWorkerToolRegistry({
          javascriptPolicy: 'deny',
          secretEnvDenylist: ['ANTHROPIC_', 'BROWSERBASE_API_KEY'],
        }),
      ),
    );

    expect(second).toBe(first);
    expect(JSON.stringify(WORKER_API_TOOL_DEFS)).toBe(first);
  });

  it('requires an explicit valid policy at registry construction', () => {
    expect(() =>
      // @ts-expect-error javascriptPolicy is intentionally required.
      createWorkerToolRegistry({
        secretEnvDenylist: [],
      }),
    ).toThrow(
      'browser_execute requires an explicit javascriptPolicy of "allow" or "deny".',
    );
  });

  it('deep-freezes the shared process-wide API definitions', () => {
    expect(Object.isFrozen(WORKER_API_TOOL_DEFS)).toBe(true);
    expect(Object.isFrozen(WORKER_API_TOOL_DEFS[0])).toBe(true);
    expect(Object.isFrozen(WORKER_API_TOOL_DEFS[0]?.input_schema)).toBe(true);

    expect(() =>
      (WORKER_API_TOOL_DEFS as ApiToolDef[]).push({
        name: 'mutated',
        description: 'mutated',
        input_schema: { type: 'object' },
      }),
    ).toThrow();
    expect(() => {
      WORKER_API_TOOL_DEFS[0]!.input_schema.type = 'mutated';
    }).toThrow();
  });
});
