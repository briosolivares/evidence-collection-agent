import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { createDiscoveredUrlIndex } from '../browser/discoveredUrlIndex.js';
import { createProductionRegistry } from '../tools/index.js';
import { setOutputContractTool } from '../tools/setOutputContract/setOutputContract.js';
import { createRegistry, toApiToolDefs, type ToolDef } from '../tools/registry.js';
import {
  assertResearchRegistry,
  createResearchRegistry,
  FORBIDDEN_RESEARCH_TOOL_NAMES,
  type ResearchRegistryDeps,
} from './researchRegistry.js';

// Hermetic: every seam is a stub that throws if used. These tests are about
// WHICH tools a child gets and in what order, not what the tools do — the
// tools' own suites cover their behavior, and re-testing it here would let
// this file pass while the child's real capability set silently drifted.

function stubDeps(overrides: Partial<ResearchRegistryDeps> = {}): ResearchRegistryDeps {
  const unused = (name: string) => (): never => {
    throw new Error(`${name} must not be called while building a registry`);
  };
  return {
    javascriptPage: () => ({
      evaluateJson: unused('evaluateJson'),
      replaceUnresponsivePage: unused('replaceUnresponsivePage'),
    }),
    textCapturePage: () => ({ captureText: unused('captureText') }),
    resourceReader: () => ({ read: unused('read') }),
    discoveredUrls: () => createDiscoveredUrlIndex(),
    evidenceStore: () => undefined,
    ...overrides,
  };
}

/** The coordinator's real tool surface, so the exclusion test compares
 * against what actually exists rather than a hand-kept list. (The row tools
 * are built per run from a factory and are covered by
 * FORBIDDEN_RESEARCH_TOOL_NAMES below.) */
function coordinatorToolNames(): string[] {
  return [
    ...createProductionRegistry('batch-enabled').keys(),
    setOutputContractTool.name,
  ];
}

describe('createResearchRegistry', () => {
  it('gives a child exactly the observe/action/JavaScript/resource/evidence tools', () => {
    const registry = createResearchRegistry(stubDeps());

    // Order is asserted, not just membership: this array is serialized into
    // every job's prompt prefix, and a reordering costs every concurrent job
    // a cache write.
    expect([...registry.keys()]).toEqual([
      'observe',
      'browser_action',
      'switch_page',
      'handle_dialog',
      'execute_javascript',
      'read_resource',
      'capture_text',
      'read_file',
      'grep',
    ]);
  });

  it('withholds every tool that would let a child act as the coordinator', () => {
    const registry = createResearchRegistry(stubDeps());

    for (const forbidden of FORBIDDEN_RESEARCH_TOOL_NAMES) {
      expect(registry.has(forbidden)).toBe(false);
    }
    // Cross-checked against the coordinator's REAL surface rather than a
    // memorized list: everything a child shares with it must be read-only.
    // A production tool that starts appearing here is a decision someone has
    // to make deliberately, and this assertion is where they make it.
    const shared = coordinatorToolNames().filter((name) => registry.has(name));
    expect([...shared].sort()).toEqual(['grep', 'read_file']);
  });

  it('serializes to byte-identical API tool definitions across builds', () => {
    // Two independently built registries: any nondeterminism (a schema built
    // from a Set, an interpolated timestamp) would break the shared cached
    // prefix that makes concurrent jobs cheap.
    const first = JSON.stringify(toApiToolDefs(createResearchRegistry(stubDeps())));
    const second = JSON.stringify(toApiToolDefs(createResearchRegistry(stubDeps())));

    expect(second).toBe(first);
  });

  it('resolves page JavaScript without an operator decision, because a child is anonymous', () => {
    const decisions: string[] = [];
    const registry = createResearchRegistry(
      stubDeps({ onPolicyDecision: (line) => decisions.push(line) }),
    );

    expect(registry.has('execute_javascript')).toBe(true);
    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toContain('javascriptPolicy=allow (anonymous session)');
  });

  it('honors a deny policy, so a run can withhold page JavaScript from children', async () => {
    const registry = createResearchRegistry(stubDeps({ javascriptPolicy: 'deny' }));

    await expect(
      registry.get('execute_javascript')!.execute(
        { target: 'selected_top_document', code: 'return 1;' },
        { runDir: '/unused' },
      ),
    ).rejects.toThrow(/disabled for this run/);
  });
});

describe('assertResearchRegistry', () => {
  it('accepts the registry createResearchRegistry builds', () => {
    expect(() => assertResearchRegistry(createResearchRegistry(stubDeps()))).not.toThrow();
  });

  it('names every forbidden tool a mis-wired session smuggled in', () => {
    const smuggled: ToolDef = {
      name: 'upsert_output_rows',
      description: 'not the child’s to call',
      inputSchema: z.strictObject({}),
      readOnly: false,
      execute: () => 'unused',
    };
    const contract: ToolDef = { ...smuggled, name: 'set_output_contract' };

    expect(() => assertResearchRegistry(createRegistry([smuggled, contract]))).toThrow(
      /upsert_output_rows, set_output_contract/,
    );
  });

  it('refuses a registry that would let a child start further research jobs', () => {
    const recursive: ToolDef = {
      name: 'run_research_jobs',
      description: 'no recursion',
      inputSchema: z.strictObject({}),
      readOnly: false,
      execute: () => 'unused',
    };

    expect(() => assertResearchRegistry(createRegistry([recursive]))).toThrow(
      /start further jobs/,
    );
  });
});
