import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { BrowserController } from '../../src/browser/controller.js';
import {
  LocalChromeBrowserSessionProvider,
  type LocalChromeBrowserSessionOptions,
} from '../../src/browser/playwrightBrowserController.js';
import type { BrowserSessionProvider } from '../../src/browser/sessionProvider.js';

const TEMP_PROFILE_PREFIX = 'evidence-agent-eval-chrome-';

type ProviderFactory = (options: LocalChromeBrowserSessionOptions) => BrowserSessionProvider;

export interface EvalBrowserRuntimeOptions {
  /** Absolute path of the persistent, logged-in Chrome profile. */
  authenticatedProfileDir: string;
  /** Test seam for browser provisioning. */
  createProvider?: ProviderFactory;
  /** Test seam for unique temporary-profile allocation. */
  createTempProfile?: () => Promise<string>;
  /** Test seam for recursive temporary-profile cleanup. */
  removeTempProfile?: (profileDir: string) => Promise<void>;
  /** Receives best-effort cleanup warnings. */
  onWarning?: (message: string) => void;
}

export interface EvalBrowserRuntime {
  /** Run one trial with the browser policy selected by its task metadata. */
  withBrowser<T>(
    requiresAuth: boolean,
    operation: (browser: BrowserController) => Promise<T>,
  ): Promise<T>;
  /** Stop accepting work, await active trials, and close the auth session. */
  close(): Promise<void>;
}

/**
 * Own the two eval browser policies:
 * - normal trials each get a new headless Chrome and unique temporary profile;
 * - authenticated trials serialize through one lazy headed persistent session.
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
  const warn = options.onWarning ?? ((message: string) => console.warn(message));

  const activeNormal = new Set<Promise<unknown>>();
  let authenticatedBrowserPromise: Promise<BrowserController> | undefined;
  let authenticatedTail: Promise<void> = Promise.resolve();
  let closePromise: Promise<void> | undefined;
  let closed = false;

  const requireOpen = () => {
    if (closed) throw new Error('eval browser runtime is closed');
  };

  const getAuthenticatedBrowser = (): Promise<BrowserController> => {
    authenticatedBrowserPromise ??= createProvider({
      profileDir: options.authenticatedProfileDir,
      headless: false,
    }).createSession();
    return authenticatedBrowserPromise;
  };

  const runNormal = <T>(operation: (browser: BrowserController) => Promise<T>): Promise<T> => {
    const work = (async () => {
      const profileDir = await createTempProfile();
      let browser: BrowserController | undefined;
      let outcome: { ok: true; value: T } | { ok: false; error: unknown };

      try {
        browser = await createProvider({ profileDir, headless: true }).createSession();
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
    withBrowser(requiresAuth, operation) {
      requireOpen();
      return requiresAuth ? runAuthenticated(operation) : runNormal(operation);
    },

    close() {
      if (closePromise !== undefined) return closePromise;
      closed = true;
      closePromise = (async () => {
        await Promise.allSettled([...activeNormal]);
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
