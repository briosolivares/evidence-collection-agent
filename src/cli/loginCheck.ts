// Probe the headed-lane Chrome profile's login state with a real browser.
//
// `loginProbe.ts` holds the pure classification; this module owns the
// browser. It exists as a library rather than living inside `login.ts`
// because two callers need the same answer: the `npm run login` helper,
// and the eval CLI's pre-batch preflight. Those two must agree exactly —
// a preflight that probes a different profile, or classifies leniently,
// is worse than no preflight, since it green-lights a batch that will
// walk into a login wall an hour later.

import { launchPersistentChrome } from '../browser/playwrightBrowserController.js';
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
   * one the trials launch, or the answer is about the wrong browser. */
  profileDir: string;
  executablePath?: string;
  services: readonly LoginService[];
  /** Headless is right for an unattended check; the interactive helper
   * needs a window the human can act in. */
  headless: boolean;
  onStatus?: (status: ServiceLoginStatus) => void;
}

/**
 * Open `profileDir`, probe every service, close.
 *
 * Self-contained by design: the caller gets its verdicts without holding a
 * browser open, so a batch's preflight has released the profile lock before
 * the first headed trial tries to claim it.
 */
export async function checkProfileLogins(
  options: CheckProfileLoginsOptions,
): Promise<ServiceLoginStatus[]> {
  const context = await launchPersistentChrome({
    profileDir: options.profileDir,
    ...(options.executablePath === undefined ? {} : { executablePath: options.executablePath }),
    headless: options.headless,
  });
  try {
    return await probeServices(context, options.services, options.onStatus);
  } finally {
    await context.close().catch(() => undefined);
  }
}

export type { ServiceLoginStatus };
