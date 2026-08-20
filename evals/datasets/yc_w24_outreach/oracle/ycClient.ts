import { fetchWithRetry, type FetchRetryDeps } from '../../../oracles/fetchWithRetry.js';

const COMPANY_DIRECTORY_URL = 'https://www.ycombinator.com/companies';
const FOUNDER_DIRECTORY_URL = 'https://www.ycombinator.com/founders';
const COMPANY_INDEX = 'YCCompany_production';
const FOUNDER_INDEX = 'YCUsers_production';
const PROFILE_FETCH_CONCURRENCY = 8;

interface AlgoliaCredentials {
  app: string;
  key: string;
}

export interface YcAiCompany {
  name: string;
  slug: string;
  oneLiner: string;
  longDescription: string;
  tags: string[];
  founders: string[];
}

export interface YcW24AiOracle {
  companies: YcAiCompany[];
}

export interface YcClientDeps extends FetchRetryDeps {}

/** Query the same public, search-only Algolia indexes the official YC
 * Startup and Founder directories use. Credentials are discovered fresh
 * from each directory page rather than committed or assumed stable. The
 * founder index retains historical company associations, so each eligible
 * company's live YC profile supplies the final active-founder roster.
 *
 * The whole W24 batch is fetched and AI-classified locally (isAiFocused)
 * rather than tag-facet-filtered server-side: tag facets under-cover the
 * directory an agent actually reads — Reprompt (W24, one-liner "AI Agents
 * for Location") carries an EMPTY tags array in YC's index, so a tag
 * filter rejects legitimate picks the page plainly presents as AI. */
export async function fetchYcW24AiCompanies(deps: YcClientDeps = {}): Promise<YcW24AiOracle> {
  const [companyCredentials, founderCredentials] = await Promise.all([
    fetchDirectoryCredentials(COMPANY_DIRECTORY_URL, deps),
    fetchDirectoryCredentials(FOUNDER_DIRECTORY_URL, deps),
  ]);
  const [companyPayload, founderPayload] = await Promise.all([
    algoliaSearch(
      companyCredentials,
      COMPANY_INDEX,
      {
        query: '',
        hitsPerPage: 1000,
        facetFilters: [['batch:Winter 2024']],
        attributesToRetrieve: ['name', 'slug', 'one_liner', 'long_description', 'tags', 'batch'],
      },
      deps,
    ),
    algoliaSearch(
      founderCredentials,
      FOUNDER_INDEX,
      {
        query: '',
        hitsPerPage: 1000,
        facetFilters: [['batches:W24']],
        attributesToRetrieve: ['first_name', 'last_name', 'company_slug', 'batches'],
      },
      deps,
    ),
  ]);
  const combined = combineDirectoryResults(companyPayload, founderPayload);
  const aiCompanies = combined.companies.filter(isAiFocused);
  const profiles = await mapConcurrent(
    aiCompanies,
    PROFILE_FETCH_CONCURRENCY,
    async (company): Promise<YcAiCompany | undefined> => {
      const founders = await fetchCurrentProfileFounders(company.slug, deps);
      return founders.length === 0 ? undefined : { ...company, founders };
    },
  );
  const companies = profiles.filter((company): company is YcAiCompany => company !== undefined);
  if (companies.length < 5) {
    throw new Error(
      `YC oracle found only ${companies.length} AI-focused W24 companies with public founders`,
    );
  }
  return { companies };
}

const AI_TAGS = new Set([
  'artificial intelligence',
  'ai',
  'generative ai',
  'machine learning',
  'ml',
]);
const AI_TEXT =
  /\b(?:ai|artificial intelligence|machine learning|deep learning|llms?|generative)\b/i;

/** Whether a directory record reads as AI-focused — by tag, or by the
 * one-liner/description an agent actually sees on the page. */
export function isAiFocused(company: YcAiCompany): boolean {
  if (company.tags.some((tag) => AI_TAGS.has(tag.toLowerCase()))) return true;
  return AI_TEXT.test(company.oneLiner) || AI_TEXT.test(company.longDescription);
}

async function fetchDirectoryCredentials(
  url: string,
  deps: YcClientDeps,
): Promise<AlgoliaCredentials> {
  const response = await fetchWithRetry(url, undefined, deps);
  if (!response.ok)
    throw new Error(`YC directory request failed for ${url}: HTTP ${response.status}`);
  return parseAlgoliaCredentials(await response.text());
}

export function parseAlgoliaCredentials(html: string): AlgoliaCredentials {
  const json = /window\.AlgoliaOpts\s*=\s*(\{[^;]+\})\s*;/.exec(html)?.[1];
  if (!json) throw new Error('YC directory page did not expose public Algolia credentials');
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    throw new Error('YC directory exposed malformed Algolia credentials');
  }
  const credentials = value as Partial<AlgoliaCredentials> | null;
  if (
    !credentials ||
    typeof credentials.app !== 'string' ||
    !/^[A-Z0-9]+$/i.test(credentials.app) ||
    typeof credentials.key !== 'string' ||
    credentials.key.length < 20
  ) {
    throw new Error('YC directory exposed incomplete Algolia credentials');
  }
  return { app: credentials.app, key: credentials.key };
}

async function algoliaSearch(
  credentials: AlgoliaCredentials,
  index: string,
  body: Record<string, unknown>,
  deps: YcClientDeps,
): Promise<unknown> {
  const url = `https://${credentials.app}-dsn.algolia.net/1/indexes/${index}/query`;
  const response = await fetchWithRetry(
    url,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-algolia-application-id': credentials.app,
        'x-algolia-api-key': credentials.key,
      },
      body: JSON.stringify(body),
    },
    deps,
  );
  if (!response.ok) throw new Error(`YC ${index} oracle query failed: HTTP ${response.status}`);
  return response.json();
}

export function combineDirectoryResults(
  companyPayload: unknown,
  founderPayload: unknown,
): YcW24AiOracle {
  const companyHits = asHits(companyPayload, 'company');
  const founderHits = asHits(founderPayload, 'founder');
  const foundersBySlug = new Map<string, string[]>();
  for (const hit of founderHits) {
    const first = stringField(hit, 'first_name');
    const last = stringField(hit, 'last_name');
    const slug = stringField(hit, 'company_slug');
    if (!first || !last || !slug) continue;
    const names = foundersBySlug.get(slug) ?? [];
    const fullName = `${first} ${last}`.replace(/\s+/g, ' ').trim();
    if (!names.includes(fullName)) names.push(fullName);
    foundersBySlug.set(slug, names);
  }

  const companies = companyHits
    .flatMap((hit): YcAiCompany[] => {
      const name = stringField(hit, 'name');
      const slug = stringField(hit, 'slug');
      const founders = slug ? foundersBySlug.get(slug) : undefined;
      if (!name || !slug || !founders?.length) return [];
      const tags = Array.isArray(hit.tags)
        ? hit.tags.filter((tag): tag is string => typeof tag === 'string')
        : [];
      return [
        {
          name,
          slug,
          oneLiner: stringField(hit, 'one_liner') ?? '',
          longDescription: stringField(hit, 'long_description') ?? '',
          tags,
          founders: founders.sort((a, b) => a.localeCompare(b)),
        },
      ];
    })
    .sort((a, b) => a.name.localeCompare(b.name));
  if (companies.length < 5)
    throw new Error(
      `YC oracle found only ${companies.length} W24 AI companies with public founders`,
    );
  return { companies };
}

function asHits(payload: unknown, label: string): Array<Record<string, unknown>> {
  const hits = (payload as { hits?: unknown } | null)?.hits;
  if (!Array.isArray(hits) || !hits.every((hit) => typeof hit === 'object' && hit !== null)) {
    throw new Error(`YC ${label} Algolia response has no valid hits array`);
  }
  return hits as Array<Record<string, unknown>>;
}

function stringField(value: Record<string, unknown>, field: string): string | undefined {
  const raw = value[field];
  return typeof raw === 'string' && raw.trim() ? raw.trim() : undefined;
}

async function fetchCurrentProfileFounders(slug: string, deps: YcClientDeps): Promise<string[]> {
  const response = await fetchWithRetry(
    `${COMPANY_DIRECTORY_URL}/${encodeURIComponent(slug)}`,
    undefined,
    deps,
  );
  if (!response.ok) throw new Error(`YC company profile ${slug} failed: HTTP ${response.status}`);
  return parseCurrentProfileFounders(await response.text());
}

function parseCurrentProfileFounders(html: string): string[] {
  const names = Array.from(
    html.matchAll(
      /&quot;is_active&quot;:true(?:(?!&quot;is_active&quot;:)[\s\S])*?&quot;full_name&quot;:&quot;([^&]+)&quot;/g,
    ),
    (match) => match[1]!.replaceAll('&#x27;', "'").replaceAll('&amp;', '&').trim(),
  );
  return [...new Set(names)].sort((a, b) => a.localeCompare(b));
}

async function mapConcurrent<T, R>(
  values: readonly T[],
  concurrency: number,
  operation: (value: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, async () => {
      for (;;) {
        const index = next++;
        if (index >= values.length) return;
        results[index] = await operation(values[index]!);
      }
    }),
  );
  return results;
}
