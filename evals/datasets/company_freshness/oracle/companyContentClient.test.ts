import { describe, expect, it } from 'vitest';

import { fetchCompanyFreshnessOracle, newest, parseEightSleepIndex } from './companyContentClient.js';

describe('company freshness oracle', () => {
  it('parses Eight Sleep cards and sorts a three-item churn window newest-first', () => {
    const html = `<h3><a href="/blog/old-post">Old Post</a></h3><p>x</p><small>Jul 1, 2026</small>
      <h3><a href="/blog/new-post">New Post</a></h3><p>x</p><small>Aug 2, 2026</small>`;
    const parsed = parseEightSleepIndex(html);
    expect(parsed.map((item) => item.title)).toEqual(['Old Post', 'New Post']);
    expect(newest(parsed, 'test')[0]?.title).toBe('New Post');
  });

  it('rejects an empty dated-content set', () => {
    expect(() => newest([], 'Empty Co')).toThrow(/no dated/);
  });

  it('fetches all three official sources and Notion article dates without live HTTP', async () => {
    const fetchFn = async (input: string | URL | Request): Promise<Response> => {
      const url = String(input);
      if (url.endsWith('/en-us/blog')) return new Response('<a href="/blog/new-notion">new</a><a href="/blog/old-notion">old</a>');
      if (url.endsWith('/blog/new-notion')) return new Response('<meta property="article:published_time" content="2026-08-10T10:00:00Z"><meta property="og:title" content="New Notion">');
      if (url.endsWith('/blog/old-notion')) return new Response('<script type="application/ld+json">{"datePublished":"2026-08-01T10:00:00Z"}</script><title>Old Notion</title>');
      if (url.endsWith('/feed/feed.json')) return new Response(JSON.stringify({ items: [
        { url: 'https://www.figma.com/blog/new-figma/', title: 'New Figma', date_modified: '2026-08-09T00:00:00Z' },
      ] }));
      if (url === 'https://www.eightsleep.com/blog/') return new Response('<h3><a href="/blog/new-eight">New Eight</a></h3><p>summary</p><small>Aug 8, 2026</small>');
      return new Response('not found', { status: 404 });
    };
    const result = await fetchCompanyFreshnessOracle({ fetchFn, sleep: async () => undefined, random: () => 0.5 });
    expect(result.companies.map((company) => company.name)).toEqual(['Notion', 'Figma', 'Eight Sleep']);
    expect(result.companies[0]?.contentCandidates[0]?.title).toBe('New Notion');
  });
});
