import type Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';

import {
  makeContractInitializerModelDriver,
  makeInitializerCallModel,
} from '../harness/initializer.js';
import type { CallModel } from '../loop/messages.js';
import type { ModelStreamEvent } from '../model/streamAssembly.js';
import { defaultInitializerCallModel } from './runTask.js';

/**
 * Which initializer binding production picks, and what that binding actually
 * puts on the wire.
 *
 * These exist because of a bug that reached a live run: `runTask` chose the
 * PROSE initializer binding — offered no tools at all — even under the
 * contract protocol, whose `runContractInitializer` requires a
 * `set_output_contract` call. Every attempt failed with "made no
 * set_output_contract call", because a model cannot call a tool it was never
 * given, and the run aborted before opening a page.
 *
 * No test of either binding alone could have caught it: both were correct.
 * The wrong thing was the CHOICE between them, so that is what this asserts.
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
  it('picks the contract binding under the output-contract protocol', () => {
    const chosen: string[] = [];
    defaultInitializerCallModel(true, {
      prose: () => {
        chosen.push('prose');
        return (async () => {
          throw new Error('unused');
        }) as unknown as CallModel;
      },
      contract: () => {
        chosen.push('contract');
        return (async () => {
          throw new Error('unused');
        }) as unknown as CallModel;
      },
    });

    expect(chosen).toEqual(['contract']);
  });

  it('picks the prose binding when the protocol is off', () => {
    const chosen: string[] = [];
    defaultInitializerCallModel(false, {
      prose: () => {
        chosen.push('prose');
        return (async () => {
          throw new Error('unused');
        }) as unknown as CallModel;
      },
      contract: () => {
        chosen.push('contract');
        return (async () => {
          throw new Error('unused');
        }) as unknown as CallModel;
      },
    });

    expect(chosen).toEqual(['prose']);
  });

  it('defaults to a binding that offers set_output_contract when the protocol is on', async () => {
    // The end-to-end claim, asserted on the wire rather than on the choice:
    // production's V2 default must actually offer the tool it will demand.
    const stream = recordingStream();
    const callModel = defaultInitializerCallModel(true, {
      prose: () => makeInitializerCallModel({ createStream: stream.createStream }),
      contract: () => makeContractInitializerModelDriver({ createStream: stream.createStream }),
    });

    const request = await firstRequest(callModel, stream.calls);

    expect(request.tools?.map((tool) => (tool as { name: string }).name)).toEqual([
      'set_output_contract',
    ]);
    expect(request.tool_choice).toEqual({ type: 'tool', name: 'set_output_contract' });
  });

  it('defaults to a tool-free binding when the protocol is off', async () => {
    const stream = recordingStream();
    const callModel = defaultInitializerCallModel(false, {
      prose: () => makeInitializerCallModel({ createStream: stream.createStream }),
      contract: () => makeContractInitializerModelDriver({ createStream: stream.createStream }),
    });

    const request = await firstRequest(callModel, stream.calls);

    // The prose initializer writes INTENT/CONTRACT text and calls nothing.
    expect(request.tools ?? []).toEqual([]);
    expect(request.tool_choice).toBeUndefined();
  });
});
