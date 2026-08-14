/**
 * Engine-neutral browser identity model (T9): pages, frames, documents,
 * observations, and element references.
 *
 * The identity rules the rest of the system builds on:
 * - `pageId` and `frameId` are stable for the lifetime of the runtime page
 *   or frame — navigation never changes them.
 * - `documentId` changes exactly when navigation, reload, or frame
 *   replacement creates a new document. Refs bound to a replaced document
 *   are stale; refs in a merely mutated document are not.
 * - `observationId` increments only when the runtime returns a new snapshot
 *   of a page. Listing pages, switching pages, or acting never advances it.
 * - `basedOnObservationId` is a *requested diff baseline*, not an optimistic
 *   lock: an evicted baseline degrades to a bounded full snapshot
 *   (`basis: 'full_snapshot'`), never to a stale error.
 */

/** Identity and location of one frame inside a page. The main frame is
 * listed first in {@link BrowserPage.frames} and shares the page's
 * `documentId`. */
export interface BrowserFrame {
  /** Stable runtime frame id; survives navigations of the same frame. */
  frameId: string;
  /** Current document in the frame; rotates on every frame navigation. */
  documentId: string;
  /** The frame's current URL. */
  url: string;
}

/** One browser page (task tab or popup) as the runtime tracks it. */
export interface BrowserPage {
  /** Stable runtime page id; survives navigation, rotates never. */
  pageId: string;
  /** The main frame's current document id. */
  documentId: string;
  /** Latest observation number for this page (0 before any observation). */
  observationId: number;
  /** The page's current URL. */
  url: string;
  /** The page's current document title ('' when unavailable mid-navigation). */
  title: string;
  /** True iff this is the selected page that legacy single-page tools
   * (goto/outline/click/...) currently operate on. */
  active: boolean;
  /** Every live frame, main frame first, so an {@link ElementRef.frameId}
   * always names an entry here. */
  frames: BrowserFrame[];
}

/**
 * A durable reference to one observed element, bound to the page, frame,
 * and document it was observed in. Resolution order is exact node (via the
 * stable locator stamped at observation time), then a unique role/name
 * match in the same document. `ordinal` is a display hint only — a
 * mutating action must NEVER be retargeted by ordinal, because after a
 * list reorder the same ordinal names a different row.
 */
export interface ElementRef {
  /** Opaque stable element id, unique per document node. */
  id: string;
  /** Page the element was observed in. */
  pageId: string;
  /** Frame the element was observed in. */
  frameId: string;
  /** Document the element belongs to; a rotated documentId makes the ref
   * stale by definition. */
  documentId: string;
  /** Browser-internal node id when the engine exposes one. The Playwright
   * implementation does not populate this yet; the stamped stable locator
   * provides equivalent same-document exact-node identity. */
  backendNodeId?: number;
  /** Engine-resolvable locator that identifies the exact node within its
   * document (survives reorders and unrelated mutation, dies with the
   * document). */
  stableLocator?: string;
  /** ARIA role at observation time (fallback match key). */
  role: string;
  /** Accessible name at observation time (fallback match key). */
  name: string;
  /** Zero-based position among same-role/name siblings at observation
   * time. A display hint only; never sufficient for a mutating fallback
   * match. */
  ordinal?: number;
}

/** The page representations a caller can request. T9 supports the compact
 * interactive outline and exact text; T11 adds table/visual/document. */
export type ObservationNeed = 'interactive' | 'text';

/** A request for one page observation. */
export interface BrowserObserveRequest {
  /** Page to observe; omitted means the currently selected page. */
  pageId?: string;
  /** Representations to return, deduplicated in request order; defaults to
   * `['interactive']`. */
  need?: readonly ObservationNeed[];
  /** Prior observation to diff against. A missing/evicted baseline returns
   * `basis: 'full_snapshot'` — never an error. */
  basedOnObservationId?: number;
}

/** One returned page representation. */
export interface ObservationView {
  need: ObservationNeed;
  /** The bounded representation: semantic outline for `interactive`, exact
   * rendered text for `text`. */
  content: string;
  /** True when `content` was cut at the per-view bound. */
  truncated: boolean;
}

/** What changed relative to the requested baseline observation. */
export interface PageChanges {
  /** `requested_observation` when the diff was computed against the
   * requested baseline; `full_snapshot` when no usable baseline existed
   * (none requested, or the cache entry was evicted) — the views then
   * carry the whole picture and the diff arrays stay empty. */
  basis: 'requested_observation' | 'full_snapshot';
  /** True when the page's document was replaced since the baseline. */
  navigated: boolean;
  /** Before/after URL, present only when `navigated` is true. */
  url?: { before: string; after: string };
  /** Elements observed now but absent from the baseline (bounded). */
  newlyVisible: ElementRef[];
  /** Ids of baseline elements no longer observed (bounded). */
  noLongerVisibleElementIds: string[];
  /** Elements whose accessible name changed since the baseline (bounded). */
  updatedText: Array<{ elementId?: string; text: string }>;
}

/** A fresh page snapshot: the page's identity, the requested views, the
 * observed interactive elements, and changes vs the requested baseline. */
export interface BrowserObservation {
  /** The page after this observation; `page.observationId` is the NEW
   * snapshot's number. */
  page: BrowserPage;
  /** One view per requested need, in request order. */
  views: ObservationView[];
  /** Interactive elements with full identity (empty unless `interactive`
   * was requested). */
  elements: ElementRef[];
  /** Diff vs the requested baseline (see {@link PageChanges.basis}). */
  changes: PageChanges;
}

/** The element-level facts one recorded observation keeps for later diffs. */
export interface ObservationSnapshot {
  /** Document the snapshot described. */
  documentId: string;
  /** Page URL at snapshot time. */
  url: string;
  /** Interactive elements visible in the snapshot. */
  elements: readonly ElementRef[];
}

/** A recorded observation retrievable as a diff baseline. */
export interface StoredObservation extends ObservationSnapshot {
  observationId: number;
}

/** Observation baselines kept per page before eviction. Small on purpose:
 * baselines exist to answer "what changed since I last looked", and a
 * model that reaches further back gets a full snapshot instead. */
export const DEFAULT_MAX_CACHED_OBSERVATIONS_PER_PAGE = 4;

/** Options for {@link createBrowserStateStore}. */
export interface BrowserStateStoreOptions {
  /** Diff baselines kept per page; older ones are evicted (and later
   * requests for them degrade to full snapshots). Must be a positive safe
   * integer — safe-integer implies finite, so NaN/Infinity are rejected. */
  maxCachedObservationsPerPage?: number;
}

/**
 * Identity issuance and observation bookkeeping shared by browser
 * controllers. Pure state — no engine types — so identity semantics stay
 * testable without a browser.
 */
export interface BrowserStateStore {
  /** Issue the next stable page id. */
  createPageId(): string;
  /** Issue the next stable frame id. */
  createFrameId(): string;
  /** Issue the next document id (one per created/replaced document). */
  createDocumentId(): string;
  /** Issue the next stable element id. */
  createElementId(): string;
  /**
   * Record a new snapshot for a page.
   *
   * @param pageId - page the snapshot belongs to
   * @param snapshot - the snapshot's document, URL, and elements
   * @returns the page's new observation number. Numbers increment per page
   *   and never reset, even after cache eviction or across documents.
   */
  recordObservation(pageId: string, snapshot: ObservationSnapshot): number;
  /**
   * Look up a recorded observation to use as a diff baseline.
   *
   * @returns the stored observation, or undefined when it was never
   *   recorded or has been evicted — the caller must then produce a full
   *   snapshot, never a stale error.
   */
  getObservation(pageId: string, observationId: number): StoredObservation | undefined;
  /**
   * Find the full ref for an element id, searching the page's retained
   * observations newest-first.
   *
   * Newest-first rather than latest-only because an observation records only
   * the elements its requested needs produced: a text-only observe records
   * none at all, so "the page's latest observation" routinely does not
   * contain a ref the model legitimately still holds. Searching the retained
   * window keeps an id usable until it is evicted, and loses no safety —
   * the returned ref carries the documentId it was seen in, and resolving it
   * rejects a rotated document.
   *
   * @returns the ref as recorded, or undefined when no retained observation
   *   of that page contains the id
   */
  findObservedElement(pageId: string, elementId: string): ElementRef | undefined;
  /** The page's latest observation number, or 0 before any observation. */
  latestObservationId(pageId: string): number;
  /** Drop all state for a closed page. Its ids are never reused. */
  forgetPage(pageId: string): void;
}

/** Upper bound on entries per {@link PageChanges} array so a huge page
 * cannot balloon every diff. Exported so callers and tests state the bound
 * instead of hardcoding a copy of it. */
export const MAX_CHANGE_ENTRIES = 100;

/**
 * Create an in-memory browser state store.
 *
 * @param options - cache sizing; see {@link BrowserStateStoreOptions}
 * @returns a store issuing monotonic ids ('page-1', 'frame-1', 'doc-1',
 *   'el-1', ...) and keeping the most recent observations per page
 * @throws TypeError when `maxCachedObservationsPerPage` is not a positive
 *   safe integer
 */
export function createBrowserStateStore(
  options: BrowserStateStoreOptions = {},
): BrowserStateStore {
  const maxCached =
    options.maxCachedObservationsPerPage ?? DEFAULT_MAX_CACHED_OBSERVATIONS_PER_PAGE;
  if (!Number.isSafeInteger(maxCached) || maxCached < 1) {
    throw new TypeError(
      `maxCachedObservationsPerPage must be a positive safe integer: ${String(maxCached)}`,
    );
  }

  let pageSequence = 0;
  let frameSequence = 0;
  let documentSequence = 0;
  let elementSequence = 0;
  // Newest-last per page; eviction shifts from the front so the retained
  // window is always the most recent baselines.
  const cachedObservations = new Map<string, StoredObservation[]>();
  // Observation counters live outside the cache so eviction never makes a
  // number reappear.
  const observationCounters = new Map<string, number>();

  return {
    createPageId: () => `page-${++pageSequence}`,
    createFrameId: () => `frame-${++frameSequence}`,
    createDocumentId: () => `doc-${++documentSequence}`,
    createElementId: () => `el-${++elementSequence}`,

    recordObservation(pageId, snapshot) {
      const observationId = (observationCounters.get(pageId) ?? 0) + 1;
      observationCounters.set(pageId, observationId);
      const cache = cachedObservations.get(pageId) ?? [];
      // Copy the elements array so later caller mutation cannot rewrite a
      // recorded baseline.
      cache.push({ ...snapshot, elements: [...snapshot.elements], observationId });
      while (cache.length > maxCached) {
        cache.shift();
      }
      cachedObservations.set(pageId, cache);
      return observationId;
    },

    getObservation(pageId, observationId) {
      return cachedObservations
        .get(pageId)
        ?.find((stored) => stored.observationId === observationId);
    },

    findObservedElement(pageId, elementId) {
      const cache = cachedObservations.get(pageId);
      if (cache === undefined) return undefined;
      for (let index = cache.length - 1; index >= 0; index -= 1) {
        const found = cache[index]!.elements.find((element) => element.id === elementId);
        if (found !== undefined) return found;
      }
      return undefined;
    },

    latestObservationId(pageId) {
      return observationCounters.get(pageId) ?? 0;
    },

    forgetPage(pageId) {
      cachedObservations.delete(pageId);
      observationCounters.delete(pageId);
    },
  };
}

/**
 * Compute what changed between a baseline observation and the current
 * snapshot.
 *
 * @param baseline - the requested baseline, or undefined when none was
 *   requested or it was evicted
 * @param current - the snapshot just taken
 * @returns bounded changes. No baseline yields `basis: 'full_snapshot'`
 *   with empty diff arrays (the views carry everything). A replaced
 *   document yields `navigated: true` with the URL transition and a full
 *   element turnover. Same-document diffs match elements by their stable
 *   ids, so unrelated mutation shows up as small, precise deltas.
 */
export function diffObservations(
  baseline: StoredObservation | undefined,
  current: ObservationSnapshot,
): PageChanges {
  if (baseline === undefined) {
    return {
      basis: 'full_snapshot',
      navigated: false,
      newlyVisible: [],
      noLongerVisibleElementIds: [],
      updatedText: [],
    };
  }

  if (baseline.documentId !== current.documentId) {
    return {
      basis: 'requested_observation',
      navigated: true,
      url: { before: baseline.url, after: current.url },
      newlyVisible: current.elements.slice(0, MAX_CHANGE_ENTRIES),
      noLongerVisibleElementIds: baseline.elements
        .slice(0, MAX_CHANGE_ENTRIES)
        .map((element) => element.id),
      updatedText: [],
    };
  }

  const baselineById = new Map(baseline.elements.map((element) => [element.id, element]));
  const currentIds = new Set(current.elements.map((element) => element.id));
  return {
    basis: 'requested_observation',
    navigated: false,
    newlyVisible: current.elements
      .filter((element) => !baselineById.has(element.id))
      .slice(0, MAX_CHANGE_ENTRIES),
    noLongerVisibleElementIds: baseline.elements
      .filter((element) => !currentIds.has(element.id))
      .slice(0, MAX_CHANGE_ENTRIES)
      .map((element) => element.id),
    updatedText: current.elements
      .filter((element) => {
        const before = baselineById.get(element.id);
        return before !== undefined && before.name !== element.name;
      })
      .slice(0, MAX_CHANGE_ENTRIES)
      .map((element) => ({ elementId: element.id, text: element.name })),
  };
}
