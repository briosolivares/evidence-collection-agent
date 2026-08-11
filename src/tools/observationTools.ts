import { z } from 'zod';

import type { BrowserAdapter } from '../browser/adapter.js';
import type { ToolCtx, ToolDef } from './registry.js';

const navigateInputSchema = z
  .object({
    url: z.url().refine((url) => {
      const protocol = new URL(url).protocol;
      return protocol === 'http:' || protocol === 'https:';
    }, 'URL must use HTTP or HTTPS'),
  })
  .strict();

const inspectPageInputSchema = z.object({}).strict();

/** Input accepted by the navigate tool. */
export type NavigateInput = z.infer<typeof navigateInputSchema>;

/** Input accepted by the inspect_page tool. */
export type InspectPageInput = z.infer<typeof inspectPageInputSchema>;

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

/** State-changing registry definition for browser navigation. */
export const navigateTool: ToolDef<NavigateInput> = {
  name: 'navigate',
  description: 'Navigate the browser to an absolute HTTP or HTTPS URL.',
  inputSchema: navigateInputSchema,
  readOnly: false,
  execute: navigate,
};

/** Read-only registry definition for semantic page inspection. */
export const inspectPageTool: ToolDef<InspectPageInput> = {
  name: 'inspect_page',
  description:
    'Inspect the current page as a compact semantic outline with refs for interactive elements.',
  inputSchema: inspectPageInputSchema,
  readOnly: true,
  execute: inspectPage,
};

/** Browser observation tools in stable registration order. */
export const observationTools: readonly ToolDef[] = [
  navigateTool,
  inspectPageTool,
];

function requireBrowser(ctx: ToolCtx): BrowserAdapter {
  if (ctx.browser === undefined) {
    throw new Error('Tool context has no browser adapter.');
  }
  return ctx.browser;
}

function formatPageHeader(url: string, title: string): string {
  return `URL: ${url}\nTitle: ${title}`;
}
