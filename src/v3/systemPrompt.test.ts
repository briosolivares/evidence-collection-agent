import { describe, expect, it } from 'vitest';

import type { Message } from '../loop/messages.js';
import { buildRequestParams } from '../model/callModel.js';
import { V3_SYSTEM_PROMPT } from './systemPrompt.js';
import { V3_API_TOOL_DEFS, V3_TOOL_ORDER } from './tools/index.js';

describe('V3_SYSTEM_PROMPT', () => {
  it('teaches the programmable browser and bounded durable-memory workflow', () => {
    expect(V3_SYSTEM_PROMPT).toContain('Use browser_execute for all browser work.');
    expect(V3_SYSTEM_PROMPT).toContain('protected browser helper');
    expect(V3_SYSTEM_PROMPT).toContain('filtered accessibility tree');
    expect(V3_SYSTEM_PROMPT).toContain('backend DOM node and box model');
    expect(V3_SYSTEM_PROMPT).toContain('verify the specific postcondition');
    expect(V3_SYSTEM_PROMPT).toContain('raw cdp as an escape hatch');
    expect(V3_SYSTEM_PROMPT).toContain('browser.importModule(workspacePath)');
    expect(V3_SYSTEM_PROMPT).toContain(
      'browser.upload(backendDOMNodeId, workspacePath)',
    );
    expect(V3_SYSTEM_PROMPT).toContain(
      'Only the two newest successful browser_execute results remain fully expanded',
    );
    expect(V3_SYSTEM_PROMPT).toContain('record durable facts in workspace files');
    expect(V3_SYSTEM_PROMPT).toContain('artifacts/helper-proposals/');
    expect(V3_SYSTEM_PROMPT).toContain('a unified .patch plus a small .json record');
    expect(V3_SYSTEM_PROMPT).toContain(
      'Never apply, commit, or automatically promote a proposal',
    );
  });

  it('teaches exact generic publication and the private workspace boundary', () => {
    expect(V3_SYSTEM_PROMPT).toContain(
      'Treat every required filename, format, column, field, section, value, count',
    );
    expect(V3_SYSTEM_PROMPT).toContain(
      'use exactly the named columns in the requested order; extra columns fail',
    );
    expect(V3_SYSTEM_PROMPT).toContain('Do not add supposedly helpful fields');
    expect(V3_SYSTEM_PROMPT).toContain('Only files under artifacts/ are published');
    expect(V3_SYSTEM_PROMPT).toContain('Use publish_artifact for every publication.');
    expect(V3_SYSTEM_PROMPT).toContain(
      'prefer text mode and publish it directly without an intermediate write_file call',
    );
    expect(V3_SYSTEM_PROMPT).toContain(
      'exact canonical run-relative path beginning with scratch/workspace/',
    );
    expect(V3_SYSTEM_PROMPT).toContain('requested_output');
    expect(V3_SYSTEM_PROMPT).toContain('evidence');
    expect(V3_SYSTEM_PROMPT).toContain(
      'normally publish one representative evidence screenshot',
    );
    expect(V3_SYSTEM_PROMPT).toContain(
      'Publish additional evidence screenshots only when the task or output contract explicitly requires them',
    );
    expect(V3_SYSTEM_PROMPT).toContain('scratch/workspace/');
    expect(V3_SYSTEM_PROMPT).toContain('bash has no browser capability');
    expect(V3_SYSTEM_PROMPT).toContain('Do not install packages or leave background work');
  });

  it('requires human authority for authentication and consequential actions', () => {
    expect(V3_SYSTEM_PROMPT).toContain(
      'never type or request a password, session secret, or MFA code yourself',
    );
    expect(V3_SYSTEM_PROMPT).toContain('Call ask_user when login, MFA, consent');
    expect(V3_SYSTEM_PROMPT).toContain('another irreversible decision requires human authority');
    expect(V3_SYSTEM_PROMPT).toContain('After a browser handoff, inspect the page again');
    expect(V3_SYSTEM_PROMPT).toContain('report the access limitation honestly');
  });

  it('makes exact exclusive finish the only completion path', () => {
    expect(V3_SYSTEM_PROMPT).toContain(
      'finish is an exclusive control call and must be the only tool call',
    );
    expect(V3_SYSTEM_PROMPT).toContain(
      'Include any concrete unresolved constraint in that summary',
    );
    expect(V3_SYSTEM_PROMPT).not.toContain('explicit limitations list');
    expect(V3_SYSTEM_PROMPT).toContain(
      'derives requested outputs and evidence from the authoritative manifest',
    );
    expect(V3_SYSTEM_PROMPT).toContain(
      'A prose-only response or a response with no tool call does not finish the run.',
    );
    expect(V3_SYSTEM_PROMPT).toContain(
      'finish requests deterministic checks and independent verification',
    );
  });

  it('names every v3 tool and no retired tool or protocol', () => {
    for (const toolName of V3_TOOL_ORDER) {
      expect(V3_SYSTEM_PROMPT).toContain(toolName);
    }

    for (const retired of [
      'set_output_contract',
      'update_table',
      'write_document',
      'observe',
      'browser_action',
      'handle_dialog',
      'execute_javascript',
      'capture_text',
      'inspect_document',
      'grep',
      'ask_user_question',
      'submit_for_verification',
      'uses_browser',
      'typed-row',
      'INTENT.md',
      'CONTRACT.md',
    ]) {
      expect(V3_SYSTEM_PROMPT).not.toContain(retired);
    }
  });

  it('forms the same byte-identical cached prefix for unrelated runs', () => {
    const firstTask = 'Collect the first fixture record as CSV.';
    const secondTask = 'Capture a screenshot from an unrelated account page.';
    const firstHistory: readonly Message[] = [
      { role: 'user', content: [{ type: 'text', text: firstTask }] },
    ];
    const secondHistory: readonly Message[] = [
      { role: 'user', content: [{ type: 'text', text: secondTask }] },
      { role: 'assistant', content: [{ type: 'text', text: 'I am working.' }] },
    ];
    const config = {
      system: V3_SYSTEM_PROMPT,
      apiToolDefs: V3_API_TOOL_DEFS,
      maxOutputTokens: 4_096,
    };

    const first = buildRequestParams(config, firstHistory);
    const second = buildRequestParams(config, secondHistory);
    const firstPrefix = JSON.stringify({
      system: first.system,
      tools: first.tools,
    });
    const secondPrefix = JSON.stringify({
      system: second.system,
      tools: second.tools,
    });

    expect(secondPrefix).toBe(firstPrefix);
    expect(firstPrefix).not.toContain(firstTask);
    expect(secondPrefix).not.toContain(secondTask);
    expect(first.system).toEqual([
      {
        type: 'text',
        text: V3_SYSTEM_PROMPT,
        cache_control: { type: 'ephemeral' },
      },
    ]);
    expect(JSON.stringify(first.messages)).not.toBe(
      JSON.stringify(second.messages),
    );
  });
});
