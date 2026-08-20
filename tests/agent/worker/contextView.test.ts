import { describe, expect, it } from 'vitest';

import type { Message, ToolResultBlock } from '../../../src/model/messages.js';
import {
  COLLAPSED_BROWSER_RESULT_MARKER,
  COLLAPSED_CAPTURE_SCREENSHOT_RESULT_MARKER,
  isCollapsedBrowserResult,
  isCollapsedCaptureScreenshotResult,
} from '../../../src/model/callModel.js';
import { buildContextView } from '../../../src/agent/worker/contextView.js';

function browserExchange(
  id: string,
  pageId: string | undefined,
  result: unknown,
  isError = false,
): Message[] {
  return [
    {
      role: 'assistant',
      content: [
        {
          type: 'tool_use',
          id,
          name: 'browser_execute',
          input: {
            code: `return ${JSON.stringify(id)}`,
            ...(pageId === undefined ? {} : { page_id: pageId }),
          },
        },
      ],
    },
    {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: id,
          content: typeof result === 'string' ? result : JSON.stringify(result),
          ...(isError ? { is_error: true } : {}),
        },
      ],
    },
  ];
}

function resultAt(messages: readonly Message[], index: number): ToolResultBlock {
  const block = messages[index]!.content[0]!;
  if (block.type !== 'tool_result') throw new Error('expected tool result');
  return block;
}

function captureExchange(id: string, pageId?: string, isError = false): Message[] {
  return [
    {
      role: 'assistant',
      content: [
        {
          type: 'tool_use',
          id,
          name: 'capture_screenshot',
          input: pageId === undefined ? {} : { page_id: pageId },
        },
      ],
    },
    {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: id,
          content: isError
            ? 'capture failed'
            : [
                { type: 'text', text: 'Captured https://example.test/live' },
                {
                  type: 'image',
                  source: { type: 'base64', media_type: 'image/png', data: 'aW1hZ2U=' },
                },
              ],
          ...(isError ? { is_error: true } : {}),
        },
      ],
    },
  ];
}

describe('buildContextView', () => {
  it('stubs only older successful browser results and leaves full history untouched', () => {
    const first = {
      status: 'exited',
      stdout: 'large first output',
      pages: [
        {
          pageId: 'page-1',
          url: 'https://one.example/report',
          active: false,
        },
      ],
    };
    const messages: Message[] = [
      { role: 'user', content: [{ type: 'text', text: 'task' }] },
      ...browserExchange('browser-1', 'page-1', first),
      ...browserExchange('browser-failed', undefined, 'browser unavailable', true),
      ...browserExchange('browser-2', 'page-2', {
        status: 'failed',
        pages: [{ pageId: 'page-2', url: 'https://two.example' }],
      }),
      ...browserExchange('browser-3', undefined, {
        status: 'exited',
        pages: [{ pageId: 'page-3', active: true }],
      }),
    ];
    const original = structuredClone(messages);

    const view = buildContextView(messages);

    const stale = resultAt(view, 2);
    expect(stale.content).toContain(COLLAPSED_BROWSER_RESULT_MARKER);
    expect(stale.content).toContain(
      'Identity: {"tool_use_id":"browser-1","requested_page_id":"page-1"}',
    );
    expect(stale.content).toContain('Status: "exited"');
    expect(stale.content).toContain(
      'Pages: [{"pageId":"page-1","url":"https://one.example/report","active":false}]',
    );
    expect(isCollapsedBrowserResult(stale)).toBe(true);

    expect(resultAt(view, 4)).toBe(messages[4]!.content[0]);
    expect(resultAt(view, 6)).toBe(messages[6]!.content[0]);
    expect(resultAt(view, 8)).toBe(messages[8]!.content[0]);
    expect(messages).toEqual(original);
    expect(resultAt(messages, 2).content).toBe(JSON.stringify(first));
  });

  it('recovers status and pages from an offload preview and produces a stable stub', () => {
    const preview = JSON.stringify({
      status: 'timed_out',
      pages: [
        {
          pageId: 'page-a',
          url: 'https://example.test/a',
          active: true,
        },
      ],
      stdout: 'truncated later',
    });
    const messages: Message[] = [
      { role: 'user', content: [{ type: 'text', text: 'task' }] },
      ...browserExchange('a', undefined, {
        preview,
        offloadedTo: 'scratch/tool-output/browser_execute-1.txt',
        note: 'offloaded',
      }),
      ...browserExchange('b', undefined, { status: 'exited', pages: [] }),
      ...browserExchange('c', undefined, { status: 'exited', pages: [] }),
    ];

    const first = buildContextView(messages);
    const second = buildContextView(messages);
    const stub = resultAt(first, 2);

    expect(stub.content).toContain('Status: "timed_out"');
    expect(stub.content).toContain(
      'Pages: [{"pageId":"page-a","url":"https://example.test/a","active":true}]',
    );
    expect(resultAt(second, 2).content).toBe(stub.content);
  });

  it('returns the original array when two or fewer successes exist', () => {
    const messages: Message[] = [
      { role: 'user', content: [{ type: 'text', text: 'task' }] },
      ...browserExchange('a', undefined, { status: 'exited', pages: [] }),
      ...browserExchange('b', undefined, { status: 'exited', pages: [] }),
    ];

    expect(buildContextView(messages)).toBe(messages);
    expect(
      isCollapsedBrowserResult({
        type: 'tool_result',
        content: `prefix ${COLLAPSED_BROWSER_RESULT_MARKER}`,
      }),
    ).toBe(false);
  });

  it('shows capture pixels once, then replaces them with stable metadata', () => {
    const messages: Message[] = [
      { role: 'user', content: [{ type: 'text', text: 'task' }] },
      ...captureExchange('capture-1', 'page-9'),
    ];
    const original = structuredClone(messages);

    expect(buildContextView(messages)).toBe(messages);

    messages.push({ role: 'assistant', content: [{ type: 'text', text: 'I inspected it.' }] });
    const first = buildContextView(messages);
    const second = buildContextView(messages);
    const collapsed = resultAt(first, 2);

    expect(collapsed.content).toContain(COLLAPSED_CAPTURE_SCREENSHOT_RESULT_MARKER);
    expect(collapsed.content).toContain('"requested_page_id":"page-9"');
    expect(collapsed.content).toContain('Captured https://example.test/live');
    expect(isCollapsedCaptureScreenshotResult(collapsed)).toBe(true);
    expect(resultAt(second, 2).content).toBe(collapsed.content);
    expect(messages.slice(0, original.length)).toEqual(original);
    expect(Array.isArray(resultAt(messages, 2).content)).toBe(true);
  });

  it('never collapses a failed capture result', () => {
    const messages: Message[] = [
      { role: 'user', content: [{ type: 'text', text: 'task' }] },
      ...captureExchange('capture-failed', undefined, true),
      { role: 'assistant', content: [{ type: 'text', text: 'I will recover.' }] },
    ];

    expect(buildContextView(messages)).toBe(messages);
    expect(
      isCollapsedCaptureScreenshotResult({
        type: 'tool_result',
        content: `prefix ${COLLAPSED_CAPTURE_SCREENSHOT_RESULT_MARKER}`,
      }),
    ).toBe(false);
  });
});
