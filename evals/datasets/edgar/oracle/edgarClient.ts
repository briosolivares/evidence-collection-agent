import { sha256Hex } from '../../../grading/hash.js';

/**
 * Typed client for the SEC EDGAR APIs: the per-company submissions feed
 * (`data.sec.gov/submissions`) and the filing document archive
 * (`www.sec.gov/Archives`). Parsing is split from fetching so the parse
 * logic can be unit-tested against canned JSON without any network access —
 * only the `fetch*` functions at the bottom of this file touch the network,
 * and the automated suite never calls them.
 */

/** Base URL of the SEC submissions API. */
const SEC_SUBMISSIONS_BASE = 'https://data.sec.gov/submissions';

/** Base URL of the SEC EDGAR document archive. */
const SEC_ARCHIVES_BASE = 'https://www.sec.gov/Archives/edgar/data';

/** Apple Inc.'s SEC CIK, zero-padded to 10 digits (the submissions API's id format). */
export const APPLE_CIK = '0000320193';

/** The filing form type the eval task targets. */
export const TARGET_FORM = '8-K';

/** The filing date (SEC's `filingDate` format, YYYY-MM-DD) the eval task targets. */
export const TARGET_FILING_DATE = '2026-01-29';

/** SEC requests a declared requester identity on every call, in their plain
 * `Name email` format — decorated strings (parentheses, colons) are rejected
 * by their edge with an HTML 403, observed live 2026-08-10. */
const SEC_USER_AGENT = 'Brios Olivares brioso@mit.edu';

/** One filing record from a company's SEC submissions feed. */
export interface EdgarFiling {
  /** The filing's accession number, e.g. "0000320193-26-000005". */
  accessionNumber: string;
  /** The filing's form type, e.g. "8-K". */
  form: string;
  /** The filing date, YYYY-MM-DD. */
  filingDate: string;
  /** Filename of the filing's primary document within its accession folder. */
  primaryDocument: string;
}

/** Ground truth for the EDGAR task: the target filing and its document bytes. */
export interface EdgarOracle {
  /** The matched filing record. */
  filing: EdgarFiling;
  /** Full URL of the filing's primary document in the EDGAR archive. */
  documentUrl: string;
  /** The primary document's exact bytes, as served by EDGAR. */
  documentBytes: Uint8Array;
  /** Lowercase hex SHA-256 of `documentBytes`. */
  documentSha256: string;
}

/**
 * Parse a company's SEC submissions JSON and find one filing matching a
 * form type and filing date.
 *
 * @param json - the parsed JSON body of a
 *   `GET /submissions/CIK##########.json` response
 * @param targetForm - the form type to match exactly (e.g. "8-K")
 * @param targetFilingDate - the filing date to match exactly, YYYY-MM-DD
 * @returns the first matching filing, in the feed's listed order
 * @throws if `json` does not have the expected `filings.recent` shape (its
 *   parallel arrays `accessionNumber`, `form`, `filingDate`, and
 *   `primaryDocument` must all be present, all arrays, and of equal length),
 *   or if no filing matches both `targetForm` and `targetFilingDate`
 */
export function parseSubmissions(
  json: unknown,
  targetForm: string,
  targetFilingDate: string,
): EdgarFiling {
  const recent = (json as { filings?: { recent?: unknown } } | null)?.filings?.recent as
    | Record<string, unknown>
    | undefined;
  if (typeof recent !== 'object' || recent === null) {
    throw new Error('submissions response is missing filings.recent');
  }

  const accessionNumber = requireStringArray(recent, 'accessionNumber');
  const form = requireStringArray(recent, 'form');
  const filingDate = requireStringArray(recent, 'filingDate');
  const primaryDocument = requireStringArray(recent, 'primaryDocument');

  const length = accessionNumber.length;
  if (form.length !== length || filingDate.length !== length || primaryDocument.length !== length) {
    throw new Error('filings.recent arrays have mismatched lengths');
  }

  for (let i = 0; i < length; i++) {
    if (form[i] === targetForm && filingDate[i] === targetFilingDate) {
      return {
        accessionNumber: accessionNumber[i]!,
        form: form[i]!,
        filingDate: filingDate[i]!,
        primaryDocument: primaryDocument[i]!,
      };
    }
  }
  throw new Error(`no ${targetForm} filing dated ${targetFilingDate} found in filings.recent`);
}

/**
 * Build the EDGAR archive URL for a filing's primary document.
 *
 * @param cik - the company's CIK, with or without leading zeros
 * @param filing - a filing record naming an accession number and primary
 *   document filename
 * @returns the document's full URL under `sec.gov/Archives/edgar/data`,
 *   with the CIK's leading zeros and the accession number's dashes
 *   stripped, per EDGAR's archive path convention
 */
export function buildEdgarDocumentUrl(cik: string, filing: EdgarFiling): string {
  const cikNoLeadingZeros = cik.replace(/^0+/, '') || '0';
  const accessionNoDashes = filing.accessionNumber.replace(/-/g, '');
  return `${SEC_ARCHIVES_BASE}/${cikNoLeadingZeros}/${accessionNoDashes}/${filing.primaryDocument}`;
}

function requireStringArray(obj: Record<string, unknown>, key: string): string[] {
  const value = obj[key];
  if (!Array.isArray(value) || !value.every((v) => typeof v === 'string')) {
    throw new Error(`filings.recent.${key} must be an array of strings`);
  }
  return value;
}

/**
 * Fetch the EDGAR oracle from the live SEC APIs: the target filing's record
 * plus its primary document's bytes and hash. Not called anywhere in the
 * automated test suite — it is the one live-HTTP seam this module exposes,
 * exercised only by `oracle/oracle.ts` at grading time and by demos.
 *
 * @returns the oracle for the EDGAR task: the matched filing, its
 *   document's URL, exact bytes, and SHA-256
 * @throws if either SEC API is unreachable, or if the submissions response
 *   cannot be parsed or has no matching filing (see `parseSubmissions`)
 */
export async function fetchEdgarOracle(): Promise<EdgarOracle> {
  const submissionsResponse = await fetch(`${SEC_SUBMISSIONS_BASE}/CIK${APPLE_CIK}.json`, {
    headers: { 'User-Agent': SEC_USER_AGENT },
  });
  const filing = parseSubmissions(await submissionsResponse.json(), TARGET_FORM, TARGET_FILING_DATE);

  const documentUrl = buildEdgarDocumentUrl(APPLE_CIK, filing);
  const documentResponse = await fetch(documentUrl, { headers: { 'User-Agent': SEC_USER_AGENT } });
  const documentBytes = new Uint8Array(await documentResponse.arrayBuffer());

  return { filing, documentUrl, documentBytes, documentSha256: sha256Hex(documentBytes) };
}
