import { z } from 'zod';

import type { BrowserPage } from '../../browser/browserState.js';
import { accessKey, type ToolDef } from '../registry.js';
import { requireBrowser } from '../shared/browser.js';

const switchPageInputSchema = z.strictObject({
  pageId: z
    .string()
    .min(1)
    .describe('Stable page id from an observe result, a browser_action openedPages entry, or a prior switch_page'),
});

/** Input accepted by the switch_page tool. */
export type SwitchPageInput = z.infer<typeof switchPageInputSchema>;

/** What switch_page reports: the newly selected page plus the full tab set,
 * so the model can see what else is open without a second call. */
export interface SwitchPageResult {
  selected: BrowserPage;
  pages: BrowserPage[];
}

/**
 * `switch_page` — choose which tracked page the single-page tools act on.
 *
 * Deliberately separate from `browser_action`: mixing "act on this element"
 * with "and also change which page we mean" is how blind batches ended up
 * clicking the wrong document. A sequence acts on one page; moving between
 * pages is its own decision, recorded as its own call.
 *
 * INTEGRATION: not registered in `src/tools/index.ts` yet — registered
 * together with `browser_action` and `handle_dialog` by the session owner.
 */
export const switchPageTool: ToolDef<SwitchPageInput> = {
  name: 'switch_page',
  description:
    'Select which browser page (tab or popup) later tools act on, by pageId from observe or a ' +
    'browser_action openedPages entry. Returns the selected page and every live page. Element refs ' +
    'stay bound to the page and document they were observed in; switching does not make them valid ' +
    'elsewhere.',
  inputSchema: switchPageInputSchema,
  readOnly: false,
  // Repoints the shared "selected page" pointer every unqualified
  // click/type/navigate/scroll/browser_action/observe call resolves through
  // (see accessKey.selectedPage's doc comment: "every unqualified browser
  // action contends for it"). That write already conflicts with anything
  // that reads OR writes page:selected — which is every one of those
  // tools' own declared access, whether by name (selectedPage()) or by
  // input-aware default (accessKey.page(input.pageId ?? 'selected')) — so
  // switch_page still serializes against exactly the calls it must, without
  // falling back to the full EXCLUSIVE_ACCESS that would also serialize it
  // against unrelated work like a bash command or a browser_action aimed at
  // an explicit, different pageId. It does not touch the target page's own
  // content or observation baseline: selecting a page does not change what
  // is on it.
  getAccess: () => ({ reads: [], writes: [accessKey.selectedPage()] }),
  async execute(input, ctx): Promise<SwitchPageResult> {
    const browser = requireBrowser(ctx);
    const selected = await browser.switchPage(input.pageId);
    return { selected, pages: await browser.pages() };
  },
};
