import { basename, relative, resolve } from 'node:path';

import { z } from 'zod';

import type { BrowserAdapter } from '../browser/adapter.js';
import { MANIFEST_FILENAME, writeArtifact } from '../run/artifacts.js';
import { resolveRunPath } from '../run/runDir.js';
import { TRANSCRIPT_FILENAME } from '../run/transcript.js';
import type { ToolCtx, ToolDef } from './registry.js';

const RESERVED_RUN_METADATA_PATHS = new Set([
  MANIFEST_FILENAME,
  TRANSCRIPT_FILENAME,
  'metrics.json',
]);

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

/** Input accepted by the screenshot tool. */
export type ScreenshotInput = z.infer<typeof screenshotInputSchema>;

/** Input accepted by the download tool. */
export type DownloadInput = z.infer<typeof downloadInputSchema>;

/** Model-readable location and byte count for a captured artifact. */
export interface EvidenceResult {
  /** Run-directory-relative path recorded in the manifest. */
  path: string;
  /** Number of bytes written to the artifact. */
  size: number;
}

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

/** Browser evidence tools in stable registration order. */
export const evidenceTools: readonly ToolDef[] = [screenshotTool, downloadTool];

function requireBrowser(ctx: ToolCtx): BrowserAdapter {
  if (ctx.browser === undefined) {
    throw new Error('Tool context has no browser adapter.');
  }
  return ctx.browser;
}

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

function assertEvidencePath(runDir: string, filename: string): void {
  const absolutePath = resolveRunPath(runDir, filename);
  const normalizedPath = relative(resolve(runDir), absolutePath);
  if (RESERVED_RUN_METADATA_PATHS.has(normalizedPath)) {
    throw new Error(
      `Evidence filename is reserved for run metadata: ${normalizedPath}`,
    );
  }
}
