/**
 * @fileoverview Helper bundled beside the application's OWN installed
 * Playwright (see this package's `dependencies`), so a generated browser
 * script resolves Playwright from here rather than from a scratch
 * directory — no per-run `npm install` needed.
 *
 * A generated script imports this module via the file:// URL the worker
 * puts in `SHERLOCK_PLAYWRIGHT_HELPER_URL`, then calls
 * {@link connectSelectedPage} to attach a SECOND, independent Playwright
 * client to the exact browser tab a running Sherlock session already has
 * selected — the same browser and the same tab
 * `PlaywrightBrowserController.prepareForBrowserScript` prepared, reached
 * over the Chrome DevTools Protocol rather than Playwright's own internal
 * control channel.
 *
 * This file is plain ES module JavaScript (not TypeScript): the scratch
 * directory a generated script runs from has no build step and no access to
 * this repository's `tsc`, so nothing here can rely on being type-checked.
 * JSDoc types are provided for editor/IDE support only.
 */

import { chromium } from 'playwright';

/** @typedef {import('playwright').Browser} PlaywrightBrowser */
/** @typedef {import('playwright').BrowserContext} PlaywrightBrowserContext */
/** @typedef {import('playwright').Page} PlaywrightPage */
/** @typedef {import('playwright').CDPSession} PlaywrightCDPSession */

const ENV_HELPER_URL = 'SHERLOCK_PLAYWRIGHT_HELPER_URL';
const ENV_CDP_URL = 'SHERLOCK_CDP_URL';
const ENV_SELECTED_PAGE_TARGET_ID = 'SHERLOCK_SELECTED_PAGE_TARGET_ID';

/** A loopback host is the only one this module ever trusts for a CDP
 * endpoint: it exists so a script can reach a browser THIS machine's own
 * session already launched, not to be pointed at an arbitrary remote one. */
const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

/** Bound on `chromium.connectOverCDP` itself. Playwright's own default for an
 * unresponsive endpoint is 30 seconds — far past what any caller waiting on
 * this module should ever have to sit through. A live browser answers this
 * handshake in well under a second; anything slower means the endpoint is
 * gone or wedged, and that must surface as a clear, prompt rejection rather
 * than a long silent wait. */
const CDP_CONNECT_TIMEOUT_MS = 5_000;

/** Bound on the ENTIRE search for the selected page once connected: one CDP
 * session plus `Target.getTargetInfo` per open page, across every context.
 * Each of those calls is itself unbounded by default, so a single wedged
 * page (not necessarily the selected one) could otherwise stall the whole
 * search well past any caller's patience. Generous beside the millisecond
 * cost of a healthy page, and still small next to a human-perceptible
 * delay. */
const PAGE_SEARCH_TIMEOUT_MS = 5_000;

/**
 * Thrown when the environment this script is running in never received (or
 * is missing part of) the contract this module needs.
 *
 * This means browser-script support was never available for this session at
 * all — either the controller has no CDP endpoint configured, or this
 * process was launched outside of the sherlock worker that sets the
 * `SHERLOCK_*` variables. It is a configuration problem, not a transient
 * one: a worker seeing this should give up on browser scripts for the rest
 * of the run and continue with ordinary Bash, not retry.
 */
export class BrowserScriptEnvironmentError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'BrowserScriptEnvironmentError';
  }
}

/**
 * Thrown when `chromium.connectOverCDP` could not reach the configured
 * endpoint, or the connection broke while enumerating pages.
 *
 * This means the browser session's CDP endpoint is unreachable right now —
 * the browser may have crashed or exited, or the endpoint is stale. A
 * worker seeing this should treat the browser session itself as suspect:
 * re-observe (call the ordinary browser tools) before assuming any part of
 * it, script or otherwise, is usable again.
 */
export class BrowserScriptConnectionError extends Error {
  /**
   * @param {string} message
   * @param {unknown} [cause]
   */
  constructor(message, cause) {
    super(message);
    this.name = 'BrowserScriptConnectionError';
    if (cause !== undefined) {
      this.cause = cause;
    }
  }
}

/**
 * Thrown when the CDP connection succeeded but the exact page selected by
 * `prepareForBrowserScript` cannot be resolved to exactly one live page:
 * zero matches (the tab was closed, or replaced by a navigation that
 * changed its target) or, unexpectedly, more than one.
 *
 * This is about ONE tab's identity, not the whole browser: a worker seeing
 * this should re-observe and re-select a page (or re-run
 * `prepareForBrowserScript`) rather than retrying the same script as-is.
 */
export class BrowserScriptPageNotFoundError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'BrowserScriptPageNotFoundError';
  }
}

/**
 * Read a required environment variable, or fail with a distinct, actionable
 * message naming exactly which one is missing.
 *
 * @param {string} name
 * @param {string} purpose
 * @returns {string}
 */
function requireEnv(name, purpose) {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new BrowserScriptEnvironmentError(
      `${name} is not set. ${purpose} This script must be launched by the sherlock ` +
        'browser-script worker, which sets all three SHERLOCK_* environment variables — ' +
        'running this module standalone, or in an environment that stripped them, is not ' +
        'supported.',
    );
  }
  return value;
}

/**
 * Require a CDP URL to name a loopback host.
 *
 * @param {string} cdpUrl
 * @returns {void}
 */
function assertLoopbackCdpUrl(cdpUrl) {
  /** @type {URL} */
  let parsed;
  try {
    parsed = new URL(cdpUrl);
  } catch {
    throw new BrowserScriptEnvironmentError(
      `${ENV_CDP_URL} is not a valid URL: ${JSON.stringify(cdpUrl)}`,
    );
  }
  if (!LOOPBACK_HOSTNAMES.has(parsed.hostname)) {
    throw new BrowserScriptEnvironmentError(
      `${ENV_CDP_URL} must name a loopback host ('127.0.0.1' or 'localhost'), got ` +
        `${JSON.stringify(parsed.hostname)}: ${cdpUrl}`,
    );
  }
}

/**
 * Find the CDP target id of a live page reached through `browser`.
 *
 * Deliberately does not touch any private Playwright field: the target id
 * is read the same way `PlaywrightBrowserController.prepareForBrowserScript`
 * reads it on the primary connection, via a throwaway CDP session and
 * `Target.getTargetInfo`.
 *
 * @param {PlaywrightBrowserContext} context
 * @param {PlaywrightPage} page
 * @returns {Promise<string>}
 */
async function targetIdOf(context, page) {
  /** @type {PlaywrightCDPSession | undefined} */
  let session;
  try {
    session = await context.newCDPSession(page);
    const { targetInfo } = await session.send('Target.getTargetInfo');
    return targetInfo.targetId;
  } finally {
    if (session !== undefined) {
      await session.detach().catch(() => undefined);
    }
  }
}

/**
 * Race a promise against a fixed deadline, rejecting with a clear,
 * purpose-built error rather than letting a caller hang on a step that has
 * no bound of its own (Playwright's own default timeouts are either much
 * longer than a script should ever wait, as with `connectOverCDP`'s 30s, or
 * simply absent, as with `CDPSession.send`).
 *
 * @template T
 * @param {Promise<T>} promise
 * @param {number} timeoutMs
 * @param {string} label - names the step in the resulting error, so a
 *   timeout here is traceable to which phase of connecting stalled
 * @returns {Promise<T>}
 */
function withDeadline(promise, timeoutMs, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(
        new BrowserScriptConnectionError(
          `${label} did not complete within ${timeoutMs}ms. The browser session's CDP ` +
            'endpoint is likely unreachable or wedged right now.',
        ),
      );
    }, timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/**
 * Connect a SECOND, independent Playwright client to the exact browser tab
 * the running Sherlock session has selected, over the Chrome DevTools
 * Protocol.
 *
 * @returns {Promise<{ browser: PlaywrightBrowser, context: PlaywrightBrowserContext, page: PlaywrightPage }>}
 *   real Playwright objects for the selected tab.
 * @throws {BrowserScriptEnvironmentError} a required `SHERLOCK_*` variable
 *   is missing or invalid — browser-script support is unavailable here
 * @throws {BrowserScriptConnectionError} the CDP endpoint could not be
 *   reached, or the connection failed while enumerating pages
 * @throws {BrowserScriptPageNotFoundError} the selected page could not be
 *   resolved to exactly one live page
 *
 * IMPORTANT: call `await browser.close()` once the script is done with it,
 * and do so BEFORE the script's process is expected to exit.
 *
 * This looks alarming (`close()` sounds like it should kill the browser) but
 * is exactly the opposite for a `Browser` obtained via
 * `chromium.connectOverCDP`: Playwright documents `Browser.close()` as
 * closing the browser only "in case this browser is obtained using
 * `browserType.launch()`"; for one that is CONNECTED to, as this always is,
 * it "clears all created contexts belonging to this browser and disconnects
 * from the browser server" — the Sherlock session's browser, its tabs, and
 * the tab this script acted on are all untouched. This was measured directly
 * against this exact launch configuration (`launchPersistentContext` plus
 * `--remote-debugging-port=0`): calling `browser.close()` here disconnects
 * in milliseconds while the primary session's controller stays fully
 * functional afterward, including against the very page a script just
 * closed.
 *
 * Skipping this call does not merely leave things open a little longer — it
 * hangs the process FOREVER. `connectOverCDP`'s CDP transport is a live
 * WebSocket, and Node will not fire `beforeExit` (nor exit on its own) while
 * that handle is open, no matter how "done" the rest of the script's logic
 * is. There is no way to observe this from inside the script itself: a
 * generated script that reads correctly, produces its output, and returns
 * from every one of its calls will nonetheless never exit until an external
 * supervisor sends it a signal. Calling `browser.close()` is the only way to
 * let the process end on its own.
 */
export async function connectSelectedPage() {
  const helperUrl = requireEnv(
    ENV_HELPER_URL,
    'It must name the file:// URL this helper module itself should be imported from.',
  );
  const cdpUrl = requireEnv(
    ENV_CDP_URL,
    'It must name the loopback CDP endpoint of the browser session this script should attach to.',
  );
  const selectedPageTargetId = requireEnv(
    ENV_SELECTED_PAGE_TARGET_ID,
    'It must name the CDP target id of the page this script should act on.',
  );
  // Not otherwise used below: whatever imported this module already used
  // SHERLOCK_PLAYWRIGHT_HELPER_URL to find it. It is still validated here so
  // this function is the ONE place that checks the full three-variable
  // contract, rather than assuming the importer's half of it was correct.
  void helperUrl;

  assertLoopbackCdpUrl(cdpUrl);

  /** @type {PlaywrightBrowser} */
  let browser;
  try {
    // An explicit, short timeout: Playwright's own default for this call is
    // 30 seconds when the endpoint never answers, which is not "a few
    // seconds" by any reading. See CDP_CONNECT_TIMEOUT_MS.
    browser = await chromium.connectOverCDP(cdpUrl, { timeout: CDP_CONNECT_TIMEOUT_MS });
  } catch (error) {
    throw new BrowserScriptConnectionError(
      `Could not connect to the browser session over CDP at ${cdpUrl}: ` +
        `${error instanceof Error ? error.message : String(error)}. The browser session may ` +
        'have closed or crashed since it was prepared for this script.',
      error,
    );
  }

  /** @type {Array<{ context: PlaywrightBrowserContext, page: PlaywrightPage }>} */
  const matches = [];
  try {
    try {
      await withDeadline(
        (async () => {
          for (const context of browser.contexts()) {
            for (const page of context.pages()) {
              const targetId = await targetIdOf(context, page);
              if (targetId === selectedPageTargetId) {
                matches.push({ context, page });
              }
            }
          }
        })(),
        PAGE_SEARCH_TIMEOUT_MS,
        'Searching the connected browser for the selected page',
      );
    } catch (error) {
      if (error instanceof BrowserScriptConnectionError) {
        throw error;
      }
      throw new BrowserScriptConnectionError(
        `Connected to the browser over CDP at ${cdpUrl}, but failed while looking for the ` +
          `selected page: ${error instanceof Error ? error.message : String(error)}.`,
        error,
      );
    }

    if (matches.length === 0) {
      throw new BrowserScriptPageNotFoundError(
        `No live page matches the selected CDP target id ${selectedPageTargetId}. The tab this ` +
          'script was meant to act on has likely been closed, or replaced by a navigation that ' +
          'gave it a new target. This function never falls back to "the first page" — re-observe ' +
          'and re-select a page (or re-run prepareForBrowserScript) rather than retrying blindly.',
      );
    }
    if (matches.length > 1) {
      // Not expected in practice (CDP target ids are unique), but a script
      // must never guess between candidates when identity is ambiguous.
      throw new BrowserScriptPageNotFoundError(
        `${matches.length} live pages unexpectedly match the selected CDP target id ` +
          `${selectedPageTargetId}; refusing to guess which one is correct.`,
      );
    }
  } catch (error) {
    // Every throw above happens AFTER connectOverCDP already succeeded, and
    // none of them return `browser` to the caller — so nothing downstream
    // will ever get the chance to close it. Per this function's own doc
    // comment, an unclosed CDP connection hangs the process forever, so
    // close it here, on every failure path, before propagating the real
    // error. A close failure is swallowed deliberately: the original error
    // is what the caller needs to see, not a problem closing a connection
    // that is already broken enough to be worth abandoning.
    await browser.close().catch(() => undefined);
    throw error;
  }

  const { context, page } = matches[0];
  return { browser, context, page };
}
