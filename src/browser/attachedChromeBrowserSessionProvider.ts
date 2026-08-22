/**
 * Attached-local Chrome provider.
 *
 * This provider joins an already-running, user-owned Chrome over a resolved
 * loopback DevTools endpoint. Ownership is intentionally narrow:
 * Sherlock owns only its Playwright client and pages it creates after the
 * controller is constructed. It never closes the attached context, browser,
 * or pages that were already open when it connected.
 *
 * Discovery and the chrome://inspect permission flow belong above this seam.
 * This module accepts a resolved endpoint only and never returns or reports
 * that session-control capability.
 */

import { chromium, type Browser } from 'playwright';

import type { BrowserController } from './controller.js';
import { assertLoopbackCdpUrl } from './cdpEndpoint.js';
import { createChromiumTargetControl } from './chromiumTargetControl.js';
import { assembleBrowserController } from './controllerAssembly.js';
import { PlaywrightBrowserController } from './playwrightBrowserController.js';
import { openScopedCdpProxy, type ScopedCdpProxy, ScopedCdpProxyError } from './scopedCdpProxy.js';
import type { BrowserSessionDiagnostics, BrowserSessionProvider } from './sessionProvider.js';

const ATTACHED_SESSION_DIAGNOSTICS = Object.freeze({
  provider: 'local',
}) satisfies BrowserSessionDiagnostics;

const DEFAULT_CONNECTION_TIMEOUT_MS = 30_000;

/** Dependencies and resolved configuration for one attached-local provider. */
export interface AttachedChromeBrowserSessionOptions {
  /** Resolved Chrome DevTools HTTP or WebSocket endpoint on loopback. */
  cdpEndpoint: string;
  /** Bound for the Playwright-to-Chrome connection and approval handshake. */
  connectionTimeoutMs?: number;
  /** Test seam; production uses Playwright Chromium directly. */
  connectOverCDP?: (cdpEndpoint: string) => Promise<Browser>;
  /** Test seam; production scopes Playwright behind a loopback proxy which
   * hides every target that was open before Sherlock attached. */
  openScopedProxy?: (cdpEndpoint: string, connectionTimeoutMs: number) => Promise<ScopedCdpProxy>;
  /** Crash-test seam, awaited after an exact target commit and before page
   * marker work. Required by the real SIGKILL sentinel regression. */
  afterTargetCreated?: () => Promise<void> | void;
}

/** An error whose text is safe to expose without revealing the endpoint. */
export class AttachedChromeSessionError extends Error {}

/**
 * Validate before any connection attempt and never echo the rejected value.
 *
 * `assertLoopbackCdpUrl` is the repository-wide host policy. The additional
 * protocol check makes this provider's narrower contract explicit. Both HTTP
 * discovery endpoints and Chrome's `DevToolsActivePort` WebSocket endpoints
 * are valid, but neither may leave loopback.
 */
function requireLoopbackEndpoint(cdpEndpoint: string): string {
  let parsed: URL;
  try {
    parsed = assertLoopbackCdpUrl(cdpEndpoint);
  } catch {
    throw new TypeError(
      'Attached Chrome requires a valid loopback HTTP or WebSocket CDP endpoint.',
    );
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'ws:') {
    throw new TypeError(
      'Attached Chrome requires a valid loopback HTTP or WebSocket CDP endpoint.',
    );
  }

  return cdpEndpoint;
}

function requirePositiveTimeout(value: number | undefined): number {
  const timeoutMs = value ?? DEFAULT_CONNECTION_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError('Attached Chrome connectionTimeoutMs must be a positive integer.');
  }
  return timeoutMs;
}

/**
 * Playwright's public `Browser.close()` disconnects a browser obtained from
 * `connectOverCDP`; it does not send `Browser.close` to the user-owned Chrome.
 * Closing the proxy afterwards ends the one upstream Chrome session. Keep the
 * operation idempotent independently of the controller so the same closer is
 * also safe on partial-initialization failure paths.
 */
function createClientDisconnect(browser: Browser, proxy: ScopedCdpProxy): () => Promise<void> {
  let disconnectPromise: Promise<void> | undefined;

  return () => {
    disconnectPromise ??= Promise.resolve()
      .then(() => browser.close())
      .finally(() => proxy.close().catch(() => undefined))
      .catch(() => {
        throw new AttachedChromeSessionError(
          "Could not disconnect Sherlock's Playwright client from attached Chrome.",
        );
      });
    return disconnectPromise;
  };
}

function safeSetupError(error: unknown, cleanupFailed: boolean): Error {
  const message =
    error instanceof AttachedChromeSessionError
      ? error.message
      : 'Could not initialize Sherlock against the attached Chrome context.';
  return new AttachedChromeSessionError(
    cleanupFailed ? `${message} Playwright client cleanup also failed.` : message,
  );
}

/** Creates Sherlock sessions inside an already-running local Chrome. */
export class AttachedChromeBrowserSessionProvider implements BrowserSessionProvider {
  private readonly cdpEndpoint: string;
  private readonly connectionTimeoutMs: number;
  private readonly connect: (cdpEndpoint: string) => Promise<Browser>;
  private readonly openProxy: (
    cdpEndpoint: string,
    connectionTimeoutMs: number,
  ) => Promise<ScopedCdpProxy>;
  private readonly afterTargetCreated: (() => Promise<void> | void) | undefined;

  constructor(options: AttachedChromeBrowserSessionOptions) {
    this.cdpEndpoint = requireLoopbackEndpoint(options.cdpEndpoint);
    const connectionTimeoutMs = requirePositiveTimeout(options.connectionTimeoutMs);
    this.connectionTimeoutMs = connectionTimeoutMs;
    this.openProxy =
      options.openScopedProxy ??
      ((cdpEndpoint, timeoutMs) =>
        openScopedCdpProxy(cdpEndpoint, { connectionTimeoutMs: timeoutMs }));
    this.connect =
      options.connectOverCDP ??
      ((cdpEndpoint: string) =>
        chromium.connectOverCDP(cdpEndpoint, {
          // Attaching must not change focus or media emulation in the user's
          // pre-existing tabs. Sherlock owns only the fresh task tab.
          noDefaults: true,
          timeout: connectionTimeoutMs,
        }));
    this.afterTargetCreated = options.afterTargetCreated;
  }

  async createSession(): Promise<BrowserController> {
    // The proxy owns the one Chrome connection: its handshake is where the
    // user approves Chrome's prompt, and its target snapshot is what keeps
    // Playwright from attaching to (and stalling on) the user's own tabs.
    let proxy: ScopedCdpProxy;
    try {
      proxy = await this.openProxy(this.cdpEndpoint, this.connectionTimeoutMs);
    } catch (error) {
      throw new AttachedChromeSessionError(
        error instanceof ScopedCdpProxyError
          ? error.message
          : 'Could not connect Sherlock to the configured attached Chrome endpoint.',
      );
    }

    let browser: Browser;
    try {
      browser = await this.connect(proxy.endpoint);
    } catch {
      await proxy.close().catch(() => undefined);
      // Playwright's connection errors commonly include the endpoint. Do not
      // retain one as `cause`, because recursive error serializers expose it.
      throw new AttachedChromeSessionError(
        'Playwright could not initialize against the attached Chrome session.',
      );
    }

    const disconnect = createClientDisconnect(browser, proxy);
    return assembleBrowserController({
      build: async (own) => {
        const contexts = browser.contexts();
        if (contexts.length === 0) {
          throw new AttachedChromeSessionError(
            'Attached Chrome exposed no browser context; exactly one is required.',
          );
        }
        if (contexts.length > 1) {
          throw new AttachedChromeSessionError(
            `Attached Chrome exposed ${contexts.length} browser contexts; exactly one is required.`,
          );
        }

        const context = contexts[0]!;
        // Snapshot, do not mutate. The controller excludes this whole set from
        // owned-page discovery. The run lifecycle later opens its own durable
        // task page through prepareTaskPage().
        const preexistingSessionPages = [...context.pages()];
        // Browser-scoped CDP needs no provider-internal page. Recovery may close
        // every stale run page in this snapshot without detaching its own target
        // inventory capability, and SIGKILL during setup cannot leak an
        // unclassified blank anchor.
        const targetControl = own(
          await createChromiumTargetControl(
            { context, browser },
            this.afterTargetCreated === undefined
              ? {}
              : { afterTargetCreated: this.afterTargetCreated },
          ),
        );

        return new PlaywrightBrowserController({
          context,
          preexistingSessionPages,
          targetControl,
          closeSession: disconnect,
          sessionDiagnostics: ATTACHED_SESSION_DIAGNOSTICS,
        });
      },
      // The user owns this Chrome: releasing the session only disconnects
      // Sherlock's Playwright client.
      releaseSession: disconnect,
      // A cleanup failure must never replace the setup error here — it is
      // folded into the redacted message instead.
      cleanupFailures: 'collect',
      mapFailure: (error, cleanupFailed) => safeSetupError(error, cleanupFailed),
    });
  }
}
