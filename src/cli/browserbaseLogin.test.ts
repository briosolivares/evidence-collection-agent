import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { BrowserbaseClient } from '../browser/browserbaseBrowserSessionProvider.js';
import { ensureBrowserbaseContext, runBrowserbaseLogin } from './browserbaseLogin.js';
import type { LoginProbeSession, OpenLoginProbeSessionOptions } from './loginCheck.js';
import type { LoginService } from './loginProbe.js';

import type { BrowserContext, Page } from 'playwright';

/**
 * A `BrowserbaseClient` stub. `sessions` is never touched by
 * `ensureBrowserbaseContext` — only `contexts.create` is — so it throws if
 * anything ever reaches it, which would mean a test accidentally exercised
 * more of the client than it meant to.
 */
function fakeClient(overrides: Partial<BrowserbaseClient['contexts']> = {}): BrowserbaseClient {
  return {
    sessions: {
      create: () => {
        throw new Error('sessions.create should not be called by ensureBrowserbaseContext');
      },
      update: () => {
        throw new Error('sessions.update should not be called by ensureBrowserbaseContext');
      },
      debug: () => {
        throw new Error('sessions.debug should not be called by ensureBrowserbaseContext');
      },
    },
    contexts: {
      create: async () => ({ id: 'ctx_fallback' }),
      ...overrides,
    },
  };
}

describe('ensureBrowserbaseContext', () => {
  let dir: string;
  let envFilePath: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'evidence-agent-browserbase-login-test-'));
    envFilePath = join(dir, '.env');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('reuses an already-configured context: returns created: false, never calls contexts.create, never touches the env file', async () => {
    await writeFile(envFilePath, 'BROWSERBASE_API_KEY=key\n');
    const before = await stat(envFilePath);
    const beforeContents = await readFile(envFilePath, 'utf8');

    let createCalled = false;
    const client = fakeClient({
      create: async () => {
        createCalled = true;
        return { id: 'should-not-be-used' };
      },
    });
    const env = { BROWSERBASE_CONTEXT_ID: 'ctx_existing' };
    const logs: string[] = [];

    // Re-creating a Context every login would abandon the one holding the
    // working logins and produce a fresh, empty Context that looks exactly
    // like a login that failed to persist — so an already-configured id must
    // win outright, with no read-modify-write of the env file at all.
    const result = await ensureBrowserbaseContext({
      client,
      env,
      envFilePath,
      log: (message) => logs.push(message),
    });

    expect(result).toEqual({ contextId: 'ctx_existing', created: false });
    expect(createCalled).toBe(false);
    expect(await readFile(envFilePath, 'utf8')).toBe(beforeContents);
    const after = await stat(envFilePath);
    expect(after.mtimeMs).toBe(before.mtimeMs);
  });

  it('creates a context when none is configured: calls contexts.create, writes the id to the env file, and sets it on the env object in-process', async () => {
    const client = fakeClient({ create: async () => ({ id: 'ctx_new' }) });
    const env: Record<string, string | undefined> = {};
    const logs: string[] = [];

    const result = await ensureBrowserbaseContext({
      client,
      env,
      envFilePath,
      log: (message) => logs.push(message),
    });

    expect(result).toEqual({ contextId: 'ctx_new', created: true });
    expect(await readFile(envFilePath, 'utf8')).toBe('BROWSERBASE_CONTEXT_ID=ctx_new\n');
    // In-process too: the session opened moments later reads `env` directly,
    // and nothing re-reads the file in between.
    expect(env.BROWSERBASE_CONTEXT_ID).toBe('ctx_new');
  });

  it('propagates a rejecting contexts.create and writes nothing to the env file', async () => {
    const client = fakeClient({
      create: async () => {
        throw new Error('contexts.create failed');
      },
    });
    const env: Record<string, string | undefined> = {};

    await expect(
      ensureBrowserbaseContext({ client, env, envFilePath, log: () => {} }),
    ).rejects.toThrow('contexts.create failed');

    // No file at all — not an empty one, not a partial write.
    await expect(stat(envFilePath)).rejects.toThrow();
    expect(env.BROWSERBASE_CONTEXT_ID).toBeUndefined();
  });

  it('names the context id in its log output, for both the reused and created paths', async () => {
    const reusedLogs: string[] = [];
    await ensureBrowserbaseContext({
      client: fakeClient(),
      env: { BROWSERBASE_CONTEXT_ID: 'ctx_abc123' },
      envFilePath,
      log: (message) => reusedLogs.push(message),
    });
    expect(reusedLogs.some((line) => line.includes('ctx_abc123'))).toBe(true);

    const createdLogs: string[] = [];
    await ensureBrowserbaseContext({
      client: fakeClient({ create: async () => ({ id: 'ctx_xyz789' }) }),
      env: {},
      envFilePath: join(dir, 'other.env'),
      log: (message) => createdLogs.push(message),
    });
    expect(createdLogs.some((line) => line.includes('ctx_xyz789'))).toBe(true);
  });
});

// `runBrowserbaseLogin` now takes its session opener as a dependency
// (`BrowserbaseLoginDeps.openSession`, defaulting to the real
// `openLoginProbeSession`), so the whole sequence — provision a Context, open
// a persisting sign-in session, close it, reopen a read-only one, probe it —
// is exercisable hermetically: every fake session below is a plain object,
// never a real browser or a real Browserbase session.

/** A minimal page: `goto` records nothing by default and `url()` reports a
 * fixed landing URL, which is all `probeService`/`settleProbe` read. Real
 * `waitForTimeout` sleeps a wall-clock delay; this fake resolves immediately
 * so `settleProbe`'s confirmation re-check costs nothing in test time. */
function fakePage(url = 'https://example.test/'): Page {
  return {
    goto: async () => undefined,
    url: () => url,
    waitForTimeout: async () => undefined,
    close: async () => undefined,
  } as unknown as Page;
}

/** A context with no pre-opened tabs, whose `newPage()` always lands on
 * `url`. Good enough for every case that does not care what a page shows —
 * an empty `services` list, or a verdict driven by the OTHER session. */
function fakeContext(url?: string): BrowserContext {
  return {
    pages: () => [],
    newPage: async () => fakePage(url),
  } as unknown as BrowserContext;
}

/** Wraps a fake `context`/`close` pair into the shape `openLoginProbeSession`
 * returns, so every test constructs a `LoginProbeSession` the same way the
 * real seam would hand one back. */
function fakeSession(overrides: {
  context: BrowserContext;
  close: () => Promise<void>;
  sessionId?: string;
  liveViewUrl?: string;
}): LoginProbeSession {
  return {
    context: overrides.context,
    provider: 'browserbase',
    ...(overrides.sessionId === undefined ? {} : { sessionId: overrides.sessionId }),
    ...(overrides.liveViewUrl === undefined ? {} : { liveViewUrl: overrides.liveViewUrl }),
    close: overrides.close,
  };
}

/** A service whose `classify` ignores its `url` argument and always returns
 * `verdict`, but records `'probe'` into `events` the first time it runs.
 * `settleProbe` calls `classify` twice (an initial read, then a confirmation
 * re-check); the guard keeps that from looking like two separate probes. */
function probeMarkerService(events: string[], verdict: 'logged-in' | 'logged-out'): LoginService {
  let recorded = false;
  return {
    id: 'x',
    name: 'Marker service',
    probeUrl: 'https://example.test/probe',
    classify: () => {
      if (!recorded) {
        recorded = true;
        events.push('probe');
      }
      return verdict;
    },
  };
}

/** A service whose verdict is read from the URL a fake page reports —
 * `fakeContext(landingUrl)` controls that — so a test can give the sign-in
 * and verification sessions different, independently controlled verdicts. */
const VERDICT_SERVICE: LoginService = {
  id: 'x',
  name: 'Verdict service',
  probeUrl: 'https://example.test/probe',
  classify: (url) => {
    if (url.includes('SIGNED_IN')) return 'logged-in';
    if (url.includes('SIGNED_OUT')) return 'logged-out';
    return 'pending';
  },
};

describe('runBrowserbaseLogin', () => {
  let dir: string;
  let envFilePath: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'evidence-agent-browserbase-login-test-'));
    envFilePath = join(dir, '.env');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('opens persist, waits for the operator, closes, sleeps, reopens read-only, then probes — in that exact order', async () => {
    const events: string[] = [];
    let openCalls = 0;

    const openSession = async (options: OpenLoginProbeSessionOptions): Promise<LoginProbeSession> => {
      openCalls += 1;
      if (options.persistContext === true) {
        events.push('open:persist');
        return fakeSession({
          context: fakeContext(),
          liveViewUrl: 'https://browserbase.example/live/1',
          close: async () => {
            events.push('close:1');
          },
        });
      }
      events.push('open:read');
      return fakeSession({
        context: fakeContext(),
        close: async () => {
          events.push('close:2');
        },
      });
    };

    const result = await runBrowserbaseLogin({
      services: [probeMarkerService(events, 'logged-in')],
      envFilePath,
      env: { BROWSERBASE_CONTEXT_ID: 'ctx-existing' },
      client: fakeClient(),
      openSession,
      log: () => {},
      waitForOperator: async () => {
        events.push('wait-for-operator');
      },
      sleep: async () => {
        events.push('sleep');
      },
      openInBrowser: () => {},
    });

    // The close is what commits the Context, and the reopen is the only real
    // evidence the sign-in persisted. If the reopen ever raced ahead of the
    // close — or the probe ran before the reopen — this command would start
    // reporting a login as verified when it never actually re-read anything.
    expect(events).toEqual([
      'open:persist',
      'wait-for-operator',
      'close:1',
      'sleep',
      'open:read',
      'probe',
      'close:2',
    ]);
    expect(openCalls).toBe(2);
    expect(result).toBe(true);
  });

  it('returns false when only the sign-in session looks logged in — the verdict comes from the reopened session, not the one the operator used', async () => {
    const openSession = async (options: OpenLoginProbeSessionOptions): Promise<LoginProbeSession> =>
      options.persistContext === true
        ? fakeSession({
            context: fakeContext('https://example.test/SIGNED_IN'),
            liveViewUrl: 'https://browserbase.example/live/1',
            close: async () => undefined,
          })
        : fakeSession({ context: fakeContext('https://example.test/SIGNED_OUT'), close: async () => undefined });

    const result = await runBrowserbaseLogin({
      services: [VERDICT_SERVICE],
      envFilePath,
      env: { BROWSERBASE_CONTEXT_ID: 'ctx' },
      client: fakeClient(),
      openSession,
      log: () => {},
      waitForOperator: async () => {},
      sleep: async () => {},
      openInBrowser: () => {},
    });

    expect(result).toBe(false);
  });

  it('returns true when the reopened session verifies the login, even though the sign-in session looked signed out', async () => {
    const openSession = async (options: OpenLoginProbeSessionOptions): Promise<LoginProbeSession> =>
      options.persistContext === true
        ? fakeSession({
            context: fakeContext('https://example.test/SIGNED_OUT'),
            liveViewUrl: 'https://browserbase.example/live/1',
            close: async () => undefined,
          })
        : fakeSession({ context: fakeContext('https://example.test/SIGNED_IN'), close: async () => undefined });

    const result = await runBrowserbaseLogin({
      services: [VERDICT_SERVICE],
      envFilePath,
      env: { BROWSERBASE_CONTEXT_ID: 'ctx' },
      client: fakeClient(),
      openSession,
      log: () => {},
      waitForOperator: async () => {},
      sleep: async () => {},
      openInBrowser: () => {},
    });

    expect(result).toBe(true);
  });

  it('provisions a Context and saves it before the very first openSession call', async () => {
    const client = fakeClient({ create: async () => ({ id: 'ctx-new' }) });
    const env: Record<string, string | undefined> = {};
    let envFileContentsAtFirstOpen: string | undefined;

    const openSession = async (options: OpenLoginProbeSessionOptions): Promise<LoginProbeSession> => {
      envFileContentsAtFirstOpen ??= readFileSync(envFilePath, 'utf8');
      return options.persistContext === true
        ? fakeSession({ context: fakeContext(), liveViewUrl: 'https://live/1', close: async () => undefined })
        : fakeSession({ context: fakeContext(), close: async () => undefined });
    };

    await runBrowserbaseLogin({
      services: [],
      envFilePath,
      env,
      client,
      openSession,
      log: () => {},
      waitForOperator: async () => {},
      sleep: async () => {},
      openInBrowser: () => {},
    });

    expect(envFileContentsAtFirstOpen).toBe('BROWSERBASE_CONTEXT_ID=ctx-new\n');
    expect(env.BROWSERBASE_CONTEXT_ID).toBe('ctx-new');
  });

  it('hands the Live View URL to both waitForOperator and openInBrowser', async () => {
    const liveViewUrl = 'https://browserbase.example/live/abc';
    let waitForOperatorArg: string | undefined;
    let openInBrowserArg: string | undefined;

    const openSession = async (options: OpenLoginProbeSessionOptions): Promise<LoginProbeSession> =>
      options.persistContext === true
        ? fakeSession({ context: fakeContext(), liveViewUrl, close: async () => undefined })
        : fakeSession({ context: fakeContext(), close: async () => undefined });

    await runBrowserbaseLogin({
      services: [],
      envFilePath,
      env: { BROWSERBASE_CONTEXT_ID: 'ctx' },
      client: fakeClient(),
      openSession,
      log: () => {},
      waitForOperator: async (url) => {
        waitForOperatorArg = url;
      },
      sleep: async () => {},
      openInBrowser: (url) => {
        openInBrowserArg = url;
      },
    });

    expect(waitForOperatorArg).toBe(liveViewUrl);
    expect(openInBrowserArg).toBe(liveViewUrl);
  });

  it('returns false, never calls waitForOperator, and still closes the session when there is no Live View URL to sign in through', async () => {
    let closed = false;
    let waitForOperatorCalled = false;

    const openSession = async (options: OpenLoginProbeSessionOptions): Promise<LoginProbeSession> => {
      if (options.persistContext === true) {
        // liveViewUrl omitted on purpose: nothing for a human to sign in through.
        return fakeSession({
          context: fakeContext(),
          close: async () => {
            closed = true;
          },
        });
      }
      throw new Error('the verification session must never open when sign-in never happened');
    };

    const result = await runBrowserbaseLogin({
      services: [],
      envFilePath,
      env: { BROWSERBASE_CONTEXT_ID: 'ctx' },
      client: fakeClient(),
      openSession,
      log: () => {},
      waitForOperator: async () => {
        waitForOperatorCalled = true;
      },
      sleep: async () => {},
      openInBrowser: () => {},
    });

    expect(result).toBe(false);
    expect(waitForOperatorCalled).toBe(false);
    expect(closed).toBe(true);
  });

  it('closes the sign-in session even when a per-service navigation rejects, and still completes the run', async () => {
    let closed = false;
    const rejectingContext: BrowserContext = {
      pages: () => [],
      newPage: async () => ({
        goto: async () => {
          throw new Error('navigation failed');
        },
        url: () => 'about:blank',
        waitForTimeout: async () => undefined,
        close: async () => undefined,
      }),
    } as unknown as BrowserContext;

    const openSession = async (options: OpenLoginProbeSessionOptions): Promise<LoginProbeSession> =>
      options.persistContext === true
        ? fakeSession({
            context: rejectingContext,
            liveViewUrl: 'https://live/1',
            close: async () => {
              closed = true;
            },
          })
        : fakeSession({ context: fakeContext(), close: async () => undefined });

    // A rejecting per-service navigation is already swallowed internally (the
    // `.catch(() => undefined)` around each `page.goto` in production), so
    // this run reaches the end normally rather than throwing.
    const result = await runBrowserbaseLogin({
      services: [{ id: 'x', name: 'Test', probeUrl: 'https://example.test/probe', classify: () => 'logged-in' }],
      envFilePath,
      env: { BROWSERBASE_CONTEXT_ID: 'ctx' },
      client: fakeClient(),
      openSession,
      log: () => {},
      waitForOperator: async () => {},
      sleep: async () => {},
      openInBrowser: () => {},
    });

    expect(closed).toBe(true);
    expect(result).toBe(true);
  });

  it('closes the sign-in session even when waitForOperator throws, and lets that error propagate — a leaked billable session is the worse failure', async () => {
    let closed = false;

    const openSession = async (options: OpenLoginProbeSessionOptions): Promise<LoginProbeSession> =>
      options.persistContext === true
        ? fakeSession({
            context: fakeContext(),
            liveViewUrl: 'https://live/1',
            close: async () => {
              closed = true;
            },
          })
        : fakeSession({ context: fakeContext(), close: async () => undefined });

    await expect(
      runBrowserbaseLogin({
        services: [],
        envFilePath,
        env: { BROWSERBASE_CONTEXT_ID: 'ctx' },
        client: fakeClient(),
        openSession,
        log: () => {},
        waitForOperator: async () => {
          throw new Error('operator prompt failed');
        },
        sleep: async () => {},
        openInBrowser: () => {},
      }),
    ).rejects.toThrow('operator prompt failed');

    expect(closed).toBe(true);
  });

  it('waits before reopening the Context, with a delay greater than zero, so Browserbase has time to persist it', async () => {
    let sleepMs: number | undefined;

    const openSession = async (options: OpenLoginProbeSessionOptions): Promise<LoginProbeSession> =>
      options.persistContext === true
        ? fakeSession({ context: fakeContext(), liveViewUrl: 'https://live/1', close: async () => undefined })
        : fakeSession({ context: fakeContext(), close: async () => undefined });

    await runBrowserbaseLogin({
      services: [],
      envFilePath,
      env: { BROWSERBASE_CONTEXT_ID: 'ctx' },
      client: fakeClient(),
      openSession,
      log: () => {},
      waitForOperator: async () => {},
      sleep: async (ms) => {
        sleepMs = ms;
      },
      openInBrowser: () => {},
    });

    expect(sleepMs).toBeGreaterThan(0);
  });
});
