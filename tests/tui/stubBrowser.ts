// A no-op BrowserController for bridge tests: the real runTask opens/closes
// its tab against this stub while scripted model streams drive the loop.

import { vi } from 'vitest';

import type {
  BrowserController,
  BrowserPage,
} from '../../src/browser/controller.js';

/** The single page every stub identity method reports. */
function stubPage(pageId = 'page-stub'): BrowserPage {
  return {
    pageId,
    url: 'about:blank',
    active: true,
  };
}

/** A fully stubbed controller whose methods are all vi.fn spies. */
export function stubBrowser(): BrowserController {
  return {
    screenshot: vi.fn(async () => new Uint8Array([137, 80])),
    download: vi.fn(async () => ({
      finalUrl: 'https://stub.example/file',
      status: 200,
      headers: {},
      bytes: new Uint8Array(),
    })),
    currentUrl: vi.fn(() => 'about:blank'),
    pages: vi.fn(async () => [stubPage()]),
    openCommandSession: vi.fn(async (pageId = 'page-stub') => ({
      pageId,
      targetId: 'target-stub',
      send: vi.fn(async () => ({})),
      upload: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
    })),
    refreshAfterExternalCommands: vi.fn(async () => {}),
    listPendingDialogs: vi.fn(() => []),
    prepareTaskPage: vi.fn(async () => {}),
    closeTaskPages: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
  };
}
