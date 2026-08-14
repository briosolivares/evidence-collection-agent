// A no-op BrowserController for bridge tests: the real runTask opens/closes
// its tab against this stub while scripted model streams drive the loop.

import { vi } from 'vitest';

import type { BrowserActionRequest } from '../../src/browser/browserActions.js';
import type { BrowserPage } from '../../src/browser/browserState.js';
import type {
  BrowserController,
  HandleDialogRequest,
} from '../../src/browser/controller.js';

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
    screenshot: vi.fn(async () => new Uint8Array([137, 80])),
    download: vi.fn(async () => ({
      finalUrl: 'https://stub.example/file',
      status: 200,
      headers: {},
      bytes: new Uint8Array(),
    })),
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
    // A stub sequence commits nothing and observes nothing: bridge tests
    // assert loop/TUI behaviour, so the receipts only need to be shaped
    // like a real result.
    browserAction: vi.fn(async (request: BrowserActionRequest) => ({
      status: 'completed' as const,
      previousObservationId: 1,
      actionReceipts: request.actions.map((action, index) => ({
        index,
        op: action.op,
        status: 'completed' as const,
        effectsCommitted: true,
      })),
      settled: true,
      checks: [],
      currentPage: stubPage(request.pageId),
      changes: {
        basis: 'full_snapshot' as const,
        navigated: false,
        newlyVisible: [],
        noLongerVisibleElementIds: [],
        updatedText: [],
      },
      changesTruncated: false,
      openedPages: [],
      dialogs: [],
      downloads: [],
    })),
    handleDialog: vi.fn(async (request: HandleDialogRequest) => ({
      dialogId: request.dialogId,
      handled: (request.action === 'accept' ? 'accepted' : 'dismissed') as
        | 'accepted'
        | 'dismissed',
      page: stubPage(),
      pendingDialogs: [],
    })),
    close: vi.fn(async () => {}),
  };
}
