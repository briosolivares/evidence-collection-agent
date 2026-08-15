import { describe, expect, it, vi } from 'vitest';
import type { BrowserContext } from 'playwright';

import { PlaywrightBrowserController } from './playwrightBrowserController.js';
import type { BrowserSessionDiagnostics } from './sessionProvider.js';

/**
 * Pins the injected-seam contract of {@link PlaywrightBrowserController}
 * WITHOUT a real browser: no Chrome launch, no CDP connection, no network.
 * The controller only touches `context.on('page', ...)` in its constructor
 * and `context.close()`/the injected `closeSession` in `close()`, so a plain
 * object satisfies everything these tests exercise.
 */

function fakeContext(): { context: BrowserContext; listeners: Map<string, (...args: unknown[]) => void>; close: ReturnType<typeof vi.fn> } {
  const listeners = new Map<string, (...args: unknown[]) => void>();
  const close = vi.fn(async () => undefined);
  const context = {
    on: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
      listeners.set(event, listener);
    }),
    close,
  };
  return { context: context as unknown as BrowserContext, listeners, close };
}

describe('PlaywrightBrowserController close() session hooks', () => {
  it('default closeSession closes the injected context', async () => {
    const { context, close } = fakeContext();
    const controller = new PlaywrightBrowserController({ context });

    await controller.close();

    expect(close).toHaveBeenCalledTimes(1);
  });

  it('an injected closeSession is called instead of context.close()', async () => {
    // This is the seam that lets a remote provider release a billable
    // session rather than closing a local Playwright context.
    const { context, close } = fakeContext();
    const closeSession = vi.fn(async () => undefined);
    const controller = new PlaywrightBrowserController({ context, closeSession });

    await controller.close();

    expect(closeSession).toHaveBeenCalledTimes(1);
    expect(close).not.toHaveBeenCalled();
  });

  it('is idempotent: two calls invoke the closer exactly once', async () => {
    const { context } = fakeContext();
    const closeSession = vi.fn(async () => undefined);
    const controller = new PlaywrightBrowserController({ context, closeSession });

    await controller.close();
    await controller.close();

    expect(closeSession).toHaveBeenCalledTimes(1);
  });
});

describe('PlaywrightBrowserController browser-script support pairing', () => {
  it('offers both prepareForBrowserScript and refreshAfterBrowserScript when cdpUrl is a loopback URL', () => {
    const { context } = fakeContext();
    const controller = new PlaywrightBrowserController({
      context,
      cdpUrl: 'http://127.0.0.1:54213',
    });

    expect(typeof controller.prepareForBrowserScript).toBe('function');
    expect(typeof controller.refreshAfterBrowserScript).toBe('function');
  });

  it('offers neither when cdpUrl is absent', () => {
    const { context } = fakeContext();
    const controller = new PlaywrightBrowserController({ context });

    expect(controller.prepareForBrowserScript).toBeUndefined();
    expect(controller.refreshAfterBrowserScript).toBeUndefined();
  });

  it('throws in the constructor for a non-loopback cdpUrl', () => {
    // This is the invariant that stops a remote session-control URL (a full
    // takeover capability) from ever reaching model-generated shell code via
    // prepareForBrowserScript.
    const { context } = fakeContext();

    expect(
      () =>
        new PlaywrightBrowserController({
          context,
          cdpUrl: 'wss://connect.browserbase.com/session-abc123',
        }),
    ).toThrow();
  });
});

describe('PlaywrightBrowserController sessionDiagnostics', () => {
  it('is exactly what was injected', () => {
    const { context } = fakeContext();
    const diagnostics: BrowserSessionDiagnostics = {
      provider: 'browserbase',
      sessionId: 'session-abc123',
      recordingUrl: 'https://browserbase.com/sessions/session-abc123',
    };
    const controller = new PlaywrightBrowserController({ context, sessionDiagnostics: diagnostics });

    expect(controller.sessionDiagnostics).toBe(diagnostics);
  });

  it('is undefined when not injected', () => {
    const { context } = fakeContext();
    const controller = new PlaywrightBrowserController({ context });

    expect(controller.sessionDiagnostics).toBeUndefined();
  });
});
