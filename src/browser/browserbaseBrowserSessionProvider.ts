/**
 * Browserbase browser sessions.
 *
 * The remote half of {@link BrowserSessionProvider}. A session here is a
 * Browserbase-hosted Chrome reached over CDP, wrapped in the SAME
 * {@link PlaywrightBrowserController} a local Chrome gets — the tool registry,
 * worker protocol, prompt prefix, output contracts, and artifact provenance
 * model are all unaffected by where the browser runs.
 *
 * What this module owns that a local launch does not need:
 *
 * - a remote lifecycle: create, connect, heartbeat, disconnect, and an
 *   explicit release so a billable session never outlives the run. Every exit
 *   path — success, CDP failure, controller-init failure, cancellation — ends
 *   the session;
 * - a download path, because the file lands inside the remote container (see
 *   `browserbaseDownloads.ts`);
 * - observability that does not leak the connection URL: the session id, Live
 *   View URL, and recording URL travel as {@link BrowserSessionDiagnostics},
 *   while `connectUrl` never leaves this module.
 *
 * Browser scripts are deliberately unsupported on this provider: no `cdpUrl`
 * is passed to the controller, so `prepareForBrowserScript` /
 * `refreshAfterBrowserScript` are both absent and the run omits that tool
 * rather than offering one that would need a remote session-control URL in a
 * model-generated shell. See `docs/browserbase-provider-plan.md` §6 for the
 * loopback-relay design that would restore it. Ordinary `bash` in
 * `scratch/workspace/` is unaffected.
 */
import Browserbase from '@browserbasehq/sdk';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';

import type { BrowserController } from './controller.js';
import {
  createBrowserbaseDownloadReader,
  type BrowserbaseDownloadReaderHandle,
} from './browserbaseDownloads.js';
import {
  withBrowserbaseRetry,
  type BrowserbaseRetryOptions,
} from './browserbaseRetry.js';
import {
  PlaywrightBrowserController,
  prepareSessionPage,
} from './playwrightBrowserController.js';
import type {
  BrowserSessionDiagnostics,
  BrowserSessionProvider,
} from './sessionProvider.js';
import { remoteUploadEncoder } from './uploadEncoder.js';

/**
 * How often a keep-alive CDP command is sent.
 *
 * Browserbase ends a session after ten minutes with no CDP traffic. An agent
 * turn can legitimately spend longer than that thinking, reading a large
 * artifact, or running a `bash` step, all without touching the browser — so
 * liveness cannot be left to incidental traffic. Two minutes is far enough
 * inside the limit to survive a slow round trip and costs one trivial command
 * per interval.
 */
const HEARTBEAT_INTERVAL_MS = 120_000;

/** Where a human watches or reviews a session. Live View comes from the API;
 * this is the durable inspector page for after the fact. */
const SESSION_INSPECTOR_BASE_URL = 'https://browserbase.com/sessions';

/** Configuration for Browserbase-hosted browser sessions. */
export interface BrowserbaseBrowserSessionOptions {
  /** Browserbase API key. Never logged, never placed in an error message, and
   * never exported into a child process environment (see
   * `BASH_SECRET_ENV_DENYLIST`). */
  apiKey: string;
  /**
   * Browserbase Context to open the session with. Present for the
   * authenticated lane, where Google/X sessions live; absent for ordinary
   * trials, which must be isolated from one another.
   */
  contextId?: string;
  /**
   * Whether to write this session's cookies and storage back into the Context
   * when it closes. Only the login flow and the authenticated lane want this;
   * a normal trial persisting into the shared Context would let one task's
   * state bleed into the next.
   */
  persistContext?: boolean;
  /** Session recording; on by default, per the project's decision to record
   * every Browserbase session. */
  recordSession?: boolean;
  /** Fetch the Live View URL at session creation. On for interactive runtimes,
   * where a human may need to take over; off for the eval normal lane, where
   * nobody is watching and it is one API call per trial. */
  liveView?: boolean;
  /**
   * Ask Browserbase to keep the session alive across CDP disconnects.
   *
   * Off by default and deliberately so: it requires a Hobby-or-above plan, and
   * a session that survives disconnection is a session that can bill after the
   * run that owned it is gone. When it IS enabled, close() still issues an
   * explicit release.
   */
  keepAlive?: boolean;
  /** Seconds before Browserbase ends the session on its own; omitted means the
   * project's configured default. */
  timeoutSeconds?: number;
  /** Region to run in; omitted means the project's default. */
  region?: 'us-west-2' | 'us-east-1' | 'eu-central-1' | 'ap-southeast-1';
  /** Browserbase proxy configuration. Left unset until a measured need — a
   * proxy changes the IP a login target sees, which is the variable the POC
   * acceptance check exists to measure. */
  proxies?: boolean;
  /** Arbitrary correlation metadata attached to the remote session. */
  userMetadata?: Record<string, unknown>;
  /** Receives operator-facing warnings (retries, cleanup failures). Never
   * receives the API key or the connection URL. */
  onWarning?: (message: string) => void;
  /** Test seams. */
  client?: BrowserbaseClient;
  connectOverCDP?: (connectUrl: string) => Promise<Browser>;
  fetchImpl?: typeof fetch;
  setInterval?: (callback: () => void, milliseconds: number) => NodeJS.Timeout;
  clearInterval?: (handle: NodeJS.Timeout) => void;
  /** Test seam for the wait between retried Browserbase calls. Without it a
   * test that simulates a retryable failure sleeps for real. */
  sleep?: (milliseconds: number) => Promise<void>;
}

/**
 * The slice of the Browserbase SDK this provider uses.
 *
 * Named as its own interface so tests inject a fake without constructing a
 * real client (which would read an ambient `BROWSERBASE_API_KEY` and could
 * reach the network). Structural, so the real SDK client satisfies it.
 */
export interface BrowserbaseClient {
  sessions: {
    create(params: {
      projectId?: string;
      keepAlive?: boolean;
      region?: string;
      api_timeout?: number;
      proxies?: boolean;
      userMetadata?: Record<string, unknown>;
      browserSettings?: {
        recordSession?: boolean;
        context?: { id: string; persist?: boolean };
      };
    }): Promise<{ id: string; connectUrl: string }>;
    update(id: string, params: { status: 'REQUEST_RELEASE' }): Promise<unknown>;
    debug(id: string): Promise<{ debuggerFullscreenUrl?: string }>;
  };
  contexts: {
    create(params?: Record<string, unknown>): Promise<{ id: string }>;
    /** Optional because only the live smoke test uses it, to clean up the
     * throwaway Context its persistence fixture creates. Required here would
     * force every test fake to stub a method the provider never calls. */
    delete?(id: string): Promise<unknown>;
  };
}

/**
 * Reject an absent or blank API key before any network call.
 *
 * @throws Error naming the variable and the provider, and NEVER echoing the
 *   value — a startup error is printed to a terminal and often pasted into a
 *   bug report
 */
export function requireBrowserbaseApiKey(
  env: Record<string, string | undefined> = process.env,
): string {
  const key = env.BROWSERBASE_API_KEY;
  if (key === undefined || key.trim() === '') {
    throw new Error(
      'SHERLOCK_BROWSER_PROVIDER=browserbase needs BROWSERBASE_API_KEY, which is not set. ' +
        'Put it in your .env, or set SHERLOCK_BROWSER_PROVIDER=local to use local Chrome.',
    );
  }
  return key;
}

/** Create the SDK client with retries disabled — `browserbaseRetry.ts` owns
 * the one retry policy, so a 429 is not retried twice at two different
 * layers with two different budgets. */
export function createBrowserbaseClient(apiKey: string): BrowserbaseClient {
  return new Browserbase({ apiKey, maxRetries: 0 }) as unknown as BrowserbaseClient;
}

/**
 * A live Browserbase session with the Playwright objects attached to it.
 * Returned by {@link BrowserbaseBrowserSessionProvider.createRawSession} for
 * the login and probe flows, which drive raw pages rather than the controller.
 */
export interface BrowserbaseRawSession {
  sessionId: string;
  browser: Browser;
  /** Browserbase's default context — the one the remote Chrome already has. */
  context: BrowserContext;
  /** The blank page `prepareSessionPage` left open; excluded from the
   * controller's page registry for the session's whole life. */
  sessionPage: Page;
  diagnostics: BrowserSessionDiagnostics;
  /** Disconnect, stop the heartbeat, and release the remote session. Safe to
   * call more than once. */
  close(): Promise<void>;
}

/** Creates Browserbase-hosted sessions controlled through Playwright. */
export class BrowserbaseBrowserSessionProvider implements BrowserSessionProvider {
  private readonly client: BrowserbaseClient;
  private readonly connect: (connectUrl: string) => Promise<Browser>;
  private readonly startInterval: (
    callback: () => void,
    milliseconds: number,
  ) => NodeJS.Timeout;
  private readonly stopInterval: (handle: NodeJS.Timeout) => void;
  private readonly warn: (message: string) => void;
  /** One retry policy for every Browserbase call this provider makes, so a
   * warning stream and a test's fake clock apply uniformly. */
  private readonly retryOptions: BrowserbaseRetryOptions;

  constructor(private readonly options: BrowserbaseBrowserSessionOptions) {
    if (options.apiKey.trim() === '') {
      throw new Error('BrowserbaseBrowserSessionProvider requires a non-empty apiKey.');
    }
    this.client = options.client ?? createBrowserbaseClient(options.apiKey);
    this.connect =
      options.connectOverCDP ?? ((connectUrl: string) => chromium.connectOverCDP(connectUrl));
    this.startInterval = options.setInterval ?? ((cb, ms) => setInterval(cb, ms));
    this.stopInterval = options.clearInterval ?? ((handle) => clearInterval(handle));
    this.warn = options.onWarning ?? ((message: string) => console.warn(message));
    this.retryOptions = {
      onRetry: this.warn,
      ...(options.sleep === undefined ? {} : { sleep: options.sleep }),
    };
  }

  /**
   * Create a session and return its raw Playwright objects.
   *
   * For the login and login-probe flows, which navigate pages directly and
   * have no use for a controller. Ordinary runs use {@link createSession}.
   *
   * @returns the connected browser, Browserbase's default context, the
   *   user-facing diagnostics, and a close that releases the remote session
   * @throws Error when the session cannot be created or connected; the remote
   *   session is released first, so a failure here never leaves one billing
   */
  async createRawSession(): Promise<BrowserbaseRawSession> {
    const session = await withBrowserbaseRetry(
      'create session',
      () =>
        this.client.sessions.create({
          browserSettings: {
            recordSession: this.options.recordSession ?? true,
            ...(this.options.contextId === undefined
              ? {}
              : {
                  context: {
                    id: this.options.contextId,
                    persist: this.options.persistContext ?? false,
                  },
                }),
          },
          ...(this.options.keepAlive === undefined ? {} : { keepAlive: this.options.keepAlive }),
          ...(this.options.region === undefined ? {} : { region: this.options.region }),
          ...(this.options.timeoutSeconds === undefined
            ? {}
            : { api_timeout: this.options.timeoutSeconds }),
          ...(this.options.proxies === undefined ? {} : { proxies: this.options.proxies }),
          ...(this.options.userMetadata === undefined
            ? {}
            : { userMetadata: this.options.userMetadata }),
        }),
      this.retryOptions,
    );

    // From here on the session exists and is billable, so EVERY failure path
    // must run releaseSession. The connection URL stays in this scope: it is
    // handed to Playwright and to nothing else, and is deliberately absent
    // from every error message below.
    let browser: Browser;
    try {
      browser = await this.connect(session.connectUrl);
    } catch (error) {
      await this.releaseSession(session.id);
      throw new Error(
        `could not connect to the Browserbase session ${session.id}: ${errorMessage(error)}`,
        { cause: error },
      );
    }

    let heartbeat: NodeJS.Timeout | undefined;
    let closed = false;
    const close = async (): Promise<void> => {
      if (closed) return;
      closed = true;
      if (heartbeat !== undefined) this.stopInterval(heartbeat);
      try {
        // Disconnects this CDP client; without keepAlive it also ends the
        // remote session. The explicit release below is what makes that
        // guarantee independent of the plan tier.
        await browser.close();
      } catch (error) {
        this.warn(`warning: could not disconnect from Browserbase session ${session.id}: ${errorMessage(error)}`);
      }
      await this.releaseSession(session.id);
    };

    try {
      const context = browser.contexts()[0];
      if (context === undefined) {
        throw new Error('the connected Browserbase browser exposed no default context');
      }
      const sessionPage = await prepareSessionPage(context);

      // One long-lived CDP session on the session page — never a task tab, so
      // nothing here can disturb refs or observations the model is holding.
      // It carries both the download configuration and the heartbeat.
      const cdp = await context.newCDPSession(sessionPage);
      await cdp.send('Browser.setDownloadBehavior', {
        behavior: 'allow',
        // Must be the literal relative directory Browserbase expects, not an
        // absolute path: it is a path inside the remote container, and only
        // files under it are exposed through the Downloads API.
        downloadPath: 'downloads',
        eventsEnabled: true,
      });

      heartbeat = this.startInterval(() => {
        // Any CDP command resets the inactivity timer; getVersion is the
        // cheapest one that touches no page. Best-effort: if the session is
        // already gone, the controller's next operation reports it as browser
        // death and the TUI relaunches — a rejected heartbeat must not become
        // an unhandled rejection.
        void cdp.send('Browser.getVersion').catch(() => undefined);
      }, HEARTBEAT_INTERVAL_MS);

      const diagnostics = await this.buildDiagnostics(session.id);
      return { sessionId: session.id, browser, context, sessionPage, diagnostics, close };
    } catch (error) {
      // Controller/download/heartbeat setup failed after connecting. Tear the
      // whole thing down rather than returning a half-built session.
      await close();
      throw error;
    }
  }

  async createSession(): Promise<BrowserController> {
    const raw = await this.createRawSession();
    let downloadReader: BrowserbaseDownloadReaderHandle;
    try {
      downloadReader = createBrowserbaseDownloadReader({
        apiKey: this.options.apiKey,
        sessionId: raw.sessionId,
        ...(this.options.fetchImpl === undefined ? {} : { fetchImpl: this.options.fetchImpl }),
        onWarning: this.warn,
      });
      return new PlaywrightBrowserController({
        context: raw.context,
        // No cdpUrl on purpose — see this module's header.
        preexistingSessionPage: raw.sessionPage,
        closeSession: () => raw.close(),
        downloadReader,
        // The remote browser cannot read this filesystem, so an upload has to
        // travel as bytes rather than as a path Playwright would otherwise
        // send verbatim over CDP. See uploadEncoder.ts.
        uploadEncoder: remoteUploadEncoder,
        sessionDiagnostics: raw.diagnostics,
      });
    } catch (error) {
      await raw.close();
      throw error;
    }
  }

  /** Live View plus the durable inspector link. A Live View lookup failure is
   * not fatal: it costs a human the takeover link, not the run. */
  private async buildDiagnostics(sessionId: string): Promise<BrowserSessionDiagnostics> {
    const diagnostics: BrowserSessionDiagnostics = {
      provider: 'browserbase',
      sessionId,
      recordingUrl: `${SESSION_INSPECTOR_BASE_URL}/${sessionId}`,
    };
    if (this.options.liveView === false) return diagnostics;

    try {
      const urls = await withBrowserbaseRetry(
        'live view',
        () => this.client.sessions.debug(sessionId),
        this.retryOptions,
      );
      if (urls.debuggerFullscreenUrl !== undefined) {
        return { ...diagnostics, liveViewUrl: urls.debuggerFullscreenUrl };
      }
    } catch (error) {
      this.warn(
        `warning: could not fetch the Browserbase Live View URL for ${sessionId}: ${errorMessage(error)}`,
      );
    }
    return diagnostics;
  }

  /**
   * Ask Browserbase to end the session now.
   *
   * Always attempted, even without `keepAlive`, because this is the only step
   * that makes "no session outlives its run" true independently of how the
   * disconnect went. Tolerant of failure: a session already COMPLETED rejects
   * this, and that rejection means the desired state already holds.
   */
  private async releaseSession(sessionId: string): Promise<void> {
    try {
      await this.client.sessions.update(sessionId, { status: 'REQUEST_RELEASE' });
    } catch {
      // Already ended, or the release raced the disconnect. Either way the
      // session is not left running by this path.
    }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
