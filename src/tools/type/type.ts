import { z } from 'zod';

import type { ToolDef } from '../registry.js';
import { actByRef, requireBrowser, requireRefDescription } from '../shared/browser.js';

const typeInputSchema = z.strictObject({
  ref: z.string().min(1).describe('Editable element ref from the latest inspect_page result'),
  text: z.string().describe('Complete text value to place in the element'),
});

type TypeInput = z.infer<typeof typeInputSchema>;

/**
 * `type` — replace an editable element value by outline ref.
 *
 * Given a `ref` returned by `inspect_page` and the complete `text` value,
 * fills the element and returns a transcript-readable confirmation containing
 * the ref and its semantic role/name. A stale or unknown ref throws an error
 * telling the model to run `inspect_page` again;
 * the pipeline surfaces it as a structured execution error.
 */
export const typeTool: ToolDef<TypeInput> = {
  name: 'type',
  description:
    'Replaces the value of an editable element by ref from inspect_page.',
  inputSchema: typeInputSchema,
  readOnly: false,
  async execute(input, ctx) {
    const browser = requireBrowser(ctx);
    const description = await requireRefDescription(browser, input.ref);
    await actByRef(input.ref, () => browser.type(input.ref, input.text));
    return `Typed into ref=${input.ref} (${description}).`;
  },
};
