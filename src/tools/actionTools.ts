import { z } from 'zod';

import {
  BrowserRefNotFoundError,
  type BrowserAdapter,
} from '../browser/adapter.js';
import type { ToolCtx, ToolDef } from './registry.js';

const clickInputSchema = z.strictObject({
  ref: z.string().min(1).describe('Element ref from the latest inspect_page result'),
});

const typeInputSchema = z.strictObject({
  ref: z.string().min(1).describe('Editable element ref from the latest inspect_page result'),
  text: z.string().describe('Complete text value to place in the element'),
});

const scrollInputSchema = z.strictObject({});

type ClickInput = z.infer<typeof clickInputSchema>;
type TypeInput = z.infer<typeof typeInputSchema>;
type ScrollInput = z.infer<typeof scrollInputSchema>;

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

/**
 * `scroll` — move the page downward by about one viewport.
 *
 * Takes no input, scrolls the active page far enough to expose or lazy-load
 * the next viewport, and returns a confirmation directing the model to
 * inspect the changed page again.
 */
export const scrollTool: ToolDef<ScrollInput> = {
  name: 'scroll',
  description:
    'Scrolls down about one viewport. Run inspect_page afterward to observe newly loaded content.',
  inputSchema: scrollInputSchema,
  readOnly: false,
  async execute(input, ctx) {
    void input;
    await requireBrowser(ctx).scroll();
    return 'Scrolled down about one viewport; run inspect_page to observe the page.';
  },
};

/** The state-changing browser action tools in stable registration order. */
export const actionTools: readonly ToolDef[] = [clickTool, typeTool, scrollTool];

function requireBrowser(ctx: ToolCtx): BrowserAdapter {
  if (ctx.browser === undefined) {
    throw new Error('Tool context has no browser adapter.');
  }
  return ctx.browser;
}

async function actByRef(
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

async function requireRefDescription(
  browser: BrowserAdapter,
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
