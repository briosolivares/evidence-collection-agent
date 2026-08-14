import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { COLLAPSED_MARKER } from '../loop/contextView.js';
import type { Message } from '../loop/messages.js';
import { createRegistry, toApiToolDefs, type ToolDef } from '../tools/registry.js';
import {
  buildRequestParams,
  DEFAULT_MODEL,
  makeAnthropicClient,
  type CallModelConfig,
} from './callModel.js';

// A small but realistic registry: two tools with described, typed schemas,
// exactly the shape the file tools use.
const tools: ToolDef[] = [
  {
    name: 'read_file',
    description: 'Reads a file from the run directory.',
    inputSchema: z.strictObject({
      file_path: z.string().describe('Path relative to the run directory'),
    }),
    getAccess: () => ({ reads: [], writes: [] }),
    execute: () => 'unused',
  },
  {
    name: 'write_file',
    description: 'Writes a file into the run directory.',
    inputSchema: z.strictObject({
      file_path: z.string().describe('Path relative to the run directory'),
      content: z.string().describe('Exact content to write'),
    }),
    getAccess: () => ({ reads: [], writes: [] }),
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

  it('places a cache_control breakpoint on the last block of the stable prefix', () => {
    const params = buildRequestParams(makeConfig(), turnOneHistory);

    // The API renders tools → system → messages, so the breakpoint on the
    // final system block ends the stable prefix and caches tools + system.
    const system = params.system as Array<{ text: string; cache_control?: unknown }>;
    expect(system.at(-1)?.cache_control).toEqual({ type: 'ephemeral' });
    expect(system.at(-1)?.text).toBe(SYSTEM_PROMPT);
    // No breakpoints inside the tools array — the system block's marker
    // already caches them (the API renders tools first).
    expect(JSON.stringify(params.tools)).not.toContain('cache_control');
  });

  it('places the moving breakpoint on the last block of the last message — and, absent stubs, nowhere else', () => {
    for (const history of [turnOneHistory, turnThreeHistory]) {
      const params = buildRequestParams(makeConfig(), history);
      const contents = params.messages.map(
        (message) => message.content as Array<{ cache_control?: unknown }>,
      );

      // The marker rides the final block (task text on turn 1, the last
      // tool_result later), so each request resumes the previous turn's
      // cache entry.
      expect(contents.at(-1)?.at(-1)?.cache_control).toEqual({ type: 'ephemeral' });
      // With no collapsed stubs in the view there is exactly one
      // message-level marker: 2 breakpoints per request total
      // (system + moving), within the API's max of 4.
      const markers = contents
        .flat()
        .filter((block) => block.cache_control !== undefined);
      expect(markers).toHaveLength(1);
    }
  });

  it('marks the collapse frontier — the newest stub — alongside the tip when the view has stubs', () => {
    const stub = (n: number): string =>
      `${COLLAPSED_MARKER}\nURL: https://site.test/page-${n}\nTitle: Page ${n}\nRun inspect_page again.`;
    const history = frozen([
      { role: 'user', content: [{ type: 'text', text: 'Collect the evidence.' }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'i1', name: 'inspect_page', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'i1', content: stub(1) }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'i2', name: 'inspect_page', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'i2', content: stub(2) }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'i3', name: 'inspect_page', input: {} }] },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'i3', content: 'URL: x\nTitle: y\n\nfull outline' }],
      },
    ]);
    const params = buildRequestParams(makeConfig(), history);
    const contents = params.messages.map(
      (message) => message.content as Array<{ cache_control?: unknown }>,
    );

    // The newest stub (message 4) carries the frontier marker — the block
    // where a displacement turn's request diverges from the previous
    // turn's — so that turn resumes from the prior frontier's cache entry
    // instead of missing the whole conversation (the server only matches
    // ~20 blocks back from a marker). The older stub is unmarked.
    expect(contents[4]?.[0]?.cache_control).toEqual({ type: 'ephemeral' });
    expect(contents[2]?.[0]?.cache_control).toBeUndefined();
    // The tip marker still rides the final block: 2 message-level markers,
    // 3 breakpoints total with the system block (API max 4).
    expect(contents.at(-1)?.at(-1)?.cache_control).toEqual({ type: 'ephemeral' });
    expect(contents.flat().filter((block) => block.cache_control !== undefined)).toHaveLength(2);
    // The frozen input never saw a marker — marked messages are clones.
    expect(JSON.stringify(history)).not.toContain('cache_control');
  });

  it('a frontier sitting on the tip block gets one marker, not two', () => {
    const history = frozen([
      { role: 'user', content: [{ type: 'text', text: 'Collect the evidence.' }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'i1', name: 'inspect_page', input: {} }] },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'i1', content: `${COLLAPSED_MARKER}\nRun inspect_page again.` }],
      },
    ]);
    const params = buildRequestParams(makeConfig(), history);
    const contents = params.messages.map(
      (message) => message.content as Array<{ cache_control?: unknown }>,
    );
    expect(contents.at(-1)?.at(-1)?.cache_control).toEqual({ type: 'ephemeral' });
    expect(contents.flat().filter((block) => block.cache_control !== undefined)).toHaveLength(1);
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

  it('passes the conversation through without mutating it — the marked message is a clone', () => {
    // turnThreeHistory is deeply frozen — any mutation would have thrown.
    const params = buildRequestParams(makeConfig(), turnThreeHistory);

    // Every message except the last passes through by identity; the last is
    // a clone equal to the original plus the moving marker on its final block.
    expect(params.messages.slice(0, -1)).toEqual(turnThreeHistory.slice(0, -1));
    const lastOriginal = turnThreeHistory.at(-1)!;
    expect(params.messages.at(-1)).toEqual({
      ...lastOriginal,
      content: [
        {
          ...lastOriginal.content.at(-1)!,
          cache_control: { type: 'ephemeral' },
        },
      ],
    });
    // And the input history itself is untouched (no marker leaked back).
    expect(JSON.stringify(turnThreeHistory)).not.toContain('cache_control');
  });
});

describe('makeAnthropicClient', () => {
  let savedKey: string | undefined;

  beforeEach(() => {
    savedKey = process.env.ANTHROPIC_API_KEY;
    // The constructor requires a key; the client never makes a call here.
    process.env.ANTHROPIC_API_KEY = 'test-key-never-used';
  });

  afterEach(() => {
    if (savedKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = savedKey;
  });

  it('disables SDK auto-retry — callWithRetry is the single retry authority', () => {
    // maxRetries: 0, or SDK retries nest inside the manual loop (up to 12
    // requests for one turn) and mid-stream failures still go unretried.
    expect(makeAnthropicClient().maxRetries).toBe(0);
  });
});
