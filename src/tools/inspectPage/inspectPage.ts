import { z } from 'zod';

import type { ToolCtx, ToolDef } from '../registry.js';
import { formatPageHeader, requireBrowser } from '../shared/browser.js';

const inspectPageInputSchema = z.object({}).strict();

/** Input accepted by the inspect_page tool. */
export type InspectPageInput = z.infer<typeof inspectPageInputSchema>;

/**
 * Inspect the active page through its compact semantic outline.
 *
 * @param input - an empty object; inspection has no configurable input
 * @param ctx - tool context containing an active browser task tab
 * @returns the current URL and title header followed by the full-page
 *   semantic outline, including refs on interactive elements
 */
async function inspectPage(
  input: InspectPageInput,
  ctx: ToolCtx,
): Promise<string> {
  void input;
  const browser = requireBrowser(ctx);
  const url = browser.currentUrl();
  const [title, outline] = await Promise.all([
    browser.title(),
    browser.outline(),
  ]);
  return `${formatPageHeader(url, title)}\n\n${outline}`;
}

/** Read-only registry definition for semantic page inspection. */
export const inspectPageTool: ToolDef<InspectPageInput> = {
  name: 'inspect_page',
  description:
    'Inspect the current page as a compact semantic outline with refs for interactive elements.',
  inputSchema: inspectPageInputSchema,
  readOnly: true,
  execute: inspectPage,
};
