import { z } from 'zod';

import type { ToolDef } from '../registry.js';
import { requireBrowser } from '../shared/browser.js';
import { accessKey } from '../registry.js';

const scrollInputSchema = z.strictObject({});

type ScrollInput = z.infer<typeof scrollInputSchema>;

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
  getAccess: () => ({
    reads: [],
    writes: [accessKey.selectedPage(), accessKey.observation('selected')],
  }),
  async execute(input, ctx) {
    void input;
    await requireBrowser(ctx).scroll();
    return 'Scrolled down about one viewport; run inspect_page to observe the page.';
  },
};
