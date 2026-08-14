import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  contractRevisionPath,
  createOutputContractStore,
} from '../contracts/outputContractStore.js';
import { buildRequestParams } from '../model/callModel.js';
import { initManifest } from '../run/artifacts.js';
import { setOutputContractTool } from '../tools/setOutputContract/setOutputContract.js';
import { createRegistry, toApiToolDefs, type ToolDef } from '../tools/registry.js';

import type { Message, ModelResponse } from '../loop/messages.js';
import {
  CONTRACT_INITIALIZER_SYSTEM_PROMPT,
  runContractInitializer,
} from './initializer.js';

// Every test drives the initializer with a scripted fake callModel — same
// hermetic-suite convention as workerSession.test.ts: zero real API calls.

/**
 * A scripted callModel: serves the given responses in order, snapshotting
 * the messages of each request into `requests`. Calling it more times than
 * scripted throws — mirrors workerSession.test.ts's scriptModel.
 */
function scriptModel(responses: ModelResponse[]): {
  callModel: (messages: readonly Message[]) => Promise<ModelResponse>;
  requests: Message[][];
} {
  const requests: Message[][] = [];
  const callModel = async (messages: readonly Message[]): Promise<ModelResponse> => {
    requests.push(structuredClone(messages) as Message[]);
    const next = responses[requests.length - 1];
    if (next === undefined) {
      throw new Error(
        `fake model called ${requests.length} times but only ${responses.length} responses scripted`,
      );
    }
    return next;
  };
  return { callModel, requests };
}

function textResponse(text: string): ModelResponse {
  return {
    content: [{ type: 'text', text }],
    stop_reason: 'end_turn',
    usage: { input_tokens: 10, output_tokens: 5 },
  };
}

// --- The contract-authoring initializer -------------------------------------

describe('runContractInitializer', () => {
  const VALID = {
    contract: {
      outputs: [
        {
          id: 'roster',
          kind: 'table',
          filename: 'roster.csv',
          format: 'csv',
          columns: [{ name: 'name', required: true, type: 'string' }],
          rules: [],
        },
      ],
    },
  };

  function contractCall(input: unknown, id = 'c1'): ModelResponse {
    return {
      content: [{ type: 'tool_use', id, name: 'set_output_contract', input }],
      stop_reason: 'tool_use',
      usage: { input_tokens: 10, output_tokens: 5 },
    };
  }

  let runDir: string;
  let store: ReturnType<typeof createOutputContractStore>;

  beforeEach(() => {
    runDir = mkdtempSync(join(tmpdir(), 'contract-init-test-'));
    initManifest(runDir, 'Publish the roster.');
    store = createOutputContractStore(runDir);
  });

  afterEach(() => {
    rmSync(runDir, { recursive: true, force: true });
  });

  it('persists the contract from a single forced tool call', async () => {
    const { callModel } = scriptModel([contractCall(VALID)]);
    const outcome = await runContractInitializer('Publish the roster.', callModel, store);

    expect(outcome).toEqual({ ok: true, revision: 1 });
    expect(store.hasContract()).toBe(true);
    expect(store.currentContract()?.outputs[0]?.id).toBe('roster');
  });

  it('stores byte-identically to a worker-authored contract for the same input', async () => {
    // The plan requires the architecture not to depend on which author ran:
    // same tool input, same stored bytes.
    const { callModel } = scriptModel([contractCall(VALID)]);
    await runContractInitializer('Publish the roster.', callModel, store);
    const initializerBytes = readFileSync(
      join(runDir, contractRevisionPath(1)),
      'utf8',
    );

    const workerRunDir = mkdtempSync(join(tmpdir(), 'worker-authored-'));
    initManifest(workerRunDir, 'Publish the roster.');
    const workerStore = createOutputContractStore(workerRunDir);
    workerStore.setOutputContract(VALID);
    const workerBytes = readFileSync(join(workerRunDir, contractRevisionPath(1)), 'utf8');
    rmSync(workerRunDir, { recursive: true, force: true });

    expect(initializerBytes).toBe(workerBytes);
  });

  it('re-asks once when the response carries no contract call, then succeeds', async () => {
    const { callModel, requests } = scriptModel([
      textResponse('Here is what I think the contract should be...'),
      contractCall(VALID),
    ]);
    const outcome = await runContractInitializer('Publish the roster.', callModel, store);

    expect(outcome).toEqual({ ok: true, revision: 1 });
    // The repair turn names the problem to the same conversation.
    expect(JSON.stringify(requests[1])).toMatch(/no set_output_contract call/);
  });

  it('re-asks once when the contract is rejected, then succeeds', async () => {
    const { callModel, requests } = scriptModel([
      contractCall({ contract: { outputs: [VALID.contract.outputs[0], VALID.contract.outputs[0]] } }),
      contractCall(VALID),
    ]);
    const outcome = await runContractInitializer('Publish the roster.', callModel, store);

    expect(outcome).toEqual({ ok: true, revision: 1 });
    expect(JSON.stringify(requests[1])).toMatch(/duplicate output id/);
  });

  it('answers the replayed tool_use with a tool_result, not bare prose', async () => {
    // The API rejects a conversation whose tool_use is followed by anything
    // but a matching tool_result, with a 400 that kills the run. Asserting
    // only that the problem text appears SOMEWHERE in the retry request is
    // what let the broken shape reach a live run, so assert the shape itself.
    const { callModel, requests } = scriptModel([
      contractCall(
        { contract: { outputs: [VALID.contract.outputs[0], VALID.contract.outputs[0]] } },
        'c9',
      ),
      contractCall(VALID),
    ]);
    await runContractInitializer('Publish the roster.', callModel, store);

    const retry = requests[1]!;
    const replayed = retry[1]!;
    const correction = retry[2]!;
    expect(replayed.role).toBe('assistant');
    expect(correction.role).toBe('user');
    // Tool results come FIRST in the corrective turn: the API requires every
    // id in the preceding assistant turn to be answered before any text.
    expect(correction.content[0]).toMatchObject({
      type: 'tool_result',
      tool_use_id: 'c9',
      is_error: true,
    });
    const answeredIds = correction.content
      .filter((block) => block.type === 'tool_result')
      .map((block) => (block as { tool_use_id: string }).tool_use_id);
    const replayedIds = replayed.content
      .filter((block) => block.type === 'tool_use')
      .map((block) => (block as { id: string }).id);
    expect(answeredIds).toEqual(replayedIds);
  });

  it('answers every id when the rejected response made more than one call', async () => {
    const twoCalls: ModelResponse = {
      content: [
        { type: 'tool_use', id: 'a1', name: 'set_output_contract', input: VALID },
        { type: 'tool_use', id: 'a2', name: 'set_output_contract', input: VALID },
      ],
      stop_reason: 'tool_use',
      usage: { input_tokens: 10, output_tokens: 5 },
    };
    const { callModel, requests } = scriptModel([twoCalls, contractCall(VALID)]);
    await runContractInitializer('Publish the roster.', callModel, store);

    const answered = requests[1]![2]!.content
      .filter((block) => block.type === 'tool_result')
      .map((block) => (block as { tool_use_id: string }).tool_use_id);
    // Leaving either id unanswered is the same 400 as answering neither.
    expect(answered).toEqual(['a1', 'a2']);
  });

  it('uses a plain text correction when the rejected response made no call', async () => {
    // Nothing to answer, so a tool_result would itself be invalid.
    const { callModel, requests } = scriptModel([
      textResponse('Here is some prose instead.'),
      contractCall(VALID),
    ]);
    await runContractInitializer('Publish the roster.', callModel, store);

    expect(requests[1]![2]!.content.every((block) => block.type === 'text')).toBe(true);
  });

  it('fails after a second bad response rather than proceeding unvalidated', async () => {
    const { callModel } = scriptModel([textResponse('no call'), textResponse('still no call')]);
    const outcome = await runContractInitializer('Publish the roster.', callModel, store);

    expect(outcome.ok).toBe(false);
    expect(store.hasContract()).toBe(false);
  });

  it('rejects a response mixing the contract call with another tool call', async () => {
    const mixed: ModelResponse = {
      content: [
        { type: 'tool_use', id: 'c1', name: 'set_output_contract', input: VALID },
        { type: 'tool_use', id: 'x1', name: 'navigate', input: { url: 'https://example.com' } },
      ],
      stop_reason: 'tool_use',
      usage: { input_tokens: 10, output_tokens: 5 },
    };
    const { callModel } = scriptModel([mixed, mixed]);
    const outcome = await runContractInitializer('Publish the roster.', callModel, store);

    expect(outcome.ok).toBe(false);
    expect(store.hasContract()).toBe(false);
  });
});

describe('makeContractInitializerModelDriver', () => {
  it('offers only set_output_contract and forces the model to call it', () => {
    const params = buildRequestParams(
      {
        system: CONTRACT_INITIALIZER_SYSTEM_PROMPT,
        apiToolDefs: toApiToolDefs(createRegistry([setOutputContractTool as ToolDef])),
        toolChoice: { type: 'tool', name: 'set_output_contract' },
        maxOutputTokens: 4096,
      },
      [{ role: 'user', content: [{ type: 'text', text: 'task' }] }],
    );

    expect(params.tools?.map((t) => (t as { name: string }).name)).toEqual([
      'set_output_contract',
    ]);
    expect(params.tool_choice).toEqual({ type: 'tool', name: 'set_output_contract' });
  });
});
