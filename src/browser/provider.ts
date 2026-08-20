/**
 * Provider composition: the one place that turns environment into a
 * {@link BrowserSessionProvider}.
 *
 * Every production entry point — the Sherlock TUI, the REPL, the eval CLI, TUI
 * evals, the login helper and its preflight, the browser-backed demos — comes
 * through here, so "which browser runtime does this run use?" has exactly one
 * answer and one place to change it. Duplicating the selection in each entry
 * point is how a batch ends up half remote and half local.
 *
 * Selection is EXPLICIT. `SHERLOCK_BROWSER_PROVIDER` must say `browserbase`
 * before a remote session is created; merely holding a `BROWSERBASE_API_KEY`
 * never starts a billable session, and `local` stays the fallback and the
 * runtime for the network-free test suite.
 */
import {
  BrowserbaseBrowserSessionProvider,
  requireBrowserbaseApiKey,
} from './browserbaseBrowserSessionProvider.js';
import {
  attachedChromeEndpoint,
  AttachedChromeSetupBrowserSessionProvider,
} from './attachedChromeSetup.js';
import { LocalChromeBrowserSessionProvider } from './playwrightBrowserController.js';
import type { BrowserProviderKind, BrowserSessionProvider } from './sessionProvider.js';

/** The environment variable that selects the runtime. */
export const BROWSER_PROVIDER_ENV_VAR = 'SHERLOCK_BROWSER_PROVIDER';
/** The environment variable holding the persistent Browserbase Context. */
export const BROWSERBASE_CONTEXT_ENV_VAR = 'BROWSERBASE_CONTEXT_ID';

/** How a local provider obtains Chrome. This never selects Browserbase. */
export type LocalBrowserMode = 'attached' | 'managed';

function requireLocalBrowserMode(value: LocalBrowserMode): LocalBrowserMode {
  if (value !== 'attached' && value !== 'managed') {
    throw new TypeError('localMode must be "attached" or "managed".');
  }
  return value;
}

/**
 * Which runtime this environment asks for.
 *
 * @param env - environment to read; defaults to `process.env`
 * @returns `browserbase` only when explicitly requested; `local` otherwise
 * @throws Error when the variable is set to something that is neither, since
 *   silently falling back to local Chrome for a typo like `browsebase` would
 *   run a whole batch on the wrong runtime
 */
export function resolveBrowserProviderKind(
  env: Record<string, string | undefined> = process.env,
): BrowserProviderKind {
  const raw = env[BROWSER_PROVIDER_ENV_VAR]?.trim().toLowerCase();
  if (raw === undefined || raw === '' || raw === 'local') return 'local';
  if (raw === 'browserbase') return 'browserbase';
  throw new Error(
    `${BROWSER_PROVIDER_ENV_VAR}=${JSON.stringify(raw)} is not a known browser provider; ` +
      'use "browserbase" or "local".',
  );
}

/** The configured persistent Browserbase Context, or undefined when the login
 * command has not created one yet. */
export function browserbaseContextId(
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  const value = env[BROWSERBASE_CONTEXT_ENV_VAR]?.trim();
  return value === undefined || value === '' ? undefined : value;
}

/** What a caller must supply to build a provider, whichever one is selected. */
export interface BrowserProviderCompositionOptions {
  /** Environment to read; defaults to `process.env`. */
  env?: Record<string, string | undefined>;
  /**
   * Required local authority decision. Interactive Sherlock chooses
   * `attached`; tests, evals, login, demos, and other managed-profile callers
   * choose `managed` so ambient Chrome is never touched accidentally.
   */
  localMode: LocalBrowserMode;
  /** Local managed-only: the persistent Chrome profile directory. Kept
   * required so switching a caller from attached or Browserbase to managed
   * cannot fail later with a missing path. */
  profileDir: string;
  /** Local-only: Chrome/Chromium binary override. */
  executablePath?: string;
  /** Local-only: run Chrome without a window. Meaningless remotely — a
   * Browserbase browser has no local window either way, and Live View is how a
   * human sees it. */
  headless?: boolean;
  /**
   * Remote-only: whether to open the session with the persistent Context.
   *
   * - `'required'` — use `BROWSERBASE_CONTEXT_ID` and FAIL when it is unset.
   *   For the authenticated eval lane and the login preflight: a lane that
   *   silently ran context-free would report every login as missing, which
   *   reads as "the login did not stick" rather than "nothing was configured".
   * - `'optional'` — use it when set, otherwise open a context-free session.
   *   For interactive runtimes: a user who has not run `npm run login` yet
   *   should still be able to browse public pages, not be locked out of the
   *   whole tool.
   * - `'none'` (default) — never. What an isolated eval trial needs, since
   *   sharing a Context across trials would let one trial's state reach the
   *   next.
   */
  context?: 'required' | 'optional' | 'none';
  /** Remote-only: write this session's cookies back into the Context on close.
   * Only the login flow wants this. */
  persistContext?: boolean;
  /** Remote-only: fetch the Live View URL at creation. Default on; the eval
   * normal lane turns it off because nobody is watching. */
  liveView?: boolean;
  /** Remote-only correlation metadata for the Browserbase session list. */
  userMetadata?: Record<string, unknown>;
  /** Receives operator-facing warnings. */
  onWarning?: (message: string) => void;
  /** Local attached-only: visible first-use setup state. Required at runtime
   * because enabling and approving debugging is deliberately a human action. */
  onAttachedSetupState?: (message: string) => void;
}

/**
 * Build the provider this environment selects.
 *
 * @param options - the union of both providers' needs; each provider reads
 *   only its own
 * @returns a provider whose `createSession()` callers cannot tell apart
 * @throws Error when the selected provider is misconfigured (no API key, or a
 *   Context was required and none is configured) — before any session is
 *   created, and without echoing the key
 */
export function createBrowserSessionProvider(
  options: BrowserProviderCompositionOptions,
): BrowserSessionProvider {
  const env = options.env ?? process.env;
  const localMode = requireLocalBrowserMode(options.localMode);
  if (resolveBrowserProviderKind(env) === 'local') {
    if (localMode === 'attached') {
      if (options.onAttachedSetupState === undefined) {
        throw new TypeError(
          'Attached local browser mode requires an onAttachedSetupState callback.',
        );
      }
      const explicitEndpoint = attachedChromeEndpoint(env);
      return new AttachedChromeSetupBrowserSessionProvider({
        ...(explicitEndpoint === undefined ? {} : { explicitEndpoint }),
        ...(options.executablePath === undefined ? {} : { executablePath: options.executablePath }),
        onSetupState: options.onAttachedSetupState,
      });
    }
    return new LocalChromeBrowserSessionProvider({
      profileDir: options.profileDir,
      ...(options.executablePath === undefined ? {} : { executablePath: options.executablePath }),
      ...(options.headless === undefined ? {} : { headless: options.headless }),
    });
  }

  const contextId =
    options.context === 'required'
      ? requireBrowserbaseContextId(env)
      : options.context === 'optional'
        ? browserbaseContextId(env)
        : undefined;
  return new BrowserbaseBrowserSessionProvider({
    apiKey: requireBrowserbaseApiKey(env),
    ...(contextId === undefined ? {} : { contextId }),
    ...(options.persistContext === undefined ? {} : { persistContext: options.persistContext }),
    ...(options.liveView === undefined ? {} : { liveView: options.liveView }),
    ...(options.userMetadata === undefined ? {} : { userMetadata: options.userMetadata }),
    ...(options.onWarning === undefined ? {} : { onWarning: options.onWarning }),
  });
}

/**
 * The configured Context, or an actionable refusal.
 *
 * @throws Error naming the command that creates one. A Context-requiring lane
 *   that quietly ran context-free would look like a login that "did not stick"
 *   rather than a missing configuration line.
 */
export function requireBrowserbaseContextId(
  env: Record<string, string | undefined> = process.env,
): string {
  const contextId = browserbaseContextId(env);
  if (contextId === undefined) {
    throw new Error(
      `this run needs a persistent Browserbase Context, but ${BROWSERBASE_CONTEXT_ENV_VAR} is ` +
        'not set. Run `npm run login` — it creates a Context, saves the id to your .env, and ' +
        'signs you in through Live View.',
    );
  }
  return contextId;
}

/**
 * One line naming the runtime a session will use, for a startup banner.
 *
 * Provider-neutral on purpose: the old message said "Chrome profile: …"
 * unconditionally, which is actively misleading once the browser is remote.
 */
export function describeBrowserProvider(options: {
  env?: Record<string, string | undefined>;
  localMode: LocalBrowserMode;
  profileDir: string;
}): string {
  const env = options.env ?? process.env;
  const localMode = requireLocalBrowserMode(options.localMode);
  if (resolveBrowserProviderKind(env) === 'local') {
    return localMode === 'attached'
      ? 'browser: local Chrome, attached to the current user session'
      : `browser: local Chrome, managed profile ${options.profileDir}`;
  }
  const contextId = browserbaseContextId(env);
  return (
    'browser: Browserbase (remote), ' +
    (contextId === undefined
      ? `no ${BROWSERBASE_CONTEXT_ENV_VAR} configured — sessions start signed out`
      : `context ${contextId}`)
  );
}

/**
 * Turn a session-startup failure into something the operator can act on.
 *
 * Managed local mode keeps the Chrome-install guidance that has been useful;
 * attached mode names the exact permission page, and the remote branch points
 * at its real configuration limits. Neither ever prints a key or connection
 * URL — `message` comes from an error this codebase raised, and the providers
 * are careful not to put either in one.
 */
export function formatBrowserStartupError(
  kind: BrowserProviderKind,
  message: string,
  localMode: LocalBrowserMode,
): string {
  const checkedLocalMode = requireLocalBrowserMode(localMode);
  const lines =
    kind === 'local'
      ? checkedLocalMode === 'attached'
        ? [
            'sherlock could not attach to the current local Chrome.',
            'Open chrome://inspect/#remote-debugging in Chrome and enable ' +
              '“Allow remote debugging for this browser instance”.',
          ]
        : [
            'sherlock could not launch a local Chrome.',
            ...(/not found|install|doesn'?t exist|does not exist/i.test(message)
              ? [
                  'Google Chrome does not appear to be installed. Install it from ' +
                    'https://www.google.com/chrome/ (or run `npx playwright install chrome`), ' +
                    'or point SHERLOCK_CHROME_PATH at a Chrome/Chromium binary.',
                ]
              : []),
          ]
      : [
          'sherlock could not start a Browserbase browser session.',
          'Check BROWSERBASE_API_KEY, and that your plan has a free concurrent session. ' +
            `Set ${BROWSER_PROVIDER_ENV_VAR}=local to fall back to local Chrome.`,
        ];
  return `${lines.join('\n')}\n\n${message}`;
}
