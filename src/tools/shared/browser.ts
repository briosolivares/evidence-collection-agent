import {
  BrowserRefNotFoundError,
  type BrowserController,
} from '../../browser/controller.js';
import type { ToolCtx } from '../registry.js';

/** Get the context's browser controller, or throw for a context without one —
 * every browser-driving tool starts here. */
export function requireBrowser(ctx: ToolCtx): BrowserController {
  if (ctx.browser === undefined) {
    throw new Error('Tool context has no browser controller.');
  }
  return ctx.browser;
}

/** The two-line URL/title header that opens every observation result. */
export function formatPageHeader(url: string, title: string): string {
  return `URL: ${url}\nTitle: ${title}`;
}

/** Run a ref-addressed browser action, converting a stale or unknown ref
 * into an error telling the model to run inspect_page again. */
export async function actByRef(
  ref: string,
  action: () => Promise<void>,
): Promise<void> {
  try {
    await action();
  } catch (thrown) {
    if (thrown instanceof BrowserRefNotFoundError) {
      throw new Error(
        `Ref ${ref} is stale or unavailable; run inspect_page again and use a current ref.`,
      );
    }
    throw thrown;
  }
}

function descriptionForRef(outline: string, ref: string): string | undefined {
  const marker = `[ref=${ref}]`;
  const line = outline.split('\n').find((candidate) => candidate.includes(marker));
  if (line === undefined) return undefined;

  const description = line.slice(0, line.indexOf(marker)).trim().replace(/^-\s*/, '');
  return description === '' ? undefined : description;
}

/** Resolve a ref to its semantic role/name in the current outline, or throw
 * the same stale-ref guidance a failed action would. */
export async function requireRefDescription(
  browser: BrowserController,
  ref: string,
): Promise<string> {
  const description = descriptionForRef(await browser.outline(), ref);
  if (description === undefined) {
    throw new Error(
      `Ref ${ref} is stale or unavailable; run inspect_page again and use a current ref.`,
    );
  }
  return description;
}
