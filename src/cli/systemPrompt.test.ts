import { describe, expect, it } from 'vitest';

import type { Message } from '../loop/messages.js';
import { buildRequestParams, type CallModelConfig } from '../model/callModel.js';
import {
  createProductionRegistry,
} from '../tools/index.js';
import { toApiToolDefs } from '../tools/registry.js';
import { SYSTEM_PROMPT } from './systemPrompt.js';

const firstTask = 'Collect the first fixture record and write it as CSV.';
const secondTask = 'Summarize a different fixture and save the answer.';

const firstTaskHistory: readonly Message[] = [
  { role: 'user', content: [{ type: 'text', text: firstTask }] },
];

const secondTaskHistory: readonly Message[] = [
  { role: 'user', content: [{ type: 'text', text: secondTask }] },
  {
    role: 'assistant',
    content: [
      {
        type: 'tool_use',
        id: 'toolu_fixture',
        name: 'inspect_page',
        input: {},
      },
    ],
  },
  {
    role: 'user',
    content: [
      {
        type: 'tool_result',
        tool_use_id: 'toolu_fixture',
        content: 'URL: http://fixture.test/\nTitle: Fixture',
      },
    ],
  },
];

/** Build a fresh production prompt prefix instead of sharing registry or API-tool objects. */
function productionConfig(): CallModelConfig {
  const registry = createProductionRegistry();
  return {
    system: SYSTEM_PROMPT,
    apiToolDefs: toApiToolDefs(registry),
    maxOutputTokens: 4096,
  };
}

describe('SYSTEM_PROMPT', () => {
  it('teaches the workspace contract: publish to artifacts/, work in scratch/, assign roles', () => {
    expect(SYSTEM_PROMPT).toContain('Publish every final requested output into artifacts/');
    expect(SYSTEM_PROMPT).toContain('Use scratch/ for intermediate working files');
    expect(SYSTEM_PROMPT).toContain(
      'Preserve supporting audit evidence (screenshots, downloads) as published artifacts',
    );
    expect(SYSTEM_PROMPT).toContain('Assign each published file its correct roles');
    expect(SYSTEM_PROMPT).toContain(
      'both when a requested file also serves as audit evidence',
    );
  });

  it('requires exact output structure and anchors interpretation to an initial page', () => {
    expect(SYSTEM_PROMPT).toContain('Treat output requirements as exact.');
    expect(SYSTEM_PROMPT).toContain('Do not add unrequested fields');
    expect(SYSTEM_PROMPT).toContain(
      'At the start of a run, inspect the current page before navigating elsewhere.',
    );
    expect(SYSTEM_PROMPT).toContain(
      'A nonblank initial page is deliberately provided task context',
    );
    expect(SYSTEM_PROMPT).toContain(
      'unless the task or concrete observed evidence indicates otherwise',
    );
  });

  it('guides non-trivial checklist use without making it loop control', () => {
    expect(SYSTEM_PROMPT).toContain(
      'For non-trivial work with three or more meaningful steps, use TaskCreate',
    );
    expect(SYSTEM_PROMPT).toContain('skip it for straightforward tasks');
    expect(SYSTEM_PROMPT).toContain('Prefer only one in_progress item at a time');
    expect(SYSTEM_PROMPT).toContain('Mark an item completed immediately');
    expect(SYSTEM_PROMPT).toContain('promised artifacts are fully done');
    expect(SYSTEM_PROMPT).toContain('After each completion, call TaskList');
    expect(SYSTEM_PROMPT).toContain('never controls the agent loop');
    expect(SYSTEM_PROMPT).toContain(
      'does not replace writing and verifying required artifacts',
    );
  });

  it('forms a byte-identical cached prefix with all fourteen core tools across unrelated task histories', () => {
    const firstParams = buildRequestParams(productionConfig(), firstTaskHistory);
    const secondParams = buildRequestParams(productionConfig(), secondTaskHistory);

    const firstPrefix = JSON.stringify({
      tools: firstParams.tools,
      system: firstParams.system,
    });
    const secondPrefix = JSON.stringify({
      tools: secondParams.tools,
      system: secondParams.system,
    });

    expect(secondPrefix).toBe(firstPrefix);
    expect(firstParams.tools).toHaveLength(14);
    expect(firstParams.tools?.map((tool) => tool.name)).toEqual([
      'read_file',
      'write_file',
      'grep',
      'navigate',
      'inspect_page',
      'click',
      'type',
      'scroll',
      'screenshot',
      'download',
      'TaskCreate',
      'TaskList',
      'TaskGet',
      'TaskUpdate',
    ]);

    expect(firstParams.system).toEqual([
      {
        type: 'text',
        text: SYSTEM_PROMPT,
        cache_control: { type: 'ephemeral' },
      },
    ]);
    expect(firstPrefix).not.toContain(firstTask);
    expect(secondPrefix).not.toContain(secondTask);
    expect(JSON.stringify(firstParams.messages)).not.toBe(
      JSON.stringify(secondParams.messages),
    );
  });
});
