/**
 * Attached-local Chrome provider.
 *
 * This provider joins an already-running, user-owned Chrome over an explicit
 * loopback DevTools HTTP endpoint. Ownership is intentionally narrow:
 * Sherlock owns only its Playwright client and pages it creates after the
 * controller is constructed. It never closes the attached context, browser,
 * or pages that were already open when it connected.
 *
 * Discovery and the chrome://inspect permission flow belong above this seam.
 * This module accepts a resolved endpoint only.
 */

import { chromium, type Browser } from 'playwright';

import type { BrowserController } from './controller.js';
import { assertLoopbackCdpUrl } from './browserScriptSetup.js';
import { PlaywrightBrowserController } from './playwrightBrowserController.js';
import type {
  BrowserSessionDiagnostics,
  BrowserSessionProvider,
} from './sessionProvider.js';

const ATTACHED_SESSION_DIAGNOSTICS = Object.freeze({
  provider: 'local',
}) satisfies BrowserSessionDiagnostics;

/** Dependencies and resolved configuration for one attached-local provider. */
export interface AttachedChromeBrowserSessionOptions {
  /** Explicit Chrome DevTools HTTP endpoint on the loopback interface. */
  cdpEndpoint: string;
  /** Test seam; production uses Playwright Chromium directly. */
  connectOverCDP?: (cdpEndpoint: string) => Promise<Browser>;
}

/** An error whose text is safe to expose without revealing the endpoint. */
class AttachedChromeSessionError extends Error {}

/**
 * Validate before any connection attempt and never echo the rejected value.
 *
 * `assertLoopbackCdpUrl` is the repository-wide host policy. The additional
 * protocol check makes this provider's narrower contract explicit: discovery
 * must resolve to an HTTP endpoint, not a WebSocket capability URL.
 */
function requireLoopbackHttpEndpoint(cdpEndpoint: string): string {
  let parsed: URL;
  try {
    parsed = new URL(cdpEndpoint);
    assertLoopbackCdpUrl(cdpEndpoint);
  } catch {
    throw new TypeError(
      'Attached Chrome requires a valid loopback HTTP CDP endpoint.',
    );
  }

  if (parsed.protocol !== 'http:') {
    throw new TypeError(
      'Attached Chrome requires a valid loopback HTTP CDP endpoint.',
    );
  }

  return cdpEndpoint;
}

/**
 * Playwright's public `Browser.close()` disconnects a browser obtained from
 * `connectOverCDP`; it does not send `Browser.close` to the user-owned Chrome.
 * Keep the operation idempotent independently of the controller so the same
 * closer is also safe on partial-initialization failure paths.
 */
function createClientDisconnect(browser: Browser): () => Promise<void> {
  let disconnectPromise: Promise<void> | undefined;

  return () => {
    disconnectPromise ??= Promise.resolve()
      .then(() => browser.close())
      .catch(() => {
        throw new AttachedChromeSessionError(
          'Could not disconnect Sherlock\'s Playwright client from attached Chrome.',
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
    cleanupFailed
      ? `${message} Playwright client cleanup also failed.`
      : message,
  );
}

/** Creates Sherlock sessions inside an already-running local Chrome. */
export class AttachedChromeBrowserSessionProvider implements BrowserSessionProvider {
  private readonly cdpEndpoint: string;
  private readonly connect: (cdpEndpoint: string) => Promise<Browser>;

  constructor(options: AttachedChromeBrowserSessionOptions) {
    this.cdpEndpoint = requireLoopbackHttpEndpoint(options.cdpEndpoint);
    this.connect =
      options.connectOverCDP ??
      ((cdpEndpoint: string) => chromium.connectOverCDP(cdpEndpoint));
  }

  async createSession(): Promise<BrowserController> {
    let browser: Browser;
    try {
      browser = await this.connect(this.cdpEndpoint);
    } catch {
      // Playwright's connection errors commonly include the endpoint. Do not
      // retain one as `cause`, because recursive error serializers expose it.
      throw new AttachedChromeSessionError(
        'Could not connect Sherlock to the configured attached Chrome endpoint.',
      );
    }

    const disconnect = createClientDisconnect(browser);

    try {
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
      // owned-page discovery and opens a fresh task page only when newTab()
      // is called by the run lifecycle.
      const preexistingSessionPages = [...context.pages()];

      return new PlaywrightBrowserController({
        context,
        preexistingSessionPages,
        closeSession: disconnect,
        sessionDiagnostics: ATTACHED_SESSION_DIAGNOSTICS,
        // No cdpUrl: V3 opens target-pinned sessions through the already
        // attached BrowserContext. Re-exporting the endpoint would revive the
        // legacy child-process capability leak this provider is designed to
        // avoid.
      });
    } catch (error) {
      let cleanupFailed = false;
      try {
        await disconnect();
      } catch {
        cleanupFailed = true;
      }
      throw safeSetupError(error, cleanupFailed);
    }
  }
}
