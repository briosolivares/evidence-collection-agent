/**
 * The run's record of which URLs the agent actually saw (T11), and the gate
 * that turns that record into permission to read a resource anonymously.
 *
 * `read_resource` is a network capability handed to a model: without a gate
 * it can request any URL it can imagine, which turns the run into an
 * open proxy for whatever the model was talked into by page content. The
 * gate here is the *provenance* half of that defence (the address half lives
 * in publicResourceReader.ts, and both must pass):
 *
 * 1. A site the agent DELIBERATELY navigated to is readable origin-wide.
 *    Deliberate navigation is the only source that widens permission beyond
 *    one URL, because it is the only source a human-authored task or an
 *    explicit tool call put there.
 * 2. Any other sighting — a link in an observation, a URL seen in browser
 *    network metadata, a URL named in the task text — grants exactly that
 *    one URL. Seeing `https://cdn.example/a.json` never implies
 *    `https://cdn.example/b.json`.
 *
 * Two deliberate non-features:
 *
 * - Origin, not registrable domain, is the unit of a "site". Treating
 *   `api.example.com` as covered by a visit to `www.example.com` requires
 *   guessing the public suffix, and guessing wrong grants an origin nobody
 *   visited. A same-site subdomain that the page actually talks to shows up
 *   as an observed URL anyway, which is the narrower and correct grant.
 * - Nothing recorded here comes from a body fetched by `read_resource`
 *   itself. Auto-recording links out of anonymously fetched HTML would turn
 *   one allowed read into an unbounded crawl, with the fetched page choosing
 *   the next target — the exact escalation this module exists to stop.
 *
 * The index is bounded and evicts oldest-first. Eviction fails closed: a
 * forgotten URL is simply no longer allowed, and the model is told to
 * observe it again.
 */

/**
 * How a URL came to the agent's attention. Only `deliberate_navigation`
 * widens permission to a whole origin; every other source grants the exact
 * URL and nothing else.
 */
export type DiscoveredUrlSource =
  /** A `navigate`/`browser_action` navigation the model asked for, or a
   * redirect it landed on. Grants the origin. */
  | 'deliberate_navigation'
  /** A URL written in the task text. Grants that URL only — the task named
   * a document, not a permission to roam the host. */
  | 'task_input'
  /** A link or other URL-valued attribute seen in a page observation. */
  | 'observed_link'
  /** A URL seen in the browser's own network metadata (a request the page
   * made, or a response the runtime recorded). */
  | 'network_response';

/** Sources that widen permission from one URL to a whole origin. */
const ORIGIN_GRANTING_SOURCES: ReadonlySet<DiscoveredUrlSource> = new Set<DiscoveredUrlSource>([
  'deliberate_navigation',
]);

/** Why a URL is not readable. `not_observed` is the interesting one — the
 * rest are shapes we refuse to track at all. */
export type ResourceUrlRejection =
  | 'malformed_url'
  | 'unsupported_scheme'
  | 'embedded_credentials'
  | 'url_too_long'
  | 'not_observed';

/**
 * The gate's answer. A decision object rather than a bare boolean on
 * purpose: every refusal has to reach the model as a sentence it can act on
 * ("observe the page again", "navigate there first"), and a boolean makes an
 * empty error message the path of least resistance.
 */
export type ResourceUrlDecision =
  | {
      allowed: true;
      /** `visited_origin` when the site was deliberately visited;
       * `observed_url` when this exact URL was seen. */
      basis: 'visited_origin' | 'observed_url';
      /** The URL in the normalized form the index keys on — pass THIS to the
       * reader so the thing that was checked is the thing that is fetched. */
      normalizedUrl: string;
    }
  | {
      allowed: false;
      rejection: ResourceUrlRejection;
      /** Model-facing explanation, ending in what to do instead. */
      reason: string;
    };

/** Longest URL the index will track or judge. Well past every real resource
 * URL; a longer one is a smuggling attempt or a bug, and either way is
 * cheaper to refuse than to store. */
export const MAX_RESOURCE_URL_CHARS = 4_096;

/** Exact URLs remembered before oldest-first eviction. */
export const DEFAULT_MAX_OBSERVED_URLS = 2_000;

/** Visited origins remembered before oldest-first eviction. Far smaller
 * than the URL window: a run visits a handful of sites and reads many URLs
 * from them. */
export const DEFAULT_MAX_VISITED_ORIGINS = 200;

/** Options for {@link createDiscoveredUrlIndex}. */
export interface DiscoveredUrlIndexOptions {
  /** Exact URLs kept; must be a positive safe integer (safe-integer implies
   * finite, so NaN/Infinity are rejected). */
  maxObservedUrls?: number;
  /** Visited origins kept; must be a positive safe integer. */
  maxVisitedOrigins?: number;
}

/**
 * The run's provenance index over URLs. In-memory and per-session: a new
 * browser session starts with no permissions, which is why a resumed run
 * must re-observe before reading.
 */
export interface DiscoveredUrlIndex {
  /**
   * Remember one sighting. The implementation seam — call
   * {@link recordObservedUrl} at ordinary call sites.
   */
  record(url: string, source: DiscoveredUrlSource): boolean;
  /**
   * Judge one URL. The implementation seam — call
   * {@link isAllowedResourceUrl} at ordinary call sites.
   */
  decide(url: string): ResourceUrlDecision;
  /** Origins currently readable in full, oldest first. Diagnostics only. */
  visitedOrigins(): readonly string[];
  /** Exact URLs currently readable, oldest first. Diagnostics only. */
  observedUrls(): readonly string[];
}

/**
 * Create an empty per-session URL provenance index.
 *
 * @param options - bounded window sizes; see
 *   {@link DiscoveredUrlIndexOptions}
 * @returns an index that starts denying everything and only grants what it
 *   is told was seen
 * @throws TypeError when a window size is not a positive safe integer
 */
export function createDiscoveredUrlIndex(
  options: DiscoveredUrlIndexOptions = {},
): DiscoveredUrlIndex {
  const maxObservedUrls = options.maxObservedUrls ?? DEFAULT_MAX_OBSERVED_URLS;
  const maxVisitedOrigins = options.maxVisitedOrigins ?? DEFAULT_MAX_VISITED_ORIGINS;
  assertPositiveSafeInteger('maxObservedUrls', maxObservedUrls);
  assertPositiveSafeInteger('maxVisitedOrigins', maxVisitedOrigins);

  // Insertion-ordered maps double as the eviction queue: re-recording a
  // sighting deletes and re-inserts, so the retained window is the most
  // recently seen URLs rather than the first ones a run happened to hit.
  const observedUrls = new Map<string, DiscoveredUrlSource>();
  const visitedOrigins = new Map<string, true>();

  return {
    record(url, source) {
      const parsed = parseTrackableUrl(url);
      if (parsed === undefined) {
        return false;
      }
      remember(observedUrls, parsed.normalizedUrl, source, maxObservedUrls);
      if (ORIGIN_GRANTING_SOURCES.has(source)) {
        remember(visitedOrigins, parsed.origin, true, maxVisitedOrigins);
      }
      return true;
    },

    decide(url) {
      const refusal = describeUntrackable(url);
      if (refusal !== undefined) {
        return refusal;
      }
      // parseTrackableUrl agrees with describeUntrackable by construction:
      // one returned undefined exactly when the other did not.
      const parsed = parseTrackableUrl(url)!;
      if (visitedOrigins.has(parsed.origin)) {
        return {
          allowed: true,
          basis: 'visited_origin',
          normalizedUrl: parsed.normalizedUrl,
        };
      }
      if (observedUrls.has(parsed.normalizedUrl)) {
        return {
          allowed: true,
          basis: 'observed_url',
          normalizedUrl: parsed.normalizedUrl,
        };
      }
      return {
        allowed: false,
        rejection: 'not_observed',
        reason:
          `${parsed.normalizedUrl} was never observed in this session and ` +
          `${parsed.origin} was never visited, so it cannot be read. Navigate to ` +
          `the page that publishes it (or observe that page again, since older ` +
          `sightings are forgotten) and use a URL taken from what you saw.`,
      };
    },

    visitedOrigins: () => [...visitedOrigins.keys()],
    observedUrls: () => [...observedUrls.keys()],
  };
}

/**
 * Remember that a URL was seen.
 *
 * Never throws and never validates on the caller's behalf: this is called
 * from navigation hooks and observation parsing, where a page can legally
 * contain a `javascript:` link or a 5 KB tracking URL, and a throw there
 * would fail an unrelated tool call.
 *
 * @param index - the session's provenance index
 * @param url - the URL as seen, absolute (relative URLs must be resolved by
 *   the caller against the document they came from)
 * @param source - how it was seen; `deliberate_navigation` also grants the
 *   whole origin, every other source grants this URL alone
 * @returns true when the sighting was recorded; false for a URL the index
 *   refuses to track (unparsable, non-HTTP(S), credential-bearing, or over
 *   {@link MAX_RESOURCE_URL_CHARS})
 */
export function recordObservedUrl(
  index: DiscoveredUrlIndex,
  url: string,
  source: DiscoveredUrlSource,
): boolean {
  return index.record(url, source);
}

/**
 * Decide whether a resource URL may be read.
 *
 * @param index - the session's provenance index
 * @param url - the URL the model asked to read
 * @returns an allow decision carrying the normalized URL to fetch and which
 *   grant justified it, or a refusal carrying a model-facing reason. This is
 *   the provenance check ONLY — the caller must still put the URL through
 *   `assertPublicHttpUrl` and the per-hop address checks, because "the page
 *   linked to it" says nothing about whether it points at localhost
 */
export function isAllowedResourceUrl(
  index: DiscoveredUrlIndex,
  url: string,
): ResourceUrlDecision {
  return index.decide(url);
}

/** The two keys one URL contributes: its exact normalized form and its
 * origin. */
interface TrackableUrl {
  normalizedUrl: string;
  origin: string;
}

/**
 * Normalize a URL to the form the index keys on, or undefined when the URL
 * is one we refuse to track.
 *
 * Normalization drops exactly one thing — the fragment — because a fragment
 * is never sent to a server, so two URLs differing only there name the same
 * resource. The query string is preserved verbatim: for an API endpoint the
 * query IS the resource, and folding it away would let one observed URL
 * authorize every parameterization of it.
 */
function parseTrackableUrl(url: string): TrackableUrl | undefined {
  if (typeof url !== 'string' || url.length > MAX_RESOURCE_URL_CHARS) {
    return undefined;
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return undefined;
  }
  // A credential-bearing URL is never tracked, so it can never be allowed
  // by an exact match either. The reader refuses these as well; keeping both
  // gates honest means neither one carries the whole weight.
  if (parsed.username !== '' || parsed.password !== '') {
    return undefined;
  }
  if (parsed.hostname === '') {
    return undefined;
  }
  parsed.hash = '';
  return { normalizedUrl: parsed.href, origin: parsed.origin };
}

/** The refusal `decide` must return for a URL the index will not track, or
 * undefined when the URL is trackable. Kept next to
 * {@link parseTrackableUrl} so the two cannot drift into disagreeing about
 * what is trackable. */
function describeUntrackable(url: string): ResourceUrlDecision | undefined {
  if (typeof url !== 'string' || url.length > MAX_RESOURCE_URL_CHARS) {
    return {
      allowed: false,
      rejection: 'url_too_long',
      reason:
        `Resource URLs are limited to ${MAX_RESOURCE_URL_CHARS} characters. ` +
        `Read the resource through the page that serves it instead.`,
    };
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return {
      allowed: false,
      rejection: 'malformed_url',
      reason:
        `${JSON.stringify(url)} is not an absolute URL. Pass the complete ` +
        `URL exactly as it appeared, including the scheme and host.`,
    };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return {
      allowed: false,
      rejection: 'unsupported_scheme',
      reason:
        `Only http and https resources can be read; ${parsed.protocol} is not ` +
        `supported. Open the source in the browser instead.`,
    };
  }
  if (parsed.username !== '' || parsed.password !== '') {
    return {
      allowed: false,
      rejection: 'embedded_credentials',
      reason:
        `Resource URLs must not carry credentials (user:password@host). ` +
        `Remove them and read the resource from the page that publishes it.`,
    };
  }
  if (parsed.hostname === '') {
    return {
      allowed: false,
      rejection: 'malformed_url',
      reason: `${JSON.stringify(url)} has no host. Pass an absolute http(s) URL.`,
    };
  }
  return undefined;
}

/** Insert into a bounded, insertion-ordered window, refreshing the position
 * of an existing key and evicting the oldest entries past the limit. */
function remember<Value>(
  window: Map<string, Value>,
  key: string,
  value: Value,
  limit: number,
): void {
  window.delete(key);
  window.set(key, value);
  while (window.size > limit) {
    // Map iteration is insertion order, so the first key is the oldest.
    const oldest = window.keys().next();
    if (oldest.done === true) {
      return;
    }
    window.delete(oldest.value);
  }
}

function assertPositiveSafeInteger(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${name} must be a positive safe integer: ${String(value)}`);
  }
}
