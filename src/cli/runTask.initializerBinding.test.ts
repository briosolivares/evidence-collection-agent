import type Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';

import { makeContractInitializerModelDriver } from '../harness/initializer.js';
import { createVerifierRegistry } from '../harness/verifierTools.js';
import type { CallModel } from '../loop/messages.js';
import type { ModelStreamEvent } from '../model/streamAssembly.js';
import { createBashTool, createV2Registry, V2_TOOL_ORDER } from '../tools/index.js';
import type { ToolDef } from '../tools/registry.js';
import { createWriteDocumentTool } from '../tools/writeDocument/writeDocument.js';
import { defaultInitializerCallModel } from './runTask.js';

/**
 * What the initializer's default binding actually puts on the wire.
 *
 * A second, prose-authoring binding used to live alongside this one, chosen
 * by a runtime flag — a live run once picked the wrong one, offering the
 * initializer no tools at all while `runContractInitializer` demanded a
 * `set_output_contract` call it could never make. That binding, and the
 * choice between the two, are gone along with the prose protocol; only the
 * wire-level assertion survives, since a binding offering the wrong tools is
 * exactly the failure that reached a live run and exactly what re-deriving
 * the same constants in a test would not catch.
 */

/** A createStream seam that records request params and returns one minimal
 * complete response, so a binding can be invoked without a network call. */
function recordingStream(): {
  calls: Anthropic.Messages.MessageStreamParams[];
  createStream: (params: Anthropic.Messages.MessageStreamParams) => AsyncIterable<ModelStreamEvent>;
} {
  const calls: Anthropic.Messages.MessageStreamParams[] = [];
  return {
    calls,
    createStream: (params) => {
      calls.push(params);
      return (async function* () {
        yield* [
          {
            type: 'message_start',
            message: { usage: { input_tokens: 10, output_tokens: 0 } },
          },
          { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
          { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } },
          { type: 'content_block_stop', index: 0 },
          {
            type: 'message_delta',
            delta: { stop_reason: 'end_turn' },
            usage: { input_tokens: null, output_tokens: 2 },
          },
          { type: 'message_stop' },
        ] as unknown as ModelStreamEvent[];
      })();
    },
  };
}

async function firstRequest(
  callModel: CallModel,
  calls: Anthropic.Messages.MessageStreamParams[],
): Promise<Anthropic.Messages.MessageStreamParams> {
  await callModel([{ role: 'user', content: [{ type: 'text', text: 'Publish the roster.' }] }]);
  const request = calls[0];
  if (request === undefined) throw new Error('the binding made no request');
  return request;
}

describe('defaultInitializerCallModel', () => {
  it('always returns the contract binding', () => {
    const chosen: string[] = [];
    defaultInitializerCallModel({
      contract: () => {
        chosen.push('contract');
        return (async () => {
          throw new Error('unused');
        }) as unknown as CallModel;
      },
    });

    expect(chosen).toEqual(['contract']);
  });

  it('defaults to a binding that offers set_output_contract', async () => {
    // The end-to-end claim, asserted on the wire rather than on the choice:
    // production's default must actually offer the tool it will demand.
    const stream = recordingStream();
    const callModel = defaultInitializerCallModel({
      contract: () => makeContractInitializerModelDriver({ createStream: stream.createStream }),
    });

    const request = await firstRequest(callModel, stream.calls);

    expect(request.tools?.map((tool) => (tool as { name: string }).name)).toEqual([
      'set_output_contract',
    ]);
    expect(request.tool_choice).toEqual({ type: 'tool', name: 'set_output_contract' });
  });
});

/**
 * `bash` and `edit_file` are WORKER-ONLY.
 *
 * The worker may mutate the run directory and run local commands; the two
 * roles that judge the work may not. An initializer that could run a shell
 * could satisfy a contract it is simultaneously authoring, and a verifier that
 * could edit files could repair the very defect it exists to report — either
 * way the run's own check ends up grading work the checker did.
 *
 * Nothing asserted this before these tools existed, because there was nothing
 * to keep out. That is precisely why it is worth pinning now: the isolation is
 * a property of three independently hand-written tool lists, not of any shared
 * read-only filter, so nothing would complain if a fourth list picked up the
 * worker's registry by accident.
 */
describe('worker-only tool isolation', () => {
  const MUTATION_TOOLS = ['bash', 'edit_file'];

  it('offers the contract initializer nothing but set_output_contract', async () => {
    const stream = recordingStream();
    const request = await firstRequest(
      makeContractInitializerModelDriver({ createStream: stream.createStream }),
      stream.calls,
    );

    const names = request.tools?.map((tool) => (tool as { name: string }).name) ?? [];
    expect(names).toEqual(['set_output_contract']);
    for (const mutation of MUTATION_TOOLS) {
      expect(names).not.toContain(mutation);
    }
  });

  it('gives the verifier only read-only inspection tools', () => {
    const names = [...createVerifierRegistry().keys()];
    expect(names).toEqual(['read_file', 'grep']);
    for (const mutation of MUTATION_TOOLS) {
      expect(names).not.toContain(mutation);
    }
    // Read-only in fact, not merely by omission: each tool's own declared
    // access has no writes and claims no exclusivity, for a representative
    // input.
    const sampleInput: Record<string, unknown> = {
      read_file: { file_path: 'artifacts/report.md' },
      grep: { pattern: 'x' },
    };
    for (const [name, tool] of createVerifierRegistry()) {
      const access = tool.getAccess(sampleInput[name]);
      expect(access.writes).toEqual([]);
      expect(access.exclusive).not.toBe(true);
    }
  });

  it('does give the worker both tools, so the isolation above is a boundary and not an absence', () => {
    // Without this half, the assertions above could pass for the wrong reason.
    // The same construction buildRunToolchain uses: the worker's real V2
    // registry, built with only a bash tool as run-scoped input — edit_file
    // is a V2_STATIC_TOOLS entry, so it is present without any factory input.
    const workerNames = [
      ...createV2Registry(
        new Map<string, ToolDef>([
          ['bash', createBashTool({ secretEnvDenylist: [] }) as ToolDef],
        ]),
      ).keys(),
    ];
    for (const mutation of MUTATION_TOOLS) {
      expect(workerNames).toContain(mutation);
    }
    expect(V2_TOOL_ORDER).toContain('bash');
    expect(V2_TOOL_ORDER).toContain('edit_file');
  });
});

/**
 * `write_document` is a V2-only tool: it was in `V2_TOOL_ORDER` but was
 * never CONSTRUCTED anywhere the runtime actually builds a registry, so a
 * typed `document` output was impossible to satisfy no matter what the
 * model did — the tool simply was not there to call. Mirrors the
 * `createV2Registry` call `buildRunToolchain` makes (the same static tools,
 * the same frozen order), so this exercises the actual mechanism production
 * relies on, not a restatement of it.
 *
 * Same isolation shape as the block above: worker has it, the two roles
 * that judge the work do not.
 */
describe('write_document isolation', () => {
  function v2RegistryWithWriteDocument() {
    return createV2Registry(
      new Map<string, ToolDef>([
        ['write_document', createWriteDocumentTool({ documentSpecs: () => [] }) as ToolDef],
        ['bash', createBashTool({ secretEnvDenylist: [] }) as ToolDef],
      ]),
    );
  }

  it("is in the worker's V2 registry, at its frozen V2_TOOL_ORDER position", () => {
    const names = [...v2RegistryWithWriteDocument().keys()];
    expect(names).toContain('write_document');

    // Not just "present somewhere" — in the exact relative order
    // V2_TOOL_ORDER declares, filtered to what this registry actually holds
    // (update_table is not supplied here and is not static, so it is absent
    // — exactly as createV2Registry's own "skip what's missing" contract
    // promises).
    const present = new Set(names);
    expect(names).toEqual(V2_TOOL_ORDER.filter((name) => present.has(name)));

    // Anchored to its two frozen neighbors directly, so a reorder of
    // V2_TOOL_ORDER around it would fail here even if the filter above
    // passed vacuously.
    expect(names.indexOf('write_document')).toBe(names.indexOf('set_output_contract') + 1);
    expect(names.indexOf('observe')).toBe(names.indexOf('write_document') + 1);
  });

  it('is NOT offered to the contract initializer', async () => {
    const stream = recordingStream();
    const request = await firstRequest(
      makeContractInitializerModelDriver({ createStream: stream.createStream }),
      stream.calls,
    );

    const names = request.tools?.map((tool) => (tool as { name: string }).name) ?? [];
    expect(names).not.toContain('write_document');
  });

  it('is NOT offered to the verifier', () => {
    const names = [...createVerifierRegistry().keys()];
    expect(names).not.toContain('write_document');
  });
});
