import { describe, expect, it, vi } from 'vitest';
import type { Browser, BrowserContext, Page } from 'playwright';

import { PlaywrightBrowserController } from '../../src/browser/playwrightBrowserController.js';
import {
  BrowserbaseBrowserSessionProvider,
  requireBrowserbaseApiKey,
  type BrowserbaseBrowserSessionOptions,
  type BrowserbaseClient,
} from '../../src/browser/browserbaseBrowserSessionProvider.js';

/**
 * Hermetic tests for the Browserbase provider. No network, no real browser, no
 * real timers: the provider's test seams (`client`, `connectOverCDP`,
 * `setInterval`/`clearInterval`, `onWarning`) are all faked below, and the
 * fake Playwright `Browser`/`BrowserContext`/`Page`/`CDPSession` objects are
 * plain objects cast through `as unknown as X` — never a real Browserbase SDK
 * client and never `chromium.connectOverCDP`.
 */

const FAKE_API_KEY = 'test-api-key';
const FAKE_SESSION_ID = 'session-abc123';
/** Stands in for a real Browserbase `connectUrl`: a full session-control
 * capability that this module's header says must never leave it. Every test
 * that touches diagnostics or controller state asserts this string is absent
 * from what came back. */
const FAKE_CONNECT_URL = 'wss://connect.browserbase.com/v1/definitely-secret-connect-url';
const FAKE_LIVE_VIEW_URL = 'https://debug.browserbase.com/fullscreen/session-abc123';

function fakeCdpSession(sendImpl?: (method: string, params?: unknown) => Promise<unknown>) {
  return {
    send: vi.fn(sendImpl ?? (async () => ({}))),
    detach: vi.fn(async () => undefined),
  };
}

function fakeContext(options: {
  cdp?: ReturnType<typeof fakeCdpSession>;
} = {}): { context: BrowserContext; cdp: ReturnType<typeof fakeCdpSession>; page: Page } {
  // Already 'about:blank' so prepareSessionPage's extra goto never fires; a
  // fake page with no `goto` method would surface that as a loud failure.
  const page = {
    url: () => 'about:blank',
    isClosed: () => false,
  } as unknown as Page;
  const cdp = options.cdp ?? fakeCdpSession();
  const targetCdp = fakeCdpSession(async (method) => {
    if (method !== 'Target.getTargetInfo') return {};
    return {
      targetInfo: {
        targetId: 'fake-session-page-target',
        type: 'page',
        title: '',
        url: 'about:blank',
        attached: true,
        browserContextId: 'fake-browserbase-context',
      },
    };
  });
  let attachmentCount = 0;
  const context = {
    on: vi.fn(),
    pages: vi.fn(() => [page]),
    newPage: vi.fn(async () => page),
    newCDPSession: vi.fn(async () => {
      attachmentCount += 1;
      return attachmentCount === 1 ? cdp : targetCdp;
    }),
    close: vi.fn(async () => undefined),
  };
  return { context: context as unknown as BrowserContext, cdp, page };
}

function fakeBrowser(options: {
  contexts?: BrowserContext[];
  closeImpl?: () => Promise<void>;
} = {}): { browser: Browser; close: ReturnType<typeof vi.fn> } {
  const close = vi.fn(options.closeImpl ?? (async () => undefined));
  const browser = {
    contexts: vi.fn(() => options.contexts ?? []),
    close,
  };
  return { browser: browser as unknown as Browser, close };
}

function fakeClient(options: {
  createImpl?: BrowserbaseClient['sessions']['create'];
  updateImpl?: BrowserbaseClient['sessions']['update'];
  debugImpl?: BrowserbaseClient['sessions']['debug'];
} = {}): {
  client: BrowserbaseClient;
  create: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
  debug: ReturnType<typeof vi.fn>;
} {
  const create = vi.fn(
    options.createImpl ?? (async () => ({ id: FAKE_SESSION_ID, connectUrl: FAKE_CONNECT_URL })),
  );
  const update = vi.fn(options.updateImpl ?? (async () => undefined));
  const debug = vi.fn(
    options.debugImpl ?? (async () => ({ debuggerFullscreenUrl: FAKE_LIVE_VIEW_URL })),
  );
  const client: BrowserbaseClient = {
    sessions: { create, update, debug },
    contexts: {
      // Never called by this provider (see createRawSession); a call here
      // would mean a future change wired it up without this test noticing.
      create: vi.fn(async () => {
        throw new Error('contexts.create is not used by BrowserbaseBrowserSessionProvider');
      }),
    },
  };
  return { client, create, update, debug };
}

/** Fake `setInterval`/`clearInterval` seams. Real timers are never allowed:
 * every session-creating test injects these, so a leaked heartbeat interval
 * cannot keep the process alive after the test finishes. */
function fakeTimers(): {
  registered: Array<{ callback: () => void; ms: number }>;
  handle: NodeJS.Timeout;
  setIntervalSeam: BrowserbaseBrowserSessionOptions['setInterval'];
  clearIntervalSeam: ReturnType<typeof vi.fn<(handle: NodeJS.Timeout) => void>>;
} {
  const registered: Array<{ callback: () => void; ms: number }> = [];
  const handle = { fakeTimerHandle: true } as unknown as NodeJS.Timeout;
  const setIntervalSeam = vi.fn((callback: () => void, ms: number) => {
    registered.push({ callback, ms });
    return handle;
  });
  const clearIntervalSeam = vi.fn<(handle: NodeJS.Timeout) => void>();
  return { registered, handle, setIntervalSeam, clearIntervalSeam };
}

/** A provider wired with hermetic defaults; every field can be overridden. */
function buildProvider(
  overrides: Partial<BrowserbaseBrowserSessionOptions> & {
    client: BrowserbaseClient;
    connectOverCDP: (connectUrl: string) => Promise<Browser>;
  },
  timers: ReturnType<typeof fakeTimers> = fakeTimers(),
  warn: ReturnType<typeof vi.fn<(message: string) => void>> = vi.fn<(message: string) => void>(),
): BrowserbaseBrowserSessionProvider {
  return new BrowserbaseBrowserSessionProvider({
    apiKey: FAKE_API_KEY,
    setInterval: timers.setIntervalSeam,
    clearInterval: timers.clearIntervalSeam,
    onWarning: warn,
    ...overrides,
  });
}

describe('requireBrowserbaseApiKey', () => {
  it('throws when the variable is missing', () => {
    expect(() => requireBrowserbaseApiKey({})).toThrow();
  });

  it('throws when the variable is whitespace-only', () => {
    expect(() => requireBrowserbaseApiKey({ BROWSERBASE_API_KEY: '   ' })).toThrow();
  });

  it('names BROWSERBASE_API_KEY and SHERLOCK_BROWSER_PROVIDER in the message', () => {
    expect(() => requireBrowserbaseApiKey({})).toThrow(/BROWSERBASE_API_KEY/);
    expect(() => requireBrowserbaseApiKey({})).toThrow(/SHERLOCK_BROWSER_PROVIDER/);
  });

  it('never echoes the key value when it is present but blank', () => {
    // A startup error is printed to a terminal and often pasted into a bug
    // report, so even a "blank" value must never round-trip into the message.
    const blankKey = '  \t  ';
    let message = '';
    try {
      requireBrowserbaseApiKey({ BROWSERBASE_API_KEY: blankKey });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).not.toBe('');
    expect(message).not.toContain(blankKey);
  });

  it('returns the key when set', () => {
    expect(requireBrowserbaseApiKey({ BROWSERBASE_API_KEY: 'sk-real-key' })).toBe('sk-real-key');
  });
});

describe('BrowserbaseBrowserSessionProvider.createSession happy path', () => {
  it('creates a session with recording on by default', async () => {
    const { client, create } = fakeClient();
    const { browser } = fakeBrowser({ contexts: [fakeContext().context] });
    const provider = buildProvider({ client, connectOverCDP: async () => browser });

    await provider.createSession();

    expect(create).toHaveBeenCalledTimes(1);
    const params = create.mock.calls[0]?.[0];
    expect(params.browserSettings.recordSession).toBe(true);
  });

  it('connects over CDP with the connectUrl the client returned', async () => {
    const { client } = fakeClient();
    const { browser } = fakeBrowser({ contexts: [fakeContext().context] });
    const connectOverCDP = vi.fn(async () => browser);
    const provider = buildProvider({ client, connectOverCDP });

    await provider.createSession();

    expect(connectOverCDP).toHaveBeenCalledWith(FAKE_CONNECT_URL);
  });

  it("prepares the default context's blank page and anchors both CDP capabilities on it", async () => {
    const { context, page } = fakeContext();
    const { client } = fakeClient();
    const { browser } = fakeBrowser({ contexts: [context] });
    const provider = buildProvider({ client, connectOverCDP: async () => browser });

    await provider.createSession();

    // The existing default page is reused, not replaced.
    expect(context.newPage).not.toHaveBeenCalled();
    expect(context.newCDPSession).toHaveBeenCalledWith(page);
    expect(context.newCDPSession).toHaveBeenCalledTimes(2);
  });

  it('sends Browser.setDownloadBehavior with exactly the expected params', async () => {
    const { context, cdp } = fakeContext();
    const { client } = fakeClient();
    const { browser } = fakeBrowser({ contexts: [context] });
    const provider = buildProvider({ client, connectOverCDP: async () => browser });

    await provider.createSession();

    expect(cdp.send).toHaveBeenCalledWith('Browser.setDownloadBehavior', {
      behavior: 'allow',
      downloadPath: 'downloads',
      eventsEnabled: true,
    });
  });

  it('returns a PlaywrightBrowserController', async () => {
    const { client } = fakeClient();
    const { browser } = fakeBrowser({ contexts: [fakeContext().context] });
    const provider = buildProvider({ client, connectOverCDP: async () => browser });

    const controller = await provider.createSession();

    expect(controller).toBeInstanceOf(PlaywrightBrowserController);
  });
});

describe('BrowserbaseBrowserSessionProvider diagnostics', () => {
  it('carries provider, session id, Live View URL, and recording URL', async () => {
    const { client } = fakeClient();
    const { browser } = fakeBrowser({ contexts: [fakeContext().context] });
    const provider = buildProvider({ client, connectOverCDP: async () => browser });

    const controller = await provider.createSession();

    expect(controller.sessionDiagnostics).toMatchObject({
      provider: 'browserbase',
      sessionId: FAKE_SESSION_ID,
      liveViewUrl: FAKE_LIVE_VIEW_URL,
    });
    expect(controller.sessionDiagnostics?.recordingUrl).toContain(FAKE_SESSION_ID);
  });

  it('never carries the connectUrl anywhere in diagnostics or controller state', async () => {
    const { client } = fakeClient();
    const { browser } = fakeBrowser({ contexts: [fakeContext().context] });
    const provider = buildProvider({ client, connectOverCDP: async () => browser });

    const controller = await provider.createSession();

    expect(JSON.stringify(controller.sessionDiagnostics)).not.toContain(FAKE_CONNECT_URL);
    // Cheap walk of the controller's own enumerable state: the connectUrl is
    // handed to Playwright's connectOverCDP and to nothing else (see this
    // module's header), so it must not survive anywhere reachable from here.
    expect(JSON.stringify(controller)).not.toContain(FAKE_CONNECT_URL);
  });
});

describe('BrowserbaseBrowserSessionProvider command-session support', () => {
  it('uses the provider-neutral command and reconciliation surface', async () => {
    const { client } = fakeClient();
    const { browser } = fakeBrowser({ contexts: [fakeContext().context] });
    const provider = buildProvider({ client, connectOverCDP: async () => browser });

    const controller = await provider.createSession();

    expect(typeof controller.openCommandSession).toBe('function');
    expect(typeof controller.refreshAfterExternalCommands).toBe('function');
  });
});

describe('BrowserbaseBrowserSessionProvider contextId / persistContext', () => {
  it('sends browserSettings.context with id and persist when contextId is given', async () => {
    const { client, create } = fakeClient();
    const { browser } = fakeBrowser({ contexts: [fakeContext().context] });
    const provider = buildProvider({
      client,
      connectOverCDP: async () => browser,
      contextId: 'ctx-123',
      persistContext: true,
    });

    await provider.createSession();

    const params = create.mock.calls[0]?.[0];
    expect(params.browserSettings.context).toEqual({ id: 'ctx-123', persist: true });
  });

  it('defaults persist to false when contextId is given without persistContext', async () => {
    const { client, create } = fakeClient();
    const { browser } = fakeBrowser({ contexts: [fakeContext().context] });
    const provider = buildProvider({
      client,
      connectOverCDP: async () => browser,
      contextId: 'ctx-123',
    });

    await provider.createSession();

    const params = create.mock.calls[0]?.[0];
    expect(params.browserSettings.context).toEqual({ id: 'ctx-123', persist: false });
  });

  it('omits browserSettings.context entirely when contextId is absent', async () => {
    const { client, create } = fakeClient();
    const { browser } = fakeBrowser({ contexts: [fakeContext().context] });
    const provider = buildProvider({ client, connectOverCDP: async () => browser });

    await provider.createSession();

    const params = create.mock.calls[0]?.[0];
    expect(params.browserSettings).not.toHaveProperty('context');
  });

  it('always sends an explicit api_timeout rather than inheriting the project default', async () => {
    const { client, create } = fakeClient();
    const { browser } = fakeBrowser({ contexts: [fakeContext().context] });
    const provider = buildProvider({ client, connectOverCDP: async () => browser });

    await provider.createSession();

    // Deferring to the project's dashboard `defaultTimeout` is how a session
    // ended up dying at 300s mid-run — shorter than an agent turn on a hard
    // task, and shorter than a human signing in through Live View. 1800s was
    // then measured to be too short as well: a mit_sororities trial was still
    // driving the browser at 30 minutes.
    const params = create.mock.calls[0]?.[0];
    expect(params.api_timeout).toBe(3_600);
  });

  it('lets a caller override the default session timeout', async () => {
    const { client, create } = fakeClient();
    const { browser } = fakeBrowser({ contexts: [fakeContext().context] });
    const provider = buildProvider({
      client,
      connectOverCDP: async () => browser,
      timeoutSeconds: 90,
    });

    await provider.createSession();

    const params = create.mock.calls[0]?.[0];
    expect(params.api_timeout).toBe(90);
  });
});

describe('BrowserbaseBrowserSessionProvider Live View', () => {
  it('liveView: false skips sessions.debug but still yields sessionId and recordingUrl', async () => {
    const { client, debug } = fakeClient();
    const { browser } = fakeBrowser({ contexts: [fakeContext().context] });
    const provider = buildProvider({
      client,
      connectOverCDP: async () => browser,
      liveView: false,
    });

    const controller = await provider.createSession();

    expect(debug).not.toHaveBeenCalled();
    expect(controller.sessionDiagnostics?.sessionId).toBe(FAKE_SESSION_ID);
    expect(controller.sessionDiagnostics?.recordingUrl).toBeDefined();
    expect(controller.sessionDiagnostics?.liveViewUrl).toBeUndefined();
  });

  it('a rejecting sessions.debug is non-fatal: session still comes back, no liveViewUrl, a warning fires', async () => {
    // Status 400 keeps this non-retryable (see browserbaseRetry.ts), so the
    // rejection surfaces on the first attempt with no real-timer backoff.
    const debugError = Object.assign(new Error('debug endpoint unavailable'), { status: 400 });
    const { client } = fakeClient({ debugImpl: async () => { throw debugError; } });
    const { browser } = fakeBrowser({ contexts: [fakeContext().context] });
    const warn = vi.fn<(message: string) => void>();
    const provider = buildProvider({ client, connectOverCDP: async () => browser }, fakeTimers(), warn);

    const controller = await provider.createSession();

    expect(controller.sessionDiagnostics?.sessionId).toBe(FAKE_SESSION_ID);
    expect(controller.sessionDiagnostics?.liveViewUrl).toBeUndefined();
    expect(warn).toHaveBeenCalled();
  });
});

describe('BrowserbaseBrowserSessionProvider partial-failure cleanup', () => {
  it('releases the session and propagates the error when connectOverCDP rejects', async () => {
    const { client, update } = fakeClient();
    const provider = buildProvider({
      client,
      connectOverCDP: async () => {
        throw new Error('cdp connect refused');
      },
    });

    await expect(provider.createSession()).rejects.toThrow(
      /could not connect to the Browserbase session/,
    );
    expect(update).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith(FAKE_SESSION_ID, { status: 'REQUEST_RELEASE' });
  });

  it('closes the browser, releases the session, and propagates when there is no default context', async () => {
    const { client, update } = fakeClient();
    const { browser, close } = fakeBrowser({ contexts: [] });
    const provider = buildProvider({ client, connectOverCDP: async () => browser });

    await expect(provider.createSession()).rejects.toThrow(/exposed no default context/);
    expect(close).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith(FAKE_SESSION_ID, { status: 'REQUEST_RELEASE' });
  });

  it('closes the browser, releases the session, and propagates when setDownloadBehavior rejects', async () => {
    const downloadError = new Error('setDownloadBehavior failed');
    const { cdp, context } = fakeContext({
      cdp: fakeCdpSession(async () => {
        throw downloadError;
      }),
    });
    const { client, update } = fakeClient();
    const { browser, close } = fakeBrowser({ contexts: [context] });
    const provider = buildProvider({ client, connectOverCDP: async () => browser });

    await expect(provider.createSession()).rejects.toThrow('setDownloadBehavior failed');
    expect(cdp.send).toHaveBeenCalled();
    expect(close).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith(FAKE_SESSION_ID, { status: 'REQUEST_RELEASE' });
  });
});

describe('BrowserbaseBrowserSessionProvider heartbeat', () => {
  it('registers an interval strictly under the 10-minute Browserbase timeout', async () => {
    const { client } = fakeClient();
    const { browser } = fakeBrowser({ contexts: [fakeContext().context] });
    const timers = fakeTimers();
    const provider = buildProvider({ client, connectOverCDP: async () => browser }, timers);

    await provider.createSession();

    expect(timers.registered).toHaveLength(1);
    // The constraint that matters is "well inside Browserbase's 10-minute
    // inactivity timeout," not any particular constant.
    expect(timers.registered[0]?.ms).toBeLessThan(600_000);
  });

  it('sends Browser.getVersion when the heartbeat callback fires', async () => {
    const { cdp, context } = fakeContext();
    const { client } = fakeClient();
    const { browser } = fakeBrowser({ contexts: [context] });
    const timers = fakeTimers();
    const provider = buildProvider({ client, connectOverCDP: async () => browser }, timers);

    await provider.createSession();
    cdp.send.mockClear();
    timers.registered[0]?.callback();
    await Promise.resolve();

    expect(cdp.send).toHaveBeenCalledWith('Browser.getVersion');
  });

  it('a rejecting Browser.getVersion does not produce an unhandled rejection', async () => {
    const cdp = fakeCdpSession(async (method) => {
      if (method === 'Browser.getVersion') throw new Error('session already gone');
      return {};
    });
    const { context } = fakeContext({ cdp });
    const { client } = fakeClient();
    const { browser } = fakeBrowser({ contexts: [context] });
    const timers = fakeTimers();
    const provider = buildProvider({ client, connectOverCDP: async () => browser }, timers);

    await provider.createSession();

    expect(() => timers.registered[0]?.callback()).not.toThrow();
    // Give the rejected promise's .catch(() => undefined) a turn to run.
    await Promise.resolve();
    await Promise.resolve();
  });

  it('close() clears the interval with the handle setInterval returned', async () => {
    const { client } = fakeClient();
    const { browser } = fakeBrowser({ contexts: [fakeContext().context] });
    const timers = fakeTimers();
    const provider = buildProvider({ client, connectOverCDP: async () => browser }, timers);

    const controller = await provider.createSession();
    await controller.close();

    expect(timers.clearIntervalSeam).toHaveBeenCalledWith(timers.handle);
  });
});

describe('BrowserbaseBrowserSessionProvider close', () => {
  it('clears the interval, closes the browser, and releases the session', async () => {
    const { client, update } = fakeClient();
    const { browser, close } = fakeBrowser({ contexts: [fakeContext().context] });
    const timers = fakeTimers();
    const provider = buildProvider({ client, connectOverCDP: async () => browser }, timers);

    const controller = await provider.createSession();
    await controller.close();

    expect(timers.clearIntervalSeam).toHaveBeenCalledWith(timers.handle);
    expect(close).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith(FAKE_SESSION_ID, { status: 'REQUEST_RELEASE' });
  });

  it('is idempotent: calling close() twice does everything exactly once', async () => {
    const { client, update } = fakeClient();
    const { browser, close } = fakeBrowser({ contexts: [fakeContext().context] });
    const timers = fakeTimers();
    const provider = buildProvider({ client, connectOverCDP: async () => browser }, timers);

    const controller = await provider.createSession();
    await controller.close();
    await controller.close();

    expect(timers.clearIntervalSeam).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledTimes(1);
  });

  it('still releases the session when browser.close() rejects', async () => {
    // The release is what guarantees no billable leak independently of
    // whether the disconnect itself succeeded.
    const { client, update } = fakeClient();
    const { browser, close } = fakeBrowser({
      contexts: [fakeContext().context],
      closeImpl: async () => {
        throw new Error('disconnect failed');
      },
    });
    const timers = fakeTimers();
    const warn = vi.fn<(message: string) => void>();
    const provider = buildProvider({ client, connectOverCDP: async () => browser }, timers, warn);

    const controller = await provider.createSession();
    await expect(controller.close()).resolves.toBeUndefined();

    expect(close).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith(FAKE_SESSION_ID, { status: 'REQUEST_RELEASE' });
    expect(warn).toHaveBeenCalled();
  });
});
