import { basename } from 'node:path';

import { z } from 'zod';

import { writeArtifact } from '../../run/artifacts.js';
import type { ToolDef } from '../registry.js';
import { requireBrowser } from '../shared/browser.js';
import { assertEvidencePath, type EvidenceResult } from '../shared/evidence.js';

const downloadInputSchema = z
  .object({
    ref: z.string().min(1).describe('Ref for a link from inspect_page'),
    filename: z
      .string()
      .min(1)
      .optional()
      .describe(
        'Run-directory-relative output path. Defaults to a safe basename derived from the link URL',
      ),
  })
  .strict();

/** Input accepted by the download tool. */
export type DownloadInput = z.infer<typeof downloadInputSchema>;

/**
 * `download` — save the bytes linked by an inspected page ref.
 *
 * Resolves `ref` to an absolute href, fetches it through the browser adapter
 * so cookies and session state are retained, and writes the exact response
 * bytes through `writeArtifact`, recording the current page URL as
 * `sourceUrl`. When `filename` is omitted, a deterministic safe basename is
 * derived from the href's final URL path segment (falling back to
 * `download`). The output path must stay inside the run directory and may not
 * replace reserved run metadata. A ref without an href fails with guidance
 * to inspect again.
 *
 * This href-based path intentionally does not capture JavaScript-triggered
 * downloads; browser download-event capture is the alternative for those
 * controls when no href exists.
 */
export const downloadTool: ToolDef<DownloadInput> = {
  name: 'download',
  description:
    'Download the href identified by an inspect_page ref through the browser session, ' +
    'preserving cookies, and save the exact bytes in the run directory. ' +
    'The filename defaults to a safe basename derived from the link URL. ' +
    'Returns the artifact path and byte size.',
  inputSchema: downloadInputSchema,
  readOnly: false,
  async execute(input, ctx): Promise<EvidenceResult> {
    const browser = requireBrowser(ctx);
    if (input.filename !== undefined) {
      assertEvidencePath(ctx.runDir, input.filename);
    }
    const sourceUrl = browser.currentUrl();
    const href = await browser.resolveHref(input.ref);
    if (href === null) {
      throw new Error(
        `Browser ref ${input.ref} has no href; re-run inspect_page and choose a link ref. ` +
          'JavaScript-triggered downloads require browser download-event capture.',
      );
    }

    const response = await browser.fetch(href);
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`Download request failed with HTTP ${response.status}: ${href}`);
    }

    const filename = input.filename ?? safeUrlBasename(href);
    assertEvidencePath(ctx.runDir, filename);
    const entry = writeArtifact(ctx.runDir, filename, response.bytes, { sourceUrl });
    return { path: entry.filename, size: response.bytes.byteLength };
  },
};

function safeUrlBasename(href: string): string {
  const encodedBasename = basename(new URL(href).pathname);
  let decodedBasename: string;
  try {
    decodedBasename = decodeURIComponent(encodedBasename);
  } catch {
    decodedBasename = encodedBasename;
  }

  const safe = decodedBasename
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/^\.+$/, '');
  return safe === '' ? 'download' : safe;
}
