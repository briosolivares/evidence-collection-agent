/**
 * Anonymous reads of public HTTP(S) resources (T11).
 *
 * This module is the network side of a capability the model drives, so it is
 * written as a gate first and a fetcher second. Two independent properties
 * have to hold, and neither is allowed to depend on the other:
 *
 * 1. **Anonymity.** The read goes through a context created HERE, with no
 *    profile, no cookie jar carried in, no `Authorization` header, and no
 *    stored HTTP credentials. The agent's logged-in Chrome profile is a
 *    different process-level object entirely; nothing in this file can reach
 *    it. That is what makes "read this endpoint" safe to offer at all: a
 *    resource read can never spend the user's session on a URL that page
 *    content suggested.
 * 2. **Destination.** Every hop — the first request and every redirect — is
 *    re-parsed, re-resolved, and re-classified before it is contacted, and
 *    the redirect count is bounded. `assertPublicHttpUrl` refuses non-HTTP
 *    schemes, credential-bearing URLs, and every address class that is not
 *    public Internet: loopback, private, carrier-private, link-local
 *    (169.254/16 — the cloud metadata service), multicast, reserved, and the
 *    IPv6 spellings that embed an IPv4 address. Numeric host spellings
 *    (decimal, octal, hex) are normalized by the WHATWG URL parser before
 *    classification, and a numeric host the parser did NOT normalize is
 *    refused rather than guessed at.
 *
 * Provenance — whether the model was ever allowed to name this URL — is the
 * separate concern of `discoveredUrlIndex.ts`. Both gates run; neither
 * substitutes for the other. A page-linked URL can still point at
 * `169.254.169.254`, and a public URL the model invented is still not
 * readable.
 *
 * **Residual risk, stated rather than hidden.** Validation resolves a
 * hostname and then hands the URL to the transport, which resolves it again;
 * a DNS answer that changes between those two moments (classic rebinding)
 * is not closed by re-resolution alone. Closing it requires pinning the
 * validated address and connecting to it with an explicit `Host` header,
 * which Playwright's request API does not expose. Re-resolving per hop
 * shrinks the window to a single request and catches every *static* private
 * answer, which is the failure mode reachable from page content today. A
 * client that pins addresses can be supplied through
 * {@link PublicResourceReaderOptions.createClient} without touching this
 * gate.
 *
 * INTEGRATION (T11) — not wired into the registry by this task:
 * - The evidence kind these records want is `network_response`; the store
 *   currently accepts only `javascript_extraction`, so records are filed
 *   under that kind with `detail.recordType = 'network_response'` (see
 *   {@link PENDING_RESOURCE_EVIDENCE_KIND}). Adding the kind to
 *   `src/evidence/evidenceStore.ts` and swapping the constant is the whole
 *   migration.
 * - The session owner should record deliberate navigations, observed links,
 *   and browser network metadata into a per-session `DiscoveredUrlIndex`
 *   (see `discoveredUrlIndex.ts`), and pass the same index to
 *   `createReadResourceTool`.
 * - {@link PublicResourceReaderOptions.allowNonPublicAddressesForTests} must
 *   never be set by production wiring. It exists so the hermetic loopback
 *   fixture server can be read at all, and it is not reachable from tool
 *   input.
 */

import { lookup } from 'node:dns/promises';

import { request } from 'playwright';

import { recordEvidence, type Evidence, type EvidenceKind, type EvidenceStore } from '../evidence/evidenceStore.js';

/** Longest URL this reader will accept, in characters. Matches the index's
 * bound so a URL cannot be trackable but unreadable, or vice versa. */
export const MAX_RESOURCE_URL_CHARS = 4_096;

/** Longest hostname, per DNS. A longer one cannot resolve, so refusing it
 * here only avoids handing an absurd string to the resolver. */
const MAX_HOSTNAME_CHARS = 253;

/** Default bound on retained response bytes: 1 MiB is a large JSON/CSV
 * export and still a fraction of process memory. */
export const DEFAULT_MAX_RESOURCE_BYTES = 1_048_576;

/** Largest byte bound a caller may request. */
export const MAX_RESOURCE_BYTES = 8_388_608;

/**
 * Advertised `content-length` above which the response is refused outright.
 * The transport buffers a whole body before this module can truncate it, so
 * the byte bound alone does not bound memory — this does, for every server
 * honest enough to advertise a length. A chunked response without one can
 * still overshoot; that is the documented limit of buffering transports.
 */
export const MAX_BUFFERED_RESPONSE_BYTES = 33_554_432;

/** Default per-hop timeout. */
export const DEFAULT_RESOURCE_TIMEOUT_MS = 15_000;

/** Largest per-hop timeout a caller may request. */
export const MAX_RESOURCE_TIMEOUT_MS = 60_000;

/** Default redirect budget. Enough for the http→https→canonical-host chains
 * real sites use, small enough that a redirect loop costs five requests. */
export const DEFAULT_MAX_REDIRECTS = 5;

/** Largest redirect budget a caller may request. */
export const MAX_REDIRECT_LIMIT = 10;

/** Statuses that continue a redirect chain. 300 (multiple choices) is not
 * here: it has no single next hop, so its body is the answer. */
const REDIRECT_STATUSES: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);

/** Low ports that are never a public web resource but are reachable
 * services on a host (SSH, SMTP, Redis-over-inetd, ...). 80 and 443 are the
 * only privileged ports a resource read has any business on. */
const ALLOWED_PRIVILEGED_PORTS: ReadonlySet<number> = new Set([80, 443]);

/**
 * The evidence kind a resource read wants. `evidenceStore.ts` does not
 * accept it yet (see the INTEGRATION note above), so records carry it in
 * `detail.recordType` and are filed under the kind the store does accept.
 */
export const PENDING_RESOURCE_EVIDENCE_KIND = 'network_response';

/** The kind resource evidence is filed under until the store learns
 * `network_response`. */
const RESOURCE_EVIDENCE_KIND: EvidenceKind = 'javascript_extraction';

/** Response headers never copied into an evidence record: persisting cookie
 * material would put credentials in the run directory that the read
 * deliberately did not use. */
const UNRECORDED_HEADERS: ReadonlySet<string> = new Set(['set-cookie', 'set-cookie2']);

/** Why a URL or address was refused. Every value is a distinct, testable
 * class of destination; the reader never collapses them, because the model's
 * next move differs between "that scheme is unsupported" and "that host is
 * inside the network". */
export type PublicUrlRejection =
  | 'malformed_url'
  | 'url_too_long'
  | 'unsupported_scheme'
  | 'embedded_credentials'
  | 'missing_host'
  | 'host_too_long'
  | 'blocked_port'
  | 'ambiguous_numeric_host'
  | 'unresolvable_host'
  | 'loopback'
  | 'private'
  | 'link_local'
  | 'multicast'
  | 'reserved'
  | 'ipv4_mapped_ipv6';

/** A URL or resolved address that must not be contacted. */
export class PublicResourceUrlError extends Error {
  /** Which class of destination was refused. */
  readonly rejection: PublicUrlRejection;
  /** The URL as the caller supplied it. */
  readonly url: string;

  constructor(rejection: PublicUrlRejection, url: string, detail: string) {
    super(`Refusing to read ${url}: ${detail}`);
    this.name = 'PublicResourceUrlError';
    this.rejection = rejection;
    this.url = url;
  }
}

/** Why a read failed after its destination was accepted. */
export type ResourceReadFailure = 'too_many_redirects' | 'response_too_large' | 'transport';

/** A read that never produced a usable response. */
export class PublicResourceReadError extends Error {
  readonly reason: ResourceReadFailure;
  readonly url: string;

  constructor(reason: ResourceReadFailure, url: string, detail: string) {
    super(`Could not read ${url}: ${detail}`);
    this.name = 'PublicResourceReadError';
    this.reason = reason;
    this.url = url;
  }
}

/** What an IP address is, for the purpose of "may the agent contact it". */
export type IpAddressClass =
  | 'public'
  | 'loopback'
  | 'private'
  | 'link_local'
  | 'multicast'
  | 'reserved'
  | 'ipv4_mapped_ipv6'
  /** Not an IP literal we can parse — never treated as public. */
  | 'unparsable';

/**
 * Classify one IP address literal.
 *
 * Accepts a dotted-quad IPv4 or a textual IPv6 (with `::` compression and
 * an optional trailing dotted quad), NOT bracketed. Anything else — a
 * hostname, an octal/hex IPv4 spelling, a zone id — is `unparsable`, which
 * callers must treat as refused: guessing at a spelling the URL parser
 * already declined to normalize is how bypasses happen.
 *
 * @param address - an IP literal, e.g. `10.0.0.1` or `::ffff:7f00:1`
 * @returns the address class; only `public` may be contacted
 */
export function classifyIpAddress(address: string): IpAddressClass {
  const ipv4 = parseIpv4Literal(address);
  if (ipv4 !== undefined) {
    return classifyIpv4(ipv4);
  }
  const ipv6 = parseIpv6Literal(address);
  if (ipv6 !== undefined) {
    return classifyIpv6(ipv6);
  }
  return 'unparsable';
}

/**
 * Validate one URL as a contactable public HTTP(S) resource.
 *
 * Checks, in order: length, parseability, scheme, embedded credentials,
 * host presence and length, privileged port, and — when the host is an IP
 * literal — the address class. The WHATWG parser has already folded decimal
 * (`http://2130706433`), octal (`http://0177.0.0.1`), hex
 * (`http://0x7f000001`), short-form (`http://127.1`), and IDN-digit host
 * spellings into a dotted quad by the time classification runs, so those
 * spellings are refused by the same loopback/private rules as the plain
 * form. A host made only of numeric labels that the parser did NOT fold is
 * refused as ambiguous.
 *
 * A DNS hostname passes this function without being resolved — resolution
 * is asynchronous and belongs to {@link assertPublicResourceTarget}, which
 * every hop of a read goes through. `localhost` (and any `*.localhost`
 * subdomain, which the spec reserves for loopback) is refused by name so a
 * resolver that answers with a public address cannot launder it.
 *
 * @param url - the URL to validate, as a string or parsed URL
 * @returns the parsed URL, fragment intact, safe to resolve and contact
 * @throws PublicResourceUrlError with the specific
 *   {@link PublicUrlRejection} for the class of destination refused
 */
export function assertPublicHttpUrl(url: string | URL): URL {
  return validateReadableUrl(url, true);
}

/**
 * Everything {@link assertPublicHttpUrl} checks except the address class.
 * Exists exclusively for the reader's test relaxation, so that permitting
 * `127.0.0.1` for a hermetic fixture never quietly permits `file:`, a
 * credentialed URL, or a privileged service port as well.
 */
function assertStructurallyReadableUrl(url: string | URL): URL {
  return validateReadableUrl(url, false);
}

/**
 * The single URL gate. `enforceAddressClass` is the only difference between
 * production validation and the test relaxation — one branch, so the two
 * cannot drift apart.
 */
function validateReadableUrl(url: string | URL, enforceAddressClass: boolean): URL {
  const asText = typeof url === 'string' ? url : url.href;
  if (asText.length > MAX_RESOURCE_URL_CHARS) {
    throw new PublicResourceUrlError(
      'url_too_long',
      truncateForMessage(asText),
      `URLs are limited to ${MAX_RESOURCE_URL_CHARS} characters.`,
    );
  }

  let parsed: URL;
  try {
    parsed = new URL(asText);
  } catch {
    throw new PublicResourceUrlError(
      'malformed_url',
      truncateForMessage(asText),
      'it is not an absolute URL.',
    );
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new PublicResourceUrlError(
      'unsupported_scheme',
      asText,
      `only http and https can be read anonymously, not ${parsed.protocol}`,
    );
  }
  // Credentials in a URL are refused rather than stripped: a URL carrying
  // them is a URL someone expected to authenticate, and this reader's entire
  // contract is that it authenticates as nobody.
  if (parsed.username !== '' || parsed.password !== '') {
    throw new PublicResourceUrlError(
      'embedded_credentials',
      redactCredentials(parsed),
      'it embeds credentials (user:password@host), and anonymous reads never authenticate.',
    );
  }
  if (parsed.hostname === '') {
    throw new PublicResourceUrlError('missing_host', asText, 'it has no host.');
  }
  if (parsed.hostname.length > MAX_HOSTNAME_CHARS) {
    throw new PublicResourceUrlError(
      'host_too_long',
      asText,
      `hostnames are limited to ${MAX_HOSTNAME_CHARS} characters.`,
    );
  }
  assertAllowedPort(parsed, asText);

  const literal = ipLiteralOf(parsed.hostname);
  if (literal !== undefined) {
    if (enforceAddressClass) {
      assertPublicAddress(literal, asText);
    }
    return parsed;
  }

  // A bracketed host that is not a parsable IPv6 literal reached us only
  // because some parser disagreed with this one; refuse rather than resolve.
  if (parsed.hostname.startsWith('[')) {
    throw new PublicResourceUrlError(
      'malformed_url',
      asText,
      'its bracketed host is not a valid IPv6 address.',
    );
  }

  const hostname = parsed.hostname.replace(/\.+$/, '').toLowerCase();
  if (enforceAddressClass && (hostname === 'localhost' || hostname.endsWith('.localhost'))) {
    throw new PublicResourceUrlError(
      'loopback',
      asText,
      'the localhost name is reserved for the loopback interface.',
    );
  }
  // Every label numeric-ish (decimal or 0x-hex) means the parser was
  // *supposed* to produce an IPv4 address and did not — no registrable
  // hostname looks like this. Refuse instead of letting the OS resolver
  // decide what `0x7f.1` means.
  if (isNumericHostSpelling(hostname)) {
    throw new PublicResourceUrlError(
      'ambiguous_numeric_host',
      asText,
      'its host is a numeric spelling that is not a valid IP address.',
    );
  }

  return parsed;
}

/** A hostname resolver, narrowed to what validation needs. Injectable so
 * the redirect and rebinding tests are hermetic. */
export interface DnsResolver {
  /**
   * Resolve a hostname to every address it currently maps to.
   *
   * @param hostname - the hostname to resolve
   * @returns every A and AAAA address; an empty array is treated as
   *   unresolvable
   */
  resolve(hostname: string): Promise<readonly string[]>;
}

/** The process resolver. `all: true` matters: validating only the first
 * address would let a host with one public and one loopback answer through
 * whenever the resolver happened to order them favourably. */
export const nodeDnsResolver: DnsResolver = {
  async resolve(hostname: string): Promise<readonly string[]> {
    const answers = await lookup(hostname, { all: true, verbatim: true });
    return answers.map((answer) => answer.address);
  },
};

/**
 * Validate one hop's destination completely: structure, then every address
 * the host currently resolves to.
 *
 * @param url - the hop's URL
 * @param resolver - hostname resolver; defaults to the process resolver
 * @param options - `allowNonPublicAddresses` relaxes ONLY the address-class
 *   check, and exists solely for hermetic loopback fixtures
 * @returns the parsed URL and the addresses that were validated (the IP
 *   literal itself for a literal host)
 * @throws PublicResourceUrlError when the URL is refused, when the host does
 *   not resolve, or when ANY resolved address is not public
 */
export async function assertPublicResourceTarget(
  url: string | URL,
  resolver: DnsResolver = nodeDnsResolver,
  options: { allowNonPublicAddresses?: boolean } = {},
): Promise<{ url: URL; addresses: readonly string[] }> {
  const parsed =
    options.allowNonPublicAddresses === true
      ? assertStructurallyReadableUrl(url)
      : assertPublicHttpUrl(url);

  const literal = ipLiteralOf(parsed.hostname);
  if (literal !== undefined) {
    return { url: parsed, addresses: [literal] };
  }

  let addresses: readonly string[];
  try {
    addresses = await resolver.resolve(parsed.hostname);
  } catch (thrown) {
    throw new PublicResourceUrlError(
      'unresolvable_host',
      parsed.href,
      `its host did not resolve (${thrown instanceof Error ? thrown.message : String(thrown)}).`,
    );
  }
  if (addresses.length === 0) {
    throw new PublicResourceUrlError(
      'unresolvable_host',
      parsed.href,
      'its host resolved to no addresses.',
    );
  }
  if (options.allowNonPublicAddresses !== true) {
    for (const address of addresses) {
      assertPublicAddress(address, parsed.href);
    }
  }
  return { url: parsed, addresses };
}

/** One HTTP response, narrowed to what a resource read needs. Structurally
 * satisfied by Playwright's `APIResponse`. */
export interface AnonymousHttpResponse {
  status(): number;
  /** Response headers with lower-case names. */
  headers(): Record<string, string>;
  /** The URL that produced this response. */
  url(): string;
  /** The complete response body. Called at most once, and never at all for
   * a hop that turns out to be a redirect. */
  body(): Promise<Uint8Array>;
  dispose(): Promise<void>;
}

/** An anonymous HTTP client: one request at a time, redirects under the
 * caller's control. Structurally satisfied by Playwright's
 * `APIRequestContext`. */
export interface AnonymousHttpClient {
  get(
    url: string,
    options?: { maxRedirects?: number; timeout?: number; failOnStatusCode?: boolean },
  ): Promise<AnonymousHttpResponse>;
  dispose(): Promise<void>;
}

/** Options for {@link createAnonymousPlaywrightClient}. */
export interface AnonymousClientOptions {
  /** User agent to send. Omitted means the transport's own — honest about
   * what is calling, at the cost of being blocked by some sites. */
  userAgent?: string;
}

/**
 * Create the anonymous client a read uses by default.
 *
 * Everything that could carry identity is explicitly empty: no storage
 * state, no extra headers, no HTTP credentials, no proxy. TLS errors are not
 * ignored, because a read that silently accepts a bad certificate is a read
 * whose bytes prove nothing.
 *
 * @param options - optional user agent
 * @returns a disposable client with its own empty cookie jar
 */
export async function createAnonymousPlaywrightClient(
  options: AnonymousClientOptions = {},
): Promise<AnonymousHttpClient> {
  const context = await request.newContext({
    // No storageState: the context starts with an empty cookie jar and never
    // sees the agent's Chrome profile.
    extraHTTPHeaders: {},
    ignoreHTTPSErrors: false,
    ...(options.userAgent !== undefined ? { userAgent: options.userAgent } : {}),
  });
  return {
    get: (url, getOptions) => context.get(url, getOptions),
    dispose: () => context.dispose(),
  };
}

/** What a caller asks the reader for. */
export interface ReadResourceRequest {
  /** Absolute HTTP(S) URL. Provenance is the caller's responsibility (see
   * `discoveredUrlIndex.ts`); this reader only judges the destination. */
  url: string;
  /** Bytes to retain, 1..{@link MAX_RESOURCE_BYTES}; defaults to
   * {@link DEFAULT_MAX_RESOURCE_BYTES}. A longer body is truncated with
   * `truncated: true`. */
  maxBytes?: number;
  /** Per-hop timeout in milliseconds, 1..{@link MAX_RESOURCE_TIMEOUT_MS}. */
  timeoutMs?: number;
}

/** One contacted hop: where it went, what it answered, and which addresses
 * were validated before it was contacted. The audit trail that makes a
 * redirect chain reviewable after the fact. */
export interface ResourceHopRecord {
  url: string;
  status: number;
  addresses: readonly string[];
}

/** The result of one anonymous read. */
export interface ReadResourceOutput {
  /** The URL as requested (normalized by the URL parser). */
  requestedUrl: string;
  /** The URL that actually produced the body. */
  finalUrl: string;
  /** Status of the final response; non-2xx statuses are returned, not
   * thrown — a 401 or 403 is exactly the evidence that a resource needs
   * credentials this reader deliberately does not have. */
  status: number;
  /** Final response headers, lower-cased names. */
  headers: Readonly<Record<string, string>>;
  /** `content-type` when the server sent one. */
  contentType?: string;
  /** The original bytes, bounded by `maxBytes`. */
  bytes: Uint8Array;
  /** True when the body was cut at the byte bound. */
  truncated: boolean;
  /** Advertised `content-length`, when the server sent a valid one. */
  advertisedBytes?: number;
  /** Every hop, first request first. */
  hops: readonly ResourceHopRecord[];
}

/** Reads public resources anonymously. */
export interface PublicResourceReader {
  /**
   * Read one resource.
   *
   * @param request - the URL and its bounds
   * @returns the bounded original bytes plus the redirect and address audit
   *   trail
   * @throws PublicResourceUrlError for a refused destination (including one
   *   reached only via redirect), PublicResourceReadError for a transport
   *   failure, an over-large body, or an exhausted redirect budget
   */
  read(request: ReadResourceRequest): Promise<ReadResourceOutput>;
}

/** Options for {@link PlaywrightPublicResourceReader}. */
export interface PublicResourceReaderOptions {
  /** Client factory; defaults to {@link createAnonymousPlaywrightClient}.
   * Called once per read and disposed afterwards, so a cookie a server sets
   * during one read can never be replayed by the next one. Supply a shared
   * client with a no-op `dispose` to pool instead. */
  createClient?: () => Promise<AnonymousHttpClient>;
  /** Hostname resolver; defaults to the process resolver. */
  resolver?: DnsResolver;
  /** Redirect budget, 0..{@link MAX_REDIRECT_LIMIT}. */
  maxRedirects?: number;
  /** Default per-hop timeout when a request does not specify one. */
  timeoutMs?: number;
  /** Default byte bound when a request does not specify one. */
  maxBytes?: number;
  /**
   * TEST ONLY. Skips the address-class check so hermetic fixtures on
   * 127.0.0.1 can be read. Everything else still applies: scheme,
   * credentials, port, redirect bound, and per-hop re-resolution. Production
   * wiring must never set this, and no tool input can reach it.
   */
  allowNonPublicAddressesForTests?: boolean;
}

/**
 * Reads public resources through a fresh anonymous Playwright request
 * context.
 *
 * The class is named for its default transport; the transport itself is an
 * injected seam ({@link PublicResourceReaderOptions.createClient}), which is
 * how the redirect and rebinding behaviour is tested without a network.
 */
export class PlaywrightPublicResourceReader implements PublicResourceReader {
  private readonly createClient: () => Promise<AnonymousHttpClient>;
  private readonly resolver: DnsResolver;
  private readonly maxRedirects: number;
  private readonly defaultTimeoutMs: number;
  private readonly defaultMaxBytes: number;
  private readonly allowNonPublicAddresses: boolean;

  /**
   * @param options - transport, resolver, and bounds; see
   *   {@link PublicResourceReaderOptions}
   * @throws TypeError when a bound is not a finite integer inside its range
   */
  constructor(options: PublicResourceReaderOptions = {}) {
    this.createClient = options.createClient ?? (() => createAnonymousPlaywrightClient());
    this.resolver = options.resolver ?? nodeDnsResolver;
    this.maxRedirects = assertBound(
      'maxRedirects',
      options.maxRedirects ?? DEFAULT_MAX_REDIRECTS,
      0,
      MAX_REDIRECT_LIMIT,
    );
    this.defaultTimeoutMs = assertBound(
      'timeoutMs',
      options.timeoutMs ?? DEFAULT_RESOURCE_TIMEOUT_MS,
      1,
      MAX_RESOURCE_TIMEOUT_MS,
    );
    this.defaultMaxBytes = assertBound(
      'maxBytes',
      options.maxBytes ?? DEFAULT_MAX_RESOURCE_BYTES,
      1,
      MAX_RESOURCE_BYTES,
    );
    this.allowNonPublicAddresses = options.allowNonPublicAddressesForTests === true;
  }

  async read(request: ReadResourceRequest): Promise<ReadResourceOutput> {
    const maxBytes = assertBound(
      'maxBytes',
      request.maxBytes ?? this.defaultMaxBytes,
      1,
      MAX_RESOURCE_BYTES,
    );
    const timeout = assertBound(
      'timeoutMs',
      request.timeoutMs ?? this.defaultTimeoutMs,
      1,
      MAX_RESOURCE_TIMEOUT_MS,
    );
    // Validated before a client is even created: a refused URL must cost no
    // process, no socket, and no DNS query.
    const requestedUrl = this.gate(request.url).href;

    const hops: ResourceHopRecord[] = [];
    const client = await this.createClient();
    try {
      let target = requestedUrl;
      for (let hop = 0; ; hop += 1) {
        if (hop > this.maxRedirects) {
          throw new PublicResourceReadError(
            'too_many_redirects',
            requestedUrl,
            `the redirect chain exceeded ${this.maxRedirects} hops ` +
              `(${hops.map((entry) => entry.url).join(' -> ')}).`,
          );
        }

        // Re-resolved and re-classified for EVERY hop, including the first:
        // a redirect target is chosen by a remote server, so it gets exactly
        // as much trust as the model's own input, which is none.
        const validated = await assertPublicResourceTarget(target, this.resolver, {
          allowNonPublicAddresses: this.allowNonPublicAddresses,
        });

        const response = await this.fetchHop(client, validated.url.href, timeout);
        try {
          const status = response.status();
          const headers = response.headers();
          hops.push({ url: validated.url.href, status, addresses: validated.addresses });

          const location = headers['location'];
          if (REDIRECT_STATUSES.has(status) && location !== undefined && location !== '') {
            // The next hop is validated HERE, before this response's body is
            // touched, and the body of a redirect is never read at all. That
            // ordering is the guarantee that a chain ending somewhere private
            // returns no content of any kind.
            target = this.resolveRedirect(location, validated.url);
            continue;
          }

          return await this.finishRead(response, {
            requestedUrl,
            headers,
            status,
            hops,
            maxBytes,
          });
        } finally {
          await response.dispose().catch(() => undefined);
        }
      }
    } finally {
      await client.dispose().catch(() => undefined);
    }
  }

  /** Apply the destination gate for this reader's configuration. Under the
   * test relaxation the structural checks still run — only address class is
   * skipped. */
  private gate(url: string | URL): URL {
    return this.allowNonPublicAddresses
      ? assertStructurallyReadableUrl(url)
      : assertPublicHttpUrl(url);
  }

  /** Resolve a `Location` header against the hop that sent it and gate the
   * result. A relative redirect is legal; a scheme change, a credentialed
   * target, or a private destination is not. */
  private resolveRedirect(location: string, from: URL): string {
    let next: URL;
    try {
      next = new URL(location, from);
    } catch {
      throw new PublicResourceUrlError(
        'malformed_url',
        `${from.href} -> ${truncateForMessage(location)}`,
        'its redirect target is not a valid URL.',
      );
    }
    return this.gate(next).href;
  }

  private async fetchHop(
    client: AnonymousHttpClient,
    url: string,
    timeout: number,
  ): Promise<AnonymousHttpResponse> {
    try {
      // maxRedirects: 0 keeps the chain in this loop's hands; the transport
      // following one silently would skip every check above.
      return await client.get(url, { maxRedirects: 0, timeout, failOnStatusCode: false });
    } catch (thrown) {
      throw new PublicResourceReadError(
        'transport',
        url,
        thrown instanceof Error ? thrown.message : String(thrown),
      );
    }
  }

  /** Read and bound the final response body. */
  private async finishRead(
    response: AnonymousHttpResponse,
    context: {
      requestedUrl: string;
      headers: Record<string, string>;
      status: number;
      hops: readonly ResourceHopRecord[];
      maxBytes: number;
    },
  ): Promise<ReadResourceOutput> {
    const finalUrl = context.hops[context.hops.length - 1]?.url ?? context.requestedUrl;
    const advertised = parseContentLength(context.headers['content-length']);
    if (advertised !== undefined && advertised > MAX_BUFFERED_RESPONSE_BYTES) {
      throw new PublicResourceReadError(
        'response_too_large',
        finalUrl,
        `the server advertised ${advertised} bytes, over the ` +
          `${MAX_BUFFERED_RESPONSE_BYTES}-byte transport limit. Fetch a narrower ` +
          `query or a paginated slice of this resource instead.`,
      );
    }

    let body: Uint8Array;
    try {
      body = await response.body();
    } catch (thrown) {
      throw new PublicResourceReadError(
        'transport',
        finalUrl,
        `reading the response body failed (${thrown instanceof Error ? thrown.message : String(thrown)}).`,
      );
    }

    const truncated = body.byteLength > context.maxBytes;
    const contentType = context.headers['content-type'];
    return {
      requestedUrl: context.requestedUrl,
      finalUrl,
      status: context.status,
      headers: { ...context.headers },
      ...(contentType !== undefined ? { contentType } : {}),
      bytes: truncated ? body.slice(0, context.maxBytes) : body,
      truncated,
      ...(advertised !== undefined ? { advertisedBytes: advertised } : {}),
      hops: [...context.hops],
    };
  }
}

/** Options for {@link recordResourceEvidence}. */
export interface ResourceEvidenceOptions {
  /** One-line description; defaults to a URL/status/size summary. */
  summary?: string;
}

/**
 * Persist the bounded original bytes of a read as durable evidence.
 *
 * The body is stored as text when the retained bytes are valid UTF-8 (so
 * `grep` and `read_file` work on it) and as base64 otherwise (so binary
 * bytes survive exactly). Exactly one of the two is present, and both are
 * the *original* bytes — never a parsed or reformatted view, which is the
 * point of keeping evidence at all.
 *
 * @param store - the run's evidence ledger
 * @param output - the read to record
 * @param options - optional summary override
 * @returns the citable evidence handle; its file exists before this returns
 */
export function recordResourceEvidence(
  store: EvidenceStore,
  output: ReadResourceOutput,
  options: ResourceEvidenceOptions = {},
): Evidence {
  const decoded = decodeUtf8Exactly(output.bytes);
  return recordEvidence(store, {
    kind: RESOURCE_EVIDENCE_KIND,
    summary:
      options.summary ??
      `Anonymous read of ${truncateForMessage(output.finalUrl, 200)} ` +
        `(HTTP ${output.status}, ${output.bytes.byteLength} bytes` +
        `${output.truncated ? ', truncated' : ''})`,
    sourceUrl: output.finalUrl,
    detail: {
      // Carries the kind the store cannot express yet; see the INTEGRATION
      // note at the top of this file.
      recordType: PENDING_RESOURCE_EVIDENCE_KIND,
      requestedUrl: output.requestedUrl,
      finalUrl: output.finalUrl,
      status: output.status,
      ...(output.contentType !== undefined ? { contentType: output.contentType } : {}),
      headers: recordableHeaders(output.headers),
      hops: output.hops.map((hop) => ({ ...hop, addresses: [...hop.addresses] })),
      byteLength: output.bytes.byteLength,
      truncated: output.truncated,
      ...(output.advertisedBytes !== undefined
        ? { advertisedBytes: output.advertisedBytes }
        : {}),
      // Anonymity is part of the record: an auditor reading this file should
      // be able to see that no profile credential was involved.
      anonymous: true,
      ...(decoded !== undefined
        ? { bodyText: decoded }
        : { bodyBase64: Buffer.from(output.bytes).toString('base64') }),
    },
  });
}

/** Refuse privileged ports that are not the web's own. */
function assertAllowedPort(parsed: URL, asText: string): void {
  if (parsed.port === '') {
    return;
  }
  const port = Number(parsed.port);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new PublicResourceUrlError('malformed_url', asText, `its port is invalid.`);
  }
  if (port < 1_024 && !ALLOWED_PRIVILEGED_PORTS.has(port)) {
    throw new PublicResourceUrlError(
      'blocked_port',
      asText,
      `port ${port} is a privileged service port, not a web resource port.`,
    );
  }
}

/** Throw the rejection matching an address's class, or return for a public
 * one. Shared by literal-host and resolved-address validation so both paths
 * report identical reasons. */
function assertPublicAddress(address: string, url: string): void {
  const addressClass = classifyIpAddress(address);
  if (addressClass === 'public') {
    return;
  }
  const rejection: PublicUrlRejection =
    addressClass === 'unparsable' ? 'ambiguous_numeric_host' : addressClass;
  throw new PublicResourceUrlError(
    rejection,
    url,
    `${address} is ${describeAddressClass(addressClass)}, which the agent must not contact.`,
  );
}

function describeAddressClass(addressClass: IpAddressClass): string {
  switch (addressClass) {
    case 'loopback':
      return 'a loopback address';
    case 'private':
      return 'a private (internal network) address';
    case 'link_local':
      return 'a link-local address (the cloud metadata range)';
    case 'multicast':
      return 'a multicast address';
    case 'reserved':
      return 'a reserved address';
    case 'ipv4_mapped_ipv6':
      return 'an IPv6 form that embeds an IPv4 address';
    default:
      return 'not a parsable IP address';
  }
}

/** The IP literal inside a hostname, or undefined for a DNS name. Strips
 * IPv6 brackets; returns undefined when a bracketed host does not parse, so
 * the caller can refuse it explicitly. */
function ipLiteralOf(hostname: string): string | undefined {
  if (hostname.startsWith('[') && hostname.endsWith(']')) {
    const inner = hostname.slice(1, -1);
    return parseIpv6Literal(inner) === undefined ? undefined : inner;
  }
  return parseIpv4Literal(hostname) === undefined ? undefined : hostname;
}

/** True when every label is a decimal or 0x-hex number — the shape the URL
 * parser folds into an IPv4 address when it can. A registrable hostname
 * cannot look like this, because a TLD is never all-numeric. */
function isNumericHostSpelling(hostname: string): boolean {
  const labels = hostname.split('.');
  return labels.every((label) => /^(?:\d+|0[xX][0-9a-fA-F]+)$/.test(label));
}

/** Parse a strict dotted-quad IPv4 literal. Deliberately strict: leading
 * zeros, hex, and short forms are NOT accepted here, because accepting a
 * spelling this function has to guess at is how an octal loopback address
 * gets classified as public. */
function parseIpv4Literal(text: string): readonly number[] | undefined {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(text);
  if (match === null) {
    return undefined;
  }
  const octets = match.slice(1, 5).map((part) => Number(part));
  if (octets.some((octet) => octet > 255)) {
    return undefined;
  }
  // '01.2.3.4' parses as 1.2.3.4 above, but the leading zero means some
  // other parser may read it as octal; refuse the ambiguity.
  if (match.slice(1, 5).some((part) => part.length > 1 && part.startsWith('0'))) {
    return undefined;
  }
  return octets;
}

/** Parse an IPv6 literal (no brackets, no zone id) into eight 16-bit
 * groups. Supports `::` compression and a trailing dotted quad. */
function parseIpv6Literal(text: string): readonly number[] | undefined {
  if (text === '' || /[^0-9a-fA-F:.]/.test(text)) {
    return undefined;
  }
  const compressionParts = text.split('::');
  if (compressionParts.length > 2) {
    return undefined;
  }

  const parseSide = (side: string): number[] | undefined => {
    if (side === '') {
      return [];
    }
    const groups: number[] = [];
    const labels = side.split(':');
    for (let index = 0; index < labels.length; index += 1) {
      const label = labels[index] ?? '';
      if (label.includes('.')) {
        // A dotted quad is legal only as the final element, and contributes
        // two groups.
        if (index !== labels.length - 1) {
          return undefined;
        }
        const quad = parseIpv4Literal(label);
        if (quad === undefined) {
          return undefined;
        }
        groups.push((quad[0]! << 8) | quad[1]!, (quad[2]! << 8) | quad[3]!);
        continue;
      }
      if (!/^[0-9a-fA-F]{1,4}$/.test(label)) {
        return undefined;
      }
      groups.push(Number.parseInt(label, 16));
    }
    return groups;
  };

  const head = parseSide(compressionParts[0] ?? '');
  if (head === undefined) {
    return undefined;
  }
  if (compressionParts.length === 1) {
    return head.length === 8 ? head : undefined;
  }
  const tail = parseSide(compressionParts[1] ?? '');
  if (tail === undefined || head.length + tail.length > 7) {
    // '::' must stand for at least one zero group, so a full eight groups
    // around it is malformed rather than merely redundant.
    return undefined;
  }
  return [...head, ...new Array<number>(8 - head.length - tail.length).fill(0), ...tail];
}

/** Classify a parsed IPv4 address. Ranges follow the IANA special-purpose
 * registry; anything not explicitly special is public. */
function classifyIpv4(octets: readonly number[]): IpAddressClass {
  const [a = 0, b = 0, c = 0] = octets;
  if (a === 0) return 'reserved'; // 0.0.0.0/8, including the unspecified address
  if (a === 10) return 'private';
  if (a === 100 && b >= 64 && b <= 127) return 'private'; // 100.64/10 carrier NAT
  if (a === 127) return 'loopback';
  if (a === 169 && b === 254) return 'link_local'; // includes 169.254.169.254
  if (a === 172 && b >= 16 && b <= 31) return 'private';
  if (a === 192 && b === 0 && c === 0) return 'reserved'; // IETF protocol assignments
  if (a === 192 && b === 0 && c === 2) return 'reserved'; // TEST-NET-1
  if (a === 192 && b === 88 && c === 99) return 'reserved'; // 6to4 relay anycast
  if (a === 192 && b === 168) return 'private';
  if (a === 198 && (b === 18 || b === 19)) return 'reserved'; // benchmarking
  if (a === 198 && b === 51 && c === 100) return 'reserved'; // TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return 'reserved'; // TEST-NET-3
  if (a >= 224 && a <= 239) return 'multicast';
  if (a >= 240) return 'reserved'; // future use, plus 255.255.255.255 broadcast
  return 'public';
}

/** Classify a parsed IPv6 address. Anything outside the allocated global
 * unicast block (2000::/3) falls through to `reserved`, so a range nobody
 * anticipated fails closed. */
function classifyIpv6(groups: readonly number[]): IpAddressClass {
  const [g0 = 0, g1 = 0, g2 = 0, g3 = 0, g4 = 0, g5 = 0, g6 = 0, g7 = 0] = groups;
  const allZeroPrefix = g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0;

  if (allZeroPrefix && g5 === 0 && g6 === 0 && g7 === 0) return 'reserved'; // ::
  if (allZeroPrefix && g5 === 0 && g6 === 0 && g7 === 1) return 'loopback'; // ::1
  // ::ffff:0:0/96 — the IPv4-mapped form. `http://[::ffff:127.0.0.1]` is
  // loopback wearing an IPv6 hat, and even a mapped *public* address is
  // refused: no legitimate public resource is addressed this way, and
  // allowing the form invites parser-differential bypasses.
  if (allZeroPrefix && g5 === 0xffff) return 'ipv4_mapped_ipv6';
  // ::/96 — the deprecated IPv4-compatible form (::1 already matched above).
  if (allZeroPrefix && g5 === 0) return 'ipv4_mapped_ipv6';
  if (g0 === 0x0064 && g1 === 0xff9b) return 'ipv4_mapped_ipv6'; // NAT64 64:ff9b::/96
  if (g0 === 0x2002) return 'ipv4_mapped_ipv6'; // 6to4, embeds an arbitrary IPv4
  if ((g0 & 0xfe00) === 0xfc00) return 'private'; // fc00::/7 unique local
  if ((g0 & 0xffc0) === 0xfe80) return 'link_local'; // fe80::/10
  if ((g0 & 0xff00) === 0xff00) return 'multicast'; // ff00::/8
  if (g0 === 0x0100 && g1 === 0 && g2 === 0 && g3 === 0) return 'reserved'; // 100::/64 discard
  if (g0 === 0x2001 && g1 === 0x0db8) return 'reserved'; // documentation
  if (g0 === 0x2001 && g1 <= 0x01ff) return 'reserved'; // 2001::/23 protocol assignments
  if ((g0 & 0xe000) !== 0x2000) return 'reserved'; // outside global unicast 2000::/3
  return 'public';
}

/** Parse a `content-length` header, or undefined when it is absent or not a
 * plain non-negative integer. */
function parseContentLength(header: string | undefined): number | undefined {
  if (header === undefined || !/^\d+$/.test(header.trim())) {
    return undefined;
  }
  const value = Number(header.trim());
  return Number.isSafeInteger(value) ? value : undefined;
}

/** Headers safe to persist: everything except cookie-setting material. */
function recordableHeaders(
  headers: Readonly<Record<string, string>>,
): Record<string, string> {
  const kept: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (!UNRECORDED_HEADERS.has(name.toLowerCase())) {
      kept[name] = value;
    }
  }
  return kept;
}

/** Decode bytes as UTF-8, but only when the decoding is exact — a body with
 * invalid sequences must be preserved as base64 rather than silently
 * rewritten with replacement characters. */
function decodeUtf8Exactly(bytes: Uint8Array): string | undefined {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

/** Keep a URL or header value short enough for an error message. */
function truncateForMessage(text: string, maxChars = 300): string {
  return text.length <= maxChars ? text : `${text.slice(0, maxChars)}... [truncated]`;
}

/** Render a credentialed URL without its credentials: the refusal message
 * travels into transcripts and logs, and must not carry the password it
 * refused. */
function redactCredentials(parsed: URL): string {
  const redacted = new URL(parsed.href);
  redacted.username = '';
  redacted.password = '';
  return `${redacted.protocol}//<redacted>@${redacted.host}${redacted.pathname}`;
}

/** Validate one integer bound, rejecting NaN/Infinity/fractions by way of
 * `Number.isSafeInteger`. */
function assertBound(name: string, value: number, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new TypeError(
      `${name} must be an integer between ${min} and ${max}: ${String(value)}`,
    );
  }
  return value;
}
