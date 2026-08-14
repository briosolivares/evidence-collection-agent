import { z } from 'zod';

import {
  assertJavaScriptPolicy,
  assertJsonCompatible,
  BrowserJavaScriptTimeoutError,
  DEFAULT_JAVASCRIPT_TIMEOUT_MS,
  describeJavaScriptPolicyDecision,
  MAX_JAVASCRIPT_TIMEOUT_MS,
  toEarlyJavaScriptRequest,
  type BrowserJavaScriptPolicy,
  type JavaScriptCapablePage,
} from '../../browser/browserJavaScript.js';
import { recordEvidence, type EvidenceStore } from '../../evidence/evidenceStore.js';
import {
  DEFAULT_MAX_RESULT_BYTES,
  offloadResult,
  type OffloadedResult,
} from '../capResult.js';
import type { ToolCtx, ToolDef } from '../registry.js';

/** Registry name of this tool, also the stem of its offload filenames. */
export const EXECUTE_JAVASCRIPT_TOOL_NAME = 'execute_javascript';

/**
 * Default inline byte budget for one return value, measured on the exact JSON
 * the model would receive. Roughly 4k tokens — enough for a bulk extraction
 * of a hundred-odd rows, which is the case this tool exists for; anything
 * larger is offloaded to a file rather than paid for in every later turn.
 */
export const DEFAULT_JAVASCRIPT_VALUE_MAX_BYTES = 16_000;

/**
 * Bytes reserved for everything in the result that is not the value (URL,
 * console lines, evidence id, timings, JSON escaping). Together with the
 * value budget this keeps a whole result under DEFAULT_MAX_RESULT_BYTES *by
 * construction*, which is the property that matters: if the pipeline's own
 * cap ever had to offload this result, the evidence id would go to the file
 * with it and the model would be left citing an id it never saw.
 */
const ENVELOPE_RESERVE_BYTES = 24_000;

/** Console lines kept in the model-facing result. Logs are a debugging aid
 * here; the complete list is in the evidence record when one was requested. */
const MAX_LOG_LINES = 12;

/** Bytes kept per console line — a page that logs its own DOM should cost
 * one truncated line, not a turn's worth of context. */
const MAX_LOG_LINE_BYTES = 400;

/** Bytes of the executed document's URL kept in the result. Real page URLs
 * are far below this; a `data:` or `blob:` URL can be megabytes, and the
 * untruncated value is in the evidence record. */
const MAX_URL_BYTES = 1_000;

/** Bytes of the URL kept in an evidence record's one-line summary. Far
 * tighter than the result's budget: a summary exists to be skimmed, and the
 * record's `detail.url` is always the complete value. */
const MAX_SUMMARY_URL_BYTES = 200;

/** Bytes kept from an engine or page error message, which can otherwise
 * carry a full stack plus a slice of page source. */
const MAX_ERROR_MESSAGE_BYTES = 1_000;

/**
 * The input contract. `pageId` names the page whose top document runs the
 * snippet, following the same optional-`pageId` convention every other
 * page-addressable tool (observe, browser_action, capture_text) already
 * uses; omitted means the selected page. Frame-level targeting within a page
 * remains future work. `timeoutMs` is bounded by the schema — over-budget
 * callers are rejected here, before the page is touched.
 */
export const earlyExecuteJavaScriptInputSchema = z.strictObject({
  pageId: z
    .string()
    .min(1)
    .optional()
    .describe(
      'Page whose top document runs the snippet, from an observe result; omit for the selected page. ' +
        'Iframes and other documents within a page are not addressable yet.',
    ),
  code: z
    .string()
    .min(1)
    .describe(
      'Complete JavaScript to evaluate in the page. Its final value is returned and must be JSON: strings, finite numbers, booleans, null, arrays, plain objects. Map DOM nodes to plain objects, e.g. [...document.querySelectorAll("tr")].map(r => ({ name: r.cells[0].innerText.trim(), href: r.querySelector("a")?.href ?? null })).',
    ),
  timeoutMs: z
    .number()
    .int()
    .min(1)
    .max(MAX_JAVASCRIPT_TIMEOUT_MS)
    .optional()
    .describe(
      `Hard deadline in milliseconds (default ${DEFAULT_JAVASCRIPT_TIMEOUT_MS}, max ${MAX_JAVASCRIPT_TIMEOUT_MS}). On timeout the page is closed and replaced, invalidating every ref and observation.`,
    ),
  captureEvidence: z
    .boolean()
    .optional()
    .describe(
      'Save the code, URL, timing, and complete return value as a durable evidence record and return its Evidence ID. Set this whenever the extracted values will appear in an answer or output file.',
    ),
});

/** Input accepted by the execute_javascript tool. */
export type EarlyExecuteJavaScriptInput = z.infer<
  typeof earlyExecuteJavaScriptInputSchema
>;

/**
 * Model-facing result of one page-JavaScript call.
 *
 * Invariant: exactly one of `value` and `offloadedValue` is present. The
 * value is split out from the rest of the result on purpose — a huge
 * extraction moves to a file while the citable `evidenceId`, the URL, and the
 * timing stay inline, where the model can actually use them.
 */
export interface ExecuteJavascriptResult {
  /** URL of the document the code ran in, read at call time (a navigation
   * between selection and execution shows up here). Truncated at
   * MAX_URL_BYTES; the evidence record holds the whole thing. */
  url: string;
  /** Opaque audit token for the document the code ran in — it changes on
   * reload and navigation, which is how a "same URL, different document"
   * extraction is spotted in the transcript. Not addressable: no tool takes
   * it as input. */
  documentToken: string;
  /** Wall-clock milliseconds spent inside the page. */
  durationMs: number;
  /** The snippet's return value, when it fit the inline budget. */
  value?: unknown;
  /** Preview plus the run-dir-relative path of the complete value, when it
   * did not. Read the path with read_file or grep. */
  offloadedValue?: OffloadedResult;
  /** Console output captured during evaluation, oldest first and bounded.
   * Absent when the snippet logged nothing. */
  logs?: string[];
  /** Citable Evidence ID ('E1', 'E2', ...), present exactly when
   * `captureEvidence` was set. */
  evidenceId?: string;
  /** Run-dir-relative path of the persisted evidence record. */
  evidencePath?: string;
}

/**
 * Everything the tool needs from the run that it cannot get from `ToolCtx`
 * yet. A factory rather than a module-level tool because two of these — the
 * page seam and the policy — are session-scoped decisions made where the
 * browser session is built (see `createExecuteJavascriptTool` below).
 */
export interface ExecuteJavascriptDeps {
  /**
   * Resolve the JavaScript-capable page for one call, addressed by the
   * call's optional `pageId` (undefined meaning the selected page). Called
   * per call, never cached: a timeout replaces the page, so a handle held
   * across calls would point at a closed one.
   */
  page: (ctx: ToolCtx, pageId?: string) => JavaScriptCapablePage;
  /**
   * Resolve the run's evidence ledger, or undefined for a run without one
   * (fixture tests, contract-less paths). A `captureEvidence` call then fails
   * rather than returning an extraction with no id to cite.
   */
  evidenceStore?: (ctx: ToolCtx) => EvidenceStore | undefined;
  /**
   * The session's explicitly configured policy, or undefined when nobody
   * configured one. Read once here, at configuration time — deliberately not
   * per call from `ToolCtx`: a per-call read means any later mutation of the
   * context silently grants a capability that no operator approved, and the
   * whole point of this switch is that the grant is explicit.
   */
  policy?: BrowserJavaScriptPolicy;
  /** Whether this session carries logged-in state (persistent profile,
   * stored cookies, filled credentials). Combined with `policy` by
   * `assertJavaScriptPolicy`: authenticated plus unset is a configuration
   * error, not a default. */
  authenticatedSession?: boolean;
  /** Receives the one-line policy decision at configuration time. Wire this
   * to the run log so an `allow` on an authenticated session is recorded as
   * accepted capability exposure. */
  onPolicyDecision?: (line: string) => void;
  /** Inline byte budget for one return value; defaults to
   * DEFAULT_JAVASCRIPT_VALUE_MAX_BYTES. */
  valueMaxBytes?: number;
  /** Monotonic clock in milliseconds for timing; defaults to
   * `performance.now`. A test seam, and the reason durations are
   * reproducible. */
  now?: () => number;
}

/**
 * Build the `execute_javascript` tool for one browser session.
 *
 * Resolving the policy here is what makes "an authenticated session with no
 * explicit policy fails at configuration time" true: this runs where the
 * run's registry is built, before the model takes a turn, so the failure
 * lands on the operator rather than mid-run on a tool call.
 *
 * @param deps - the session's page seam, evidence ledger resolver, policy,
 *   and optional clock/budget overrides
 * @returns the registry definition, ready to append to a registry
 * @throws Error when the session is authenticated and no policy was
 *   configured (the configuration-time failure), or when `valueMaxBytes` is
 *   not a positive integer leaving room for the result envelope
 */
export function createExecuteJavascriptTool(
  deps: ExecuteJavascriptDeps,
): ToolDef<EarlyExecuteJavaScriptInput> {
  const policy = assertJavaScriptPolicy(
    deps.policy,
    deps.authenticatedSession ?? false,
  );
  deps.onPolicyDecision?.(
    describeJavaScriptPolicyDecision(policy, deps.authenticatedSession ?? false),
  );

  const valueMaxBytes = deps.valueMaxBytes ?? DEFAULT_JAVASCRIPT_VALUE_MAX_BYTES;
  if (!Number.isInteger(valueMaxBytes) || valueMaxBytes < 1) {
    throw new Error(
      `valueMaxBytes must be a positive integer, got ${String(valueMaxBytes)}`,
    );
  }
  if (valueMaxBytes + ENVELOPE_RESERVE_BYTES > DEFAULT_MAX_RESULT_BYTES) {
    throw new Error(
      `valueMaxBytes ${valueMaxBytes} leaves no room for the result envelope: ` +
        `it must be at most ${DEFAULT_MAX_RESULT_BYTES - ENVELOPE_RESERVE_BYTES}, ` +
        `so a result carrying an evidence id is never offloaded whole.`,
    );
  }
  const now = deps.now ?? (() => performance.now());

  return {
    name: EXECUTE_JAVASCRIPT_TOOL_NAME,
    description:
      'Run JavaScript in a page and return its JSON value. Set pageId to target a specific page ' +
      '(from an observe result); omit it to run in the selected page. Use it to extract every ' +
      'row of a repeated structure in ONE call instead of many observations, and to read values ' +
      'the accessibility outline flattens (table cells, data attributes, hrefs). ' +
      'Return only JSON — strings, finite numbers, booleans, null, arrays, plain objects; a DOM node, a Date, or a Map is an error. ' +
      'This is a page WRITE: the snippet can mutate the DOM, submit forms, or navigate, so it is never scheduled in parallel with other page work. ' +
      'It is also not a sandbox — the code runs with this page\'s full authority. ' +
      'Set captureEvidence to persist the extraction and get an Evidence ID to cite.',
    inputSchema: earlyExecuteJavaScriptInputSchema,
    // Every call is a page write, full stop. A snippet that "only reads the
    // DOM" is indistinguishable from one that clicks a button — nothing about
    // read-only intent is checkable, and the scheduler must never run this
    // concurrently with other page work on the promise that it might be
    // harmless. Naming a pageId narrows WHICH page the snippet targets, but
    // not WHAT it can do once there: arbitrary code can still navigate away,
    // open new pages, or close the very page it was told to run in — effects
    // an input-aware getAccess (like browser_action's) could never enumerate
    // in advance. So unlike screenshot/download, whose pageId narrows their
    // declared access, this tool's only honest declaration stays the fully
    // exclusive one, regardless of pageId.
    getAccess: () => ({ reads: [], writes: [], exclusive: true }),
    async execute(input, ctx): Promise<ExecuteJavascriptResult> {
      // Enforced before the page is touched at all: `deny` means the page
      // never sees model-authored code, not that we inspect the code first
      // (deciding what a snippet does is undecidable).
      if (policy === 'deny') {
        throw new Error(
          `Page JavaScript is disabled for this run (javascriptPolicy=deny). ` +
            `Do not retry ${EXECUTE_JAVASCRIPT_TOOL_NAME}; extract with observe, ` +
            `browser_action scroll, and download instead.`,
        );
      }

      const request = toEarlyJavaScriptRequest(
        input.code,
        input.timeoutMs ?? DEFAULT_JAVASCRIPT_TIMEOUT_MS,
        input.pageId,
      );
      // Resolved before execution: a snippet that may mutate the page must
      // not run at all when the evidence it was asked to produce could never
      // be recorded. Failing after a successful mutation would be the one
      // unrecoverable ordering.
      const store =
        input.captureEvidence === true ? requireEvidenceStore(deps, ctx) : undefined;
      const page = deps.page(ctx, request.pageId);

      const startedAt = now();
      let evaluated;
      try {
        evaluated = await page.evaluateJson(request.code, request.timeoutMs);
      } catch (thrown) {
        // The engine owns the timeout race, not this tool, and
        // BrowserJavaScriptTimeoutError is the only signal it gives that the
        // underlying page must be discarded rather than reused — any other
        // thrown value is treated as an ordinary page-script failure below.
        if (thrown instanceof BrowserJavaScriptTimeoutError) {
          throw await recoverFromTimeout(page, thrown);
        }
        // A page-thrown error is bounded here: its message can carry a whole
        // stack plus page source, and the model only needs the first lines to
        // fix its snippet.
        throw new Error(`Page JavaScript failed: ${boundErrorMessage(thrown)}`);
      }
      const durationMs = Math.round(now() - startedAt);

      // The engine's serializer is not the contract: verify the shape we
      // promised the model before anything persists or is reported.
      assertJsonCompatible(evaluated.value);

      const logs = boundLogs(evaluated.logs);
      const evidence =
        store === undefined
          ? undefined
          : recordEvidence(store, {
              kind: 'javascript_extraction',
              // The summary is a one-line citation, so its URL is bounded
              // harder than the result's: `detail.url` below is the complete
              // one, and a record whose summary is a megabyte of data: URL is
              // no longer a summary.
              summary:
                `Page JavaScript extraction from ` +
                `${truncateUtf8(evaluated.url, MAX_SUMMARY_URL_BYTES)}: ` +
                describeValueShape(evaluated.value),
              sourceUrl: evaluated.url,
              // Uncapped and complete — the record is the auditable copy, and
              // the model-facing result above is only a view of it.
              detail: {
                pageId: request.pageId ?? null,
                code: request.code,
                url: evaluated.url,
                documentToken: evaluated.documentToken,
                timeoutMs: request.timeoutMs,
                durationMs,
                logs: [...evaluated.logs],
                value: evaluated.value,
              },
            });

      return {
        url: truncateUtf8(evaluated.url, MAX_URL_BYTES),
        documentToken: evaluated.documentToken,
        durationMs,
        ...capValue(ctx.runDir, evaluated.value, valueMaxBytes),
        ...(logs.length > 0 ? { logs } : {}),
        ...(evidence !== undefined
          ? { evidenceId: evidence.id, evidencePath: evidence.path }
          : {}),
      };
    },
  };
}

/**
 * Split a return value between "inline" and "offloaded to a file", producing
 * the matching half of {@link ExecuteJavascriptResult}.
 *
 * Uses `offloadResult` rather than `capResult` on purpose. `capResult` caps a
 * whole tool result against the tool's own limit; here the budget applies to
 * one *field*, so the decision is made here and only the value moves to disk
 * — the evidence id, URL, and timing stay in context where they are useful.
 *
 * The measurement is compact JSON, byte-for-byte what the pipeline would put
 * in the transcript. The offloaded copy is pretty-printed instead: it makes
 * the preview cut on whole-line boundaries (see capResult's buildPreview) so
 * a preview never ends mid-record, and it keeps the file greppable. Same
 * value in, same preview bytes out, every time.
 */
function capValue(
  runDir: string,
  value: unknown,
  valueMaxBytes: number,
): Pick<ExecuteJavascriptResult, 'value' | 'offloadedValue'> {
  // Safe: assertJsonCompatible has already ruled out every input for which
  // JSON.stringify returns undefined.
  const compact = JSON.stringify(value);
  if (Buffer.byteLength(compact, 'utf8') <= valueMaxBytes) return { value };

  return {
    offloadedValue: offloadResult(
      runDir,
      EXECUTE_JAVASCRIPT_TOOL_NAME,
      `${JSON.stringify(value, null, 2)}\n`,
      `over the ${valueMaxBytes}-byte inline limit for one returned value`,
    ),
  };
}

/** Resolve the evidence ledger for a `captureEvidence` call, or explain that
 * this run cannot issue ids. Failing closed matters: silently returning an
 * extraction without an id invites the model to cite one that does not
 * exist. */
function requireEvidenceStore(
  deps: ExecuteJavascriptDeps,
  ctx: ToolCtx,
): EvidenceStore {
  const store = deps.evidenceStore?.(ctx);
  if (store === undefined) {
    throw new Error(
      'captureEvidence was requested but this run has no evidence ledger, so ' +
        'no Evidence ID can be issued. Re-run the call without captureEvidence ' +
        'and persist the values with write_file instead.',
    );
  }
  return store;
}

/**
 * Turn a timeout into the error the model sees, replacing the page first.
 *
 * A timed-out snippet may still be spinning, so the page's event loop is not
 * trustworthy and reusing it would hang the next call instead of this one.
 * The replacement is what keeps the *run* usable; it also destroys every ref
 * and observation, which the message has to say or the model will act on
 * stale ids.
 */
async function recoverFromTimeout(
  page: JavaScriptCapablePage,
  timeout: BrowserJavaScriptTimeoutError,
): Promise<Error> {
  try {
    await page.replaceUnresponsivePage();
  } catch (thrown) {
    return new Error(
      `${timeout.message} Replacing the unresponsive page also failed ` +
        `(${boundErrorMessage(thrown)}), so this browser session is no longer ` +
        `usable — finish with what has already been collected.`,
    );
  }
  return new Error(
    `${timeout.message} The page was closed and replaced, so every ref and ` +
      `observation from before this call is now invalid: navigate again and ` +
      `re-observe before acting. Then retry with a smaller snippet — avoid ` +
      `unbounded loops, waits, and network calls — or a larger timeoutMs ` +
      `(max ${MAX_JAVASCRIPT_TIMEOUT_MS}).`,
  );
}

/** Describe a value's shape for an evidence summary: enough to recognize the
 * record without opening it, and bounded so a wide row cannot stretch the
 * summary line. */
function describeValueShape(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) {
    const first = value[0];
    const keys =
      typeof first === 'object' && first !== null && !Array.isArray(first)
        ? Object.keys(first).slice(0, 6)
        : [];
    const shape = keys.length > 0 ? ` with keys ${keys.join(', ')}` : '';
    return `${value.length} ${value.length === 1 ? 'item' : 'items'}${shape}`;
  }
  if (typeof value === 'object') {
    const keys = Object.keys(value as object);
    return `object with ${keys.length} ${keys.length === 1 ? 'key' : 'keys'}` +
      (keys.length > 0 ? ` (${keys.slice(0, 6).join(', ')})` : '');
  }
  if (typeof value === 'string') {
    return `string of ${value.length} characters`;
  }
  return `${typeof value} ${String(value)}`;
}

/** Bound captured console output: at most MAX_LOG_LINES lines of at most
 * MAX_LOG_LINE_BYTES each, with an explicit line saying what was dropped so
 * the model never reads a truncated list as a complete one. */
function boundLogs(logs: readonly string[]): string[] {
  const kept = logs
    .slice(0, MAX_LOG_LINES)
    .map((line) => truncateUtf8(line, MAX_LOG_LINE_BYTES));
  if (logs.length > MAX_LOG_LINES) {
    kept.push(`... ${logs.length - MAX_LOG_LINES} more console lines omitted`);
  }
  return kept;
}

/** Bound an error message's bytes, whatever was thrown. */
function boundErrorMessage(thrown: unknown): string {
  return truncateUtf8(
    thrown instanceof Error ? thrown.message : String(thrown),
    MAX_ERROR_MESSAGE_BYTES,
  );
}

/** Truncate to a UTF-8 byte budget without splitting a character, marking the
 * cut so a truncated value is never mistaken for a complete one. */
function truncateUtf8(text: string, maxBytes: number): string {
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.length <= maxBytes) return text;
  // Walk back off UTF-8 continuation bytes (0b10xxxxxx) so the character
  // straddling the boundary is dropped whole rather than sliced.
  let end = maxBytes;
  while (end > 0 && (bytes[end]! & 0b1100_0000) === 0b1000_0000) end -= 1;
  return `${bytes.subarray(0, end).toString('utf8')}... [truncated]`;
}
