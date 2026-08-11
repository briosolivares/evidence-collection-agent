import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import type { Message } from '../loop/messages.js';
import { createRegistry, toApiToolDefs, type ToolDef } from '../tools/registry.js';
import { buildRequestParams, DEFAULT_MODEL, type CallModelConfig } from './callModel.js';

// A small but realistic registry: two tools with described, typed schemas,
// exactly the shape the file tools use.
const tools: ToolDef[] = [
  {
    name: 'read_file',
    description: 'Reads a file from the run directory.',
    inputSchema: z.strictObject({
      file_path: z.string().describe('Path relative to the run directory'),
    }),
    readOnly: true,
    execute: () => 'unused',
  },
  {
    name: 'write_file',
    description: 'Writes a file into the run directory.',
    inputSchema: z.strictObject({
      file_path: z.string().describe('Path relative to the run directory'),
      content: z.string().describe('Exact content to write'),
    }),
    readOnly: false,
    execute: () => 'unused',
  },
];

const SYSTEM_PROMPT = 'You are a careful file-editing agent. Use the tools to do the work.';

/** A fresh config, with the tools array rebuilt from the registry — so the
 * tests also cover determinism of the whole prefix construction path, not
 * just reuse of one shared array instance. */
function makeConfig(): CallModelConfig {
  return {
    system: SYSTEM_PROMPT,
    apiToolDefs: toApiToolDefs(createRegistry(tools)),
    maxOutputTokens: 4096,
  };
}

/** Deep-freeze a message history to prove buildRequestParams never mutates it. */
function frozen(messages: Message[]): readonly Message[] {
  for (const message of messages) {
    Object.freeze(message.content.map((block) => Object.freeze(block)));
    Object.freeze(message.content);
    Object.freeze(message);
  }
  return Object.freeze(messages);
}

const turnOneHistory = frozen([
  { role: 'user', content: [{ type: 'text', text: 'Write a limerick to limerick.txt' }] },
]);

const turnThreeHistory = frozen([
  { role: 'user', content: [{ type: 'text', text: 'Write a limerick to limerick.txt' }] },
  {
    role: 'assistant',
    content: [
      { type: 'text', text: 'Writing it now.' },
      { type: 'tool_use', id: 'toolu_01A', name: 'write_file', input: { file_path: 'limerick.txt', content: 'x' } },
    ],
  },
  {
    role: 'user',
    content: [{ type: 'tool_result', tool_use_id: 'toolu_01A', content: 'Wrote limerick.txt' }],
  },
]);

describe('buildRequestParams', () => {
  it('keeps the prefix byte-identical across calls with different message histories', () => {
    // Two independently-built configs at different times: any dynamic value
    // (timestamp, run id, random id) leaking into system or tools would
    // break the byte equality that prompt caching depends on.
    const paramsA = buildRequestParams(makeConfig(), turnOneHistory);
    const paramsB = buildRequestParams(makeConfig(), turnThreeHistory);

    const prefixA = JSON.stringify({ tools: paramsA.tools, system: paramsA.system });
    const prefixB = JSON.stringify({ tools: paramsB.tools, system: paramsB.system });
    expect(prefixB).toBe(prefixA);

    // Sanity: the histories really did differ — only messages may vary.
    expect(JSON.stringify(paramsA.messages)).not.toBe(JSON.stringify(paramsB.messages));
  });

  it('places the cache_control breakpoint on the last block of the stable prefix', () => {
    const params = buildRequestParams(makeConfig(), turnOneHistory);

    // The API renders tools → system → messages, so the breakpoint on the
    // final system block ends the stable prefix and caches tools + system.
    const system = params.system as Array<{ text: string; cache_control?: unknown }>;
    expect(system.at(-1)?.cache_control).toEqual({ type: 'ephemeral' });
    expect(system.at(-1)?.text).toBe(SYSTEM_PROMPT);
    // No breakpoints inside the volatile suffix.
    expect(JSON.stringify(params.messages)).not.toContain('cache_control');
  });

  it('carries the config into the request: model default and override, max_tokens, thinking off', () => {
    const defaulted = buildRequestParams(makeConfig(), turnOneHistory);
    expect(defaulted.model).toBe(DEFAULT_MODEL);
    expect(defaulted.max_tokens).toBe(4096);
    // Thinking is explicitly disabled: the loop's message types cannot
    // replay thinking blocks, so the model must not produce them.
    expect(defaulted.thinking).toEqual({ type: 'disabled' });

    const overridden = buildRequestParams({ ...makeConfig(), model: 'claude-opus-5' }, turnOneHistory);
    expect(overridden.model).toBe('claude-opus-5');
  });

  it('passes the conversation through verbatim without mutating it', () => {
    // turnThreeHistory is deeply frozen — any mutation would have thrown.
    const params = buildRequestParams(makeConfig(), turnThreeHistory);
    expect(params.messages).toEqual(turnThreeHistory);
  });
});
