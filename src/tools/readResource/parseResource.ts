/**
 * Body parsing for `read_resource` (T11): turn retrieved bytes into the
 * smallest representation that still answers a question.
 *
 * Two rules shape everything here:
 *
 * 1. Parsing never destroys the original. The reader's bytes are what goes
 *    into evidence; this module produces a *view* for the model, and every
 *    view carries enough shape (row count, column names, item count) that a
 *    truncated view cannot be mistaken for a complete one.
 * 2. Parsing never throws for content reasons. A body that claims to be JSON
 *    and is not degrades to text with a warning, because a tool result the
 *    model can read and correct beats an exception it can only retry.
 */

/** How a body was parsed. */
export type ResourceFormat = 'json' | 'csv' | 'html' | 'text';

/** What a caller may ask for. `auto` decides from the content type and then
 * from the bytes themselves — servers mislabel JSON as `text/plain` often
 * enough that the label alone is not trustworthy. */
export type RequestedResourceFormat = 'auto' | ResourceFormat;

/** Rows above this are dropped from the parsed table. The byte bound already
 * limits the body; this bounds the *object* count for a pathological body of
 * one-byte rows. */
export const MAX_PARSED_CSV_ROWS = 20_000;

/** Links reported from an HTML body. Enough to find the next resource,
 * cheap enough to keep in context. */
export const MAX_HTML_LINKS = 50;

/** Delimiters `auto` will consider for a tabular body, in preference order. */
const CSV_DELIMITERS: readonly string[] = [',', '\t', ';', '|'];

/** A parsed tabular body. */
export interface ResourceTable {
  /** Header row, or synthetic `column1..N` names when the first row is not
   * a plausible header. */
  columns: string[];
  /** Data rows, each padded/truncated to `columns.length`. */
  rows: string[][];
  /** Rows parsed, which is `rows.length` unless `rowsTruncated`. */
  rowCount: number;
  /** True when parsing stopped at {@link MAX_PARSED_CSV_ROWS}. */
  rowsTruncated: boolean;
  /** The delimiter the body actually used. */
  delimiter: string;
}

/** One parsed body: exactly one of `json`, `table`, or `text` describes the
 * content, plus the complete rendered form for the offload path. */
export interface ParsedResource {
  format: ResourceFormat;
  /** Parsed value when `format` is `json`. */
  json?: unknown;
  /** Parsed table when `format` is `csv`. */
  table?: ResourceTable;
  /** Text content for `text`, and the extracted visible text for `html`. */
  text?: string;
  /** Document title, for `html`. */
  title?: string;
  /** Absolute links found in an HTML body, deduplicated and bounded. Report
   * only — reading one still requires it to have been observed in a page
   * (see `discoveredUrlIndex.ts`). */
  links?: string[];
  /** Why the requested format was not used, when it could not be. */
  parseWarning?: string;
  /** The complete content in its readable form: pretty JSON, the original
   * delimited text, or extracted/plain text. This is what the offload path
   * writes to disk. */
  rendered: string;
}

/** Options for {@link parseResourceBody}. */
export interface ParseResourceOptions {
  /** The format to parse as; `auto` sniffs. */
  format?: RequestedResourceFormat;
  /** The response's `content-type`, used by `auto` and for the charset. */
  contentType?: string;
  /** Final URL, used to resolve relative HTML links. */
  baseUrl?: string;
}

/**
 * Parse a retrieved body.
 *
 * @param body - the bytes the reader retained (already bounded)
 * @param options - requested format, content type, and base URL
 * @returns the parsed view plus its complete rendered form. Never throws for
 *   content reasons: an unparsable body comes back as `text` with
 *   `parseWarning` explaining what failed
 */
export function parseResourceBody(
  body: Uint8Array,
  options: ParseResourceOptions = {},
): ParsedResource {
  const text = decodeBody(body, options.contentType);
  const requested = options.format ?? 'auto';
  const format =
    requested === 'auto' ? detectResourceFormat(options.contentType, text) : requested;

  if (format === 'json') {
    try {
      const json = JSON.parse(text) as unknown;
      return { format: 'json', json, rendered: `${JSON.stringify(json, null, 2)}\n` };
    } catch (thrown) {
      // An explicit `format: 'json'` that fails is worth saying out loud;
      // `auto` only picks json after the body already looked like JSON, so
      // the same fallback covers a truncated body mid-object.
      return {
        ...asText(text),
        parseWarning:
          `Body is not valid JSON (${thrown instanceof Error ? thrown.message : String(thrown)}); ` +
          `returning it as text.`,
      };
    }
  }

  if (format === 'csv') {
    const table = parseDelimitedText(text, options.contentType);
    if (table === undefined) {
      return {
        ...asText(text),
        parseWarning: 'Body has no delimited rows; returning it as text.',
      };
    }
    return { format: 'csv', table, rendered: text };
  }

  if (format === 'html') {
    const extracted = extractHtmlText(text, options.baseUrl);
    return {
      format: 'html',
      text: extracted.text,
      ...(extracted.title !== undefined ? { title: extracted.title } : {}),
      ...(extracted.links.length > 0 ? { links: extracted.links } : {}),
      rendered: extracted.text,
    };
  }

  return asText(text);
}

/**
 * Decide a body's format from its content type, falling back to its bytes.
 *
 * The content type is checked first but is not the last word: `text/plain`
 * and `application/octet-stream` are what a lot of real JSON and CSV
 * endpoints send, so a labelled-but-unhelpful type falls through to
 * sniffing.
 *
 * @param contentType - the response `content-type`, when present
 * @param text - the decoded body, used for sniffing
 * @returns the format to parse as
 */
export function detectResourceFormat(
  contentType: string | undefined,
  text: string,
): ResourceFormat {
  const mediaType = (contentType ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
  if (mediaType.endsWith('/json') || mediaType.endsWith('+json')) return 'json';
  if (mediaType === 'text/csv' || mediaType === 'text/tab-separated-values') return 'csv';
  if (mediaType === 'text/html' || mediaType === 'application/xhtml+xml') return 'html';

  const head = text.slice(0, 4_096).trimStart();
  if (head.startsWith('{') || head.startsWith('[')) {
    // Only claim JSON if it actually parses — a template file can start with
    // '{' and a truncated body often does.
    try {
      JSON.parse(text);
      return 'json';
    } catch {
      // fall through to the remaining sniffs
    }
  }
  if (/^<(?:!doctype|html|\?xml|head|body)/i.test(head)) return 'html';
  if (looksDelimited(text)) return 'csv';
  return 'text';
}

/**
 * Parse delimited text (CSV/TSV) per RFC 4180: double-quoted fields,
 * doubled quotes as escapes, embedded newlines, and CRLF or LF line ends.
 *
 * @param text - the decoded body
 * @param contentType - used only to prefer tabs for
 *   `text/tab-separated-values`
 * @returns the table, or undefined when the body has no delimited rows at
 *   all (a single column with no delimiter is not a table)
 */
export function parseDelimitedText(
  text: string,
  contentType?: string,
): ResourceTable | undefined {
  const preferTabs = (contentType ?? '').toLowerCase().includes('tab-separated');
  const delimiter = chooseDelimiter(text, preferTabs, true);
  if (delimiter === undefined) {
    return undefined;
  }

  const records: string[][] = [];
  let rowsTruncated = false;
  let field = '';
  let record: string[] = [];
  let inQuotes = false;
  let sawAnyContent = false;

  const endField = (): void => {
    record.push(field);
    field = '';
  };
  const endRecord = (): boolean => {
    endField();
    // A trailing newline produces one empty field; that is not a row.
    if (!(record.length === 1 && record[0] === '')) {
      records.push(record);
    }
    record = [];
    if (records.length > MAX_PARSED_CSV_ROWS) {
      rowsTruncated = true;
      return false;
    }
    return true;
  };

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    if (inQuotes) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 1;
          continue;
        }
        inQuotes = false;
        continue;
      }
      field += char;
      continue;
    }
    if (char === '"' && field === '') {
      inQuotes = true;
      sawAnyContent = true;
      continue;
    }
    if (char === delimiter) {
      endField();
      sawAnyContent = true;
      continue;
    }
    if (char === '\r') {
      // Swallow CR of a CRLF pair; a lone CR also ends the record.
      if (text[index + 1] === '\n') index += 1;
      if (!endRecord()) break;
      continue;
    }
    if (char === '\n') {
      if (!endRecord()) break;
      continue;
    }
    field += char;
    sawAnyContent = true;
  }
  if (!rowsTruncated && (field !== '' || record.length > 0)) {
    endRecord();
  }
  if (records.length === 0 || !sawAnyContent) {
    return undefined;
  }

  const kept = records.slice(0, MAX_PARSED_CSV_ROWS);
  const header = kept[0]!;
  const useHeader = isPlausibleHeader(header);
  const columns = useHeader
    ? header.map((name, position) => (name.trim() === '' ? `column${position + 1}` : name.trim()))
    : header.map((_value, position) => `column${position + 1}`);
  const dataRows = (useHeader ? kept.slice(1) : kept).map((row) => normalizeRow(row, columns.length));

  return {
    columns,
    rows: dataRows,
    rowCount: dataRows.length,
    rowsTruncated,
    delimiter,
  };
}

/**
 * Extract the readable content of an HTML body.
 *
 * Deliberately a text extractor, not a DOM: this runs on bytes fetched
 * outside any browser, so there is no document to query and no scripts to
 * run. Script, style, and template content is dropped, block boundaries
 * become newlines, and the handful of entities that matter are decoded.
 *
 * @param html - the decoded HTML
 * @param baseUrl - final URL, used to make links absolute
 * @returns the title, the extracted text, and bounded absolute links
 */
export function extractHtmlText(
  html: string,
  baseUrl?: string,
): { title?: string; text: string; links: string[] } {
  const withoutHiddenContent = html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|template|svg)\b[\s\S]*?<\/\1\s*>/gi, ' ');

  const rawTitle = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(withoutHiddenContent)?.[1];
  const title = rawTitle === undefined ? undefined : collapseInline(decodeEntities(rawTitle));

  const text = decodeEntities(
    withoutHiddenContent
      // Block-level boundaries become line breaks and cell boundaries become
      // tabs, so extracted text keeps the structure a reader needs to tell
      // rows, cells, and paragraphs apart. Cell tags map to tabs ONLY: giving
      // `</td>` a newline as well would put every cell on its own line and
      // destroy the row it belongs to.
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(
        /<\/(p|div|section|article|li|tr|h[1-6]|table|thead|tbody|header|footer|nav|blockquote|pre|option)\s*>/gi,
        '\n',
      )
      .replace(/<(li|tr|p|div|h[1-6])\b[^>]*>/gi, '\n')
      .replace(/<(td|th)\b[^>]*>/gi, '\t')
      .replace(/<[^>]+>/g, ' '),
  )
    // Collapse runs of horizontal whitespace that is neither tab nor newline
    // (this is what folds a decoded no-break space into an ordinary space);
    // tabs survive because they carry the cell structure.
    .replace(/[^\S\n\t]+/g, ' ')
    .replace(/ *\t+ */g, '\t')
    .replace(/[ \t]*\n[ \t]*/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  const links: string[] = [];
  const seen = new Set<string>();
  const hrefPattern = /<a\b[^>]*?\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/gi;
  for (const match of withoutHiddenContent.matchAll(hrefPattern)) {
    if (links.length >= MAX_HTML_LINKS) break;
    const raw = decodeEntities(match[1] ?? match[2] ?? match[3] ?? '').trim();
    if (raw === '') continue;
    const absolute = toAbsoluteHttpUrl(raw, baseUrl);
    if (absolute === undefined || seen.has(absolute)) continue;
    seen.add(absolute);
    links.push(absolute);
  }

  return { ...(title !== undefined && title !== '' ? { title } : {}), text, links };
}

/** The plain-text shape of a parsed body. */
function asText(text: string): ParsedResource {
  return { format: 'text', text, rendered: text };
}

/**
 * Decode bytes to text using the charset the server declared, defaulting to
 * UTF-8. Non-fatal on purpose: replacement characters in a preview are
 * strictly better than refusing to show a mostly-readable body, and the
 * exact bytes are preserved in evidence either way.
 */
function decodeBody(body: Uint8Array, contentType?: string): string {
  const charset = /charset\s*=\s*"?([\w-]+)"?/i.exec(contentType ?? '')?.[1];
  if (charset !== undefined && charset.toLowerCase() !== 'utf-8') {
    try {
      return new TextDecoder(charset).decode(body);
    } catch {
      // Unknown label: fall back to UTF-8 rather than failing the read.
    }
  }
  return new TextDecoder('utf-8').decode(body);
}

/** True when the text has at least two lines that share a delimiter count —
 * the minimum evidence that a body is tabular rather than prose. A single
 * line with a comma in it is prose (or a truncated JSON body), which is why
 * sniffing requires more than one line while an explicit `format: 'csv'`
 * does not. */
function looksDelimited(text: string): boolean {
  return chooseDelimiter(text, false, false) !== undefined;
}

/**
 * Pick the delimiter a body uses: the candidate whose field count on the
 * first line is matched by a majority of the following lines. Counting only
 * outside quotes keeps a quoted comma from voting; requiring a majority
 * rather than unanimity tolerates the two shapes real exports have — a field
 * containing a newline (which splits one record across sampled lines) and an
 * occasional ragged row.
 */
function chooseDelimiter(
  text: string,
  preferTabs: boolean,
  allowSingleLine: boolean,
): string | undefined {
  const lines = text.split(/\r?\n/).filter((line) => line.trim() !== '').slice(0, 8);
  if (lines.length === 0 || (lines.length === 1 && !allowSingleLine)) {
    return undefined;
  }
  const candidates = preferTabs
    ? ['\t', ...CSV_DELIMITERS.filter((candidate) => candidate !== '\t')]
    : CSV_DELIMITERS;
  for (const candidate of candidates) {
    const counts = lines.map((line) => countOutsideQuotes(line, candidate));
    const first = counts[0] ?? 0;
    if (first === 0) continue;
    const agreeing = counts.filter((count) => count === first).length;
    if (agreeing * 2 > counts.length) {
      return candidate;
    }
  }
  return undefined;
}

function countOutsideQuotes(line: string, delimiter: string): number {
  let count = 0;
  let inQuotes = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '"') {
      inQuotes = !inQuotes;
      continue;
    }
    if (!inQuotes && char === delimiter) count += 1;
  }
  return count;
}

/** A header row is one where no cell is empty and no cell is purely
 * numeric — a first row of numbers is data, and naming columns `1`, `2`
 * would silently swallow a row. */
function isPlausibleHeader(row: readonly string[]): boolean {
  return row.every((cell) => cell.trim() !== '' && !/^-?\d+(?:\.\d+)?$/.test(cell.trim()));
}

/** Pad short rows and fold overflow cells into the last column, so every row
 * has the header's width and no data is dropped silently. */
function normalizeRow(row: readonly string[], width: number): string[] {
  if (row.length === width) return [...row];
  if (row.length < width) {
    return [...row, ...new Array<string>(width - row.length).fill('')];
  }
  const kept = row.slice(0, width - 1);
  kept.push(row.slice(width - 1).join(' '));
  return kept;
}

/** Resolve one HTML link to an absolute http(s) URL, dropping anything else
 * (`javascript:`, `mailto:`, fragments). */
function toAbsoluteHttpUrl(href: string, baseUrl?: string): string | undefined {
  try {
    const resolved = baseUrl === undefined ? new URL(href) : new URL(href, baseUrl);
    if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') return undefined;
    resolved.hash = '';
    return resolved.href;
  } catch {
    return undefined;
  }
}

/** Decode the entities that actually appear in extracted text, plus numeric
 * references. A full entity table is not worth carrying for a preview. */
function decodeEntities(text: string): string {
  return text
    .replace(/&#x([0-9a-fA-F]+);/g, (_match, hex: string) =>
      safeFromCodePoint(Number.parseInt(hex, 16)),
    )
    .replace(/&#(\d+);/g, (_match, digits: string) =>
      safeFromCodePoint(Number.parseInt(digits, 10)),
    )
    .replace(/&nbsp;/gi, ' ')
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    // Ampersand last: decoding it first would let `&amp;lt;` become `<`.
    .replace(/&amp;/gi, '&');
}

function safeFromCodePoint(codePoint: number): string {
  if (!Number.isInteger(codePoint) || codePoint < 0 || codePoint > 0x10_ffff) return '';
  try {
    return String.fromCodePoint(codePoint);
  } catch {
    return '';
  }
}

function collapseInline(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}
