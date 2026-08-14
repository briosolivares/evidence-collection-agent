import { describe, expect, it } from 'vitest';

import type { Message } from '../loop/messages.js';
import { buildRequestParams, type CallModelConfig } from '../model/callModel.js';
import { createProductionRegistry, createBashTool } from '../tools/index.js';
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
  // Built through the real production builder rather than by re-listing the
  // groups: bash is run-scoped (it closes over the secret-env denylist), so
  // hand-assembling the groups would silently omit it and this test would stop
  // describing the prefix production actually sends.
  const registry = createProductionRegistry('atomic', {
    bash: createBashTool({ secretEnvDenylist: [] }),
  });
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
    // The worker no longer authors the contract itself — it defers to
    // CONTRACT.md when the harness provided one, falling back to the
    // task's own stated structure otherwise.
    expect(SYSTEM_PROMPT).toContain('The output contract is CONTRACT.md when present');
    expect(SYSTEM_PROMPT).toContain(
      "otherwise the task's own stated columns, fields, and field-level rules",
    );
    expect(SYSTEM_PROMPT).toContain('enum-like values copied verbatim with nothing added');
    expect(SYSTEM_PROMPT).toContain('reconcile in both directions');
    expect(SYSTEM_PROMPT).toContain('its absence justified by observed evidence');
    expect(SYSTEM_PROMPT).toContain('every line of the output is a valid row under the contract');
  });

  it('teaches the conditional INTENT.md/CONTRACT.md protocol for harness-managed runs', () => {
    // These files exist only when the initializer→worker→judge harness
    // wrote them; REPL/interactive runs and many existing tests are
    // judge-less, so the language must be conditional on presence.
    expect(SYSTEM_PROMPT).toContain('may also contain INTENT.md and CONTRACT.md at its root');
    expect(SYSTEM_PROMPT).toContain('When present, read both before starting work');
    expect(SYSTEM_PROMPT).toContain('consult the contract every time you write output');
    expect(SYSTEM_PROMPT).toContain(
      'do not consider the task done until every contract criterion is satisfied and proven',
    );
    expect(SYSTEM_PROMPT).toContain('These files cannot be modified.');
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

  it('teaches the authentication playbook lightly: never type secrets, hand off instead', () => {
    expect(SYSTEM_PROMPT).toContain('Authentication.');
    expect(SYSTEM_PROMPT).toContain(
      'you hold no credentials, so a login wall is always a handoff',
    );
    expect(SYSTEM_PROMPT).toContain(
      'Never type usernames or passwords yourself',
    );
    expect(SYSTEM_PROMPT).toContain(
      'ask_user_question pauses the task so they can act in the browser window',
    );
    expect(SYSTEM_PROMPT).toContain('reinspect the page before continuing');
  });

  it('frames finishing as a proposal for verification, not a claim of success', () => {
    // The judge harness reviews the worker's no-tool-call response as a
    // completion proposal rather than trusting it as a success claim.
    expect(SYSTEM_PROMPT).toContain(
      'Finishing is a handoff for verification, not a claim of success.',
    );
    expect(SYSTEM_PROMPT).toContain(
      'Only propose completion after all requested artifacts have been written and verified.',
    );
    expect(SYSTEM_PROMPT).toContain('There is no finish tool: propose completion');
    expect(SYSTEM_PROMPT).toContain(
      'your response submits the run for verification rather than declaring success',
    );
    expect(SYSTEM_PROMPT).toContain('briefly name the files you produced');
  });

  it('forms a byte-identical cached prefix with all thirteen production tools across unrelated task histories', () => {
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
    expect(firstParams.tools).toHaveLength(13);
    expect(firstParams.tools?.map((tool) => tool.name)).toEqual([
      'read_file',
      'write_file',
      'edit_file',
      'grep',
      'bash',
      'navigate',
      'inspect_page',
      'click',
      'type',
      'scroll',
      'screenshot',
      'download',
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
