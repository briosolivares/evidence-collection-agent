import type {
  BrowserObservation,
  BrowserObserveRequest,
  BrowserPage,
} from './browserState.js';

/** Options controlling a browser screenshot. */
export interface BrowserScreenshotOptions {
  /** Capture the entire scrollable page instead of only the viewport. */
  fullPage?: boolean;
}

/** An HTTP response fetched through the browser session. */
export interface BrowserFetchResult {
  /** HTTP response status code. */
  status: number;
  /** Response headers, keyed case-insensitively using lower-case names. */
  headers: Readonly<Record<string, string>>;
  /** Complete response body. */
  bytes: Uint8Array;
}

/** A resource captured through an actual browser page or download event. */
export interface BrowserDownloadResult {
  /** Final resource URL after redirects, or a browser-generated blob URL. */
  finalUrl: string;
  /** HTTP status when the capture came from a navigation response. */
  status?: number;
  /** Response headers when available, keyed using lower-case names. */
  headers: Readonly<Record<string, string>>;
  /** Complete downloaded response bytes. */
  bytes: Uint8Array;
  /** Browser-provided filename for attachment/download-event captures. */
  suggestedFilename?: string;
}

/** A browser-native download source: an observed page ref or verified URL. */
export type BrowserDownloadTarget = { ref: string } | { url: string };

/** Error raised when a ref from an outline no longer identifies an element. */
export class BrowserRefNotFoundError extends Error {
  /** Ref that could not be resolved. */
  readonly ref: string;

  constructor(ref: string) {
    super(`Browser ref ${ref} is unavailable; inspect the page again before acting.`);
    this.name = 'BrowserRefNotFoundError';
    this.ref = ref;
  }
}

/**
 * Engine-neutral control surface for one browser session.
 *
 * A session owns at most one task tab at a time. Calling {@link newTab}
 * starts a run with a fresh page; calling {@link closeTab} ends that run
 * without closing the underlying browser session or its shared state.
 */
export interface BrowserController {
  /**
   * Open a fresh blank tab for a task run.
   *
   * @returns nothing; a new active tab whose URL is `about:blank` is ready
   *   for browser operations. Rejects if a task tab is already active.
   */
  newTab(): Promise<void>;

  /**
   * Close the active task tab while keeping the browser session alive.
   *
   * @returns nothing; after resolution no task tab is active. Calling this
   *   when no task tab is active is a no-op.
   */
  closeTab(): Promise<void>;

  /**
   * Navigate the active task tab to a URL.
   *
   * @param url - absolute HTTP or HTTPS URL to load
   * @returns nothing; the active tab has reached its load event, including
   *   any redirects, before the promise resolves
   */
  goto(url: string): Promise<void>;

  /**
   * Capture an AI-oriented semantic outline of the active page.
   *
   * @returns a YAML accessibility snapshot covering the full loaded page,
   *   with interactive elements annotated by refs. Consecutive calls on an
   *   unchanged page preserve refs, and returned refs can be passed to the
   *   ref-based methods on this controller.
   */
  outline(): Promise<string>;

  /**
   * Click the element identified by a ref from the latest outline.
   *
   * @param ref - exact element ref returned by {@link outline}
   * @returns nothing; the click has completed. Rejects with
   *   {@link BrowserRefNotFoundError} when the ref is invalid or stale.
   */
  click(ref: string): Promise<void>;

  /**
   * Replace an editable element's value using a ref from the latest outline.
   *
   * @param ref - exact element ref returned by {@link outline}
   * @param text - complete text value to place in the element
   * @returns nothing; the value has been filled. Rejects with
   *   {@link BrowserRefNotFoundError} when the ref is invalid or stale.
   */
  type(ref: string, text: string): Promise<void>;

  /**
   * Scroll the active page downward by approximately one viewport height.
   *
   * @returns nothing; the page has been scrolled before resolution
   */
  scroll(): Promise<void>;

  /**
   * Capture the active page as PNG bytes.
   *
   * @param options - optional viewport or full-page capture selection
   * @returns the complete PNG file bytes without writing an artifact
   */
  screenshot(options?: BrowserScreenshotOptions): Promise<Uint8Array>;

  /**
   * Resolve an element's link destination from a ref in the latest outline.
   *
   * @param ref - exact element ref returned by {@link outline}
   * @returns the absolute link URL, or null when the element has no href.
   *   Rejects with {@link BrowserRefNotFoundError} when the ref is invalid or
   *   stale.
   */
  resolveHref(ref: string): Promise<string | null>;

  /**
   * Fetch a URL through the browser session's request layer.
   *
   * @param url - absolute HTTP or HTTPS URL to request
   * @returns response status, headers, and complete bytes; browser cookies
   *   and session state are included, and non-success statuses still resolve
   */
  fetch(url: string): Promise<BrowserFetchResult>;

  /**
   * Capture a resource through Chrome's page network stack.
   *
   * HTTP(S) refs and URLs are opened in a temporary page so the active task
   * page remains unchanged; the main navigation response or resulting browser
   * download is captured exactly. Refs without an HTTP(S) href are clicked on
   * the active page and must trigger a browser download event.
   *
   * @param target - an inspected page ref or an absolute HTTP(S) URL
   * @returns exact bytes plus the final URL and available response metadata
   */
  download(target: BrowserDownloadTarget): Promise<BrowserDownloadResult>;

  /**
   * Read the active task tab's current URL.
   *
   * @returns the absolute current URL, including the landed URL after a
   *   redirect. Throws when no task tab is active.
   */
  currentUrl(): string;

  /**
   * Read the active task tab's document title.
   *
   * @returns the current document title. Rejects when no task tab is active.
   */
  title(): Promise<string>;

  /**
   * List every tracked page (task tab and popups) with stable identity.
   *
   * @returns one {@link BrowserPage} per live tracked page, in tracking
   *   order. Internal throwaway pages (e.g. download capture pages) never
   *   appear. Listing never advances any page's observation id.
   */
  pages(): Promise<BrowserPage[]>;

  /**
   * Take a fresh snapshot of a page in the requested representations.
   *
   * @param request - page selection, requested needs, and an optional diff
   *   baseline; omitted entirely means an interactive snapshot of the
   *   selected page
   * @returns the new observation: the page (with its incremented
   *   observation id), one bounded view per need, the observed elements,
   *   and changes vs the requested baseline. An evicted or unknown
   *   baseline degrades to `basis: 'full_snapshot'` — never an error.
   */
  observe(request?: BrowserObserveRequest): Promise<BrowserObservation>;

  /**
   * Select a tracked page as the target of the single-page methods
   * (goto/outline/click/type/...) — how legacy tools reach a popup.
   *
   * @param pageId - a page id from {@link pages} or an observation
   * @returns the selected page's current state with `active: true`.
   *   Rejects when the id names no live tracked page.
   */
  switchPage(pageId: string): Promise<BrowserPage>;

  /**
   * Close the browser session and every page it owns.
   *
   * @returns nothing; all browser resources are released. Repeated calls are
   *   safe and no later browser operation may succeed.
   */
  close(): Promise<void>;
}
