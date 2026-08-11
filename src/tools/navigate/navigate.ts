import { z } from 'zod';

import type { ToolCtx, ToolDef } from '../registry.js';
import { formatPageHeader, requireBrowser } from '../shared/browser.js';

const navigateInputSchema = z
  .object({
    url: z.url().refine((url) => {
      const protocol = new URL(url).protocol;
      return protocol === 'http:' || protocol === 'https:';
    }, 'URL must use HTTP or HTTPS'),
  })
  .strict();

/** Input accepted by the navigate tool. */
export type NavigateInput = z.infer<typeof navigateInputSchema>;

/**
 * Navigate the active browser tab and report the page that actually loaded.
 *
 * @param input - an absolute HTTP or HTTPS URL to load
 * @param ctx - tool context containing an active browser task tab
 * @returns a two-line header containing the landed URL and document title
 */
async function navigate(input: NavigateInput, ctx: ToolCtx): Promise<string> {
  const browser = requireBrowser(ctx);
  await browser.goto(input.url);
  return formatPageHeader(browser.currentUrl(), await browser.title());
}

/** State-changing registry definition for browser navigation. */
export const navigateTool: ToolDef<NavigateInput> = {
  name: 'navigate',
  description: 'Navigate the browser to an absolute HTTP or HTTPS URL.',
  inputSchema: navigateInputSchema,
  readOnly: false,
  execute: navigate,
};
