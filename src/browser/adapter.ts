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

/** Configuration for launching a persistent local Chrome session. */
export interface BrowserLaunchOptions {
  /** Absolute path to the persistent Chrome profile directory. */
  profileDir: string;
  /** Whether Chrome runs without a visible window; defaults to false. */
  headless?: boolean;
}

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
 * Engine-neutral control surface for one persistent browser session.
 *
 * A session owns at most one task tab at a time. Calling {@link newTab}
 * starts a run with a fresh page; calling {@link closeTab} ends that run
 * without closing the underlying browser or its shared profile.
 */
export interface BrowserAdapter {
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
   *   ref-based methods on this adapter.
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
   * Fetch a URL through the persistent browser context's request layer.
   *
   * @param url - absolute HTTP or HTTPS URL to request
   * @returns response status, headers, and complete bytes; browser cookies
   *   and session state are included, and non-success statuses still resolve
   */
  fetch(url: string): Promise<BrowserFetchResult>;

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
   * Close the persistent browser session and every page it owns.
   *
   * @returns nothing; all browser resources are released. Repeated calls are
   *   safe and no later browser operation may succeed.
   */
  close(): Promise<void>;
}
