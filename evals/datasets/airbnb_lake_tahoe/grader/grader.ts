import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  findRequestedOutputByName,
  readManifest,
  verifyManifestHashes,
} from '../../../grading/manifestVerification.js';
import type { AssertionResult, Grader } from '../../../types.js';
import type { AirbnbLakeTahoeOracle } from '../oracle/oracle.js';

const ANSWER_FILENAME = 'answer.md';
const LIST_ASSERTION_NAME = 'answer has a numbered list containing exactly items 1 through 30';
const URL_ASSERTION_NAME = 'all 30 items contain distinct Airbnb room URLs';
const ITEM_ASSERTION_NAME =
  'all 30 items identify a place and contain a substantive listing-specific summary';
const DATE_ASSERTION_NAME = 'answer states a seven-night date range beginning next week';
const OVERALL_ASSERTION_NAME =
  'answer contains a substantive overall summary and identifies Lake Tahoe';

interface NumberedSection {
  number: number;
  title: string;
  text: string;
}

/** Grade the durable report's structure and internal consistency. Exact
 * personalized ranking, availability, price, and prose fidelity remain the
 * human overlay because Airbnb exposes no stable public oracle. */
export const grade: Grader = (runDirPath, oracleData) => {
  const oracle = asOracle(oracleData);
  const manifest = readManifest(runDirPath);
  const answerEntry = findRequestedOutputByName(manifest, ANSWER_FILENAME);
  const answerExists =
    answerEntry !== undefined && existsSync(join(runDirPath, answerEntry.filename));
  const assertions: AssertionResult[] = [
    {
      name: `${ANSWER_FILENAME} exists with a manifest entry`,
      passed: answerExists,
      detail: answerExists
        ? `${answerEntry!.filename} found and manifested`
        : `${ANSWER_FILENAME} missing or not published as a requested output`,
    },
  ];

  if (!answerExists) {
    return [
      ...assertions,
      ...failedContent(`${ANSWER_FILENAME} is unavailable`),
      verifyManifestHashes(runDirPath, manifest),
    ];
  }

  const answer = readFileSync(join(runDirPath, answerEntry!.filename), 'utf8');
  const sections = parseNumberedSections(answer);
  assertions.push(listAssertion(sections, oracle));
  assertions.push(urlAssertion(sections, oracle));
  assertions.push(itemAssertion(sections, oracle));
  assertions.push(dateAssertion(answer, manifest.startedAt, oracle));
  assertions.push(overallAssertion(answer, oracle));
  assertions.push(verifyManifestHashes(runDirPath, manifest));
  return assertions;
};

/** Accept `1.`, `1)`, or a Markdown heading such as `### 1.`. */
export function parseNumberedSections(markdown: string): NumberedSection[] {
  const pattern = /^(?:#{1,6}\s+)?(\d{1,2})[.)]\s+(.+)$/gm;
  const matches = [...markdown.matchAll(pattern)];
  return matches.map((match, index) => ({
    number: Number(match[1]),
    title: match[2]!.trim(),
    text: markdown.slice(match.index!, matches[index + 1]?.index ?? markdown.length).trim(),
  }));
}

function listAssertion(
  sections: NumberedSection[],
  oracle: AirbnbLakeTahoeOracle,
): AssertionResult {
  const expected = Array.from({ length: oracle.listingCount }, (_, index) => index + 1);
  const actual = sections.map((section) => section.number);
  const passed =
    actual.length === expected.length &&
    actual.every((number, index) => number === expected[index]);
  return {
    name: LIST_ASSERTION_NAME,
    passed,
    detail: passed
      ? `found the ordered sequence 1–${oracle.listingCount}`
      : `number sequence: ${actual.join(', ') || '(none)'}`,
  };
}

function urlAssertion(sections: NumberedSection[], oracle: AirbnbLakeTahoeOracle): AssertionResult {
  const parsed = sections.map((section) => ({
    section,
    listing: firstAirbnbListing(section.text),
  }));
  const missing = parsed
    .filter(({ listing }) => listing === undefined)
    .map(({ section }) => section.number);
  const ids = parsed.flatMap(({ listing }) => (listing ? [listing.id] : []));
  const duplicateCount = ids.length - new Set(ids).size;
  const passed =
    sections.length === oracle.listingCount && missing.length === 0 && duplicateCount === 0;
  const problems = [
    missing.length ? `missing/invalid URL in item(s) ${missing.join(', ')}` : '',
    duplicateCount ? `${duplicateCount} duplicate listing id(s)` : '',
  ].filter(Boolean);
  return {
    name: URL_ASSERTION_NAME,
    passed,
    detail: problems.length ? problems.join('; ') : `${ids.length} distinct /rooms/<id> URLs`,
  };
}

function firstAirbnbListing(text: string): { id: string; url: URL } | undefined {
  for (const raw of text.match(/https?:\/\/[^\s)>\]}]+/gi) ?? []) {
    try {
      const url = new URL(raw.replace(/[.,;:]+$/, ''));
      const host = url.hostname.toLowerCase();
      const id = /^\/rooms\/(\d+)/.exec(url.pathname)?.[1];
      if ((host === 'airbnb.com' || host.endsWith('.airbnb.com')) && id) return { id, url };
    } catch {
      // Keep searching this item for another URL.
    }
  }
  return undefined;
}

function itemAssertion(
  sections: NumberedSection[],
  oracle: AirbnbLakeTahoeOracle,
): AssertionResult {
  const bad = sections
    .filter((section) => {
      const title = section.title.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').trim();
      const withoutUrls = section.text
        .replace(/https?:\/\/[^\s)>\]}]+/gi, '')
        .replace(/[#*_`|\-]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      return title.length < 3 || withoutUrls.length < 70;
    })
    .map((section) => section.number);
  return {
    name: ITEM_ASSERTION_NAME,
    passed: sections.length === oracle.listingCount && bad.length === 0,
    detail: bad.length
      ? `too little identity/summary detail in item(s) ${bad.join(', ')}`
      : `${sections.length} substantive item(s)`,
  };
}

function dateAssertion(
  answer: string,
  startedAt: string,
  oracle: AirbnbLakeTahoeOracle,
): AssertionResult {
  const dates = extractDates(answer);
  const runDate = startOfUtcDay(new Date(startedAt));
  let match: { checkIn: Date; checkOut: Date } | undefined;
  for (let i = 0; i < dates.length; i++) {
    for (let j = i + 1; j < dates.length; j++) {
      const nights = dayDifference(dates[i]!, dates[j]!);
      const daysAfterRun = dayDifference(runDate, dates[i]!);
      if (
        nights === oracle.stayNights &&
        daysAfterRun >= oracle.earliestCheckInDaysAfterRun &&
        daysAfterRun <= oracle.latestCheckInDaysAfterRun
      ) {
        match = { checkIn: dates[i]!, checkOut: dates[j]! };
        break;
      }
    }
    if (match) break;
  }
  return {
    name: DATE_ASSERTION_NAME,
    passed: match !== undefined,
    detail: match
      ? `${formatDate(match.checkIn)} to ${formatDate(match.checkOut)} (${oracle.stayNights} nights)`
      : `no acceptable ${oracle.stayNights}-night pair found among: ${dates.map(formatDate).join(', ') || '(no dates)'}`,
  };
}

function extractDates(text: string): Date[] {
  const candidates = [
    ...(text.match(/\b\d{4}-\d{2}-\d{2}\b/g) ?? []),
    ...(text.match(
      /\b(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+\d{1,2},?\s+\d{4}\b/gi,
    ) ?? []),
    ...(text.match(/\b\d{1,2}\/\d{1,2}\/\d{4}\b/g) ?? []),
  ];
  const unique = new Map<number, Date>();
  for (const candidate of candidates) {
    const value = /^\d{4}-/.test(candidate)
      ? new Date(`${candidate}T00:00:00Z`)
      : new Date(candidate);
    if (!Number.isNaN(value.getTime()))
      unique.set(startOfUtcDay(value).getTime(), startOfUtcDay(value));
  }
  return [...unique.values()].sort((a, b) => a.getTime() - b.getTime());
}

function overallAssertion(answer: string, oracle: AirbnbLakeTahoeOracle): AssertionResult {
  const heading = /^(?:#{1,6}\s+|\*\*)overall summary(?:\*\*)?\s*[:\-]?\s*$/im.exec(answer);
  const summary = heading ? answer.slice(heading.index + heading[0].length).trim() : '';
  const hasLocation = oracle.locationTerms.some((term) => answer.toLowerCase().includes(term));
  const passed = hasLocation && summary.replace(/\s+/g, ' ').length >= 120;
  return {
    name: OVERALL_ASSERTION_NAME,
    passed,
    detail: `${hasLocation ? 'Lake Tahoe identified' : 'Lake Tahoe not identified'}; overall summary has ${summary.length} character(s) (ranking/content fidelity is human-reviewed)`,
  };
}

function startOfUtcDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}
function dayDifference(from: Date, to: Date): number {
  return Math.round((startOfUtcDay(to).getTime() - startOfUtcDay(from).getTime()) / 86_400_000);
}
function formatDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function failedContent(detail: string): AssertionResult[] {
  return [
    LIST_ASSERTION_NAME,
    URL_ASSERTION_NAME,
    ITEM_ASSERTION_NAME,
    DATE_ASSERTION_NAME,
    OVERALL_ASSERTION_NAME,
  ].map((name) => ({ name, passed: false, detail }));
}

function asOracle(data: unknown): AirbnbLakeTahoeOracle {
  const value = data as Partial<AirbnbLakeTahoeOracle> | null;
  if (
    !value ||
    !Array.isArray(value.locationTerms) ||
    !value.locationTerms.every((term) => typeof term === 'string') ||
    value.listingCount !== 30 ||
    value.stayNights !== 7 ||
    typeof value.earliestCheckInDaysAfterRun !== 'number' ||
    typeof value.latestCheckInDaysAfterRun !== 'number'
  ) {
    throw new Error('airbnb_lake_tahoe grader was handed malformed oracle data');
  }
  return value as AirbnbLakeTahoeOracle;
}
