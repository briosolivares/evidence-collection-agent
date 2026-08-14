import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { BrowserController } from '../../src/browser/controller.js';
import {
  LocalChromeBrowserSessionProvider,
  type LocalChromeBrowserSessionOptions,
} from '../../src/browser/playwrightBrowserController.js';
import type { BrowserSessionProvider } from '../../src/browser/sessionProvider.js';

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

export interface EvalBrowserRuntimeOptions {
  /** Absolute path of the persistent, logged-in Chrome profile. */
  authenticatedProfileDir: string;
  /** Optional Chrome/Chromium binary override shared by both policies. */
  executablePath?: string;
  /** Test seam for browser provisioning. */
  createProvider?: ProviderFactory;
  /** Test seam for unique temporary-profile allocation. */
  createTempProfile?: () => Promise<string>;
  /** Test seam for recursive temporary-profile cleanup. */
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
  /** Run one trial with the browser policy selected by its task metadata. */
  withBrowser<T>(
    headed: boolean,
    operation: (browser: BrowserController) => Promise<T>,
  ): Promise<T>;
  /** Stop accepting work, await active trials, and close the headed session. */
  close(): Promise<void>;
}

/**
 * Own the two eval browser policies:
 * - headless trials each get a new headless Chrome and unique temporary profile;
 * - headed trials serialize through one lazy headed persistent (logged-in)
 *   session, for tasks that need a real login or that bot-block headless
 *   browsers.
 *
 * Also reaps temporary profiles abandoned by earlier batches — see
 * `reapStaleProfiles`.
 */
export function createEvalBrowserRuntime(options: EvalBrowserRuntimeOptions): EvalBrowserRuntime {
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
  const warn = options.onWarning ?? ((message: string) => console.warn(message));

  const activeNormal = new Set<Promise<unknown>>();
  let authenticatedBrowserPromise: Promise<BrowserController> | undefined;
  let authenticatedTail: Promise<void> = Promise.resolve();
  let closePromise: Promise<void> | undefined;
  let closed = false;

  const requireOpen = () => {
    if (closed) throw new Error('eval browser runtime is closed');
  };

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
    ...(options.executablePath === undefined
      ? {}
      : { executablePath: options.executablePath }),
  });

  const getAuthenticatedBrowser = (): Promise<BrowserController> => {
    authenticatedBrowserPromise ??= createProvider(
      providerOptions(options.authenticatedProfileDir, false),
    )
      .createSession()
      .catch((error: unknown) => {
        const message = errorMessage(error);
        if (/ProcessSingleton|user data directory is already in use|profile.*in use/i.test(message)) {
          throw new Error(
            `authenticated Chrome profile is already in use (${options.authenticatedProfileDir}); ` +
              'close the other Sherlock or authenticated eval session and retry',
          );
        }
        throw error;
      });
    return authenticatedBrowserPromise;
  };

  const runNormal = <T>(operation: (browser: BrowserController) => Promise<T>): Promise<T> => {
    const work = (async () => {
      const profileDir = await createTempProfile();
      let browser: BrowserController | undefined;
      let outcome: { ok: true; value: T } | { ok: false; error: unknown };

      try {
        browser = await createProvider(providerOptions(profileDir, true)).createSession();
        outcome = { ok: true, value: await operation(browser) };
      } catch (error) {
        outcome = { ok: false, error };
      }

      let closeError: unknown;
      if (browser !== undefined) {
        try {
          await browser.close();
        } catch (error) {
          closeError = error;
        }
      }

      try {
        await removeTempProfile(profileDir);
      } catch (error) {
        warn(`warning: could not remove temporary Chrome profile ${profileDir}: ${errorMessage(error)}`);
      }

      if (!outcome.ok) {
        if (closeError !== undefined) {
          warn(`warning: could not close temporary Chrome for ${profileDir}: ${errorMessage(closeError)}`);
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
    withBrowser(headed, operation) {
      requireOpen();
      return headed ? runAuthenticated(operation) : runNormal(operation);
    },

    close() {
      if (closePromise !== undefined) return closePromise;
      closed = true;
      closePromise = (async () => {
        await Promise.allSettled([...activeNormal, reaping]);
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
