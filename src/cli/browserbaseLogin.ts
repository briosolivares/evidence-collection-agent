/**
 * Browserbase login: provision a Context, sign in through Live View, verify the
 * logins survive a session boundary.
 *
 * The local login helper's whole design premise is that a session lives in a
 * directory on this machine, so a human can be handed a real Chrome window
 * pointed at it. Remotely neither half holds: the browser is in someone else's
 * datacenter, and what persists is a Browserbase Context rather than a profile
 * directory. So the ritual changes shape:
 *
 *   create/reuse a Context → open a session on it with `persist: true` →
 *   hand the operator a Live View URL → they sign in by hand →
 *   CLOSE the session, which is what commits the Context →
 *   open a SECOND session on the same Context and probe it
 *
 * That second session is the point of the whole exercise. A sign-in that looks
 * fine in Live View proves nothing about whether Browserbase persisted it, and
 * "the login did not stick" is precisely the failure the local helper was built
 * to stop hiding. Verification therefore always crosses the close/reopen
 * boundary — the same boundary an authenticated eval trial will cross.
 *
 * Credentials are never typed by this code. The operator signs in themselves,
 * in a browser this process only watches.
 *
 * A caveat that no amount of correctness here removes: Google and X may refuse
 * a sign-in from a cloud browser's IP or fingerprint regardless. Context
 * persistence is not consent from the login target. That is a POC acceptance
 * question, and it is why proxy/region configuration is left unset until the
 * behavior has actually been measured against the user's accounts.
 */
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline/promises';

import {
  createBrowserbaseClient,
  requireBrowserbaseApiKey,
  type BrowserbaseClient,
} from '../browser/browserbaseBrowserSessionProvider.js';
import { BROWSERBASE_CONTEXT_ENV_VAR, browserbaseContextId } from '../browser/provider.js';
import { setEnvFileValue } from './envFile.js';
import {
  openLoginProbeSession,
  openServiceTabs,
  probeServices,
  probeStatusPrinter,
} from './loginCheck.js';
import { allLoggedIn, type LoginService } from './loginProbe.js';

/**
 * How long to wait after closing the sign-in session before probing the
 * Context.
 *
 * Browserbase writes a Context's user-data-directory asynchronously once the
 * session that owned it ends. Reopening immediately can load the state as it
 * was BEFORE the sign-in — which would report a perfectly good login as
 * "did not stick" and send the operator round the loop again. Deliberately
 * generous: this runs once, interactively, and a false negative here costs far
 * more than five seconds.
 */
const CONTEXT_SYNC_DELAY_MS = 5_000;

export interface BrowserbaseLoginDeps {
  /** Services to sign into and verify. */
  services: readonly LoginService[];
  /** The env file the Context id is saved into — the one the application
   * runtime loads, so the next command sees it without being told. */
  envFilePath: string;
  /** Mutable environment this process reads and updates in place, so the
   * session opened moments later sees the Context that was just created.
   * Defaults to `process.env`. */
  env?: Record<string, string | undefined>;
  /** Test seams. */
  client?: BrowserbaseClient;
  /**
   * Opens the login/verification browsing sessions.
   *
   * A seam rather than a direct call to {@link openLoginProbeSession}, because
   * this function's whole contract is a SEQUENCE — provision a Context, open a
   * persisting session, close it, reopen, probe — and every interesting failure
   * is an ordering failure. Without an injectable opener none of that ordering
   * can be checked without a real Browserbase account, so the one part most
   * worth testing would be the only part untested.
   */
  openSession?: typeof openLoginProbeSession;
  log?: (message: string) => void;
  /** Blocks until the operator says they have finished signing in. */
  waitForOperator?: (liveViewUrl: string | undefined) => Promise<void>;
  sleep?: (milliseconds: number) => Promise<void>;
  /** Opens the Live View in the operator's own browser; best-effort. */
  openInBrowser?: (url: string) => void;
}

/**
 * Ensure a Browserbase Context exists and its id is persisted.
 *
 * Reuses `BROWSERBASE_CONTEXT_ID` when it is already set: re-creating one every
 * login would abandon the Context holding the working logins and produce a
 * fresh empty one, which looks identical to a login that failed.
 *
 * @returns the Context id, and whether this call created it
 * @throws whatever the Contexts API raised; a `.env` write failure also throws,
 *   because a Context whose id was not saved is invisible to every later
 *   command and would be silently re-created (and billed) next time
 */
export async function ensureBrowserbaseContext(deps: {
  client: BrowserbaseClient;
  env: Record<string, string | undefined>;
  envFilePath: string;
  log: (message: string) => void;
}): Promise<{ contextId: string; created: boolean }> {
  const existing = browserbaseContextId(deps.env);
  if (existing !== undefined) {
    deps.log(`Browserbase context: ${existing} (already configured)`);
    return { contextId: existing, created: false };
  }

  deps.log('No Browserbase context configured yet — creating one…');
  const context = await deps.client.contexts.create({});
  setEnvFileValue(deps.envFilePath, BROWSERBASE_CONTEXT_ENV_VAR, context.id);
  // In-process too: the session opened moments from now must use this Context,
  // and nothing re-reads the file in between.
  deps.env[BROWSERBASE_CONTEXT_ENV_VAR] = context.id;
  deps.log(`Browserbase context: ${context.id} (created; saved to ${deps.envFilePath})`);
  return { contextId: context.id, created: true };
}

/**
 * Run the interactive Browserbase login.
 *
 * @returns true when every requested service verified in a SECOND session
 *   opened on the same Context — the only evidence that the login persisted
 */
export async function runBrowserbaseLogin(deps: BrowserbaseLoginDeps): Promise<boolean> {
  const env = deps.env ?? process.env;
  const log = deps.log ?? ((message: string) => console.log(message));
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));
  const client = deps.client ?? createBrowserbaseClient(requireBrowserbaseApiKey(env));
  const openInBrowser = deps.openInBrowser ?? openUrlInSystemBrowser;
  const waitForOperator = deps.waitForOperator ?? promptOperator;
  const openSession = deps.openSession ?? openLoginProbeSession;

  await ensureBrowserbaseContext({ client, env, envFilePath: deps.envFilePath, log });

  // Sign-in session: persists, so closing it is what commits the Context.
  const session = await openSession({
    headless: false,
    persistContext: true,
    env,
    onWarning: log,
  });
  try {
    log(`Browserbase session: ${session.sessionId ?? '(unknown)'}`);
    await openServiceTabs(session.context, deps.services);

    if (session.liveViewUrl === undefined) {
      log(
        '\nCould not obtain a Live View URL for this session, so there is no window to sign in ' +
          'through. Check the session in the Browserbase dashboard and retry.',
      );
      return false;
    }

    log('\nOpen this Live View and sign in by hand — nothing here types your credentials:');
    log(`  ${session.liveViewUrl}\n`);
    openInBrowser(session.liveViewUrl);
    log('Google or X may refuse a cloud browser outright; if so, that is the answer we');
    log('are looking for, not a bug in this command.\n');
    await waitForOperator(session.liveViewUrl);
  } finally {
    // The close is the commit. Everything after this reads the Context.
    log('\nClosing the session so Browserbase persists the context…');
    await session.close();
  }

  await sleep(CONTEXT_SYNC_DELAY_MS);

  log('Reopening a second session on the same context and verifying…');
  const verification = await openSession({
    headless: false,
    // A verification probe is a pure READ. Persisting from it could write a
    // half-loaded state back over the Context that was just committed.
    persistContext: false,
    env,
    onWarning: log,
  });
  try {
    const statuses = await probeServices(
      verification.context,
      deps.services,
      probeStatusPrinter(log),
    );
    return allLoggedIn(statuses);
  } finally {
    await verification.close();
  }
}

/** Block until the operator confirms on stdin. */
async function promptOperator(): Promise<void> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    await rl.question('Press Enter here once you have finished signing in: ');
  } catch {
    // EOF or a closed stream: treat it as "go ahead and verify" rather than
    // hanging — the verification step is what decides the outcome anyway.
  } finally {
    rl.close();
  }
}

/** Best-effort convenience: put the Live View in front of the operator. The URL
 * is printed regardless, so a platform without an opener loses nothing. */
function openUrlInSystemBrowser(url: string): void {
  const command =
    process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
  try {
    spawn(command, [url], { stdio: 'ignore', detached: true }).unref();
  } catch {
    // No opener on this platform; the printed URL is the fallback.
  }
}
