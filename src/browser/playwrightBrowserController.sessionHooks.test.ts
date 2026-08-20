import { describe, expect, it, vi } from 'vitest';
import type { BrowserContext } from 'playwright';

import { isBrowserDeathMessage } from '../tui/bridge/runSession.js';
import { PlaywrightBrowserController } from './playwrightBrowserController.js';
import type { BrowserSessionDiagnostics } from './sessionProvider.js';

/**
 * Pins the injected-seam contract of {@link PlaywrightBrowserController}
 * WITHOUT a real browser: no Chrome launch, no CDP connection, no network.
 * The controller only touches `context.on('page', ...)` in its constructor
 * and inventories `context.pages()` before `context.close()`/the injected
 * `closeSession` in `close()`, so a small contract-faithful fake is enough.
 */

function fakeContext(options: { connected?: boolean } = {}): {
  context: BrowserContext;
  listeners: Map<string, (...args: unknown[]) => void>;
  close: ReturnType<typeof vi.fn>;
} {
  const listeners = new Map<string, (...args: unknown[]) => void>();
  const close = vi.fn(async () => undefined);
  const context = {
    on: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
      listeners.set(event, listener);
    }),
    pages: vi.fn(() => []),
    close,
    // A locally launched persistent context returns null here; a
    // CDP-connected remote one returns the Browser. Both shapes matter.
    browser: () =>
      options.connected === undefined ? null : { isConnected: () => options.connected },
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

describe('PlaywrightBrowserController reporting of a session that ended on its own', () => {
  /** Drive any operation that goes through the open-context guard. */
  const attempt = async (context: BrowserContext): Promise<string> => {
    const controller = new PlaywrightBrowserController({ context });
    try {
      controller.currentUrl();
      return '(no error)';
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  };

  it('says the browser is disconnected, in words isBrowserDeathMessage recognizes', async () => {
    // The failure this prevents: a Browserbase session hits its own timeout,
    // and every later operation reports "No browser task page is active;
    // prepare the task page first." That reads as recoverable, so an agent
    // retries against a browser that is gone. The classifier link is the point of this
    // test: the wording alone is worthless if it does not route to relaunch.
    const message = await attempt(fakeContext({ connected: false }).context);

    expect(message).toMatch(/disconnected/i);
    expect(message).not.toMatch(/newTab/);
    expect(isBrowserDeathMessage(message)).toBe(true);
  });

  it('leaves a live remote session alone', async () => {
    const message = await attempt(fakeContext({ connected: true }).context);

    expect(isBrowserDeathMessage(message)).toBe(false);
  });

  it('is inert for a local persistent context, which exposes no browser', async () => {
    // context.browser() is null there, so the guard must not fire — a local
    // Chrome has no equivalent expire-underneath-you failure.
    const message = await attempt(fakeContext().context);

    expect(message).not.toMatch(/disconnected/i);
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
