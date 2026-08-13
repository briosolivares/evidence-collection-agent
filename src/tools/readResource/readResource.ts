/**
 * INTEGRATION (T11) — `read_resource` is complete and tested but deliberately
 * NOT registered: `src/tools/index.ts`, `src/tools/registry.ts`, and the
 * session wiring belong to the primary agent. What remains:
 *
 * 1. `src/tools/registry.ts` — add to `ToolCtx`:
 *      `evidenceStore?: EvidenceStore`              (src/evidence/evidenceStore.js)
 *      `resourceReader?: PublicResourceReader`      (src/browser/publicResourceReader.js)
 *      `discoveredUrls?: DiscoveredUrlIndex`        (src/browser/discoveredUrlIndex.js)
 *    The reader and the index are SESSION-scoped: create one
 *    `PlaywrightPublicResourceReader` and one `createDiscoveredUrlIndex()`
 *    where the browser session is created, and hand the same instances to
 *    every call. A per-call index would grant nothing (it would be empty) and
 *    a per-call reader would relaunch a transport per read.
 *
 * 2. Session wiring must feed the index, or this tool refuses everything:
 *      - after a deliberate `navigate` / `browser_action` navigation:
 *        `recordObservedUrl(index, landedUrl, 'deliberate_navigation')`
 *      - for each link in an observation:
 *        `recordObservedUrl(index, absoluteHref, 'observed_link')`
 *      - from the controller's `response` listener:
 *        `recordObservedUrl(index, response.url(), 'network_response')`
 *      - for URLs written in the task text:
 *        `recordObservedUrl(index, url, 'task_input')`
 *    NEVER feed it URLs found inside a body this tool fetched — that turns
 *    one allowed read into an unbounded crawl steered by page content.
 *
 * 3. `src/tools/index.ts` — export a `resourceTools` array and spread it LAST
 *    inside `createProductionRegistry`, after the existing conditional tools,
 *    so no existing tool's index moves and the cached prompt prefix keeps its
 *    bytes.
 *
 * 4. Evidence kind: records are filed under `javascript_extraction` with
 *    `detail.recordType = 'network_response'` until
 *    `src/evidence/evidenceStore.ts` accepts `network_response` (see
 *    `PENDING_RESOURCE_EVIDENCE_KIND` in publicResourceReader.ts).
 *
 * The plan's `readResourceTool` symbol is the value
 * {@link createReadResourceTool} returns; a module-level constant is not
 * possible while the reader and index reach the tool through a factory rather
 * than `ToolCtx`.
 */

import { z } from 'zod';

import {
  isAllowedResourceUrl,
  recordObservedUrl,
  type DiscoveredUrlIndex,
} from '../../browser/discoveredUrlIndex.js';
import {
  MAX_RESOURCE_BYTES,
  MAX_RESOURCE_URL_CHARS,
  PublicResourceReadError,
  PublicResourceUrlError,
  recordResourceEvidence,
  type PublicResourceReader,
  type ReadResourceOutput,
} from '../../browser/publicResourceReader.js';
import type { EvidenceStore } from '../../evidence/evidenceStore.js';
import { DEFAULT_MAX_RESULT_BYTES, offloadResult, type OffloadedResult } from '../capResult.js';
import type { ToolCtx, ToolDef } from '../registry.js';
import {
  parseResourceBody,
  type ParsedResource,
  type RequestedResourceFormat,
} from './parseResource.js';

/** Registry name of this tool, also the stem of its offload filenames. */
export const READ_RESOURCE_TOOL_NAME = 'read_resource';

/**
 * Default inline byte budget for the parsed view. Roughly 3k tokens: enough
 * for a hundred-odd table rows or a mid-size JSON document, small enough that
 * one resource read cannot dominate every later turn.
 */
export const DEFAULT_INLINE_CONTENT_BYTES = 12_000;

/** Bytes reserved for everything that is not the parsed view (URLs, hop
 * list, headers, evidence id, JSON escaping). Together with the content
 * budget this keeps a result under DEFAULT_MAX_RESULT_BYTES by construction,
 * so the pipeline never offloads a result *containing* an evidence id — which
 * would leave the model citing an id it never saw. */
const ENVELOPE_RESERVE_BYTES = 20_000;

/** Table rows inlined at most, regardless of the byte budget: a wide table's
 * first fifty rows answer "what is in here", and the rest is on disk. */
const MAX_INLINE_TABLE_ROWS = 50;

/** Standing reminder attached to every result. Endpoint values are a
 * shortcut, not an authority: when a JSON/CSV endpoint disagrees with the
 * rendered page, the deliberately opened or task-named source wins. */
const SPOT_CHECK_NOTE =
  'Read anonymously (no login, no cookies), so this may differ from what the ' +
  'logged-in page shows. Spot-check a few values and the ordering against the ' +
  'visible page before using them as final answers; if they disagree, the page ' +
  'you deliberately opened is authoritative.';

/** Input accepted by `read_resource`. */
export const readResourceInputSchema = z.strictObject({
  url: z
    .string()
    .min(1)
    .max(MAX_RESOURCE_URL_CHARS)
    .describe(
      'Absolute http(s) URL of a resource you have already seen in this session — a link from an observation, a URL the page requested, or a page you navigated to. Invented URLs are refused.',
    ),
  format: z
    .enum(['auto', 'json', 'csv', 'html', 'text'])
    .optional()
    .describe(
      "How to parse the body; 'auto' (default) decides from the content type and the bytes.",
    ),
  maxBytes: z
    .number()
    .int()
    .min(1)
    .max(MAX_RESOURCE_BYTES)
    .optional()
    .describe(
      `Bytes to retrieve (max ${MAX_RESOURCE_BYTES}). A longer resource is truncated and reported as truncated.`,
    ),
  captureEvidence: z
    .boolean()
    .optional()
    .describe(
      'Save the original response bytes as a durable evidence record and return its Evidence ID (default true). Leave it on whenever the values may appear in an answer or output file.',
    ),
});

/** Input accepted by `read_resource`. */
export type ReadResourceInput = z.infer<typeof readResourceInputSchema>;

/** The table view of a delimited resource, bounded for the model. */
export interface ReadResourceTableView {
  columns: string[];
  /** Rows parsed from the retrieved bytes. */
  rowCount: number;
  /** Rows included inline (the rest are in the offloaded file). */
  rowsShown: number;
  rows: string[][];
  /** True when parsing itself stopped at a row bound. */
  rowsTruncated: boolean;
  /** The delimiter the body used. */
  delimiter: string;
}

/** Model-facing result of one anonymous resource read. */
export interface ReadResourceResult {
  requestedUrl: string;
  /** The URL that produced the body (differs after a redirect). */
  finalUrl: string;
  status: number;
  contentType?: string;
  /** The whole hop chain, first request first, present only when the read was
   * redirected. */
  redirectChain?: string[];
  /** Bytes retrieved. */
  bytes: number;
  /** True when the body was cut at the byte bound — parsed values may be
   * incomplete. */
  truncated: boolean;
  /** How the body was parsed. */
  format: ParsedResource['format'];
  /** Why the requested format was not used, when it could not be. */
  parseWarning?: string;
  /** Parsed JSON, when it fit the inline budget. */
  json?: unknown;
  /** One-line shape of an offloaded JSON value, so the model knows what is
   * in the file it was handed. */
  shape?: string;
  /** Bounded table view, for a delimited body. */
  table?: ReadResourceTableView;
  /** Extracted text, when it fit the inline budget. */
  text?: string;
  /** Document title, for an HTML body. */
  title?: string;
  /** Links found in an HTML body. Reading one still requires observing it in
   * a page first. */
  links?: string[];
  /** Preview plus the run-dir-relative path of the complete content, when the
   * parsed view did not fit inline. Read it with read_file or grep. */
  offloaded?: OffloadedResult;
  /** Citable Evidence ID for the original bytes. */
  evidenceId?: string;
  /** Run-dir-relative path of the evidence record. */
  evidencePath?: string;
  /** Standing caveat about anonymous reads. */
  note: string;
}

/** Everything the tool needs from the session that `ToolCtx` cannot carry
 * yet (see the INTEGRATION note above). */
export interface ReadResourceDeps {
  /** The session's anonymous resource reader. */
  reader: (ctx: ToolCtx) => PublicResourceReader;
  /** The session's URL provenance index — the same instance the navigation
   * and observation paths feed. */
  discoveredUrls: (ctx: ToolCtx) => DiscoveredUrlIndex;
  /** The run's evidence ledger, or undefined for a run without one. */
  evidenceStore?: (ctx: ToolCtx) => EvidenceStore | undefined;
  /** Inline byte budget for the parsed view; defaults to
   * {@link DEFAULT_INLINE_CONTENT_BYTES}. */
  inlineMaxBytes?: number;
}

/**
 * Build the `read_resource` tool for one browser session.
 *
 * @param deps - the session's reader, provenance index, and evidence
 *   resolver
 * @returns the registry definition, ready to append to a registry
 * @throws Error when `inlineMaxBytes` is not a positive integer that leaves
 *   room for the result envelope
 */
export function createReadResourceTool(deps: ReadResourceDeps): ToolDef<ReadResourceInput> {
  const inlineMaxBytes = deps.inlineMaxBytes ?? DEFAULT_INLINE_CONTENT_BYTES;
  if (!Number.isInteger(inlineMaxBytes) || inlineMaxBytes < 1) {
    throw new Error(
      `inlineMaxBytes must be a positive integer, got ${String(inlineMaxBytes)}`,
    );
  }
  if (inlineMaxBytes + ENVELOPE_RESERVE_BYTES > DEFAULT_MAX_RESULT_BYTES) {
    throw new Error(
      `inlineMaxBytes ${inlineMaxBytes} leaves no room for the result envelope: ` +
        `it must be at most ${DEFAULT_MAX_RESULT_BYTES - ENVELOPE_RESERVE_BYTES}, ` +
        `so a result carrying an evidence id is never offloaded whole.`,
    );
  }

  return {
    name: READ_RESOURCE_TOOL_NAME,
    description:
      'Read a public JSON, CSV, HTML, or text resource you have already seen in this session (a link from an observation, a URL the page requested, or a page you navigated to) and get a bounded parsed view. ' +
      'Use it to pull a whole dataset in one call instead of paging through a rendered table. ' +
      'The read is ANONYMOUS: no login, no cookies, no credentials — so a resource behind a session returns 401/403 and must be read through the browser page instead. ' +
      'Only public Internet addresses are reachable; internal, loopback, and metadata addresses are refused. ' +
      'Spot-check the values against the visible page before treating them as final.',
    inputSchema: readResourceInputSchema,
    // A network read that touches no page state, so it is safe to schedule
    // alongside other reads. It does append an evidence record; evidence ids
    // are issued synchronously inside one record() call, so parallel reads
    // cannot interleave into the same id.
    readOnly: true,
    async execute(input, ctx): Promise<ReadResourceResult> {
      const index = deps.discoveredUrls(ctx);
      // Provenance first: a URL the model was never shown must cost no DNS
      // query and no socket, so this precedes every other check.
      const decision = isAllowedResourceUrl(index, input.url);
      if (!decision.allowed) {
        throw new Error(`read_resource refused ${input.url}. ${decision.reason}`);
      }

      const captureEvidence = input.captureEvidence ?? true;
      // Resolved before the request: a read whose evidence could never be
      // recorded should not spend a network call, and must not return values
      // the model would then cite with an id that does not exist.
      const store = captureEvidence ? requireEvidenceStore(deps, ctx) : undefined;

      const output = await readWithGuidance(deps.reader(ctx), {
        url: decision.normalizedUrl,
        ...(input.maxBytes !== undefined ? { maxBytes: input.maxBytes } : {}),
      });

      // The URL that actually served the body is now a first-hand sighting;
      // re-reading it later needs no fresh observation. Nothing from inside
      // the body is recorded (see the INTEGRATION note).
      recordObservedUrl(index, output.finalUrl, 'network_response');

      const parsed = parseResourceBody(output.bytes, {
        format: (input.format ?? 'auto') as RequestedResourceFormat,
        ...(output.contentType !== undefined ? { contentType: output.contentType } : {}),
        baseUrl: output.finalUrl,
      });

      const evidence =
        store === undefined
          ? undefined
          : recordResourceEvidence(store, output, {
              summary: describeEvidenceSummary(output, parsed),
            });

      return {
        requestedUrl: output.requestedUrl,
        finalUrl: output.finalUrl,
        status: output.status,
        ...(output.contentType !== undefined ? { contentType: output.contentType } : {}),
        ...(output.hops.length > 1
          ? { redirectChain: output.hops.map((hop) => hop.url) }
          : {}),
        bytes: output.bytes.byteLength,
        truncated: output.truncated,
        format: parsed.format,
        ...(parsed.parseWarning !== undefined ? { parseWarning: parsed.parseWarning } : {}),
        ...buildContentView(ctx.runDir, parsed, inlineMaxBytes),
        ...(evidence !== undefined
          ? { evidenceId: evidence.id, evidencePath: evidence.path }
          : {}),
        note: SPOT_CHECK_NOTE,
      };
    },
  };
}

/**
 * Split the parsed view between "inline" and "offloaded to a file".
 *
 * Metadata that is small and load-bearing — the column names, the row count,
 * a JSON value's shape — always stays inline, even when the content itself
 * moves to disk: without it the model cannot tell whether the file is worth
 * opening.
 */
function buildContentView(
  runDir: string,
  parsed: ParsedResource,
  inlineMaxBytes: number,
): Partial<ReadResourceResult> {
  if (parsed.format === 'json') {
    const compact = JSON.stringify(parsed.json ?? null);
    if (Buffer.byteLength(compact, 'utf8') <= inlineMaxBytes) {
      return { json: parsed.json };
    }
    return {
      shape: describeValueShape(parsed.json),
      offloaded: offload(runDir, parsed.rendered, inlineMaxBytes, 'parsed JSON value'),
    };
  }

  if (parsed.format === 'csv' && parsed.table !== undefined) {
    const table = parsed.table;
    const rows: string[][] = [];
    let usedBytes = Buffer.byteLength(JSON.stringify(table.columns), 'utf8');
    for (const row of table.rows) {
      if (rows.length >= MAX_INLINE_TABLE_ROWS) break;
      const rowBytes = Buffer.byteLength(JSON.stringify(row), 'utf8');
      if (usedBytes + rowBytes > inlineMaxBytes) break;
      usedBytes += rowBytes;
      rows.push(row);
    }
    const view: ReadResourceTableView = {
      columns: table.columns,
      rowCount: table.rowCount,
      rowsShown: rows.length,
      rows,
      rowsTruncated: table.rowsTruncated,
      delimiter: table.delimiter,
    };
    return {
      table: view,
      // Offloaded whenever any row is missing inline, so "the rest" always
      // has a path rather than being silently unavailable.
      ...(rows.length < table.rows.length
        ? {
            offloaded: offload(
              runDir,
              parsed.rendered,
              inlineMaxBytes,
              `complete delimited content (${table.rowCount} rows, ${rows.length} shown inline)`,
            ),
          }
        : {}),
    };
  }

  const text = parsed.text ?? '';
  const shared: Partial<ReadResourceResult> = {
    ...(parsed.title !== undefined ? { title: parsed.title } : {}),
    ...(parsed.links !== undefined ? { links: parsed.links } : {}),
  };
  if (Buffer.byteLength(text, 'utf8') <= inlineMaxBytes) {
    return { ...shared, text };
  }
  return {
    ...shared,
    offloaded: offload(runDir, parsed.rendered, inlineMaxBytes, 'extracted text'),
  };
}

function offload(
  runDir: string,
  rendered: string,
  inlineMaxBytes: number,
  what: string,
): OffloadedResult {
  return offloadResult(
    runDir,
    READ_RESOURCE_TOOL_NAME,
    rendered,
    `over the ${inlineMaxBytes}-byte inline limit for the ${what}`,
  );
}

/** Run the read, converting the reader's typed refusals into guidance the
 * model can act on instead of retrying blindly. */
async function readWithGuidance(
  reader: PublicResourceReader,
  request: { url: string; maxBytes?: number },
): Promise<ReadResourceOutput> {
  try {
    return await reader.read(request);
  } catch (thrown) {
    if (thrown instanceof PublicResourceUrlError) {
      throw new Error(
        `${thrown.message} Only public web addresses can be read; do not retry this ` +
          `URL. Open the source in the browser if it is reachable there.`,
      );
    }
    if (thrown instanceof PublicResourceReadError) {
      throw new Error(
        `${thrown.message} Try the browser page for this source, or a narrower ` +
          `query against the same endpoint.`,
      );
    }
    throw thrown;
  }
}

/** Resolve the evidence ledger, or explain that this run cannot issue ids.
 * Failing closed matters: returning values with no id invites the model to
 * cite one that does not exist. */
function requireEvidenceStore(deps: ReadResourceDeps, ctx: ToolCtx): EvidenceStore {
  const store = deps.evidenceStore?.(ctx);
  if (store === undefined) {
    throw new Error(
      'captureEvidence was requested but this run has no evidence ledger, so no ' +
        'Evidence ID can be issued. Re-run with captureEvidence: false and persist ' +
        'the values with write_file instead.',
    );
  }
  return store;
}

/** One-line evidence summary: what was read, and what shape it turned out to
 * be, so the record is recognizable without opening it. */
function describeEvidenceSummary(
  output: ReadResourceOutput,
  parsed: ParsedResource,
): string {
  const shape =
    parsed.format === 'csv' && parsed.table !== undefined
      ? `${parsed.table.rowCount} rows x ${parsed.table.columns.length} columns`
      : parsed.format === 'json'
        ? describeValueShape(parsed.json)
        : `${(parsed.text ?? '').length} characters of ${parsed.format}`;
  return (
    `Anonymous ${parsed.format} read of ${truncate(output.finalUrl, 200)} ` +
    `(HTTP ${output.status}, ${output.bytes.byteLength} bytes` +
    `${output.truncated ? ', truncated' : ''}): ${shape}`
  );
}

/** Describe a value's shape for a summary or an offload pointer. */
function describeValueShape(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (Array.isArray(value)) {
    const first = value[0] as unknown;
    const keys =
      typeof first === 'object' && first !== null && !Array.isArray(first)
        ? Object.keys(first as object).slice(0, 6)
        : [];
    return (
      `${value.length} ${value.length === 1 ? 'item' : 'items'}` +
      (keys.length > 0 ? ` with keys ${keys.join(', ')}` : '')
    );
  }
  if (typeof value === 'object') {
    const keys = Object.keys(value as object);
    return (
      `object with ${keys.length} ${keys.length === 1 ? 'key' : 'keys'}` +
      (keys.length > 0 ? ` (${keys.slice(0, 6).join(', ')})` : '')
    );
  }
  if (typeof value === 'string') return `string of ${value.length} characters`;
  return `${typeof value} ${String(value)}`;
}

function truncate(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : `${text.slice(0, maxChars)}... [truncated]`;
}
