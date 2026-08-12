import { fetchWithRetry, type FetchRetryDeps } from '../../../oracles/fetchWithRetry.js';

const NOTION_INDEX = 'https://www.notion.com/en-us/blog';
const FIGMA_FEED = 'https://www.figma.com/blog/feed/feed.json';
const EIGHT_SLEEP_INDEX = 'https://www.eightsleep.com/blog/';
const CHURN_WINDOW = 3;

export interface ContentCandidate {
  url: string;
  title: string;
  publishedAt: string;
}

export interface CompanyFreshnessTarget {
  name: string;
  homepageHosts: string[];
  contentCandidates: ContentCandidate[];
}

export interface CompanyFreshnessOracle {
  companies: CompanyFreshnessTarget[];
}

export interface CompanyContentDeps extends FetchRetryDeps {}

/** Fetch a small live freshness window from each company's official blog.
 * Three candidates absorb a post published between browser capture and
 * grading without accepting arbitrary old content. */
export async function fetchCompanyFreshnessOracle(
  deps: CompanyContentDeps = {},
): Promise<CompanyFreshnessOracle> {
  const [notion, figma, eightSleep] = await Promise.all([
    fetchNotionCandidates(deps),
    fetchFigmaCandidates(deps),
    fetchEightSleepCandidates(deps),
  ]);
  return {
    companies: [
      { name: 'Notion', homepageHosts: ['notion.com', 'www.notion.com'], contentCandidates: notion },
      { name: 'Figma', homepageHosts: ['figma.com', 'www.figma.com'], contentCandidates: figma },
      { name: 'Eight Sleep', homepageHosts: ['eightsleep.com', 'www.eightsleep.com'], contentCandidates: eightSleep },
    ],
  };
}

async function fetchNotionCandidates(deps: CompanyContentDeps): Promise<ContentCandidate[]> {
  const html = await fetchText(NOTION_INDEX, deps);
  const urls = extractUniqueMatches(html, /href="(\/blog\/(?!topic\/)[a-z0-9-]+)"/gi)
    .slice(0, 10).map((path) => new URL(path, 'https://www.notion.com').href);
  const candidates = (await Promise.all(urls.map((url) => fetchDatedArticle(url, deps))))
    .filter((value): value is ContentCandidate => value !== undefined);
  return newest(candidates, 'Notion');
}

async function fetchFigmaCandidates(deps: CompanyContentDeps): Promise<ContentCandidate[]> {
  const response = await fetchWithRetry(FIGMA_FEED, undefined, deps);
  if (!response.ok) throw new Error(`Figma feed request failed: HTTP ${response.status}`);
  const value = await response.json() as { items?: unknown };
  if (!Array.isArray(value.items)) throw new Error('Figma JSON feed has no items array');
  const candidates = value.items.flatMap((item): ContentCandidate[] => {
    if (typeof item !== 'object' || item === null) return [];
    const row = item as { url?: unknown; title?: unknown; date_modified?: unknown; date_published?: unknown };
    const publishedAt = typeof row.date_published === 'string' ? row.date_published : row.date_modified;
    return typeof row.url === 'string' && typeof row.title === 'string' && typeof publishedAt === 'string' && validDate(publishedAt)
      ? [{ url: row.url, title: row.title, publishedAt }]
      : [];
  });
  return newest(candidates, 'Figma');
}

async function fetchEightSleepCandidates(deps: CompanyContentDeps): Promise<ContentCandidate[]> {
  const html = await fetchText(EIGHT_SLEEP_INDEX, deps);
  return newest(parseEightSleepIndex(html), 'Eight Sleep');
}

export function parseEightSleepIndex(html: string): ContentCandidate[] {
  const pattern = /<h3\b[^>]*>[\s\S]*?<a\b[^>]*href="(\/blog\/[a-z0-9-]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<\/h3>/gi;
  const candidates: ContentCandidate[] = [];
  for (const match of html.matchAll(pattern)) {
    const after = html.slice(match.index! + match[0].length, match.index! + match[0].length + 3000);
    const dateText = /<small\b[^>]*>([\s\S]*?)<\/small>/i.exec(after)?.[1];
    if (!dateText) continue;
    const parsed = new Date(stripTags(dateText));
    if (Number.isNaN(parsed.getTime())) continue;
    candidates.push({
      url: new URL(match[1]!, 'https://www.eightsleep.com').href,
      title: stripTags(match[2]!),
      publishedAt: parsed.toISOString(),
    });
  }
  return dedupeByUrl(candidates);
}

async function fetchDatedArticle(url: string, deps: CompanyContentDeps): Promise<ContentCandidate | undefined> {
  const response = await fetchWithRetry(url, undefined, deps);
  if (!response.ok) return undefined;
  const html = await response.text();
  const publishedAt = /property="article:published_time"\s+content="([^"]+)"/i.exec(html)?.[1] ??
    /"datePublished"\s*:\s*"([^"]+)"/i.exec(html)?.[1] ??
    /<time\b[^>]*dateTime="([^"]+)"/i.exec(html)?.[1];
  if (!publishedAt || !validDate(publishedAt)) return undefined;
  const title = /property="og:title"\s+content="([^"]+)"/i.exec(html)?.[1] ??
    /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? new URL(url).pathname;
  return { url, title: stripTags(title), publishedAt };
}

async function fetchText(url: string, deps: CompanyContentDeps): Promise<string> {
  const response = await fetchWithRetry(url, undefined, deps);
  if (!response.ok) throw new Error(`official content index request failed for ${url}: HTTP ${response.status}`);
  return response.text();
}

export function newest(candidates: ContentCandidate[], label: string): ContentCandidate[] {
  const sorted = dedupeByUrl(candidates).filter((candidate) => validDate(candidate.publishedAt))
    .sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt)).slice(0, CHURN_WINDOW);
  if (sorted.length === 0) throw new Error(`${label} oracle found no dated official content`);
  return sorted;
}

function extractUniqueMatches(value: string, pattern: RegExp): string[] {
  return [...new Set([...value.matchAll(pattern)].map((match) => match[1]!))];
}
function dedupeByUrl(candidates: ContentCandidate[]): ContentCandidate[] {
  return [...new Map(candidates.map((candidate) => [normalizeUrl(candidate.url), candidate])).values()];
}
function normalizeUrl(value: string): string {
  const url = new URL(value);
  return `${url.hostname.toLowerCase()}${url.pathname.replace(/\/$/, '')}`;
}
function validDate(value: string): boolean {
  return !Number.isNaN(Date.parse(value));
}
function stripTags(value: string): string {
  return value.replace(/<[^>]*>/g, ' ').replace(/&amp;/g, '&').replace(/&#\d+;/g, ' ').replace(/\s+/g, ' ').trim();
}
