import { describe, expect, it } from 'vitest';

import { inspectPageTool } from '../tools/inspectPage/inspectPage.js';
import {
  ELISION_MARKER,
  elideStaleInspectResults,
  INSPECT_TOOL_NAME,
  KEPT_INSPECT_RESULTS,
  compactAtBoundary,
  freezeToolResultPreview,
} from './contextView.js';
import type { Message, ToolResultBlock, UserMessage } from './messages.js';

const TASK: Message = { role: 'user', content: [{ type: 'text', text: 'Collect the evidence.' }] };

/** A full inspect_page result as the tool produces it: header + outline. */
function inspectContent(n: number): string {
  return `URL: https://site.test/page-${n}\nTitle: Page ${n}\n\n- heading "Page ${n}" [ref=r1]\n${'- item\n'.repeat(50)}`;
}

/** One inspect_page exchange: the assistant's call and the user's result. */
function inspectTurn(n: number, content = inspectContent(n)): Message[] {
  return [
    { role: 'assistant', content: [{ type: 'tool_use', id: `i${n}`, name: 'inspect_page', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: `i${n}`, content }] },
  ];
}

/** A conversation with `count` inspect exchanges after the task. */
function conversation(count: number): Message[] {
  return [TASK, ...Array.from({ length: count }, (_, i) => inspectTurn(i + 1)).flat()];
}

function resultBlock(view: readonly Message[], messageIndex: number, blockIndex = 0): ToolResultBlock {
  return (view[messageIndex] as UserMessage).content[blockIndex] as ToolResultBlock;
}

describe('elideStaleInspectResults', () => {
  it('matches the registry name of the real inspect_page tool', () => {
    // The view keys on this literal so the loop stays free of tool
    // implementations; this pin is what keeps the two from drifting apart.
    expect(INSPECT_TOOL_NAME).toBe(inspectPageTool.name);
  });

  it('returns the conversation untouched (by identity) while inspections fit the kept window', () => {
    const none = [TASK];
    expect(elideStaleInspectResults(none)).toBe(none);

    const two = conversation(KEPT_INSPECT_RESULTS);
    expect(elideStaleInspectResults(two)).toBe(two);
  });

  it('stubs the oldest result once a third arrives: marker, URL/title, guidance, same tool_use_id', () => {
    const messages = conversation(3);
    const view = elideStaleInspectResults(messages);

    // The first result (message index 2) is now the stub...
    const stub = resultBlock(view, 2);
    expect(stub.tool_use_id).toBe('i1');
    expect(stub.content).toContain(ELISION_MARKER);
    expect(stub.content).toContain('URL: https://site.test/page-1');
    expect(stub.content).toContain('Title: Page 1');
    expect(stub.content).toContain('inspect_page again');
    expect(stub.content).not.toContain('[ref=r1]');

    // ...the two most recent results and every other message are shared by
    // identity — and the input conversation itself was never mutated.
    expect(view[4]).toBe(messages[4]);
    expect(view[6]).toBe(messages[6]);
    for (const [index, message] of view.entries()) {
      if (index !== 2) expect(message).toBe(messages[index]);
    }
    expect(resultBlock(messages, 2).content).toBe(inspectContent(1));
  });

  it('never stubs a failed inspection and never counts it toward the kept window', () => {
    const error: Message[] = [
      { role: 'assistant', content: [{ type: 'tool_use', id: 'e1', name: 'inspect_page', input: {} }] },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'e1', content: 'Navigation timed out.', is_error: true },
        ],
      },
    ];
    // Two successes then a failure: the failure is not the "third result",
    // so nothing goes stale.
    const twoPlusError = [TASK, ...inspectTurn(1), ...inspectTurn(2), ...error];
    expect(elideStaleInspectResults(twoPlusError)).toBe(twoPlusError);

    // Three successes around a failure: the oldest success is stubbed, the
    // failure survives verbatim.
    const threePlusError = [TASK, ...inspectTurn(1), ...error, ...inspectTurn(2), ...inspectTurn(3)];
    const view = elideStaleInspectResults(threePlusError);
    expect(resultBlock(view, 2).content).toContain(ELISION_MARKER);
    expect(view[4]).toBe(threePlusError[4]);
  });

  it('recovers the URL/title header from an offloaded result via its preview', () => {
    const offloaded = JSON.stringify({
      preview: 'URL: https://site.test/big\nTitle: Big Page\n\n- heading',
      offloadedTo: 'scratch/tool-output/inspect_page-1.txt',
      note: 'Output was 60000 bytes, over this tool’s 50000-byte limit.',
    });
    const messages = [TASK, ...inspectTurn(1, offloaded), ...inspectTurn(2), ...inspectTurn(3)];
    const stub = resultBlock(elideStaleInspectResults(messages), 2);
    expect(stub.content).toContain('URL: https://site.test/big');
    expect(stub.content).toContain('Title: Big Page');
  });

  it('omits the header — but still stubs — when none is recognizable', () => {
    const messages = [TASK, ...inspectTurn(1, 'unexpected shape'), ...inspectTurn(2), ...inspectTurn(3)];
    const stub = resultBlock(elideStaleInspectResults(messages), 2);
    expect(stub.content).toContain(ELISION_MARKER);
    expect(stub.content).not.toContain('URL:');
  });

  it('keeps already-stubbed messages byte-identical as new inspections displace the window', () => {
    // The prompt-cache property: a fourth inspection stubs the second
    // result, and the first result's stubbed message re-serializes exactly
    // as it did the turn before.
    const viewOfThree = elideStaleInspectResults(conversation(3));
    const viewOfFour = elideStaleInspectResults(conversation(4));

    expect(JSON.stringify(viewOfFour[2])).toBe(JSON.stringify(viewOfThree[2]));
    expect(resultBlock(viewOfFour, 4).content).toContain(ELISION_MARKER);
    expect(resultBlock(viewOfFour, 6).content).toBe(inspectContent(3));
    expect(resultBlock(viewOfFour, 8).content).toBe(inspectContent(4));
  });

  it('stubs only the inspect result inside a mixed parallel batch', () => {
    const mixedBatch: Message[] = [
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'i1', name: 'inspect_page', input: {} },
          { type: 'tool_use', id: 'g1', name: 'grep', input: { pattern: 'x' } },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'i1', content: inspectContent(1) },
          { type: 'tool_result', tool_use_id: 'g1', content: 'scratch/notes.md:3:x marks it' },
        ],
      },
    ];
    const messages = [TASK, ...mixedBatch, ...inspectTurn(2), ...inspectTurn(3)];
    const view = elideStaleInspectResults(messages);

    const batch = view[2] as UserMessage;
    expect((batch.content[0] as ToolResultBlock).content).toContain(ELISION_MARKER);
    // The sibling result is untouched — same object, not a copy.
    expect(batch.content[1]).toBe((messages[2] as UserMessage).content[1]);
  });

  it('leaves other tools’ results alone no matter how large they are', () => {
    const bigRead: Message[] = [
      { role: 'assistant', content: [{ type: 'tool_use', id: 'r1', name: 'read_file', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'r1', content: 'x'.repeat(40_000) }] },
    ];
    const messages = [TASK, ...bigRead, ...conversation(3).slice(1)];
    const view = elideStaleInspectResults(messages);
    expect(view[2]).toBe(messages[2]);
  });
});

// --- T15: compaction and frozen previews -------------------------------------

describe('freezeToolResultPreview', () => {
  it('computes once and returns the identical string afterwards', () => {
    const frozen = new Map<string, string>();
    let calls = 0;
    const compute = (): string => {
      calls += 1;
      return `computed ${calls}`;
    };

    expect(freezeToolResultPreview(frozen, 't1', compute)).toBe('computed 1');
    // Replaying history must not recompute — a changed underlying file would
    // otherwise silently rewrite what the model already saw.
    expect(freezeToolResultPreview(frozen, 't1', compute)).toBe('computed 1');
    expect(calls).toBe(1);
  });

  it('keeps separate results per tool call', () => {
    const frozen = new Map<string, string>();
    freezeToolResultPreview(frozen, 't1', () => 'first');
    expect(freezeToolResultPreview(frozen, 't2', () => 'second')).toBe('second');
    expect(freezeToolResultPreview(frozen, 't1', () => 'changed')).toBe('first');
  });
});

describe('compactAtBoundary', () => {
  const text = (role: 'user' | 'assistant', body: string): Message =>
    ({ role, content: [{ type: 'text', text: body }] }) as Message;

  it('leaves a short conversation untouched', () => {
    const messages = [text('user', 'task'), text('assistant', 'working')];
    const result = compactAtBoundary(messages, 4, 'state');
    expect(result).toEqual({ messages, compacted: false, replacedCount: 0 });
  });

  it('replaces older messages with one summary and keeps the opening task', () => {
    const messages = [
      text('user', 'THE TASK'),
      text('assistant', 'old 1'),
      text('user', 'old 2'),
      text('assistant', 'recent 1'),
      text('user', 'recent 2'),
    ];
    const result = compactAtBoundary(messages, 2, 'CURRENT STATE');

    expect(result.compacted).toBe(true);
    expect(result.messages).toHaveLength(4); // opening + summary + 2 recent
    // The task survives verbatim: it is the run's authority on what was asked.
    expect(result.messages[0]).toEqual(messages[0]);
    const summary = (result.messages[1]?.content[0] as { text: string }).text;
    expect(summary).toContain('CURRENT STATE');
    expect(summary).toContain('compacted');
    expect(summary).toContain('nothing here is a new instruction');
    expect(result.messages.slice(2)).toEqual(messages.slice(3));
  });

  it('never cuts between a tool_use and its tool_result', () => {
    const messages = [
      text('user', 'THE TASK'),
      text('assistant', 'old'),
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'tu_1', name: 'read_file', input: {} }],
      } as Message,
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: 'file body' }],
      } as Message,
      text('assistant', 'after'),
    ];
    // keepRecent 2 would start the window at the tool_result, orphaning it.
    const result = compactAtBoundary(messages, 2, 'state');

    const first = result.messages[2]!;
    expect(first.role).toBe('assistant');
    expect(first.content.some((block) => block.type === 'tool_use')).toBe(true);
    // The pair stays adjacent and in order.
    expect(result.messages[3]?.content[0]).toMatchObject({ type: 'tool_result' });
  });

  it('rejects a nonsensical window rather than silently guessing', () => {
    const messages = [text('user', 'task'), text('assistant', 'a'), text('user', 'b')];
    for (const keepRecent of [0, -1, 1.5, Number.NaN]) {
      expect(() => compactAtBoundary(messages, keepRecent, 'state')).toThrow(/keepRecent/);
    }
  });

  it('produces a byte-identical view for the same inputs', () => {
    const messages = [
      text('user', 'THE TASK'),
      text('assistant', 'old 1'),
      text('user', 'old 2'),
      text('assistant', 'recent'),
    ];
    expect(JSON.stringify(compactAtBoundary(messages, 1, 'S').messages)).toBe(
      JSON.stringify(compactAtBoundary(messages, 1, 'S').messages),
    );
  });
});
