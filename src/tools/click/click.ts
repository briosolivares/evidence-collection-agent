import { z } from 'zod';

import type { ToolDef } from '../registry.js';
import { actByRef, requireBrowser, requireRefDescription } from '../shared/browser.js';

const clickInputSchema = z.strictObject({
  ref: z.string().min(1).describe('Element ref from the latest inspect_page result'),
});

type ClickInput = z.infer<typeof clickInputSchema>;

/**
 * `click` — activate an element identified by the latest page outline.
 *
 * Given a `ref` returned by `inspect_page`, clicks that element and returns
 * a transcript-readable confirmation containing the ref and its semantic
 * role/name. A stale or unknown ref throws an error
 * telling the model to run `inspect_page` again; the pipeline surfaces it as
 * a structured execution error.
 */
export const clickTool: ToolDef<ClickInput> = {
  name: 'click',
  description:
    'Clicks an element by ref from inspect_page. Re-run inspect_page after page changes before reusing refs.',
  inputSchema: clickInputSchema,
  readOnly: false,
  async execute(input, ctx) {
    const browser = requireBrowser(ctx);
    const description = await requireRefDescription(browser, input.ref);
    await actByRef(input.ref, () => browser.click(input.ref));
    return `Clicked ref=${input.ref} (${description}).`;
  },
};
