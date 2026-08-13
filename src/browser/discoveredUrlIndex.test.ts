import { describe, expect, it } from 'vitest';

import {
  createDiscoveredUrlIndex,
  isAllowedResourceUrl,
  MAX_RESOURCE_URL_CHARS,
  recordObservedUrl,
  type DiscoveredUrlIndex,
} from './discoveredUrlIndex.js';

/** The decision's rejection code, or 'allowed' — keeps the assertions about
 * *which* refusal happened rather than merely that one did. */
function verdict(index: DiscoveredUrlIndex, url: string): string {
  const decision = isAllowedResourceUrl(index, url);
  return decision.allowed ? `allowed:${decision.basis}` : decision.rejection;
}

describe('createDiscoveredUrlIndex', () => {
  it('rejects non-positive or non-finite window sizes', () => {
    for (const invalid of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => createDiscoveredUrlIndex({ maxObservedUrls: invalid })).toThrow(TypeError);
      expect(() => createDiscoveredUrlIndex({ maxVisitedOrigins: invalid })).toThrow(TypeError);
    }
  });

  it('denies every URL before anything has been observed', () => {
    const index = createDiscoveredUrlIndex();
    expect(verdict(index, 'https://example.test/data.json')).toBe('not_observed');
    expect(index.observedUrls()).toEqual([]);
    expect(index.visitedOrigins()).toEqual([]);
  });
});

describe('isAllowedResourceUrl', () => {
  it('allows any path on a deliberately visited origin', () => {
    const index = createDiscoveredUrlIndex();
    expect(recordObservedUrl(index, 'https://example.test/report', 'deliberate_navigation')).toBe(
      true,
    );

    expect(verdict(index, 'https://example.test/api/rows.json')).toBe('allowed:visited_origin');
    expect(verdict(index, 'https://example.test/report')).toBe('allowed:visited_origin');
  });

  it('keeps a visited origin from leaking to other origins, hosts, ports, or schemes', () => {
    const index = createDiscoveredUrlIndex();
    recordObservedUrl(index, 'https://example.test/report', 'deliberate_navigation');

    // A subdomain is a different origin: covering it would mean guessing the
    // public suffix, and guessing wrong grants a host nobody visited.
    expect(verdict(index, 'https://api.example.test/rows.json')).toBe('not_observed');
    expect(verdict(index, 'https://example.test:8443/rows.json')).toBe('not_observed');
    expect(verdict(index, 'http://example.test/rows.json')).toBe('not_observed');
    expect(verdict(index, 'https://evil.test/rows.json')).toBe('not_observed');
  });

  it('grants only the exact URL for a sighting that is not a deliberate visit', () => {
    const index = createDiscoveredUrlIndex();
    for (const source of ['observed_link', 'network_response', 'task_input'] as const) {
      const url = `https://cdn.test/${source}.json`;
      expect(recordObservedUrl(index, url, source)).toBe(true);
      expect(verdict(index, url)).toBe('allowed:observed_url');
    }
    // Same origin, unseen path: still refused.
    expect(verdict(index, 'https://cdn.test/other.json')).toBe('not_observed');
    expect(index.visitedOrigins()).toEqual([]);
  });

  it('ignores the fragment but never the query string', () => {
    const index = createDiscoveredUrlIndex();
    recordObservedUrl(index, 'https://cdn.test/rows.json?page=1#top', 'observed_link');

    // A fragment is never sent to a server, so it cannot change the resource.
    expect(verdict(index, 'https://cdn.test/rows.json?page=1')).toBe('allowed:observed_url');
    expect(verdict(index, 'https://cdn.test/rows.json?page=1#bottom')).toBe('allowed:observed_url');
    // The query IS the resource for an endpoint; one sighting must not
    // authorize every parameterization.
    expect(verdict(index, 'https://cdn.test/rows.json?page=2')).toBe('not_observed');
    expect(verdict(index, 'https://cdn.test/rows.json')).toBe('not_observed');
  });

  it('returns the normalized URL the caller should actually fetch', () => {
    const index = createDiscoveredUrlIndex();
    recordObservedUrl(index, 'https://EXAMPLE.test:443/A/b.json#frag', 'observed_link');

    const decision = isAllowedResourceUrl(index, 'https://example.TEST/A/b.json');
    expect(decision).toEqual({
      allowed: true,
      basis: 'observed_url',
      normalizedUrl: 'https://example.test/A/b.json',
    });
  });

  it('refuses to track or allow URLs that are not plain http(s) resources', () => {
    const index = createDiscoveredUrlIndex();

    for (const url of ['file:///etc/passwd', 'javascript:alert(1)', 'data:text/plain,hi']) {
      expect(recordObservedUrl(index, url, 'deliberate_navigation')).toBe(false);
      expect(verdict(index, url)).toBe('unsupported_scheme');
    }
    // A credential-bearing URL is never tracked, so an exact match can never
    // launder it into an allowed read.
    expect(recordObservedUrl(index, 'https://user:pass@example.test/x', 'deliberate_navigation')).toBe(
      false,
    );
    expect(verdict(index, 'https://user:pass@example.test/x')).toBe('embedded_credentials');
    expect(verdict(index, 'https://example.test/x')).toBe('not_observed');

    expect(recordObservedUrl(index, '/relative/path', 'observed_link')).toBe(false);
    expect(verdict(index, '/relative/path')).toBe('malformed_url');

    const tooLong = `https://example.test/${'a'.repeat(MAX_RESOURCE_URL_CHARS)}`;
    expect(recordObservedUrl(index, tooLong, 'observed_link')).toBe(false);
    expect(verdict(index, tooLong)).toBe('url_too_long');
  });

  it('evicts the oldest sightings and fails closed on the evicted ones', () => {
    const index = createDiscoveredUrlIndex({ maxObservedUrls: 2, maxVisitedOrigins: 1 });
    recordObservedUrl(index, 'https://cdn.test/1.json', 'observed_link');
    recordObservedUrl(index, 'https://cdn.test/2.json', 'observed_link');
    recordObservedUrl(index, 'https://cdn.test/3.json', 'observed_link');

    expect(verdict(index, 'https://cdn.test/1.json')).toBe('not_observed');
    expect(verdict(index, 'https://cdn.test/2.json')).toBe('allowed:observed_url');
    expect(verdict(index, 'https://cdn.test/3.json')).toBe('allowed:observed_url');
    expect(index.observedUrls()).toEqual([
      'https://cdn.test/2.json',
      'https://cdn.test/3.json',
    ]);

    recordObservedUrl(index, 'https://a.test/page', 'deliberate_navigation');
    recordObservedUrl(index, 'https://b.test/page', 'deliberate_navigation');
    expect(index.visitedOrigins()).toEqual(['https://b.test']);
    expect(verdict(index, 'https://a.test/other')).toBe('not_observed');
  });

  it('refreshes a re-observed URL so the retained window is the recent one', () => {
    const index = createDiscoveredUrlIndex({ maxObservedUrls: 2 });
    recordObservedUrl(index, 'https://cdn.test/1.json', 'observed_link');
    recordObservedUrl(index, 'https://cdn.test/2.json', 'observed_link');
    // Seeing 1 again moves it to the newest position, so adding 3 drops 2.
    recordObservedUrl(index, 'https://cdn.test/1.json', 'observed_link');
    recordObservedUrl(index, 'https://cdn.test/3.json', 'observed_link');

    expect(verdict(index, 'https://cdn.test/1.json')).toBe('allowed:observed_url');
    expect(verdict(index, 'https://cdn.test/2.json')).toBe('not_observed');
    expect(verdict(index, 'https://cdn.test/3.json')).toBe('allowed:observed_url');
  });

  it('explains a refusal in terms of what to do next', () => {
    const index = createDiscoveredUrlIndex();
    const decision = isAllowedResourceUrl(index, 'https://cdn.test/rows.json');
    expect(decision.allowed).toBe(false);
    if (decision.allowed) return;
    expect(decision.reason).toContain('https://cdn.test/rows.json');
    expect(decision.reason).toContain('Navigate');
  });
});
