import { z } from 'zod';

import { writeArtifact } from '../../run/artifacts.js';
import type { ToolDef } from '../registry.js';
import { requireBrowser } from '../shared/browser.js';
import { assertEvidencePath, type EvidenceResult } from '../shared/evidence.js';

const screenshotInputSchema = z
  .object({
    filename: z
      .string()
      .min(1)
      .describe('Run-directory-relative path for the PNG evidence file'),
    fullPage: z
      .boolean()
      .optional()
      .describe('Capture the whole scrollable page instead of the viewport'),
  })
  .strict();

/** Input accepted by the screenshot tool. */
export type ScreenshotInput = z.infer<typeof screenshotInputSchema>;

/**
 * `screenshot` — capture the current browser page as PNG evidence.
 *
 * Captures the viewport by default, or the complete scrollable document when
 * `fullPage` is true. The PNG is written to the run-dir-relative `filename`
 * through `writeArtifact`, with the current page URL recorded as `sourceUrl`.
 * Returns only the artifact path and byte size; image bytes stay out of the
 * model transcript. The filename must stay inside the run directory and may
 * not replace reserved run metadata; violations and browser failures are
 * surfaced by the pipeline as structured error results.
 */
export const screenshotTool: ToolDef<ScreenshotInput> = {
  name: 'screenshot',
  description:
    'Capture the current page as PNG evidence in the run directory. ' +
    'Captures the viewport by default; set fullPage to capture the entire scrollable page. ' +
    'Returns the artifact path and byte size.',
  inputSchema: screenshotInputSchema,
  readOnly: false,
  async execute(input, ctx): Promise<EvidenceResult> {
    const browser = requireBrowser(ctx);
    assertEvidencePath(ctx.runDir, input.filename);
    const sourceUrl = browser.currentUrl();
    const bytes = await browser.screenshot({ fullPage: input.fullPage ?? false });
    const entry = writeArtifact(ctx.runDir, input.filename, bytes, { sourceUrl });
    return { path: entry.filename, size: bytes.byteLength };
  },
};
