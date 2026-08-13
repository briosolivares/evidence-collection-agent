import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Message, ModelResponse } from '../loop/messages.js';
import {
  CONTRACT_FILENAME,
  INTENT_FILENAME,
  runInitializer,
  writeInitializerFiles,
  type InitializerResult,
} from './initializer.js';

// Every test drives the initializer with a scripted fake callModel — same
// hermetic-suite convention as agentLoop.test.ts: zero real API calls.

const TASK = 'Collect the widget roster and publish it as a CSV.';

/** A terminal response: text only, no tool_use (the initializer's
 * callModel never sees tools, so every scripted response is text-only). */
function textResponse(text: string): ModelResponse {
  return {
    content: [{ type: 'text', text }],
    stop_reason: 'end_turn',
    usage: { input_tokens: 10, output_tokens: 5 },
  };
}

const WELL_FORMED = textResponse(
  '# INTENT\nThe user wants a CSV roster of widgets.\n\n# CONTRACT\nEvery row has columns id,name.',
);

/**
 * A scripted callModel: serves the given responses in order, snapshotting
 * the messages of each request into `requests`. Calling it more times than
 * scripted throws — mirrors agentLoop.test.ts's scriptModel.
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

describe('runInitializer', () => {
  it('parses a well-formed response into both sections in one call', async () => {
    const { callModel, requests } = scriptModel([WELL_FORMED]);

    const result = await runInitializer(TASK, callModel);

    expect(result).toEqual({
      intent: 'The user wants a CSV roster of widgets.',
      contract: 'Every row has columns id,name.',
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toEqual([{ role: 'user', content: [{ type: 'text', text: TASK }] }]);
  });

  it('recovers from a malformed first response (missing header) via one corrective follow-up', async () => {
    const malformed = textResponse('Sure, here is my answer: widgets go in a CSV.');
    const { callModel, requests } = scriptModel([malformed, WELL_FORMED]);

    const result = await runInitializer(TASK, callModel);

    expect(result).toEqual({
      intent: 'The user wants a CSV roster of widgets.',
      contract: 'Every row has columns id,name.',
    });
    expect(requests).toHaveLength(2);

    // The second request replays the task, the malformed assistant
    // response, and a corrective user message naming what was wrong.
    const secondRequest = requests[1];
    expect(secondRequest).toHaveLength(3);
    expect(secondRequest[0]).toEqual({ role: 'user', content: [{ type: 'text', text: TASK }] });
    expect(secondRequest[1]).toEqual({ role: 'assistant', content: malformed.content });
    expect(secondRequest[2].role).toBe('user');
    const correctiveText = (secondRequest[2].content[0] as { text: string }).text;
    expect(correctiveText).toContain('malformed');
    expect(correctiveText).toContain('# INTENT');
    expect(correctiveText).toContain('# CONTRACT');
  });

  it('treats headers present but an empty section body as malformed, and still recovers on retry', async () => {
    // Both headers are present, in order, but the INTENT body is blank.
    const emptyIntent = textResponse('# INTENT\n\n# CONTRACT\nEvery row has columns id,name.');
    const { callModel, requests } = scriptModel([emptyIntent, WELL_FORMED]);

    const result = await runInitializer(TASK, callModel);

    expect(result).toEqual({
      intent: 'The user wants a CSV roster of widgets.',
      contract: 'Every row has columns id,name.',
    });
    // The retry path ran even though both headers were present — an empty
    // section is malformed regardless of header presence.
    expect(requests).toHaveLength(2);
    const correctiveText = (requests[1][2].content[0] as { text: string }).text;
    expect(correctiveText).toContain('INTENT');
    expect(correctiveText.toLowerCase()).toContain('empty');
  });

  it('throws naming the problem when the response is still malformed after the corrective retry', async () => {
    const malformedOnce = textResponse('No headers at all here.');
    const malformedTwice = textResponse('# INTENT\nGoal stated.\n\nNo contract header this time.');
    const { callModel, requests } = scriptModel([malformedOnce, malformedTwice]);

    await expect(runInitializer(TASK, callModel)).rejects.toThrow(/CONTRACT/);
    // Exactly two calls: the original attempt plus the one corrective retry
    // — a run without a contract fails loudly instead of retrying forever
    // or silently degrading to judge-less behavior.
    expect(requests).toHaveLength(2);
  });

  it('throws when both attempts omit the INTENT header entirely', async () => {
    const malformed = textResponse('Just some prose, no headers.');
    const { callModel } = scriptModel([malformed, malformed]);

    await expect(runInitializer(TASK, callModel)).rejects.toThrow(/INTENT/);
  });
});

describe('writeInitializerFiles', () => {
  let runDir: string;

  beforeEach(() => {
    runDir = mkdtempSync(join(tmpdir(), 'initializer-test-'));
  });

  afterEach(() => {
    rmSync(runDir, { recursive: true, force: true });
  });

  it('writes INTENT.md and CONTRACT.md at the run-dir root with the section bodies', () => {
    const result: InitializerResult = {
      intent: 'The user wants a CSV roster of widgets.',
      contract: 'Every row has columns id,name.',
    };

    writeInitializerFiles(runDir, result);

    expect(existsSync(join(runDir, INTENT_FILENAME))).toBe(true);
    expect(existsSync(join(runDir, CONTRACT_FILENAME))).toBe(true);
    expect(readFileSync(join(runDir, INTENT_FILENAME), 'utf8')).toBe(`${result.intent}\n`);
    expect(readFileSync(join(runDir, CONTRACT_FILENAME), 'utf8')).toBe(`${result.contract}\n`);
    // Written directly at the run-dir root — not under artifacts/ or scratch/.
    expect(INTENT_FILENAME).not.toContain('/');
    expect(CONTRACT_FILENAME).not.toContain('/');
  });
});
