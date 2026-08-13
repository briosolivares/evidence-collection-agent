import { z } from 'zod';

import { writeArtifact } from '../../run/artifacts.js';
import type { ToolDef } from '../registry.js';
import { requireBrowser } from '../shared/browser.js';
import { artifactRolesInput, assertEvidencePath, type EvidenceResult } from '../shared/evidence.js';

const screenshotInputSchema = z
  .object({
    filename: z
      .string()
      .min(1)
      .describe('Run-directory-relative path for the PNG evidence file, under artifacts/'),
    fullPage: z
      .boolean()
      .optional()
      .describe('Capture the whole scrollable page instead of the viewport'),
    roles: artifactRolesInput.describe(
      'Roles recorded for the capture. Defaults to ["evidence"]; ' +
        'pass ["requested_output","evidence"] when the task explicitly asked for this screenshot.',
    ),
  })
  .strict();

/** Input accepted by the screenshot tool. */
export type ScreenshotInput = z.infer<typeof screenshotInputSchema>;

/**
 * `screenshot` — capture the current browser page as PNG evidence.
 *
 * Captures the viewport by default, or the complete scrollable document when
 * `fullPage` is true. The PNG is written to the run-dir-relative `filename`
 * through `writeArtifact`, with the current page URL recorded as `sourceUrl`
 * and the given roles (default `evidence`) recorded in its manifest entry.
 * Returns only the artifact path and byte size; image bytes stay out of the
 * model transcript. Captures always publish: the filename must land under
 * artifacts/ and may not replace reserved run metadata; violations and
 * browser failures are surfaced by the pipeline as structured error results.
 */
export const screenshotTool: ToolDef<ScreenshotInput> = {
  name: 'screenshot',
  description:
    'Capture the current page as PNG evidence, published under artifacts/ in the run directory. ' +
    'Captures the viewport by default; set fullPage to capture the entire scrollable page. ' +
    'Returns the artifact path and byte size.',
  inputSchema: screenshotInputSchema,
  readOnly: false,
  async execute(input, ctx): Promise<EvidenceResult> {
    const browser = requireBrowser(ctx);
    assertEvidencePath(ctx.runDir, input.filename);
    const sourceUrl = browser.currentUrl();
    const bytes = await browser.screenshot({ fullPage: input.fullPage ?? false });
    const entry = writeArtifact(ctx.runDir, input.filename, bytes, {
      sourceUrl,
      roles: input.roles ?? ['evidence'],
    });
    return { path: entry.filename, size: bytes.byteLength };
  },
};
