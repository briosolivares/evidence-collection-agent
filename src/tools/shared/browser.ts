import type { BrowserController } from '../../browser/controller.js';
import type { ToolCtx } from '../registry.js';

/** Get the context's browser controller, or throw for a context without one —
 * every browser-driving tool starts here. */
export function requireBrowser(ctx: ToolCtx): BrowserController {
  if (ctx.browser === undefined) {
    throw new Error('Tool context has no browser controller.');
  }
  return ctx.browser;
}
