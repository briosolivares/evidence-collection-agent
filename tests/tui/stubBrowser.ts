// A no-op BrowserController for bridge tests: the real runTask opens/closes
// its tab against this stub while scripted model streams drive the loop.

import { vi } from 'vitest';

import type { BrowserPage } from '../../src/browser/browserState.js';
import type { BrowserController } from '../../src/browser/controller.js';

/** The single page every stub identity method reports. */
function stubPage(pageId = 'page-stub'): BrowserPage {
  return {
    pageId,
    documentId: 'doc-stub',
    observationId: 1,
    url: 'about:blank',
    title: 'stub',
    active: true,
    frames: [{ frameId: 'frame-stub', documentId: 'doc-stub', url: 'about:blank' }],
  };
}

/** A fully stubbed controller whose methods are all vi.fn spies. */
export function stubBrowser(): BrowserController {
  return {
    newTab: vi.fn(async () => {}),
    closeTab: vi.fn(async () => {}),
    goto: vi.fn(async () => {}),
    outline: vi.fn(async () => '- page: empty'),
    click: vi.fn(async () => {}),
    type: vi.fn(async () => {}),
    scroll: vi.fn(async () => {}),
    screenshot: vi.fn(async () => new Uint8Array([137, 80])),
    download: vi.fn(async () => ({
      finalUrl: 'https://stub.example/file',
      status: 200,
      headers: {},
      bytes: new Uint8Array(),
    })),
    resolveHref: vi.fn(async () => null),
    fetch: vi.fn(async () => ({
      status: 200,
      headers: {},
      bytes: new Uint8Array(),
    })),
    currentUrl: vi.fn(() => 'about:blank'),
    title: vi.fn(async () => 'stub'),
    pages: vi.fn(async () => [stubPage()]),
    observe: vi.fn(async () => ({
      page: stubPage(),
      views: [{ need: 'interactive' as const, content: '- page: empty', truncated: false }],
      elements: [],
      changes: {
        basis: 'full_snapshot' as const,
        navigated: false,
        newlyVisible: [],
        noLongerVisibleElementIds: [],
        updatedText: [],
      },
    })),
    switchPage: vi.fn(async (pageId: string) => stubPage(pageId)),
    close: vi.fn(async () => {}),
  };
}
