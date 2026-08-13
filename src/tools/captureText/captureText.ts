/**
 * INTEGRATION (T11) — `capture_text` is complete and tested but deliberately
 * NOT registered: `src/tools/index.ts`, `src/tools/registry.ts`, and the
 * browser controller belong to other owners. What remains:
 *
 * 1. `src/tools/registry.ts` — add to `ToolCtx`:
 *      `evidenceStore?: EvidenceStore`   (src/evidence/evidenceStore.js)
 *
 * 2. `src/browser/controller.ts` — expose the two capabilities the adapter
 *    below needs on `BrowserController` (the Playwright class already
 *    implements `resolveElementRef`; it is simply not on the interface):
 *      `resolveElementRef(ref: ElementRef): Promise<Locator>`
 *      `observedElement(pageId: string, elementId: string): ElementRef | undefined`
 *    The second is a lookup into the page's latest recorded observation
 *    (`BrowserStateStore.getObservation`), which is what turns the
 *    `elementId` this tool takes back into the full `ElementRef` that
 *    `resolveElementRef` requires — an id alone cannot carry the
 *    frame/document identity that makes a ref stale on navigation.
 *
 *    Then adapt a controller to this task's narrow seam:
 *      const page = (ctx: ToolCtx): TextCapturePage => {
 *        const browser = requireBrowser(ctx);
 *        return {
 *          async captureText({ pageId, elementId }) {
 *            const target = pageId ?? (await browser.pages()).find((p) => p.active)!.pageId;
 *            if (elementId === undefined) {
 *              const page = await browser.pageState(target);
 *              return { ...page, locator: 'body', text: await browser.pageText(target) };
 *            }
 *            const ref = browser.observedElement(target, elementId);
 *            if (ref === undefined) throw new BrowserRefNotFoundError(elementId);
 *            const locator = await browser.resolveElementRef(ref);
 *            return { ..., locator: ref.stableLocator ?? `${ref.role}[name=${ref.name}]`,
 *                     text: await locator.innerText() };
 *          },
 *        };
 *      };
 *    Whole-page capture must read the page's rendered text directly
 *    (`document.body.innerText`), NOT `observe`'s `text` view: that view is
 *    cut at a per-view bound, and a quotation cut mid-sentence is exactly
 *    what this tool exists to prevent.
 *
 * 3. `src/tools/index.ts` — export a `resourceTools` array containing this
 *    tool and `read_resource`, and spread it LAST inside
 *    `createProductionRegistry` so no existing tool's index moves and the
 *    cached prompt prefix keeps its bytes.
 *
 * 4. Evidence kind: records are filed under `javascript_extraction` with
 *    `detail.recordType = 'web_text'` until `src/evidence/evidenceStore.ts`
 *    accepts `web_text` (see {@link PENDING_WEB_TEXT_EVIDENCE_KIND}).
 *
 * The plan's `captureTextTool` symbol is the value
 * {@link createCaptureTextTool} returns; a module-level constant is not
 * possible while the capture seam reaches the tool through a factory rather
 * than `ToolCtx`.
 *
 * Why this tool exists at all: an observation is transient and normalized —
 * the interactive outline collapses whitespace and drops nodes, and the text
 * view is bounded and never persisted. A number that will appear in an answer
 * has to be quotable later, byte for byte, from a file an auditor can re-read.
 * That is a *capture*, not an observation.
 */

import { z } from 'zod';

import { recordEvidence, type EvidenceKind, type EvidenceStore } from '../../evidence/evidenceStore.js';
import {
  DEFAULT_MAX_RESULT_BYTES,
  offloadResult,
  type OffloadedResult,
} from '../capResult.js';
import type { ToolCtx, ToolDef } from '../registry.js';

/** Registry name of this tool, also the stem of its offload filenames. */
export const CAPTURE_TEXT_TOOL_NAME = 'capture_text';

/**
 * The evidence kind a text capture wants. `evidenceStore.ts` does not accept
 * it yet, so records carry it in `detail.recordType` and are filed under the
 * kind the store does accept.
 */
export const PENDING_WEB_TEXT_EVIDENCE_KIND = 'web_text';

/** The kind text captures are filed under until the store learns
 * `web_text`. */
const WEB_TEXT_EVIDENCE_KIND: EvidenceKind = 'javascript_extraction';

/**
 * Default inline byte budget for captured text. The persisted record is
 * always complete; this only bounds what re-enters the transcript, where a
 * whole page of text would be paid for on every later turn.
 */
export const DEFAULT_CAPTURED_TEXT_MAX_BYTES = 12_000;

/** Bytes reserved for the rest of the result (ids, URL, locator, escaping),
 * so a result carrying an evidence id is never offloaded whole — the model
 * must never be left citing an id it did not see. */
const ENVELOPE_RESERVE_BYTES = 12_000;

/** Characters of a label kept; a label is a caption, not a paragraph. */
const MAX_LABEL_CHARS = 200;

/** What the tool asks the browser for. */
export interface TextCaptureRequest {
  /** Page to capture from; omitted means the selected page. */
  pageId?: string;
  /** Element id from a prior observation; omitted captures the whole page. */
  elementId?: string;
}

/** Exactly what was read, and what it was read from. Every field is part of
 * the evidence record: without page/document identity, a captured string
 * cannot be traced back to the thing that rendered it. */
export interface CapturedPageText {
  /** The text exactly as rendered — no normalization, no truncation. */
  text: string;
  /** URL of the document the text came from. */
  url: string;
  /** Title of that document. */
  title: string;
  /** Stable page id the text came from. */
  pageId: string;
  /** Document id at capture time; a later rotation means the source is
   * gone, which is why it is recorded rather than inferred. */
  documentId: string;
  /** The page's observation number at capture time, when known. */
  observationId?: number;
  /** Engine-resolvable locator of what was read ('body' for a whole page).
   * This is the part that makes a capture reproducible. */
  locator: string;
}

/** The narrow browser seam this tool needs. */
export interface TextCapturePage {
  /**
   * Read exact rendered text for a page or one located region.
   *
   * @param request - page and optional element selection
   * @returns the text plus the identity of what produced it
   */
  captureText(request: TextCaptureRequest): Promise<CapturedPageText>;
}

/** Input accepted by `capture_text`. */
export const captureTextInputSchema = z.strictObject({
  pageId: z
    .string()
    .min(1)
    .optional()
    .describe('Page to capture from, from an observation or page listing; omit for the selected page'),
  elementId: z
    .string()
    .min(1)
    .optional()
    .describe(
      'Element id from a recent observation to capture just that region; omit to capture the whole page text',
    ),
  label: z
    .string()
    .min(1)
    .max(MAX_LABEL_CHARS)
    .optional()
    .describe(
      'Short description of what is being captured (e.g. "Q3 revenue row"); becomes the evidence summary',
    ),
});

/** Input accepted by `capture_text`. */
export type CaptureTextInput = z.infer<typeof captureTextInputSchema>;

/** Model-facing result of one text capture. */
export interface CaptureTextResult {
  /** Citable Evidence ID ('E1', 'E2', ...) for the exact captured text. */
  evidenceId: string;
  /** Run-dir-relative path of the evidence record holding the complete
   * text. */
  evidencePath: string;
  /** URL the text came from. */
  url: string;
  /** Title of the source document. */
  title: string;
  pageId: string;
  documentId: string;
  /** The page's observation number at capture time, when known. */
  observationId?: number;
  /** Locator of what was read; reproduce the capture with it. */
  locator: string;
  /** Character count of the complete captured text. */
  characters: number;
  /** The captured text, when it fit the inline budget. */
  text?: string;
  /** Preview plus the run-dir-relative path of the complete text, when it
   * did not. The evidence record holds it complete either way. */
  offloaded?: OffloadedResult;
}

/** Everything the tool needs from the session that `ToolCtx` cannot carry
 * yet (see the INTEGRATION note above). */
export interface CaptureTextDeps {
  /** Resolve the capture seam for one call. Called per call, never cached:
   * pages can be replaced between calls. */
  page: (ctx: ToolCtx) => TextCapturePage;
  /** The run's evidence ledger, or undefined for a run without one — a
   * capture then fails rather than returning text with no id to cite. */
  evidenceStore?: (ctx: ToolCtx) => EvidenceStore | undefined;
  /** Inline byte budget for the returned text; defaults to
   * {@link DEFAULT_CAPTURED_TEXT_MAX_BYTES}. */
  textMaxBytes?: number;
}

/**
 * Build the `capture_text` tool for one browser session.
 *
 * @param deps - the session's capture seam and evidence resolver
 * @returns the registry definition, ready to append to a registry
 * @throws Error when `textMaxBytes` is not a positive integer that leaves
 *   room for the result envelope
 */
export function createCaptureTextTool(deps: CaptureTextDeps): ToolDef<CaptureTextInput> {
  const textMaxBytes = deps.textMaxBytes ?? DEFAULT_CAPTURED_TEXT_MAX_BYTES;
  if (!Number.isInteger(textMaxBytes) || textMaxBytes < 1) {
    throw new Error(`textMaxBytes must be a positive integer, got ${String(textMaxBytes)}`);
  }
  if (textMaxBytes + ENVELOPE_RESERVE_BYTES > DEFAULT_MAX_RESULT_BYTES) {
    throw new Error(
      `textMaxBytes ${textMaxBytes} leaves no room for the result envelope: it must ` +
        `be at most ${DEFAULT_MAX_RESULT_BYTES - ENVELOPE_RESERVE_BYTES}, so a result ` +
        `carrying an evidence id is never offloaded whole.`,
    );
  }

  return {
    name: CAPTURE_TEXT_TOOL_NAME,
    description:
      'Save the exact text of a page or one observed element as durable evidence and get a citable Evidence ID. ' +
      'Use it for every value that will appear in an answer or output file: quotes, names, dates, and figures. ' +
      'An observation is transient and normalized; a capture records the text byte for byte together with its URL and locator, so the value can be re-checked later.',
    inputSchema: captureTextInputSchema,
    // Reads the page and appends an evidence record; it changes no page
    // state. Evidence ids are issued synchronously inside one record() call,
    // so parallel captures cannot interleave into the same id.
    readOnly: true,
    async execute(input, ctx): Promise<CaptureTextResult> {
      // Resolved before the page is read: a capture that cannot be recorded
      // is not a capture, and returning the text anyway would invite the
      // model to cite an id that was never issued.
      const store = requireEvidenceStore(deps, ctx);
      const captured = await deps.page(ctx).captureText({
        ...(input.pageId !== undefined ? { pageId: input.pageId } : {}),
        ...(input.elementId !== undefined ? { elementId: input.elementId } : {}),
      });

      if (typeof captured.text !== 'string') {
        throw new Error(
          `capture_text read no text from ${captured.locator}; observe the page again ` +
            `and capture an element that has visible text.`,
        );
      }

      const evidence = recordEvidence(store, {
        kind: WEB_TEXT_EVIDENCE_KIND,
        summary: buildSummary(input.label, captured),
        sourceUrl: captured.url,
        // Uncapped and complete: this record is the auditable copy, and the
        // result below is only a view of it.
        detail: {
          // Carries the kind the store cannot express yet; see the
          // INTEGRATION note at the top of this file.
          recordType: PENDING_WEB_TEXT_EVIDENCE_KIND,
          ...(input.label !== undefined ? { label: input.label } : {}),
          url: captured.url,
          title: captured.title,
          pageId: captured.pageId,
          documentId: captured.documentId,
          ...(captured.observationId !== undefined
            ? { observationId: captured.observationId }
            : {}),
          locator: captured.locator,
          characters: captured.text.length,
          text: captured.text,
        },
      });

      return {
        evidenceId: evidence.id,
        evidencePath: evidence.path,
        url: captured.url,
        title: captured.title,
        pageId: captured.pageId,
        documentId: captured.documentId,
        ...(captured.observationId !== undefined
          ? { observationId: captured.observationId }
          : {}),
        locator: captured.locator,
        characters: captured.text.length,
        ...capText(ctx.runDir, captured.text, textMaxBytes),
      };
    },
  };
}

/**
 * Split captured text between "inline" and "offloaded to a file".
 *
 * Uses `offloadResult` rather than `capResult` because the budget applies to
 * one *field*: the evidence id, URL, and locator stay in context where the
 * model needs them, and only the text moves to disk.
 */
function capText(
  runDir: string,
  text: string,
  textMaxBytes: number,
): Pick<CaptureTextResult, 'text' | 'offloaded'> {
  if (Buffer.byteLength(text, 'utf8') <= textMaxBytes) {
    return { text };
  }
  return {
    offloaded: offloadResult(
      runDir,
      CAPTURE_TEXT_TOOL_NAME,
      text,
      `over the ${textMaxBytes}-byte inline limit for captured text`,
    ),
  };
}

/** Resolve the evidence ledger, or explain that this run cannot issue ids. */
function requireEvidenceStore(deps: CaptureTextDeps, ctx: ToolCtx): EvidenceStore {
  const store = deps.evidenceStore?.(ctx);
  if (store === undefined) {
    throw new Error(
      'capture_text needs an evidence ledger to issue an Evidence ID, and this run ' +
        'has none. Persist the text with write_file instead.',
    );
  }
  return store;
}

/** One-line summary: the caller's label when given, otherwise what was read
 * and from where. Never empty — the store rejects a blank summary, and a
 * citation with no description is not usable. */
function buildSummary(label: string | undefined, captured: CapturedPageText): string {
  const source = `${captured.locator} on ${truncate(captured.url, 200)}`;
  if (label !== undefined && label.trim() !== '') {
    return `${truncate(label.trim(), MAX_LABEL_CHARS)} (captured from ${source})`;
  }
  return `Captured ${captured.text.length} characters of exact text from ${source}`;
}

function truncate(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : `${text.slice(0, maxChars)}... [truncated]`;
}
