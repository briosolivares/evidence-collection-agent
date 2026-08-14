import { z } from 'zod';

import type { BrowserObserveRequest } from '../../browser/browserState.js';
import { accessKey, type ToolDef } from '../registry.js';
import { requireBrowser } from '../shared/browser.js';

/**
 * Input accepted by the observe tool. `basedOnObservationId` is a
 * requested diff baseline, NOT an optimistic lock — pointing at an evicted
 * observation returns a bounded full snapshot (`changes.basis:
 * 'full_snapshot'`), never a stale error.
 */
export const observeRequestSchema = z.strictObject({
  pageId: z
    .string()
    .min(1)
    .optional()
    .describe(
      'Page to observe, from a previous observe result or page listing; omit for the selected page',
    ),
  need: z
    .array(z.enum(['interactive', 'text']))
    .min(1)
    .max(2)
    .optional()
    .describe(
      "Views to return: 'interactive' is a compact outline with element refs, 'text' is exact page text; defaults to ['interactive']",
    ),
  basedOnObservationId: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe(
      'Earlier observation to diff against; an evicted baseline returns a full snapshot, never an error',
    ),
});

/** Input accepted by the observe tool. */
export type ObserveInput = z.infer<typeof observeRequestSchema>;

/**
 * `observe` — snapshot a browser page with stable identity.
 *
 * Returns the page (stable pageId, current documentId, incremented
 * observationId), the requested bounded views, interactive elements bound
 * to page/frame/document, and changes relative to the requested baseline.
 *
 * NOT registered in the production registry yet — the session owner
 * integrates it in a later task.
 */
export const observeTool: ToolDef<ObserveInput> = {
  name: 'observe',
  description:
    'Observe a browser page: a compact interactive outline and/or exact text with stable page, document, and element identity, plus changes since a prior observation.',
  inputSchema: observeRequestSchema,
  // Declaring only a page READ would be conceptually WRONG — observe advances
  // the page's observation id and diff baseline (a write to observation
  // state), and two concurrent observations of one page must not both claim
  // the next baseline. This is the input-aware access declaration that gets
  // it right: an explicit read of the page plus a write of its observation
  // state, so the scheduler serializes this against another observe (or a
  // navigate/click/etc.) on the same page instead of racing it.
  getAccess: (input) => {
    const pageId = input.pageId ?? 'selected';
    return { reads: [accessKey.page(pageId)], writes: [accessKey.observation(pageId)] };
  },
  async execute(input, ctx) {
    const browser = requireBrowser(ctx);
    const request: BrowserObserveRequest = {
      ...(input.pageId !== undefined ? { pageId: input.pageId } : {}),
      ...(input.need !== undefined ? { need: input.need } : {}),
      ...(input.basedOnObservationId !== undefined
        ? { basedOnObservationId: input.basedOnObservationId }
        : {}),
    };
    // The observation is returned structured (the pipeline JSON-serializes
    // it); element refs must round-trip intact for later targeted actions.
    return browser.observe(request);
  },
};
