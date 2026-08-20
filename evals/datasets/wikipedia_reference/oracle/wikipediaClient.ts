import { fetchWithRetry, type FetchRetryDeps } from '../../../oracles/fetchWithRetry.js';

const PAGE_TITLE = 'World War II';
export const TARGET_REFERENCE_NUMBER = 275;

export interface WikipediaReferenceOracle {
  pageTitle: string;
  referenceNumber: number;
  referenceId: string;
  referenceText: string;
  sourceId: string;
  sourceText: string;
}

export interface WikipediaClientDeps extends FetchRetryDeps {}

/** Fetch parsed HTML through MediaWiki's official API and independently
 * follow displayed reference 275 to the cited Sources entry. */
export async function fetchWikipediaReference(
  deps: WikipediaClientDeps = {},
): Promise<WikipediaReferenceOracle> {
  const url = new URL('https://en.wikipedia.org/w/api.php');
  url.search = new URLSearchParams({
    action: 'parse',
    page: PAGE_TITLE,
    prop: 'text',
    format: 'json',
    formatversion: '2',
  }).toString();
  const response = await fetchWithRetry(
    url.href,
    {
      headers: { 'user-agent': 'evidence-collection-agent/0.1 (evaluation oracle)' },
    },
    deps,
  );
  if (!response.ok) throw new Error(`Wikipedia oracle request failed: HTTP ${response.status}`);
  const data = (await response.json()) as { parse?: { title?: unknown; text?: unknown } };
  if (typeof data.parse?.text !== 'string' || typeof data.parse.title !== 'string') {
    throw new Error('Wikipedia parse API returned malformed page HTML');
  }
  return parseReferenceSourceHtml(data.parse.text, TARGET_REFERENCE_NUMBER, data.parse.title);
}

/** Parse by the displayed citation number, not MediaWiki's internal numeric
 * suffix: those differ whenever named citations are reused. */
export function parseReferenceSourceHtml(
  rawHtml: string,
  referenceNumber = TARGET_REFERENCE_NUMBER,
  pageTitle = PAGE_TITLE,
): WikipediaReferenceOracle {
  const html = rawHtml.replaceAll('&#95;', '_');
  const referenceSup = [
    ...html.matchAll(/<sup\b[^>]*class="[^"]*\breference\b[^"]*"[^>]*>[\s\S]*?<\/sup>/gi),
  ].find((match) => htmlToText(match[0]).replace(/\s+/g, '') === `[${referenceNumber}]`)?.[0];
  if (!referenceSup)
    throw new Error(`Wikipedia page has no displayed reference [${referenceNumber}]`);
  const referenceId = /href="#([^"]+)"/i.exec(referenceSup)?.[1];
  if (!referenceId) throw new Error(`Wikipedia reference [${referenceNumber}] has no target id`);

  const referenceItem = captureElementById(html, 'li', referenceId);
  const referenceHtml =
    /<span\b[^>]*class="[^"]*\breference-text\b[^"]*"[^>]*>([\s\S]*?)<\/span>/i.exec(
      referenceItem,
    )?.[1];
  if (!referenceHtml)
    throw new Error(`Wikipedia reference [${referenceNumber}] has no reference-text span`);
  const sourceId = /href="#(CITEREF[^"]+)"/i.exec(referenceHtml)?.[1];
  if (!sourceId)
    throw new Error(`Wikipedia reference [${referenceNumber}] does not link into Sources`);

  const sourceHtml = captureElementById(html, 'cite', sourceId);
  const sourceText = htmlToText(sourceHtml);
  if (sourceText.length < 20) throw new Error(`Wikipedia source ${sourceId} is unexpectedly short`);
  return {
    pageTitle,
    referenceNumber,
    referenceId,
    referenceText: htmlToText(referenceHtml),
    sourceId,
    sourceText,
  };
}

function captureElementById(html: string, tag: string, id: string): string {
  const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`<${tag}\\b[^>]*id="${escaped}"[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i').exec(
    html,
  );
  if (!match) throw new Error(`Wikipedia page has no <${tag}> with id ${id}`);
  return match[1]!;
}

export function htmlToText(html: string): string {
  return decodeEntities(html.replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

function decodeEntities(value: string): string {
  const named: Record<string, string> = {
    amp: '&',
    apos: "'",
    gt: '>',
    lt: '<',
    nbsp: ' ',
    ndash: '–',
    mdash: '—',
    quot: '"',
  };
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (entity, body: string) => {
    if (body.startsWith('#x') || body.startsWith('#X'))
      return String.fromCodePoint(Number.parseInt(body.slice(2), 16));
    if (body.startsWith('#')) return String.fromCodePoint(Number.parseInt(body.slice(1), 10));
    return named[body.toLowerCase()] ?? entity;
  });
}
