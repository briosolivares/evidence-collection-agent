// Probe the headed-lane Chrome profile's login state with a real browser.
//
// `loginProbe.ts` holds the pure classification; this module owns the
// browser. It exists as a library rather than living inside `login.ts`
// because two callers need the same answer: the `npm run login` helper,
// and the eval CLI's pre-batch preflight. Those two must agree exactly —
// a preflight that probes a different profile, or classifies leniently,
// is worse than no preflight, since it green-lights a batch that will
// walk into a login wall an hour later.

import {
  BrowserbaseBrowserSessionProvider,
  requireBrowserbaseApiKey,
} from '../browser/browserbaseBrowserSessionProvider.js';
import { launchPersistentChrome } from '../browser/playwrightBrowserController.js';
import {
  requireBrowserbaseContextId,
  resolveBrowserProviderKind,
} from '../browser/provider.js';
import type { BrowserProviderKind } from '../browser/sessionProvider.js';
import {
  settleProbe,
  type LoginService,
  type LoginState,
  type ServiceLoginStatus,
} from './loginProbe.js';

import type { BrowserContext } from 'playwright';

const PROBE_NAVIGATION_TIMEOUT_MS = 20_000;

/**
 * Navigate a fresh tab to `service.probeUrl` and classify where it landed.
 *
 * A navigation failure yields `pending`, never a throw: "could not tell"
 * is a real answer that callers already handle, and a flaky network must
 * not be indistinguishable from a signed-out session.
 */
export async function probeService(
  context: BrowserContext,
  service: LoginService,
): Promise<LoginState> {
  const page = await context.newPage();
  try {
    await page.goto(service.probeUrl, {
      waitUntil: 'domcontentloaded',
      timeout: PROBE_NAVIGATION_TIMEOUT_MS,
    });
    return await settleProbe(service, () => page.url(), (ms) => page.waitForTimeout(ms));
  } catch {
    return 'pending';
  } finally {
    await page.close().catch(() => undefined);
  }
}

/** Probe each service in turn against an already-open context. */
export async function probeServices(
  context: BrowserContext,
  services: readonly LoginService[],
  onStatus?: (status: ServiceLoginStatus) => void,
): Promise<ServiceLoginStatus[]> {
  const statuses: ServiceLoginStatus[] = [];
  for (const service of services) {
    const status: ServiceLoginStatus = { service, state: await probeService(context, service) };
    statuses.push(status);
    onStatus?.(status);
  }
  return statuses;
}

export interface CheckProfileLoginsOptions {
  /** The profile directory whose sessions are being checked — must be the
   * one the trials launch, or the answer is about the wrong browser. Used
   * only by the local provider. */
  profileDir: string;
  executablePath?: string;
  services: readonly LoginService[];
  /** Headless is right for an unattended check; the interactive helper
   * needs a window the human can act in. Local-only — a Browserbase browser
   * has no local window either way. */
  headless: boolean;
  onStatus?: (status: ServiceLoginStatus) => void;
  /** Environment the provider is selected from; defaults to `process.env`. */
  env?: Record<string, string | undefined>;
}

/**
 * A raw browsing context for login work, from whichever provider is selected.
 *
 * The login helper and its probes navigate pages directly — they open a tab per
 * service, read where it landed, and hand a real window to a human — so they
 * need a `BrowserContext`, not the model-facing controller. That is why this is
 * a separate seam from {@link BrowserSessionProvider} rather than a method on
 * it: nothing a run does should be able to reach a raw context.
 */
export interface LoginProbeSession {
  context: BrowserContext;
  /** Which runtime produced it, for provider-specific operator text. */
  provider: BrowserProviderKind;
  /** Browserbase session id, when remote. */
  sessionId?: string;
  /** Where a human signs in when the browser is not on this machine. */
  liveViewUrl?: string;
  close(): Promise<void>;
}

export interface OpenLoginProbeSessionOptions {
  /** Local-only: the profile directory to open. Required when the local
   * provider is selected and meaningless otherwise, which is why it is optional
   * here rather than a value a remote caller has to invent. */
  profileDir?: string;
  executablePath?: string;
  /** Local-only; see {@link CheckProfileLoginsOptions.headless}. */
  headless: boolean;
  /**
   * Write the session's cookies back into the Browserbase Context on close.
   *
   * TRUE only for the interactive sign-in step: that is the write, and it is
   * the close that commits it. A verification probe must be a pure read —
   * persisting from a probe would let a half-finished sign-in overwrite a good
   * Context.
   */
  persistContext?: boolean;
  env?: Record<string, string | undefined>;
  onWarning?: (message: string) => void;
}

/**
 * Open a login-capable browsing context on the selected provider.
 *
 * Remote sessions always use the configured Context: a login check that probed
 * a context-free session would report "signed out" for a Context that is
 * perfectly good, and a sign-in into a context-free session would be discarded
 * on close.
 *
 * @returns the context plus what a human needs to act in it
 * @throws Error when the provider is misconfigured — no API key, or no
 *   `BROWSERBASE_CONTEXT_ID` yet
 */
export async function openLoginProbeSession(
  options: OpenLoginProbeSessionOptions,
): Promise<LoginProbeSession> {
  const env = options.env ?? process.env;
  if (resolveBrowserProviderKind(env) === 'local') {
    if (options.profileDir === undefined) {
      throw new Error('a local login session needs a profileDir to open.');
    }
    const context = await launchPersistentChrome({
      profileDir: options.profileDir,
      ...(options.executablePath === undefined ? {} : { executablePath: options.executablePath }),
      headless: options.headless,
    });
    return {
      context,
      provider: 'local',
      close: () => context.close().catch(() => undefined),
    };
  }

  const interactive = options.persistContext === true;
  const provider = new BrowserbaseBrowserSessionProvider({
    apiKey: requireBrowserbaseApiKey(env),
    contextId: requireBrowserbaseContextId(env),
    persistContext: options.persistContext ?? false,
    liveView: true,
    // No timeoutSeconds: the provider's default already outlasts a human
    // signing in through Live View, which is what a sign-in session waits on.
    userMetadata: { purpose: interactive ? 'login' : 'login-check' },
    ...(options.onWarning === undefined ? {} : { onWarning: options.onWarning }),
  });
  const raw = await provider.createRawSession();
  return {
    context: raw.context,
    provider: 'browserbase',
    sessionId: raw.sessionId,
    ...(raw.diagnostics.liveViewUrl === undefined
      ? {}
      : { liveViewUrl: raw.diagnostics.liveViewUrl }),
    close: () => raw.close(),
  };
}

/**
 * Open a login session on the selected provider, probe every service, close.
 *
 * Self-contained by design: the caller gets its verdicts without holding a
 * browser open, so a batch's preflight has released the local profile lock —
 * or the remote Context — before the first authenticated trial claims it.
 */
export async function checkProfileLogins(
  options: CheckProfileLoginsOptions,
): Promise<ServiceLoginStatus[]> {
  const session = await openLoginProbeSession({
    profileDir: options.profileDir,
    ...(options.executablePath === undefined ? {} : { executablePath: options.executablePath }),
    headless: options.headless,
    ...(options.env === undefined ? {} : { env: options.env }),
  });
  try {
    return await probeServices(session.context, options.services, options.onStatus);
  } finally {
    await session.close();
  }
}

export type { ServiceLoginStatus };
