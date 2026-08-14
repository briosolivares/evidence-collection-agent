import { describe, expect, it } from 'vitest';

import type { Message } from '../loop/messages.js';
import { buildRequestParams, type CallModelConfig } from '../model/callModel.js';
import { createBashTool, createV2Registry } from '../tools/index.js';
import { toApiToolDefs, type ToolDef } from '../tools/registry.js';
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
    content: [{ type: 'tool_use', id: 'toolu_fixture', name: 'observe', input: {} }],
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
  // Built through the real production builder rather than by re-listing the
  // tools: `bash` is run-scoped (it closes over the secret-env denylist), so
  // hand-assembling would silently omit it and this test would stop describing
  // the prefix production actually sends. The exact tool set and its frozen
  // order are pinned once, in tools/index.test.ts; what matters here is that
  // whatever that set is serializes identically on every call.
  const registry = createV2Registry(
    new Map<string, ToolDef>([['bash', createBashTool({ secretEnvDenylist: [] }) as ToolDef]]),
  );
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
      'At the start of a run, observe the current page before navigating elsewhere.',
    );
    expect(SYSTEM_PROMPT).toContain(
      'A nonblank initial page is deliberately provided task context',
    );
    expect(SYSTEM_PROMPT).toContain(
      'unless the task or concrete observed evidence indicates otherwise',
    );
  });

  it('teaches the multi-entity protocol: roster before collecting, reconcile before finishing', () => {
    expect(SYSTEM_PROMPT).toContain('plan before collecting');
    expect(SYSTEM_PROMPT).toContain(
      'write a roster of every entity to cover into a scratch/ file',
    );
    expect(SYSTEM_PROMPT).toContain('reconcile in both directions');
    expect(SYSTEM_PROMPT).toContain('its absence justified by observed evidence');
    expect(SYSTEM_PROMPT).toContain('every row of the output is a valid row under the contract');
  });

  it('names the typed output contract as the run\'s requirements, deferring per-run detail', () => {
    // The static prompt states that a typed contract governs the run and that
    // the runtime owns rendering; WHICH revision and WHICH outputs are per-run
    // facts and belong to workerProtocolBrief, not here. Nothing in this
    // paragraph may contradict that brief.
    expect(SYSTEM_PROMPT).toContain('a typed output contract');
    expect(SYSTEM_PROMPT).toContain('enforced by code before any verifier sees your work');
    expect(SYSTEM_PROMPT).toContain('The opening message tells you whether a contract is already set');
    expect(SYSTEM_PROMPT).toContain(
      'do not consider the task done until every criterion is satisfied and proven',
    );
    expect(SYSTEM_PROMPT).toContain('build those through the output tools rather than writing the file yourself');
    // The V1 prose protocol is gone: no run writes these files any more, and
    // mentioning them sent workers hunting for files that never appear.
    expect(SYSTEM_PROMPT).not.toContain('INTENT.md');
    expect(SYSTEM_PROMPT).not.toContain('CONTRACT.md');
  });

  it('teaches chunked writes: large files are built with append, in small pieces', () => {
    // The decode-stall workaround: single large write_file values stall at
    // deep context; pieces of a few thousand characters never have.
    expect(SYSTEM_PROMPT).toContain('longer than about 3,000 characters in pieces');
    expect(SYSTEM_PROMPT).toContain('append: true');
  });

  it('teaches the observation window: stale observations collapse, facts go to files, refs stay fresh', () => {
    // Must match the loop's actual behavior (contextView.ts): only the two
    // most recent observe results survive in the conversation.
    expect(SYSTEM_PROMPT).toContain(
      'Only your two most recent observations stay in the conversation',
    );
    expect(SYSTEM_PROMPT).toContain('record lasting facts in scratch/ or artifacts/ files');
    expect(SYSTEM_PROMPT).toContain('observe a page again if you need it');
  });

  it('names only tools the V2 registry actually offers', () => {
    // A prompt that names a deleted tool costs a wasted turn and an error the
    // model cannot act on, so this pins the direction of the cutover.
    for (const live of ['observe', 'browser_action', 'submit_for_verification']) {
      expect(SYSTEM_PROMPT).toContain(live);
    }
    for (const dead of ['inspect_page', 'fill_credentials', 'read_resource']) {
      expect(SYSTEM_PROMPT).not.toContain(dead);
    }
  });

  it('teaches the authentication playbook lightly: never type secrets, hand off instead', () => {
    expect(SYSTEM_PROMPT).toContain('Authentication.');
    expect(SYSTEM_PROMPT).toContain(
      'you hold no credentials, so a login wall is always a handoff',
    );
    expect(SYSTEM_PROMPT).toContain('Never type usernames or passwords yourself');
    expect(SYSTEM_PROMPT).toContain(
      'ask_user_question pauses the task so they can act in the browser window',
    );
    expect(SYSTEM_PROMPT).toContain('observe the page before continuing');
  });

  it('frames finishing as a submission for verification, not a claim of success', () => {
    expect(SYSTEM_PROMPT).toContain(
      'Finishing is a handoff for verification, not a claim of success.',
    );
    expect(SYSTEM_PROMPT).toContain(
      'Only propose completion after all requested artifacts have been written and verified',
    );
    expect(SYSTEM_PROMPT).toContain('call submit_for_verification on its own');
    expect(SYSTEM_PROMPT).toContain('A response with no tool call does not finish the run.');
    expect(SYSTEM_PROMPT).toContain('briefly name the files you produced');
  });

  it('forms a byte-identical cached prefix across unrelated task histories', () => {
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
    expect(firstParams.tools?.length).toBeGreaterThan(0);
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
