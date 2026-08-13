import { createHash } from 'node:crypto';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { startFixtureServer, type FixtureServer } from '../../tests/fixtures/server.js';
import { createEvidenceStore, type EvidenceRecord, type EvidenceStore } from '../evidence/evidenceStore.js';
import { initManifest, MANIFEST_FILENAME, type Manifest } from '../run/artifacts.js';
import {
  assertPublicHttpUrl,
  assertPublicResourceTarget,
  classifyIpAddress,
  MAX_BUFFERED_RESPONSE_BYTES,
  MAX_RESOURCE_URL_CHARS,
  PlaywrightPublicResourceReader,
  PublicResourceReadError,
  PublicResourceUrlError,
  recordResourceEvidence,
  type AnonymousHttpClient,
  type AnonymousHttpResponse,
  type DnsResolver,
  type PublicUrlRejection,
} from './publicResourceReader.js';

/** A routable public IPv4/IPv6 pair used wherever a test needs an address
 * the gate must accept. */
const PUBLIC_IPV4 = '93.184.216.34';
const PUBLIC_IPV6 = '2606:2800:220:1:248:1893:25c8:1946';

/** Assert a URL is refused and return WHICH class of destination refused it —
 * the reason is the contract, not merely the throw. */
function rejectionFor(url: string): PublicUrlRejection {
  try {
    assertPublicHttpUrl(url);
  } catch (thrown) {
    if (thrown instanceof PublicResourceUrlError) return thrown.rejection;
    throw thrown;
  }
  throw new Error(`expected ${url} to be refused`);
}

/** Every rejection code produced for a list of URLs, deduplicated for a
 * single-value assertion. */
function rejectionsFor(urls: readonly string[]): string[] {
  return [...new Set(urls.map((url) => rejectionFor(url)))];
}

function resolverFor(map: Readonly<Record<string, readonly string[]>>): DnsResolver {
  return {
    async resolve(hostname) {
      const addresses = map[hostname];
      if (addresses === undefined) throw new Error(`no DNS answer for ${hostname}`);
      return addresses;
    },
  };
}

/** One scripted hop for the fake transport. */
interface FakeHop {
  status: number;
  headers?: Record<string, string>;
  body?: string | Uint8Array;
}

/** A transport that answers from a script and records exactly what was asked
 * for — including whether a response body was ever read, which is how
 * "rejected before any content is returned" becomes testable. */
function fakeTransport(hops: Readonly<Record<string, FakeHop>>): {
  createClient: () => Promise<AnonymousHttpClient>;
  requested: string[];
  bodiesRead: string[];
  clientsDisposed: () => number;
} {
  const requested: string[] = [];
  const bodiesRead: string[] = [];
  let clientsDisposed = 0;

  const createClient = async (): Promise<AnonymousHttpClient> => ({
    async get(url): Promise<AnonymousHttpResponse> {
      requested.push(url);
      const hop = hops[url];
      if (hop === undefined) throw new Error(`unscripted request: ${url}`);
      return {
        status: () => hop.status,
        headers: () => ({ ...(hop.headers ?? {}) }),
        url: () => url,
        async body() {
          bodiesRead.push(url);
          const body = hop.body ?? '';
          return typeof body === 'string' ? new TextEncoder().encode(body) : body;
        },
        dispose: async () => undefined,
      };
    },
    dispose: async () => {
      clientsDisposed += 1;
    },
  });

  return { createClient, requested, bodiesRead, clientsDisposed: () => clientsDisposed };
}

describe('assertPublicHttpUrl', () => {
  it('accepts ordinary public URLs and returns the parsed URL', () => {
    expect(assertPublicHttpUrl('https://example.test/data.json?page=2').href).toBe(
      'https://example.test/data.json?page=2',
    );
    expect(assertPublicHttpUrl(`http://${PUBLIC_IPV4}:8080/rows.csv`).hostname).toBe(PUBLIC_IPV4);
    expect(assertPublicHttpUrl(`https://[${PUBLIC_IPV6}]/x`).protocol).toBe('https:');
    // Just outside the private blocks: 172.32 and 100.128 are public.
    expect(assertPublicHttpUrl('http://172.32.0.1/x').hostname).toBe('172.32.0.1');
    expect(assertPublicHttpUrl('http://100.128.0.1/x').hostname).toBe('100.128.0.1');
  });

  it('rejects non-http(s) schemes', () => {
    expect(
      rejectionsFor([
        'file:///etc/passwd',
        'ftp://example.test/x',
        'gopher://example.test/x',
        'ws://example.test/x',
        'data:text/plain,hello',
      ]),
    ).toEqual(['unsupported_scheme']);
  });

  it('rejects credentials in the URL without echoing the password back', () => {
    expect(rejectionFor('https://user:pass@example.test/x')).toBe('embedded_credentials');
    expect(rejectionFor('https://user@example.test/x')).toBe('embedded_credentials');
    try {
      assertPublicHttpUrl('https://user:hunter2@example.test/x');
      throw new Error('expected a refusal');
    } catch (thrown) {
      expect((thrown as Error).message).not.toContain('hunter2');
      expect((thrown as Error).message).toContain('<redacted>');
    }
  });

  it('rejects IPv4 loopback (127.0.0.0/8)', () => {
    expect(
      rejectionsFor(['http://127.0.0.1/x', 'http://127.0.0.53/x', 'https://127.255.255.254/x']),
    ).toEqual(['loopback']);
  });

  it('rejects the localhost name and its reserved subdomains', () => {
    expect(
      rejectionsFor(['http://localhost/x', 'http://LOCALHOST./x', 'http://api.localhost/x']),
    ).toEqual(['loopback']);
  });

  it('rejects IPv6 loopback (::1)', () => {
    expect(rejectionsFor(['http://[::1]/x', 'http://[0:0:0:0:0:0:0:1]/x'])).toEqual(['loopback']);
  });

  it('rejects private ranges (10/8, 172.16/12, 192.168/16)', () => {
    expect(
      rejectionsFor([
        'http://10.0.0.1/x',
        'http://10.255.255.255/x',
        'http://172.16.0.1/x',
        'http://172.31.255.254/x',
        'http://192.168.0.1/x',
        'http://192.168.1.254/x',
      ]),
    ).toEqual(['private']);
  });

  it('rejects carrier-private space (100.64/10) and IPv6 unique-local (fc00::/7)', () => {
    expect(
      rejectionsFor(['http://100.64.0.1/x', 'http://[fd00::1]/x', 'http://[fc00::1]/x']),
    ).toEqual(['private']);
  });

  it('rejects IPv4 link-local (169.254/16), including the metadata address', () => {
    expect(
      rejectionsFor(['http://169.254.169.254/latest/meta-data/', 'http://169.254.0.1/x']),
    ).toEqual(['link_local']);
  });

  it('rejects IPv6 link-local (fe80::/10)', () => {
    expect(rejectionsFor(['http://[fe80::1]/x', 'http://[febf::1]/x'])).toEqual(['link_local']);
  });

  it('rejects multicast (224.0.0.0/4 and ff00::/8)', () => {
    expect(
      rejectionsFor([
        'http://224.0.0.1/x',
        'http://239.255.255.250/x',
        'http://[ff02::1]/x',
        'http://[ff05::1:3]/x',
      ]),
    ).toEqual(['multicast']);
  });

  it('rejects reserved and unspecified addresses', () => {
    expect(
      rejectionsFor([
        'http://0.0.0.0/x', // unspecified
        'http://0.1.2.3/x', // 0.0.0.0/8
        'http://[::]/x', // IPv6 unspecified
        'http://255.255.255.255/x', // broadcast
        'http://240.0.0.1/x', // future use
        'http://192.0.2.1/x', // TEST-NET-1
        'http://198.51.100.7/x', // TEST-NET-2
        'http://203.0.113.7/x', // TEST-NET-3
        'http://198.18.0.1/x', // benchmarking
        'http://192.0.0.1/x', // IETF protocol assignments
        'http://192.88.99.1/x', // 6to4 relay anycast
        'http://[2001:db8::1]/x', // documentation
        'http://[fec0::1]/x', // outside global unicast 2000::/3
        'http://[100::1]/x', // discard-only
      ]),
    ).toEqual(['reserved']);
  });

  it('rejects IPv4-mapped IPv6 forms of loopback, link-local, and private addresses', () => {
    expect(
      rejectionsFor([
        'http://[::ffff:127.0.0.1]/x', // loopback, written as mapped IPv4
        'http://[::ffff:7f00:1]/x', // the same address in hex-group form
        'http://[::ffff:169.254.169.254]/x', // metadata service, mapped
        'http://[0:0:0:0:0:ffff:10.0.0.1]/x', // private, mapped, uncompressed
        'http://[::127.0.0.1]/x', // deprecated IPv4-compatible form
        'http://[64:ff9b::7f00:1]/x', // NAT64 well-known prefix
        'http://[2002:7f00:1::]/x', // 6to4, embeds 127.0.0.1
      ]),
    ).toEqual(['ipv4_mapped_ipv6']);
    // Even a mapped PUBLIC address is refused: the form is never used by a
    // legitimate public resource, and allowing it invites parser-differential
    // bypasses.
    expect(rejectionFor(`http://[::ffff:${PUBLIC_IPV4}]/x`)).toBe('ipv4_mapped_ipv6');
  });

  it('rejects decimal, octal, and hex spellings of non-public IPv4 addresses', () => {
    // The WHATWG parser folds each of these to a dotted quad before
    // classification, so they are refused by the same rules as the plain form.
    expect(
      rejectionsFor([
        'http://2130706433/x', // decimal 127.0.0.1
        'http://017700000001/x', // octal 127.0.0.1
        'http://0x7f000001/x', // hex 127.0.0.1
        'http://0177.0.0.1/x', // mixed octal
        'http://0x7f.0x0.0x0.0x1/x', // per-label hex
        'http://127.1/x', // short form
      ]),
    ).toEqual(['loopback']);
    expect(rejectionFor('http://2852039166/x')).toBe('link_local'); // 169.254.169.254
    expect(rejectionFor('http://167772161/x')).toBe('private'); // 10.0.0.1
    expect(rejectionFor('http://0/x')).toBe('reserved'); // 0.0.0.0
  });

  it('rejects a numeric host spelling that is not a valid address', () => {
    // Today's WHATWG parser refuses these outright (a numeric last label makes
    // the whole host an IPv4 candidate, and these do not parse), so they land
    // as malformed rather than reaching the numeric-spelling guard. The guard
    // stays as the fail-closed path if a parser ever accepts one of these as a
    // domain name.
    expect(
      rejectionsFor(['http://0x7f.0x0.0x0.0x1.0x2/x', 'http://1.2.3.4.5/x']),
    ).toEqual(['malformed_url']);
  });

  it('rejects privileged service ports that are not the web ports', () => {
    expect(
      rejectionsFor([
        'http://example.test:22/x',
        'http://example.test:25/x',
        'http://example.test:6379/x'.replace('6379', '11'),
      ]),
    ).toEqual(['blocked_port']);
    // The web's own privileged ports and any unprivileged port stay allowed.
    expect(assertPublicHttpUrl('http://example.test:80/x').port).toBe('');
    expect(assertPublicHttpUrl('https://example.test:8443/x').port).toBe('8443');
  });

  it('rejects malformed, hostless, and over-long URLs', () => {
    expect(rejectionFor('not-a-url')).toBe('malformed_url');
    expect(rejectionFor('/only/a/path')).toBe('malformed_url');
    expect(rejectionFor('http://[not-ipv6]/x')).toBe('malformed_url');
    expect(rejectionFor(`https://example.test/${'a'.repeat(MAX_RESOURCE_URL_CHARS)}`)).toBe(
      'url_too_long',
    );
    expect(rejectionFor(`https://${'label.'.repeat(50)}test/x`)).toBe('host_too_long');
  });
});

describe('classifyIpAddress', () => {
  it('never guesses at a spelling it cannot parse exactly', () => {
    // Leading zeros, hex, and short forms are ambiguous between parsers, so
    // they are 'unparsable' here rather than optimistically public.
    for (const ambiguous of ['0177.0.0.1', '0x7f000001', '127.1', '1.2.3.4.5', 'example.test']) {
      expect(classifyIpAddress(ambiguous)).toBe('unparsable');
    }
    expect(classifyIpAddress(PUBLIC_IPV4)).toBe('public');
    expect(classifyIpAddress(PUBLIC_IPV6)).toBe('public');
  });
});

describe('assertPublicResourceTarget', () => {
  it('validates every address a hostname resolves to, not just the first', async () => {
    const resolver = resolverFor({ 'mixed.test': [PUBLIC_IPV4, '10.1.2.3'] });
    await expect(
      assertPublicResourceTarget('https://mixed.test/x', resolver),
    ).rejects.toMatchObject({ rejection: 'private' });
  });

  it('reports the validated addresses for an allowed host', async () => {
    const resolver = resolverFor({ 'public.test': [PUBLIC_IPV4, PUBLIC_IPV6] });
    const target = await assertPublicResourceTarget('https://public.test/x', resolver);
    expect(target.addresses).toEqual([PUBLIC_IPV4, PUBLIC_IPV6]);
    expect(target.url.href).toBe('https://public.test/x');
  });

  it('refuses a resolved address it cannot parse rather than assuming it is public', async () => {
    const resolver = resolverFor({ 'weird.test': ['not-an-ip-at-all'] });
    await expect(
      assertPublicResourceTarget('https://weird.test/x', resolver),
    ).rejects.toMatchObject({ rejection: 'ambiguous_numeric_host' });
  });

  it('refuses a host that does not resolve, and never resolves an IP literal', async () => {
    await expect(
      assertPublicResourceTarget('https://missing.test/x', resolverFor({})),
    ).rejects.toMatchObject({ rejection: 'unresolvable_host' });
    await expect(
      assertPublicResourceTarget('https://empty.test/x', resolverFor({ 'empty.test': [] })),
    ).rejects.toMatchObject({ rejection: 'unresolvable_host' });

    const neverCalled: DnsResolver = {
      resolve: async () => {
        throw new Error('the resolver must not be consulted for an IP literal');
      },
    };
    const target = await assertPublicResourceTarget(`http://${PUBLIC_IPV4}/x`, neverCalled);
    expect(target.addresses).toEqual([PUBLIC_IPV4]);
  });
});

describe('PlaywrightPublicResourceReader redirect handling', () => {
  it('refuses a chain whose second hop resolves to a private address, before any content', async () => {
    const transport = fakeTransport({
      'https://public.test/start': {
        status: 302,
        headers: { location: 'https://internal.test/secrets' },
        body: 'this body must never be read',
      },
      'https://internal.test/secrets': { status: 200, body: 'internal data' },
    });
    const reader = new PlaywrightPublicResourceReader({
      createClient: transport.createClient,
      // The first hop is a perfectly ordinary public address; only the
      // redirect target resolves inside the network.
      resolver: resolverFor({
        'public.test': [PUBLIC_IPV4],
        'internal.test': ['169.254.169.254'],
      }),
    });

    await expect(reader.read({ url: 'https://public.test/start' })).rejects.toMatchObject({
      name: 'PublicResourceUrlError',
      rejection: 'link_local',
    });
    // The private hop was never contacted, and the redirect's own body was
    // never read: no content of any kind came back.
    expect(transport.requested).toEqual(['https://public.test/start']);
    expect(transport.bodiesRead).toEqual([]);
    expect(transport.clientsDisposed()).toBe(1);
  });

  it('re-resolves each hop, so a host that answers privately later is caught', async () => {
    const answers = new Map<string, readonly string[]>([
      ['first.test', [PUBLIC_IPV4]],
      ['second.test', [PUBLIC_IPV4]],
    ]);
    const resolver: DnsResolver = {
      async resolve(hostname) {
        const addresses = answers.get(hostname);
        if (addresses === undefined) throw new Error(`no DNS answer for ${hostname}`);
        // Rebinding: the same name answers with a loopback address the second
        // time it is asked.
        answers.set(hostname, ['127.0.0.1']);
        return addresses;
      },
    };
    const transport = fakeTransport({
      'https://first.test/a': { status: 301, headers: { location: 'https://second.test/b' } },
      'https://second.test/b': { status: 302, headers: { location: 'https://second.test/c' } },
      'https://second.test/c': { status: 200, body: 'ok' },
    });
    const reader = new PlaywrightPublicResourceReader({
      createClient: transport.createClient,
      resolver,
    });

    await expect(reader.read({ url: 'https://first.test/a' })).rejects.toMatchObject({
      rejection: 'loopback',
    });
    expect(transport.requested).toEqual(['https://first.test/a', 'https://second.test/b']);
    expect(transport.bodiesRead).toEqual([]);
  });

  it('follows an allowed chain, resolves a relative Location, and records every hop', async () => {
    const transport = fakeTransport({
      'https://public.test/a': { status: 301, headers: { location: '/b' } },
      'https://public.test/b': {
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: '{"ok":true}',
      },
    });
    const reader = new PlaywrightPublicResourceReader({
      createClient: transport.createClient,
      resolver: resolverFor({ 'public.test': [PUBLIC_IPV4] }),
    });

    const output = await reader.read({ url: 'https://public.test/a' });
    expect(output.requestedUrl).toBe('https://public.test/a');
    expect(output.finalUrl).toBe('https://public.test/b');
    expect(output.status).toBe(200);
    expect(output.contentType).toBe('application/json');
    expect(new TextDecoder().decode(output.bytes)).toBe('{"ok":true}');
    expect(output.hops).toEqual([
      { url: 'https://public.test/a', status: 301, addresses: [PUBLIC_IPV4] },
      { url: 'https://public.test/b', status: 200, addresses: [PUBLIC_IPV4] },
    ]);
  });

  it('bounds the redirect count', async () => {
    const transport = fakeTransport({
      'https://public.test/1': { status: 302, headers: { location: '/2' } },
      'https://public.test/2': { status: 302, headers: { location: '/3' } },
      'https://public.test/3': { status: 302, headers: { location: '/4' } },
      'https://public.test/4': { status: 200, body: 'too deep' },
    });
    const reader = new PlaywrightPublicResourceReader({
      createClient: transport.createClient,
      resolver: resolverFor({ 'public.test': [PUBLIC_IPV4] }),
      maxRedirects: 2,
    });

    await expect(reader.read({ url: 'https://public.test/1' })).rejects.toMatchObject({
      name: 'PublicResourceReadError',
      reason: 'too_many_redirects',
    });
    expect(transport.bodiesRead).toEqual([]);
  });

  it('refuses a redirect that leaves http(s) or adds credentials', async () => {
    for (const location of ['file:///etc/passwd', 'https://user:pass@public.test/b']) {
      const transport = fakeTransport({
        'https://public.test/a': { status: 303, headers: { location } },
      });
      const reader = new PlaywrightPublicResourceReader({
        createClient: transport.createClient,
        resolver: resolverFor({ 'public.test': [PUBLIC_IPV4] }),
      });
      await expect(reader.read({ url: 'https://public.test/a' })).rejects.toBeInstanceOf(
        PublicResourceUrlError,
      );
      expect(transport.bodiesRead).toEqual([]);
    }
  });

  it('treats a redirect status without a Location as the final response', async () => {
    const transport = fakeTransport({
      'https://public.test/a': { status: 302, body: 'body instead of a location' },
    });
    const reader = new PlaywrightPublicResourceReader({
      createClient: transport.createClient,
      resolver: resolverFor({ 'public.test': [PUBLIC_IPV4] }),
    });

    const output = await reader.read({ url: 'https://public.test/a' });
    expect(output.status).toBe(302);
    expect(new TextDecoder().decode(output.bytes)).toBe('body instead of a location');
  });
});

describe('PlaywrightPublicResourceReader body handling', () => {
  const resolver = resolverFor({ 'public.test': [PUBLIC_IPV4] });

  it('truncates at the byte bound and says so', async () => {
    const transport = fakeTransport({
      'https://public.test/big': { status: 200, body: 'abcdefghij' },
    });
    const reader = new PlaywrightPublicResourceReader({
      createClient: transport.createClient,
      resolver,
    });

    const output = await reader.read({ url: 'https://public.test/big', maxBytes: 4 });
    expect(new TextDecoder().decode(output.bytes)).toBe('abcd');
    expect(output.truncated).toBe(true);
  });

  it('refuses a body whose advertised length is over the transport limit', async () => {
    const transport = fakeTransport({
      'https://public.test/huge': {
        status: 200,
        headers: { 'content-length': String(MAX_BUFFERED_RESPONSE_BYTES + 1) },
        body: 'never read',
      },
    });
    const reader = new PlaywrightPublicResourceReader({
      createClient: transport.createClient,
      resolver,
    });

    await expect(reader.read({ url: 'https://public.test/huge' })).rejects.toMatchObject({
      name: 'PublicResourceReadError',
      reason: 'response_too_large',
    });
    expect(transport.bodiesRead).toEqual([]);
  });

  it('returns a non-success status instead of throwing, and disposes the client', async () => {
    const transport = fakeTransport({
      'https://public.test/gone': { status: 404, body: 'Not found' },
    });
    const reader = new PlaywrightPublicResourceReader({
      createClient: transport.createClient,
      resolver,
    });

    const output = await reader.read({ url: 'https://public.test/gone' });
    expect(output.status).toBe(404);
    expect(transport.clientsDisposed()).toBe(1);
  });

  it('rejects an unusable bound before any request is made', async () => {
    const transport = fakeTransport({});
    const reader = new PlaywrightPublicResourceReader({
      createClient: transport.createClient,
      resolver,
    });

    for (const maxBytes of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      await expect(
        reader.read({ url: 'https://public.test/x', maxBytes }),
      ).rejects.toBeInstanceOf(TypeError);
    }
    expect(transport.requested).toEqual([]);
  });

  it('refuses a refused URL without creating a client at all', async () => {
    const transport = fakeTransport({});
    const reader = new PlaywrightPublicResourceReader({
      createClient: transport.createClient,
      resolver,
    });

    await expect(reader.read({ url: 'http://169.254.169.254/latest/' })).rejects.toBeInstanceOf(
      PublicResourceUrlError,
    );
    expect(transport.clientsDisposed()).toBe(0);
    expect(transport.requested).toEqual([]);
  });

  it('turns a transport failure into a typed read error', async () => {
    const reader = new PlaywrightPublicResourceReader({
      createClient: async () => ({
        get: async () => {
          throw new Error('socket hang up');
        },
        dispose: async () => undefined,
      }),
      resolver,
    });

    await expect(reader.read({ url: 'https://public.test/x' })).rejects.toBeInstanceOf(
      PublicResourceReadError,
    );
  });
});

// --- Live loopback reads. These use the TEST-ONLY address relaxation, which
// is the only way a hermetic fixture on 127.0.0.1 can be read at all; every
// other check (scheme, credentials, port, redirect bound, re-resolution)
// still applies. ---
describe('anonymous reads over a real transport', () => {
  let fixture: FixtureServer;
  /** Headers every request to the recording server arrived with. */
  let received: Array<{ url: string; headers: IncomingHttpHeaders }>;
  let recordingServer: Server;
  let recordingBase: string;

  beforeAll(async () => {
    fixture = await startFixtureServer();
    received = [];
    recordingServer = createServer((request, response) => {
      received.push({ url: request.url ?? '', headers: request.headers });
      if (request.url === '/rows.json') {
        const body = JSON.stringify({ rows: [{ name: 'alpha' }, { name: 'beta' }] });
        response.writeHead(200, {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          // A cookie the server tries to set: it must not survive into a
          // later read, and it must not be persisted as evidence.
          'Set-Cookie': 'resource-session=1; Path=/',
        });
        response.end(body);
        return;
      }
      if (request.url === '/echo-cookie') {
        const body = request.headers.cookie ?? '<no cookie header>';
        response.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
        response.end(body);
        return;
      }
      response.writeHead(404, { 'Content-Type': 'text/plain' });
      response.end('nope');
    });
    await new Promise<void>((resolve) => {
      recordingServer.listen(0, '127.0.0.1', resolve);
    });
    const address = recordingServer.address();
    if (address === null || typeof address === 'string') throw new Error('no port');
    recordingBase = `http://127.0.0.1:${address.port}`;
  }, 30_000);

  afterAll(async () => {
    await fixture?.close();
    await new Promise<void>((resolve) => {
      recordingServer.close(() => {
        resolve();
      });
    });
  });

  function loopbackReader(): PlaywrightPublicResourceReader {
    return new PlaywrightPublicResourceReader({ allowNonPublicAddressesForTests: true });
  }

  it('gets the cookie-gated 401 the fixture returns to an unauthenticated caller', async () => {
    // Control: the route DOES serve content when the profile's session cookie
    // is presented, so the 401 below is about the missing cookie and nothing
    // else.
    const withCookie = await fetch(fixture.url('/authenticated.bin'), {
      headers: { cookie: 'fixture-session=ready' },
    });
    expect(withCookie.status).toBe(200);
    expect(await withCookie.text()).toContain('browser-session-authenticated');

    const output = await loopbackReader().read({ url: fixture.url('/authenticated.bin') });
    // No profile cookie reached the resource server: the gate answered 401.
    expect(output.status).toBe(401);
    expect(new TextDecoder().decode(output.bytes)).toContain('Missing browser session cookie');
  }, 30_000);

  it('sends no cookie and no authorization header, and carries none between reads', async () => {
    const reader = loopbackReader();
    const first = await reader.read({ url: `${recordingBase}/rows.json` });
    expect(first.status).toBe(200);
    // Each read gets a fresh anonymous client, so the Set-Cookie above cannot
    // be replayed on the next read.
    const second = await reader.read({ url: `${recordingBase}/echo-cookie` });
    expect(new TextDecoder().decode(second.bytes)).toBe('<no cookie header>');

    expect(received.length).toBeGreaterThanOrEqual(2);
    for (const request of received) {
      expect(request.headers.cookie).toBeUndefined();
      expect(request.headers.authorization).toBeUndefined();
      expect(request.headers['proxy-authorization']).toBeUndefined();
    }
  }, 30_000);

  it('still refuses a non-HTTP scheme and a credentialed URL under the test relaxation', async () => {
    const reader = loopbackReader();
    await expect(reader.read({ url: 'file:///etc/passwd' })).rejects.toMatchObject({
      rejection: 'unsupported_scheme',
    });
    await expect(
      reader.read({ url: `http://user:pass@127.0.0.1:${new URL(recordingBase).port}/rows.json` }),
    ).rejects.toMatchObject({ rejection: 'embedded_credentials' });
  }, 30_000);

  it('follows the fixture server redirect and reports both hops', async () => {
    const output = await loopbackReader().read({ url: fixture.url('/redirect-to-second') });
    expect(output.status).toBe(200);
    expect(output.finalUrl).toBe(fixture.url('/second.html'));
    expect(output.hops.map((hop) => hop.status)).toEqual([302, 200]);
  }, 30_000);
});

describe('recordResourceEvidence', () => {
  let runDir: string;
  let store: EvidenceStore;

  beforeEach(() => {
    runDir = mkdtempSync(join(tmpdir(), 'resource-evidence-test-'));
    initManifest(runDir, 'read the resource');
    store = createEvidenceStore(runDir);
  });

  afterEach(() => {
    rmSync(runDir, { recursive: true, force: true });
  });

  function readRecord(path: string): EvidenceRecord & { detail: Record<string, unknown> } {
    return JSON.parse(readFileSync(join(runDir, path), 'utf8')) as EvidenceRecord & {
      detail: Record<string, unknown>;
    };
  }

  it('persists the exact original bytes, the hop trail, and no cookie material', () => {
    const evidence = recordResourceEvidence(store, {
      requestedUrl: 'https://public.test/a',
      finalUrl: 'https://public.test/b',
      status: 200,
      headers: {
        'content-type': 'application/json',
        'set-cookie': 'session=secret; Path=/',
      },
      contentType: 'application/json',
      bytes: new TextEncoder().encode('{"rows":2}'),
      truncated: false,
      hops: [
        { url: 'https://public.test/a', status: 301, addresses: [PUBLIC_IPV4] },
        { url: 'https://public.test/b', status: 200, addresses: [PUBLIC_IPV4] },
      ],
    });

    const record = readRecord(evidence.path);
    expect(record.detail.recordType).toBe('network_response');
    expect(record.detail.bodyText).toBe('{"rows":2}');
    expect(record.detail.anonymous).toBe(true);
    expect(record.detail.hops).toHaveLength(2);
    // Cookie material is never persisted: the read deliberately did not use a
    // credential, so the run directory must not gain one.
    expect(JSON.stringify(record.detail)).not.toContain('secret');
    expect(record.sourceUrl).toBe('https://public.test/b');

    // Hashed into the manifest like every other artifact.
    const manifest = JSON.parse(
      readFileSync(join(runDir, MANIFEST_FILENAME), 'utf8'),
    ) as Manifest;
    const entry = manifest.artifacts.find((artifact) => artifact.filename === evidence.path);
    const bytes = readFileSync(join(runDir, evidence.path));
    expect(entry?.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
  });

  it('keeps non-UTF-8 bytes exactly, as base64', () => {
    const evidence = recordResourceEvidence(store, {
      requestedUrl: 'https://public.test/bin',
      finalUrl: 'https://public.test/bin',
      status: 200,
      headers: {},
      bytes: new Uint8Array([0x00, 0xff, 0xfe, 0x41]),
      truncated: true,
      hops: [{ url: 'https://public.test/bin', status: 200, addresses: [PUBLIC_IPV4] }],
    });

    const record = readRecord(evidence.path);
    expect(record.detail.bodyText).toBeUndefined();
    expect(Buffer.from(String(record.detail.bodyBase64), 'base64')).toEqual(
      Buffer.from([0x00, 0xff, 0xfe, 0x41]),
    );
    expect(record.detail.truncated).toBe(true);
    expect(record.summary).toContain('truncated');
  });
});
