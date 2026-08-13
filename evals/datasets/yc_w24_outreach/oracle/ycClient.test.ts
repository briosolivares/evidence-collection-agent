import { describe, expect, it } from 'vitest';

import { combineDirectoryResults, fetchYcW24AiCompanies, isAiFocused, parseAlgoliaCredentials } from './ycClient.js';

const COMPANY_HITS = Array.from({ length: 5 }, (_, index) => ({
  name: `Company ${index + 1}`, slug: `company-${index + 1}`,
  one_liner: `Robotic workflow ${index + 1}`, long_description: `Automates a distinctive workflow ${index + 1}.`,
  tags: ['Artificial Intelligence'], batch: 'Winter 2024',
}));
const FOUNDER_HITS = COMPANY_HITS.flatMap((company, index) => [
  { first_name: `Alice${index}`, last_name: `Founder${index}`, company_slug: company.slug, batches: ['W24'] },
  { first_name: `Bob${index}`, last_name: `Builder${index}`, company_slug: company.slug, batches: ['W24'] },
]);

describe('YC W24 AI oracle', () => {
  it('parses fresh public Algolia credentials from official directory HTML', () => {
    expect(parseAlgoliaCredentials('<script>window.AlgoliaOpts = {"app":"APP123","key":"abcdefghijklmnopqrstuvwxyz"};</script>'))
      .toEqual({ app: 'APP123', key: 'abcdefghijklmnopqrstuvwxyz' });
    expect(() => parseAlgoliaCredentials('<html></html>')).toThrow(/credentials/);
  });

  it('joins W24 AI companies to public founder records by company slug', () => {
    const result = combineDirectoryResults({ hits: COMPANY_HITS }, { hits: FOUNDER_HITS });
    expect(result.companies).toHaveLength(5);
    expect(result.companies[0]?.founders).toEqual(['Alice0 Founder0', 'Bob0 Builder0']);
  });

  it('ignores companies without public founder rows and validates envelopes', () => {
    const result = combineDirectoryResults({ hits: [...COMPANY_HITS, { name: 'No Founder', slug: 'none' }] }, { hits: FOUNDER_HITS });
    expect(result.companies.map((company) => company.name)).not.toContain('No Founder');
    expect(() => combineDirectoryResults({ wrong: [] }, { hits: [] })).toThrow(/company/);
  });

  it('performs two directory reads and two index queries without live HTTP', async () => {
    const seen: string[] = [];
    const fetchFn = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      seen.push(`${init?.method ?? 'GET'} ${url}`);
      if (url.endsWith('/companies')) return new Response('<script>window.AlgoliaOpts = {"app":"APP123","key":"companykeycompanykeycompanykey"};</script>');
      if (url.endsWith('/founders')) return new Response('<script>window.AlgoliaOpts = {"app":"APP123","key":"founderkeyfounderkeyfounderkey"};</script>');
      if (url.includes('YCCompany_production')) return new Response(JSON.stringify({ hits: COMPANY_HITS }));
      if (url.includes('YCUsers_production')) return new Response(JSON.stringify({ hits: FOUNDER_HITS }));
      return new Response('not found', { status: 404 });
    };
    const result = await fetchYcW24AiCompanies({ fetchFn, sleep: async () => undefined, random: () => 0.5 });
    expect(result.companies).toHaveLength(5);
    expect(seen.filter((item) => item.startsWith('POST'))).toHaveLength(2);
  });

  it('keeps an untagged company whose one-liner reads AI and drops a non-AI company', async () => {
    const hits = [
      ...COMPANY_HITS,
      { name: 'Maplike', slug: 'maplike', one_liner: 'AI Agents for Location', long_description: 'Keeps map data current.', tags: [], batch: 'Winter 2024' },
      { name: 'Pure Fintech', slug: 'pure-fintech', one_liner: 'Payments for restaurants', long_description: 'Card processing for hospitality.', tags: ['Fintech'], batch: 'Winter 2024' },
    ];
    const founders = [
      ...FOUNDER_HITS,
      { first_name: 'Ada', last_name: 'One', company_slug: 'maplike', batches: ['W24'] },
      { first_name: 'Ben', last_name: 'Two', company_slug: 'pure-fintech', batches: ['W24'] },
    ];
    const fetchFn = async (input: string | URL | Request): Promise<Response> => {
      const url = String(input);
      if (url.endsWith('/companies') || url.endsWith('/founders')) {
        return new Response('<script>window.AlgoliaOpts = {"app":"APP123","key":"companykeycompanykeycompanykey"};</script>');
      }
      if (url.includes('YCCompany_production')) return new Response(JSON.stringify({ hits }));
      if (url.includes('YCUsers_production')) return new Response(JSON.stringify({ hits: founders }));
      return new Response('not found', { status: 404 });
    };
    const result = await fetchYcW24AiCompanies({ fetchFn, sleep: async () => undefined, random: () => 0.5 });
    const names = result.companies.map((company) => company.name);
    expect(names).toContain('Maplike');
    expect(names).not.toContain('Pure Fintech');
  });

  it('classifies AI focus by tag or visible text, without substring false positives', () => {
    const base = { name: 'X', slug: 'x', oneLiner: '', longDescription: '', tags: [], founders: ['A B'] };
    expect(isAiFocused({ ...base, oneLiner: 'AI Agents for Location' })).toBe(true);
    expect(isAiFocused({ ...base, tags: ['Generative AI'] })).toBe(true);
    expect(isAiFocused({ ...base, longDescription: 'We fine-tune machine learning models.' })).toBe(true);
    expect(isAiFocused({ ...base, oneLiner: 'Air freight from Shanghai' })).toBe(false);
    expect(isAiFocused({ ...base, oneLiner: 'Payments for restaurants', tags: ['Fintech'] })).toBe(false);
  });
});
