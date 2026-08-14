import { z } from 'zod';

import {
  MAX_ACTIONS_PER_SEQUENCE,
  MAX_SETTLE_POLICY,
  type BrowserAction,
  type BrowserActionRequest,
} from '../../browser/browserActions.js';
import { accessKey, type ToolDef } from '../registry.js';
import { requireBrowser } from '../shared/browser.js';

/**
 * One element target: the object `observe` returned, copied verbatim.
 *
 * The ref carries its own page/frame/document identity, which is what makes
 * revalidation precise — the runtime can tell "this element moved" from
 * "this document was replaced" without trusting the model's bookkeeping. A
 * strict object is deliberate: a garbled or invented target must fail
 * validation, not silently act on a similar-looking element.
 */
const elementRefSchema = z
  .strictObject({
    id: z.string().min(1),
    pageId: z.string().min(1),
    frameId: z.string().min(1),
    documentId: z.string().min(1),
    role: z.string().min(1),
    name: z.string(),
    backendNodeId: z.number().int().optional(),
    stableLocator: z.string().min(1).optional(),
    ordinal: z.number().int().min(0).optional(),
  })
  .describe('An element object copied exactly from an observe result');

const scrollAmountSchema = z.strictObject({
  unit: z.enum(['pixels', 'viewport']),
  value: z.number().positive().finite(),
});

const browserActionSchema = z.discriminatedUnion('op', [
  z.strictObject({
    op: z.literal('navigate'),
    url: z
      .url()
      .refine((url) => {
        const protocol = new URL(url).protocol;
        return protocol === 'http:' || protocol === 'https:';
      }, 'URL must use HTTP or HTTPS')
      .describe('Absolute HTTP(S) URL to load in this page'),
  }),
  z.strictObject({ op: z.literal('click'), target: elementRefSchema }),
  z.strictObject({
    op: z.literal('fill'),
    target: elementRefSchema,
    text: z.string().describe('Complete replacement value for the field'),
  }),
  z.strictObject({
    op: z.literal('press'),
    target: elementRefSchema
      .optional()
      .describe('Element to focus first; omit to send the key to the page'),
    key: z.string().min(1).describe("Key name, e.g. 'Enter', 'Tab', 'Control+a'"),
  }),
  z.strictObject({
    op: z.literal('select'),
    target: elementRefSchema,
    values: z
      .array(z.string())
      .min(1)
      .max(20)
      .describe('Option values (or visible labels) to select'),
  }),
  z.strictObject({
    op: z.literal('check'),
    target: elementRefSchema,
    checked: z.boolean().describe('Desired final state of the checkbox or radio'),
  }),
  z.strictObject({ op: z.literal('hover'), target: elementRefSchema }),
  z.strictObject({
    op: z.literal('upload'),
    target: elementRefSchema,
    runPath: z
      .string()
      .min(1)
      .describe('Run-directory-relative path of the file to attach'),
  }),
  z.strictObject({
    op: z.literal('scroll'),
    direction: z.enum(['up', 'down']),
    amount: scrollAmountSchema,
  }),
]);

const successCheckSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('url_matches'),
    pattern: z
      .string()
      .min(1)
      .describe('Regular expression (or plain substring) the landed URL must match'),
  }),
  z.strictObject({
    type: z.literal('element_exists'),
    role: z.string().min(1),
    name: z.string().min(1),
  }),
  z.strictObject({
    type: z.literal('text_present'),
    text: z.string().min(1).describe('Exact text that must appear in the page'),
  }),
  z.strictObject({ type: z.literal('download_started') }),
  z.strictObject({ type: z.literal('popup_opened') }),
]);

const settlePolicySchema = z.strictObject({
  successCheckTimeoutMs: z
    .number()
    .int()
    .min(1)
    .max(MAX_SETTLE_POLICY.successCheckTimeoutMs)
    .optional(),
  quietWindowMs: z.number().int().min(1).max(MAX_SETTLE_POLICY.quietWindowMs).optional(),
  settleTimeoutMs: z
    .number()
    .int()
    .min(1)
    .max(MAX_SETTLE_POLICY.settleTimeoutMs)
    .optional(),
});

const browserActionInputSchema = z.strictObject({
  pageId: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Page to act on, from an observe result's otherOpenPages or a browser_action result's " +
        'openedPages; omit for the selected page',
    ),
  documentId: z
    .string()
    .min(1)
    .optional()
    .describe(
      'Document you observed. A mismatch stops the sequence before any action runs',
    ),
  basedOnObservationId: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe('Observation to diff the resulting page against'),
  actions: z
    .array(browserActionSchema)
    .min(1, 'Include at least one action')
    .max(
      MAX_ACTIONS_PER_SEQUENCE,
      `A sequence may contain at most ${MAX_ACTIONS_PER_SEQUENCE} actions`,
    ),
  successChecks: z
    .array(successCheckSchema)
    .max(4)
    .optional()
    .describe('Observable definitions of success, waited for after the last action'),
  settle: settlePolicySchema.optional(),
});

/** Input accepted by the browser_action tool. */
export type BrowserActionInput = z.infer<typeof browserActionInputSchema>;

/**
 * `browser_action` — perform 1–8 related actions on one page and document,
 * and return what actually committed.
 *
 * Replaces the blind `browser_batch` loop: every target is revalidated
 * immediately before its action, each action gets a receipt with
 * `effectsCommitted`, and the sequence stops at the first navigation,
 * document replacement, popup, dialog, stale target, or failure — naming
 * the first index it did not run. Nothing is ever rolled back, so a failed
 * success check returns `failed_check` with the receipts intact rather than
 * pretending the page is untouched.
 *
 * Upload paths resolve only through `resolveRunPath`, so a sequence cannot
 * read a file outside the run directory.
 */
export const browserActionTool: ToolDef<BrowserActionInput> = {
  name: 'browser_action',
  description:
    'Perform 1-8 related browser actions (navigate/click/fill/press/select/check/hover/upload/scroll) ' +
    'on ONE page and document, then return the updated page. Copy each target element object from a ' +
    'prior observe result. Returns one receipt per attempted action saying whether its effects ' +
    'committed, and stops at the first navigation, popup, dialog, stale target, or failure, naming the ' +
    'first action it did not run. Completed effects are never undone. Add successChecks to state what ' +
    "success looks like; pass a different pageId (from an observe result's otherOpenPages or this " +
    "tool's own openedPages) to act on another page, and use handle_dialog to answer a dialog.",
  inputSchema: browserActionInputSchema,
  // A hardcoded EXCLUSIVE_ACCESS here — every browser_action call
  // serializing against every other tool call in the run, no matter which
  // page it names — would directly contradict the design ToolAccess
  // documents in registry.ts: "`browser_action` on page p1
  // and `browser_action` on page p2 are the same TOOL with different
  // access" — i.e. this is the paradigm case an input-aware getAccess exists
  // for. The sequence mutates the acted-on page's content (each action) and
  // — because finishSequence() calls session.observe() to build the
  // returned page and diff — also advances that page's observation
  // baseline, exactly as observe.ts's own getAccess does. An 'upload'
  // action additionally reads a file from the run directory (the attached
  // file), which must serialize behind a concurrent write to that same
  // path (write_file, edit_file, download, ...) or the upload could read
  // bytes that were never fully written.
  getAccess: (input) => {
    const pageId = input.pageId ?? 'selected';
    return {
      reads: input.actions
        .filter((action): action is typeof action & { op: 'upload'; runPath: string } =>
          action.op === 'upload',
        )
        .map((action) => accessKey.file(action.runPath)),
      writes: [accessKey.page(pageId), accessKey.observation(pageId)],
    };
  },
  async execute(input, ctx) {
    const browser = requireBrowser(ctx);
    const request: BrowserActionRequest = {
      // The validated union is structurally the engine's action type; the
      // cast documents that, rather than re-mapping nine op shapes by hand.
      actions: input.actions as readonly BrowserAction[],
      // Always passed: it is the confinement root for upload paths, and a
      // sequence without uploads simply never uses it.
      runDir: ctx.runDir,
      ...(input.pageId !== undefined ? { pageId: input.pageId } : {}),
      ...(input.documentId !== undefined ? { documentId: input.documentId } : {}),
      ...(input.basedOnObservationId !== undefined
        ? { basedOnObservationId: input.basedOnObservationId }
        : {}),
      ...(input.successChecks !== undefined
        ? { successChecks: input.successChecks }
        : {}),
      ...(input.settle !== undefined ? { settle: input.settle } : {}),
    };
    // Returned structured: receipts, element refs, and page identity must
    // round-trip intact for the model's next targeted call.
    return browser.browserAction(request);
  },
};
