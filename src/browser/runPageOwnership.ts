/**
 * Durable run-page ownership: the stateless kernel.
 *
 * Everything here is a pure derivation or a self-contained page/context
 * operation — marker hashing, the sentinel URL, the in-page marker scripts,
 * and the bounded evaluation gate they all run under. The stateful epoch
 * machine (generations, poisoning, fixed-point cleanup, crash recovery) stays
 * on PlaywrightBrowserController; its SIGKILL semantics are pinned by
 * tests/browser/playwrightBrowserController.runOwnership.crash.test.ts.
 */
import { createHash } from 'node:crypto';

import type { BrowserContext, Disposable, Page } from 'playwright';

import { raceWithDeadline } from './boundedSettlement.js';

/** The browser-visible property/value namespace is deliberately generic and
 * versioned. The caller's durable run id is hashed before it crosses into a
 * page, so neither page content nor a driver error can disclose a local run
 * path/id. Exact descriptor/value equality is the only ownership test. */
const RUN_PAGE_OWNERSHIP_PROPERTY = '__sherlock_run_page_owner_v1__';
const RUN_PAGE_OWNERSHIP_MARKER_PREFIX = '__sherlock_run_page_owner_v1__:';
const RUN_PAGE_TARGET_SENTINEL_PREFIX = '__sherlock_run_target_v1__:';
const MAX_RUN_PAGE_OWNERSHIP_ID_BYTES = 4_096;
const RUN_PAGE_OWNERSHIP_EVALUATION_TIMEOUT_MS = 5_000;

/** Derive a stable browser marker without placing the caller's local run id
 * into page state. Including the versioned namespace in the digest separates
 * this use from any other hash of the same opaque id. */
export function runPageOwnershipMarker(ownershipId: string): string {
  if (typeof ownershipId !== 'string' || ownershipId.length === 0) {
    throw new TypeError('Durable run page ownership requires a non-empty string id.');
  }
  if (Buffer.byteLength(ownershipId, 'utf8') > MAX_RUN_PAGE_OWNERSHIP_ID_BYTES) {
    throw new RangeError(
      `Durable run page ownership ids may not exceed ` +
        `${MAX_RUN_PAGE_OWNERSHIP_ID_BYTES} UTF-8 bytes.`,
    );
  }
  const digest = createHash('sha256')
    .update(RUN_PAGE_OWNERSHIP_MARKER_PREFIX, 'utf8')
    .update('\0', 'utf8')
    .update(ownershipId, 'utf8')
    .digest('base64url');
  return `${RUN_PAGE_OWNERSHIP_MARKER_PREFIX}${digest}`;
}

/** Exact browser-only URL used between Chromium target commit and durable
 * page-marker installation. It contains only a namespace-separated digest of
 * the already-hashed marker; neither the durable run id nor a filesystem path
 * crosses into target metadata. */
export function runPageTargetSentinel(marker: string): string {
  const digest = createHash('sha256')
    .update(RUN_PAGE_TARGET_SENTINEL_PREFIX, 'utf8')
    .update('\0', 'utf8')
    .update(marker, 'utf8')
    .digest('base64url');
  return `about:blank#${RUN_PAGE_TARGET_SENTINEL_PREFIX}${digest}`;
}

/** Renderer inspection cannot inherit Playwright's global 30s+ waits: this
 * gate runs before a resumed coordinator may safely do anything else. The
 * losing evaluation is read-only (or an idempotent exact marker install) and
 * stays observed inside the shared race, so a later driver rejection cannot
 * become unhandled. */
export function withRunPageOwnershipEvaluationDeadline<T>(evaluation: Promise<T>): Promise<T> {
  return raceWithDeadline(() => evaluation, {
    timeoutMs: RUN_PAGE_OWNERSHIP_EVALUATION_TIMEOUT_MS,
    onTimeout: () => new Error('Durable page ownership inspection timed out.'),
  });
}

/** Read only an equality bit out of the page. The marker itself never comes
 * back through Playwright, so it cannot accidentally enter an error,
 * diagnostic, page listing, or tool result. */
export async function pageHasRunOwnershipMarker(page: Page, marker: string): Promise<boolean> {
  return withRunPageOwnershipEvaluationDeadline(
    page.evaluate(
      ({ property, marker: expectedMarker }: { property: string; marker: string }) => {
        const descriptor = Object.getOwnPropertyDescriptor(window, property);
        return (
          descriptor?.value === expectedMarker &&
          descriptor.enumerable === false &&
          descriptor.configurable === false &&
          descriptor.writable === false
        );
      },
      { property: RUN_PAGE_OWNERSHIP_PROPERTY, marker },
    ),
  );
}

/** Install an unconditional per-page new-document script, then mark and
 * verify the current document. `Page.addInitScript` follows this browsing
 * context across same- and cross-origin navigation. */
export async function markPageWithRunOwnership(
  page: Page,
  marker: string | undefined,
): Promise<void> {
  if (marker === undefined) return;
  const payload = { property: RUN_PAGE_OWNERSHIP_PROPERTY, marker };
  await page.addInitScript(
    ({ property, marker: expectedMarker }: { property: string; marker: string }) => {
      Object.defineProperty(window, property, {
        value: expectedMarker,
        enumerable: false,
        configurable: false,
        writable: false,
      });
    },
    payload,
  );
  const marked = await withRunPageOwnershipEvaluationDeadline(
    page.evaluate(({ property, marker: expectedMarker }: { property: string; marker: string }) => {
      const existing = Object.getOwnPropertyDescriptor(window, property);
      if (existing === undefined) {
        Object.defineProperty(window, property, {
          value: expectedMarker,
          enumerable: false,
          configurable: false,
          writable: false,
        });
      }
      const installed = Object.getOwnPropertyDescriptor(window, property);
      return (
        installed?.value === expectedMarker &&
        installed.enumerable === false &&
        installed.configurable === false &&
        installed.writable === false
      );
    }, payload),
  );
  if (marked !== true) {
    throw new Error('The browser did not retain its durable task-page marker.');
  }
}

/** Arm context-wide ownership inheritance: runs before site JavaScript in
 * every new document, and a popup inherits ownership only from an exact
 * marked opener — unrelated new tabs stay untouched. Per-page scripts
 * installed at positive claim remain the unconditional
 * navigation-persistence layer. */
export function installRunOwnershipInheritScript(
  context: BrowserContext,
  marker: string,
): Promise<Disposable> {
  return context.addInitScript(
    ({ property, marker: expectedMarker }: { property: string; marker: string }) => {
      const own = Object.getOwnPropertyDescriptor(window, property);
      if (
        own?.value === expectedMarker &&
        own.enumerable === false &&
        own.configurable === false &&
        own.writable === false
      ) {
        return;
      }
      try {
        const opener = window.opener as (Window & Record<string, unknown>) | null;
        if (opener?.[property] !== expectedMarker) return;
        Object.defineProperty(window, property, {
          value: expectedMarker,
          enumerable: false,
          configurable: false,
          writable: false,
        });
      } catch {
        // A cross-origin or explicitly severed opener is not evidence.
      }
    },
    { property: RUN_PAGE_OWNERSHIP_PROPERTY, marker },
  );
}
