import { describe, expect, it } from 'vitest';

import type { Message } from '../loop/messages.js';
import { buildRequestParams, type CallModelConfig } from '../model/callModel.js';
import {
  actionTools,
  authTools,
  evidenceTools,
  fileTools,
  interactionTools,
  observationTools,
} from '../tools/index.js';
import { createRegistry, toApiToolDefs } from '../tools/registry.js';
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
  const registry = createRegistry([
    ...fileTools,
    ...observationTools,
    ...actionTools,
    ...evidenceTools,
    ...authTools,
    ...interactionTools,
  ]);
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

  it('teaches the multi-entity protocol: roster and contract before collecting, reconcile before finishing', () => {
    expect(SYSTEM_PROMPT).toContain('plan before collecting');
    expect(SYSTEM_PROMPT).toContain(
      'write a roster of every entity to cover into a scratch/ file',
    );
    expect(SYSTEM_PROMPT).toContain('write the output contract');
    expect(SYSTEM_PROMPT).toContain('enum-like values copied verbatim with nothing added');
    expect(SYSTEM_PROMPT).toContain('reconcile in both directions');
    expect(SYSTEM_PROMPT).toContain('its absence justified by observed evidence');
    expect(SYSTEM_PROMPT).toContain('every line of the output is a valid row under the contract');
  });

  it('teaches chunked writes: large files are built with append, in small pieces', () => {
    // The decode-stall workaround: single large write_file values stall at
    // deep context; pieces of a few thousand characters never have.
    expect(SYSTEM_PROMPT).toContain('longer than about 3,000 characters in pieces');
    expect(SYSTEM_PROMPT).toContain('append: true');
  });

  it('teaches the inspection window: stale inspections collapse, facts go to files, refs stay fresh', () => {
    // Must match the loop's actual behavior (contextView.ts): only the two
    // most recent inspect_page results survive in the conversation.
    expect(SYSTEM_PROMPT).toContain(
      'Only your two most recent page inspections stay in the conversation',
    );
    expect(SYSTEM_PROMPT).toContain('record lasting facts in scratch/ or artifacts/ files');
    expect(SYSTEM_PROMPT).toContain('re-inspect a page if you need it again');
  });

  it('teaches the authentication playbook lightly: fill first, never type, ask on failure', () => {
    expect(SYSTEM_PROMPT).toContain('Authentication.');
    expect(SYSTEM_PROMPT).toContain(
      'use fill_credentials to fill the form — it knows which sites have ' +
        'stored credentials and will tell you if none exist',
    );
    expect(SYSTEM_PROMPT).toContain(
      'Never type usernames or passwords with the type tool.',
    );
    expect(SYSTEM_PROMPT).toContain(
      'ask_user_question pauses the task so they can act in the browser window',
    );
    expect(SYSTEM_PROMPT).toContain('reinspect the page before continuing');
  });

  it('forms a byte-identical cached prefix with all twelve production tools across unrelated task histories', () => {
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
    expect(firstParams.tools).toHaveLength(12);
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
      'fill_credentials',
      'ask_user_question',
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
