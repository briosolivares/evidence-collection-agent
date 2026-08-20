import { z } from 'zod';

import type { BrowserController } from '../../browser/controller.js';
import type { ToolCtx, ToolDef } from '../registry.js';
import { createInlineImageToolOutput } from '../inlineImage.js';

export const CAPTURE_SCREENSHOT_TOOL_NAME = 'capture_screenshot' as const;

export const captureScreenshotInputSchema = z.strictObject({
  page_id: z
    .string()
    .min(1)
    .optional()
    .describe('Sherlock page id to capture; omit for the active task page.'),
});

export type CaptureScreenshotInput = z.infer<typeof captureScreenshotInputSchema>;

/**
 * Give the worker one visual observation of the exact live viewport.
 * Publication remains a separate, explicit publish_artifact operation.
 */
export const captureScreenshotTool: ToolDef<CaptureScreenshotInput> = {
  name: CAPTURE_SCREENSHOT_TOOL_NAME,
  description:
    'Capture the exact current browser viewport and return its PNG pixels inline for visual ' +
    'inspection. Use this when layout, canvas content, imagery, cross-origin UI, or visible ' +
    'postconditions cannot be verified reliably from accessibility or DOM data. This observes ' +
    'the existing live page and does not navigate, save a file, publish evidence, or satisfy a ' +
    'requested screenshot output; use publish_artifact kind=screenshot separately for evidence. ' +
    'Call capture_screenshot as the only tool in the response so you can inspect its pixels ' +
    'before deciding the next action. Use browser_execute to scroll before another capture.',
  inputSchema: captureScreenshotInputSchema,
  async execute(input, ctx) {
    const browser = requireBrowser(ctx.browser);
    ctx.abortSignal?.throwIfAborted();
    const sourceUrl = browser.currentUrl(input.page_id);
    const bytes = await browser.screenshot({
      fullPage: false,
      scale: 'css',
      ...(input.page_id === undefined ? {} : { pageId: input.page_id }),
    });
    ctx.abortSignal?.throwIfAborted();
    return createInlineImageToolOutput(
      `Captured the live viewport from ${sourceUrl}. This is a private visual observation, not a published artifact.`,
      'image/png',
      bytes,
    );
  },
};

function requireBrowser(browser: BrowserController | undefined): BrowserController {
  if (browser === undefined) {
    throw new Error('capture_screenshot requires an active browser session');
  }
  return browser;
}
