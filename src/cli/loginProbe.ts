// Login-state probes for the persistent headed-lane Chrome profile.
//
// The pre-batch ritual ("log into Google and X first") failed silently
// twice because nothing ever verified WHERE the login landed or whether
// it stuck. These probes are the verification: navigate to a URL whose
// post-redirect destination reveals the session state, and classify what
// the browser actually did. Behavioral ground truth — a cookie can be
// present yet expired; a page that loads signed-in cannot.
//
// Pure logic only (classification + settle loop with injected clock);
// `login.ts` owns the browser and terminal.

/** What a probe navigation revealed about the session. */
export type LoginState = 'logged-in' | 'logged-out' | 'pending';

/** Stable identifier a caller can name in data — an eval task.json says
 * `"requiresLogin": ["google-sheets"]`, not a URL or a display name. */
export type LoginServiceId = 'google-sheets' | 'x';

export interface LoginService {
  /** Stable id used in configuration and task metadata. */
  id: LoginServiceId;
  /** Human label used in status lines. */
  name: string;
  /** URL whose post-redirect destination reveals the session state. */
  probeUrl: string;
  /** Classify a URL observed after navigating to `probeUrl`. `pending`
   * means "not determinable yet" — mid-redirect or an unexpected page. */
  classify(url: string): LoginState;
}

/** Sheets home: signed out server-redirects to accounts.google.com;
 * signed in it stays on docs.google.com/spreadsheets. */
export const GOOGLE_SHEETS: LoginService = {
  id: 'google-sheets',
  name: 'Google (Sheets)',
  probeUrl: 'https://docs.google.com/spreadsheets/u/0/',
  classify: (url) => {
    const parsed = safeUrl(url);
    if (!parsed) return 'pending';
    if (parsed.hostname === 'accounts.google.com') return 'logged-out';
    if (parsed.hostname === 'docs.google.com' && parsed.pathname.startsWith('/spreadsheets')) {
      return 'logged-in';
    }
    return 'pending';
  },
};

/** X home: signed out client-redirects to the login flow (late — the
 * settle loop's confirmation re-check exists for exactly this); signed
 * in it stays on /home. */
export const X_HOME: LoginService = {
  id: 'x',
  name: 'X',
  probeUrl: 'https://x.com/home',
  classify: (url) => {
    const parsed = safeUrl(url);
    if (!parsed) return 'pending';
    const host = parsed.hostname.replace(/^www\./, '');
    if (host !== 'x.com' && host !== 'twitter.com') return 'pending';
    if (parsed.pathname.startsWith('/i/flow/login') || parsed.pathname === '/login') {
      return 'logged-out';
    }
    return parsed.pathname === '/home' ? 'logged-in' : 'pending';
  },
};

/** Every service the headed lane needs: mit → Google Sheets;
 * edgar + elon_tweets → X. */
export const HEADED_LANE_SERVICES: readonly LoginService[] = [GOOGLE_SHEETS, X_HOME];

/**
 * Resolve service ids to probes, in the order `HEADED_LANE_SERVICES`
 * declares them, dropping duplicates.
 *
 * @param ids - service ids, e.g. from eval task metadata
 * @returns the matching probes; throws naming the unknown id, because a
 *   silently-dropped requirement is a batch that reports "login OK" for a
 *   service it never checked
 */
export function loginServicesForIds(ids: Iterable<string>): LoginService[] {
  const wanted = new Set<string>();
  for (const id of ids) {
    const known = HEADED_LANE_SERVICES.some((service) => service.id === id);
    if (!known) {
      throw new Error(
        `unknown login service ${JSON.stringify(id)} ` +
          `(known: ${HEADED_LANE_SERVICES.map((s) => s.id).join(', ')})`,
      );
    }
    wanted.add(id);
  }
  return HEADED_LANE_SERVICES.filter((service) => wanted.has(service.id));
}

/** One service's verdict. */
export interface ServiceLoginStatus {
  service: LoginService;
  state: LoginState;
}

/** Whether every probed service is signed in. `pending` counts as not
 * ready: an unverified session is exactly the case that burned two
 * batches, so it must never pass a gate. */
export function allLoggedIn(statuses: readonly ServiceLoginStatus[]): boolean {
  return statuses.every((status) => status.state === 'logged-in');
}

/** Terminal-facing label for a probe verdict, shared by every caller so
 * "NOT LOGGED IN" reads identically in the helper and in a batch preflight. */
export function formatLoginState(state: LoginState): string {
  if (state === 'logged-in') return 'LOGGED IN';
  if (state === 'logged-out') return 'NOT LOGGED IN';
  return 'UNVERIFIED (page never reached a recognizable destination)';
}

export interface SettleOptions {
  /** Give up and report `pending` after this long. */
  timeoutMs?: number;
  /** How often to re-read the URL while pending. */
  pollMs?: number;
  /** After a first non-pending verdict, wait this long and re-classify —
   * catches late client-side redirects (x.com/home when logged out). */
  confirmMs?: number;
}

/**
 * Poll `currentUrl` until it classifies as a definite state, then confirm
 * the verdict survives one more delay. Returns `pending` only when the
 * page never reached a recognizable destination within the timeout.
 */
export async function settleProbe(
  service: LoginService,
  currentUrl: () => string,
  sleep: (ms: number) => Promise<void>,
  options: SettleOptions = {},
): Promise<LoginState> {
  const timeoutMs = options.timeoutMs ?? 8_000;
  const pollMs = options.pollMs ?? 250;
  const confirmMs = options.confirmMs ?? 1_500;

  let elapsed = 0;
  let state = service.classify(currentUrl());
  while (state === 'pending' && elapsed < timeoutMs) {
    await sleep(pollMs);
    elapsed += pollMs;
    state = service.classify(currentUrl());
  }
  if (state === 'pending') return 'pending';

  await sleep(confirmMs);
  const confirmed = service.classify(currentUrl());
  return confirmed === 'pending' ? state : confirmed;
}

function safeUrl(url: string): URL | undefined {
  try {
    return new URL(url);
  } catch {
    return undefined;
  }
}
