// A no-op BrowserController for bridge tests: the real runTask opens/closes
// its tab against this stub while scripted model streams drive the loop.

import { vi } from 'vitest';

import type { BrowserController } from '../../src/browser/controller.js';

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
    close: vi.fn(async () => {}),
  };
}
