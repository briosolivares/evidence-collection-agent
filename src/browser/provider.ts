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
import { LocalChromeBrowserSessionProvider } from './playwrightBrowserController.js';
import type { BrowserProviderKind, BrowserSessionProvider } from './sessionProvider.js';

/** The environment variable that selects the runtime. */
export const BROWSER_PROVIDER_ENV_VAR = 'SHERLOCK_BROWSER_PROVIDER';
/** The environment variable holding the persistent Browserbase Context. */
export const BROWSERBASE_CONTEXT_ENV_VAR = 'BROWSERBASE_CONTEXT_ID';

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
  /** Local-only: the persistent Chrome profile directory. Required because the
   * local provider cannot be built without it, and a caller that omits it
   * would only discover that after flipping the provider back to local. */
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
  if (resolveBrowserProviderKind(env) === 'local') {
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
  profileDir: string;
}): string {
  const env = options.env ?? process.env;
  if (resolveBrowserProviderKind(env) === 'local') {
    return `browser: local Chrome, profile ${options.profileDir}`;
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
 * The local branch keeps the Chrome-install guidance that has been the useful
 * answer for that failure; the remote branch points at the configuration and
 * plan limits that actually produce remote failures. Neither ever prints a key
 * or a connection URL — `message` comes from an error this codebase raised, and
 * the provider is careful not to put either in one.
 */
export function formatBrowserStartupError(
  kind: BrowserProviderKind,
  message: string,
): string {
  const lines =
    kind === 'local'
      ? [
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
