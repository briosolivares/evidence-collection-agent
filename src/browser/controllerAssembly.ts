/**
 * Shared provider assembly ladder.
 *
 * Every session provider builds a controller the same way — create the
 * Chromium target control, construct the PlaywrightBrowserController, and on
 * ANY failure close the target control and release the underlying session so
 * neither a half-built controller nor a running (possibly billable) browser
 * session can leak. That guarantee lives here exactly once; what genuinely
 * differs per provider — how the session is released, whether cleanup
 * failures replace or annotate the setup error, and how the setup error is
 * redacted — rides through as parameters rather than being flattened.
 */
import type { BrowserContext, Page } from 'playwright';

import type { BrowserController } from './controller.js';
import type { ChromiumTargetControl } from './chromiumTargetControl.js';

export interface BrowserControllerAssembly {
  /**
   * Provider-specific setup ending in a constructed controller. It MUST
   * register the target control through `own(...)` the moment the control
   * exists, so a failure at any later step still closes it. Everything inside
   * runs under the never-leak guard.
   */
  build: (
    own: (control: ChromiumTargetControl) => ChromiumTargetControl,
  ) => Promise<BrowserController>;
  /** Release the underlying browser session on assembly failure: close the
   * local persistent context, disconnect the attached client, or disconnect
   * and explicitly release the billable remote session. */
  releaseSession: () => Promise<void>;
  /**
   * What a failing cleanup does to the setup error. 'propagate' (default)
   * matches an unguarded await: a cleanup rejection replaces the setup error
   * and skips the remaining cleanup step. 'collect' swallows cleanup
   * rejections, runs every step, and reports `cleanupFailed` to `mapFailure`.
   */
  cleanupFailures?: 'propagate' | 'collect';
  /** Redact/wrap the setup error before it is rethrown. Defaults to identity. */
  mapFailure?: (error: unknown, cleanupFailed: boolean) => unknown;
}

/** Assemble a provider's controller with the shared never-leak guarantee. */
export async function assembleBrowserController(
  assembly: BrowserControllerAssembly,
): Promise<BrowserController> {
  let targetControl: ChromiumTargetControl | undefined;
  const own = (control: ChromiumTargetControl): ChromiumTargetControl => {
    targetControl = control;
    return control;
  };

  try {
    return await assembly.build(own);
  } catch (error) {
    let cleanupFailed = false;
    if (assembly.cleanupFailures === 'collect') {
      try {
        await targetControl?.close();
      } catch {
        cleanupFailed = true;
      }
      try {
        await assembly.releaseSession();
      } catch {
        cleanupFailed = true;
      }
    } else {
      await targetControl?.close();
      await assembly.releaseSession();
    }
    throw (assembly.mapFailure ?? ((setupError: unknown) => setupError))(error, cleanupFailed);
  }
}

/**
 * @returns the surviving pre-existing session page — never tracked, never
 *   closed by this codebase, and deliberately excluded from the controller's
 *   page registry for the whole session. The caller threads it into the
 *   controller's constructor so later ownership rescans keep excluding it
 *   rather than adopting it as a task page.
 *
 * Shared so a remote provider prepares its default context's blank page
 * through the SAME code as a local launch. A second implementation of "which
 * page is the session page" is exactly how a provider ends up with a tracked
 * page the local one excludes.
 */
export async function prepareSessionPage(context: BrowserContext): Promise<Page> {
  const pages = context.pages();
  const sessionPage = pages[0] ?? (await context.newPage());

  for (const extraPage of pages.slice(1)) {
    await extraPage.close();
  }

  if (sessionPage.url() !== 'about:blank') {
    await sessionPage.goto('about:blank');
  }

  return sessionPage;
}
