import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  BrowserbaseBrowserSessionProvider,
  requireBrowserbaseApiKey,
} from '../../src/browser/browserbaseBrowserSessionProvider.js';
import type { BrowserController } from '../../src/browser/controller.js';
import {
  LocalChromeBrowserSessionProvider,
  type LocalChromeBrowserSessionOptions,
} from '../../src/browser/playwrightBrowserController.js';
import {
  requireBrowserbaseContextId,
  resolveBrowserProviderKind,
} from '../../src/browser/provider.js';
import type {
  BrowserProviderKind,
  BrowserSessionProvider,
} from '../../src/browser/sessionProvider.js';

const TEMP_PROFILE_PREFIX = 'evidence-agent-eval-chrome-';

/**
 * How stale a temporary profile must be before the reaper claims it.
 *
 * The guard against deleting a *live* trial's profile is the mtime, not this
 * number: a running Chrome writes to its profile continuously, so anything
 * untouched for hours belongs to a process that is gone. Four hours leaves
 * enormous headroom over the longest observed trial (~11 minutes) while still
 * bounding disk growth to a single day's abandoned batches.
 */
const STALE_PROFILE_AGE_MS = 4 * 60 * 60 * 1000;

type ProviderFactory = (options: LocalChromeBrowserSessionOptions) => BrowserSessionProvider;

/**
 * One browser leased for one ordinary trial, plus how to give it back.
 *
 * A lease rather than a bare controller because "what backs this browser" is
 * exactly what differs between providers — a temporary Chrome profile
 * directory on disk, or a billable remote session — and the lane policy above
 * must not know which. Local-profile allocation, cleanup, and stale-profile
 * reaping now live ONLY inside the local adapter.
 */
export interface EvalBrowserLease {
  browser: BrowserController;
  /** What to call this browser in an operator-facing warning — the temporary
   * profile it runs from, or the remote session id. Provided by the adapter
   * because only it knows what backs the lease, and a warning that says
   * "the browser" is not one an operator can act on. */
  label: string;
  /**
   * Close the browser and reclaim whatever backed it.
   *
   * @returns the browser's own close failure, when there was one, so the lane
   *   policy can decide whether it outranks a trial failure. Reclaim failures
   *   (a profile directory that would not delete, a remote session that was
   *   already gone) are warned about here and never propagate: failing a graded
   *   trial over housekeeping would throw away a real result.
   */
  release(): Promise<{ closeError?: unknown }>;
}

/**
 * Provider-specific browser provisioning for the two eval lanes.
 *
 * The lane policy — isolated-and-concurrent for ordinary trials, single and
 * serialized for authenticated ones — is provider-independent and lives in
 * {@link createEvalBrowserRuntime}. Everything a specific runtime needs to
 * honor that policy lives behind this seam.
 */
export interface EvalBrowserAdapter {
  /** Which runtime this adapter provisions, for operator-facing text. */
  readonly kind: BrowserProviderKind;
  /** A fresh, isolated browser for one ordinary trial. */
  leaseIsolated(): Promise<EvalBrowserLease>;
  /** The lane's single authenticated browser: the logged-in local profile, or
   * a session on the configured Browserbase Context. */
  openAuthenticated(): Promise<BrowserController>;
  /** Background housekeeping started at construction; awaited by `close()` so
   * a batch never outruns its own cleanup. */
  housekeeping(): Promise<void>;
}

export interface EvalBrowserRuntimeOptions {
  /** Absolute path of the persistent, logged-in Chrome profile. Local only. */
  authenticatedProfileDir: string;
  /** Optional Chrome/Chromium binary override shared by both policies. */
  executablePath?: string;
  /** Environment the provider is selected from; defaults to `process.env`.
   * Pass `{}` in a test to pin the local provider regardless of the developer's
   * shell. */
  env?: Record<string, string | undefined>;
  /** Test seam replacing the whole provisioning layer. Overrides provider
   * selection, so a test never reaches a network. */
  adapter?: EvalBrowserAdapter;
  /** Test seam for browser provisioning (local adapter). */
  createProvider?: ProviderFactory;
  /** Test seam for unique temporary-profile allocation (local adapter). */
  createTempProfile?: () => Promise<string>;
  /** Test seam for recursive temporary-profile cleanup (local adapter). */
  removeTempProfile?: (profileDir: string) => Promise<void>;
  /** Directory swept for orphaned profiles; defaults to the system temp dir. */
  tempProfileRoot?: string;
  /**
   * Test seam listing absolute paths of existing temporary eval profiles, live
   * ones included. Pass `async () => []` to opt a test out of reaping.
   */
  listTempProfiles?: () => Promise<string[]>;
  /** Receives best-effort cleanup warnings. */
  onWarning?: (message: string) => void;
}

export interface EvalBrowserRuntime {
  /** Which runtime the trials will use, for the batch's opening banner. */
  readonly provider: BrowserProviderKind;
  /** Run one trial with the browser policy selected by its task metadata. */
  withBrowser<T>(
    headed: boolean,
    operation: (browser: BrowserController) => Promise<T>,
  ): Promise<T>;
  /** Stop accepting work, await active trials, and close the headed session. */
  close(): Promise<void>;
}

/**
 * Own the two eval browser policies, for whichever runtime hosts them:
 *
 * - ordinary trials each lease a fresh, isolated browser and release it when
 *   the trial ends, at the runner's bounded concurrency;
 * - authenticated trials serialize through ONE lazily opened logged-in browser,
 *   for tasks that need a real login or that bot-block headless browsers. One
 *   at a time is not merely a convention remotely: simultaneous sessions
 *   against the same Browserbase Context would race over the same stored
 *   cookies.
 *
 * Nothing here inspects task names or task text — the lane comes from
 * `task.json`'s `headed` field, which the caller passes in.
 */
export function createEvalBrowserRuntime(options: EvalBrowserRuntimeOptions): EvalBrowserRuntime {
  const warn = options.onWarning ?? ((message: string) => console.warn(message));
  const adapter = options.adapter ?? createDefaultAdapter(options, warn);

  const activeNormal = new Set<Promise<unknown>>();
  let authenticatedBrowserPromise: Promise<BrowserController> | undefined;
  let authenticatedTail: Promise<void> = Promise.resolve();
  let closePromise: Promise<void> | undefined;
  let closed = false;

  const requireOpen = () => {
    if (closed) throw new Error('eval browser runtime is closed');
  };

  const runNormal = <T>(operation: (browser: BrowserController) => Promise<T>): Promise<T> => {
    const work = (async () => {
      const lease = await adapter.leaseIsolated();
      let outcome: { ok: true; value: T } | { ok: false; error: unknown };
      try {
        outcome = { ok: true, value: await operation(lease.browser) };
      } catch (error) {
        outcome = { ok: false, error };
      }

      const { closeError } = await lease.release();
      if (!outcome.ok) {
        if (closeError !== undefined) {
          warn(`warning: could not close ${lease.label}: ${errorMessage(closeError)}`);
        }
        throw outcome.error;
      }
      if (closeError !== undefined) throw closeError;
      return outcome.value;
    })();

    activeNormal.add(work);
    void work.finally(() => activeNormal.delete(work)).catch(() => undefined);
    return work;
  };

  const getAuthenticatedBrowser = (): Promise<BrowserController> => {
    authenticatedBrowserPromise ??= adapter.openAuthenticated();
    return authenticatedBrowserPromise;
  };

  const runAuthenticated = <T>(
    operation: (browser: BrowserController) => Promise<T>,
  ): Promise<T> => {
    const result = authenticatedTail.then(async () => operation(await getAuthenticatedBrowser()));
    authenticatedTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };

  return {
    provider: adapter.kind,

    withBrowser(headed, operation) {
      requireOpen();
      return headed ? runAuthenticated(operation) : runNormal(operation);
    },

    close() {
      if (closePromise !== undefined) return closePromise;
      closed = true;
      closePromise = (async () => {
        await Promise.allSettled([...activeNormal, adapter.housekeeping()]);
        await authenticatedTail;
        if (authenticatedBrowserPromise !== undefined) {
          const browser = await authenticatedBrowserPromise.catch(() => undefined);
          await browser?.close();
        }
      })();
      return closePromise;
    },
  };
}

/** Select and build the adapter the environment asks for. */
function createDefaultAdapter(
  options: EvalBrowserRuntimeOptions,
  warn: (message: string) => void,
): EvalBrowserAdapter {
  const env = options.env ?? process.env;
  return resolveBrowserProviderKind(env) === 'browserbase'
    ? createBrowserbaseEvalBrowserAdapter({ env, onWarning: warn })
    : createLocalEvalBrowserAdapter(options, warn);
}

/**
 * Local Chrome provisioning: a unique temporary profile per ordinary trial, the
 * persistent logged-in profile for authenticated ones, and the orphaned-profile
 * reaper.
 *
 * This is the ONLY place that knows temporary profile directories exist.
 */
export function createLocalEvalBrowserAdapter(
  options: EvalBrowserRuntimeOptions,
  warn: (message: string) => void,
): EvalBrowserAdapter {
  const createProvider =
    options.createProvider ??
    ((providerOptions: LocalChromeBrowserSessionOptions) =>
      new LocalChromeBrowserSessionProvider(providerOptions));
  const createTempProfile =
    options.createTempProfile ?? (() => mkdtemp(join(tmpdir(), TEMP_PROFILE_PREFIX)));
  const removeTempProfile =
    options.removeTempProfile ??
    ((profileDir: string) => rm(profileDir, { recursive: true, force: true }));
  const tempProfileRoot = options.tempProfileRoot ?? tmpdir();
  const listTempProfiles =
    options.listTempProfiles ?? (() => defaultListTempProfiles(tempProfileRoot));

  /**
   * Remove temporary profiles left behind by batches that never reached their
   * own cleanup.
   *
   * Per-trial cleanup is correct on any normal exit, but nothing reaps a
   * profile whose process died first — a crash, a Ctrl-C, an out-of-disk. Those
   * accumulate silently and unboundedly: seven survivors from two days of
   * batches came to ~260 MB, one of them 158 MB alone, and on a full disk that
   * was the difference between a batch running and failing.
   *
   * Deliberately forgiving at every step. A profile whose age cannot be
   * determined is left alone, a failed removal warns and the sweep continues,
   * and an unreadable temp directory ends the sweep quietly — reclaiming disk
   * must never be the reason an eval batch dies.
   */
  const reapStaleProfiles = async (): Promise<void> => {
    let candidates: string[];
    try {
      candidates = await listTempProfiles();
    } catch (error) {
      warn(`warning: could not scan for orphaned Chrome profiles: ${errorMessage(error)}`);
      return;
    }

    const cutoff = Date.now() - STALE_PROFILE_AGE_MS;
    for (const profileDir of candidates) {
      let modifiedAt: number;
      try {
        modifiedAt = (await stat(profileDir)).mtimeMs;
      } catch {
        // Vanished between listing and stat, or unreadable. Either way it is
        // not ours to reason about.
        continue;
      }
      if (modifiedAt >= cutoff) continue;
      try {
        await removeTempProfile(profileDir);
      } catch (error) {
        warn(
          `warning: could not remove orphaned Chrome profile ${profileDir}: ${errorMessage(error)}`,
        );
      }
    }
  };

  // Started at construction so it overlaps the first trial's browser launch
  // instead of delaying it, and awaited by close() so a batch never outruns
  // its own housekeeping. The no-op catch is attached now rather than left to
  // close(): a runtime that is never closed must not surface an unhandled
  // rejection, and close() still sees the settled promise.
  const reaping = reapStaleProfiles();
  void reaping.catch(() => undefined);

  const providerOptions = (
    profileDir: string,
    headless: boolean,
  ): LocalChromeBrowserSessionOptions => ({
    profileDir,
    headless,
    ...(options.executablePath === undefined ? {} : { executablePath: options.executablePath }),
  });

  return {
    kind: 'local',
    housekeeping: () => reaping,

    async leaseIsolated(): Promise<EvalBrowserLease> {
      const profileDir = await createTempProfile();
      let browser: BrowserController;
      try {
        browser = await createProvider(providerOptions(profileDir, true)).createSession();
      } catch (error) {
        // The profile exists but no browser ever claimed it; reclaim it now
        // rather than leaving it for the reaper four hours from now.
        await removeTempProfile(profileDir).catch((cleanupError: unknown) => {
          warn(
            `warning: could not remove temporary Chrome profile ${profileDir}: ` +
              `${errorMessage(cleanupError)}`,
          );
        });
        throw error;
      }

      return {
        browser,
        label: `temporary Chrome for ${profileDir}`,
        async release() {
          let closeError: unknown;
          try {
            await browser.close();
          } catch (error) {
            closeError = error;
          }
          try {
            await removeTempProfile(profileDir);
          } catch (error) {
            warn(
              `warning: could not remove temporary Chrome profile ${profileDir}: ${errorMessage(error)}`,
            );
          }
          return closeError === undefined ? {} : { closeError };
        },
      };
    },

    openAuthenticated(): Promise<BrowserController> {
      return createProvider(providerOptions(options.authenticatedProfileDir, false))
        .createSession()
        .catch((error: unknown) => {
          const message = errorMessage(error);
          if (
            /ProcessSingleton|user data directory is already in use|profile.*in use/i.test(message)
          ) {
            throw new Error(
              `authenticated Chrome profile is already in use (${options.authenticatedProfileDir}); ` +
                'close the other Sherlock or authenticated eval session and retry',
            );
          }
          throw error;
        });
    },
  };
}

export interface BrowserbaseEvalAdapterOptions {
  env?: Record<string, string | undefined>;
  onWarning?: (message: string) => void;
  /**
   * Test seam: build the provider for one lane instead of constructing a real
   * one (which would reach Browserbase).
   *
   * The config carries every lane-distinguishing choice — including
   * `persistContext`, which a test would otherwise be unable to observe: any
   * hermetic test must replace this factory wholesale, so a value hardcoded
   * inside the default factory could only be re-asserted by copying it into
   * the fake, which proves nothing.
   */
  createProvider?: (config: {
    contextId?: string;
    persistContext: boolean;
    liveView: boolean;
    lane: 'isolated' | 'authenticated';
  }) => BrowserSessionProvider;
}

/**
 * Browserbase provisioning.
 *
 * Ordinary trials get one fresh, CONTEXT-FREE session each — the remote
 * equivalent of a throwaway profile, and the property that keeps trials
 * independent of one another. Nothing is persisted and nothing is reaped: the
 * session ends with the trial, and the provider's own close path releases it.
 *
 * Authenticated trials share ONE session opened against the configured
 * Context, serialized by the lane policy above. That session is deliberately
 * NON-persisting: it reads the logins the operator established with
 * `npm run login` and cannot write over them, so a trial that gets signed out
 * mid-batch degrades that trial instead of destroying the Context every later
 * batch depends on. (The local persistent profile has always been mutable this
 * way; not reproducing that is the intended difference.)
 */
export function createBrowserbaseEvalBrowserAdapter(
  options: BrowserbaseEvalAdapterOptions = {},
): EvalBrowserAdapter {
  const env = options.env ?? process.env;
  const warn = options.onWarning ?? ((message: string) => console.warn(message));
  // Validated once, at construction, so a batch with a missing key or Context
  // fails before its first trial rather than per trial.
  const apiKey = requireBrowserbaseApiKey(env);
  const createProvider =
    options.createProvider ??
    ((config) =>
      new BrowserbaseBrowserSessionProvider({
        apiKey,
        ...(config.contextId === undefined ? {} : { contextId: config.contextId }),
        persistContext: config.persistContext,
        liveView: config.liveView,
        userMetadata: { lane: config.lane },
        onWarning: warn,
      }));

  return {
    kind: 'browserbase',
    // Nothing accumulates locally, so there is no sweep to await.
    housekeeping: () => Promise.resolve(),

    async leaseIsolated(): Promise<EvalBrowserLease> {
      const browser = await createProvider({
        // No Context at all: isolation between trials is the point.
        persistContext: false,
        liveView: false,
        lane: 'isolated',
      }).createSession();
      return {
        browser,
        label: `browserbase session ${browser.sessionDiagnostics?.sessionId ?? '(unknown id)'}`,
        async release() {
          try {
            // Closing the controller disconnects AND releases the remote
            // session; there is no separate resource to reclaim.
            await browser.close();
            return {};
          } catch (error) {
            return { closeError: error };
          }
        },
      };
    },

    openAuthenticated(): Promise<BrowserController> {
      return createProvider({
        contextId: requireBrowserbaseContextId(env),
        // Read the operator's logins; never write over them. See this
        // function's doc comment.
        persistContext: false,
        // A human may need to take over an authenticated trial (finish a
        // re-auth prompt), so this lane always has its Live View link.
        liveView: true,
        lane: 'authenticated',
      }).createSession();
    },
  };
}

/**
 * Absolute paths of every temporary eval profile directory in `root`, live ones
 * included — the caller decides which are stale enough to remove.
 *
 * @param root - directory to scan, normally the system temp directory
 * @returns candidate profile directories; empty when `root` holds none
 * @throws when `root` cannot be read
 */
async function defaultListTempProfiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory() && entry.name.startsWith(TEMP_PROFILE_PREFIX))
    .map((entry) => join(root, entry.name));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
