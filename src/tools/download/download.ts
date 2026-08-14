import { basename } from 'node:path';

import { z } from 'zod';

import { ARTIFACTS_DIR, writeArtifact } from '../../run/artifacts.js';
import type { ToolDef } from '../registry.js';
import { requireBrowser } from '../shared/browser.js';
import { artifactRolesInput, assertEvidencePath, type EvidenceResult } from '../shared/evidence.js';
import { accessKey } from '../registry.js';

const filenameSchema = z
  .string()
  .min(1)
  .optional()
  .describe(
    'Run-directory-relative output path under artifacts/. ' +
      'Defaults to artifacts/<browser-suggested filename or safe URL basename>',
  );

const httpUrlSchema = z.url().refine((url) => {
  const protocol = new URL(url).protocol;
  return protocol === 'http:' || protocol === 'https:';
}, 'URL must use HTTP or HTTPS');

// A single object with an exactly-one-of check rather than a z.union of two
// objects: the Anthropic API requires input_schema to have top-level
// `type: "object"`, and a union converts to a bare `anyOf` without it.
const downloadInputSchema = z
  .object({
    ref: z
      .string()
      .min(1)
      .optional()
      .describe('Ref for a download link or control from observe'),
    url: httpUrlSchema
      .optional()
      .describe(
        'Verified direct resource URL when the visible page link is a viewer or redirect wrapper',
      ),
    pageId: z
      .string()
      .min(1)
      .optional()
      .describe(
        'Page to download from (the page a ref was observed on, or the page whose context ' +
          'frames a direct URL fetch); omit for the selected page',
      ),
    filename: filenameSchema,
    roles: artifactRolesInput.describe(
      'Roles recorded for the download. Defaults to ["evidence"]; ' +
        'pass ["requested_output","evidence"] when the task explicitly asked for this file.',
    ),
  })
  .strict()
  .refine((input) => (input.ref === undefined) !== (input.url === undefined), {
    message: 'Provide exactly one of ref or url',
  });

/** Input accepted by the download tool. */
export type DownloadInput = z.infer<typeof downloadInputSchema>;

/**
 * `download` — save exact bytes obtained through Chrome itself.
 *
 * Accepts either a link/control ref from the current page or a verified
 * direct HTTP(S) URL. The browser controller captures a real Chrome navigation
 * response or download event, preserving the page's cookies, network
 * identity, and session. Direct URLs let the agent bypass viewer wrappers
 * without any site-specific logic. The exact captured bytes are written
 * through `writeArtifact` — always published under artifacts/, with the
 * given roles (default `evidence`) recorded — and the final resource URL is
 * recorded as provenance (or the initiating page for browser-generated blob
 * downloads).
 */
export const downloadTool: ToolDef<DownloadInput> = {
  name: 'download',
  description:
    'Download exact bytes through Chrome using either an observe ref or a verified ' +
    'direct HTTP(S) URL (provide exactly one). Supports ordinary document responses, ' +
    'attachment links, and JavaScript-triggered browser downloads. Use a direct URL when ' +
    'an observed link is only a viewer or redirect wrapper. Set pageId to name the page the ref ' +
    'was observed on; omit it for the selected page. ' +
    'Saves the artifact under artifacts/ with final-URL provenance.',
  inputSchema: downloadInputSchema,
  // When `filename` is given, it's known at getAccess() time and declared
  // as its own write — matching write_file/screenshot — so a concurrent
  // read_file/grep/inspect_document on that exact path is serialized behind
  // this call instead of racing the writeArtifact() that happens only after
  // the (slow, network-bound) browser.download() resolves. The
  // default-suggested-filename case has no path to declare until then, so
  // it still relies on the manifest write alone. The page read is keyed by
  // input.pageId (defaulting to 'selected') rather than the fixed
  // accessKey.selectedPage(), so a download named at a different page does
  // not wrongly serialize against work on the task tab, and two downloads
  // naming different pages can run concurrently.
  getAccess: (input) => ({
    reads: [accessKey.page(input.pageId ?? 'selected')],
    writes: [
      accessKey.manifest(),
      ...(input.filename !== undefined ? [accessKey.file(input.filename)] : []),
    ],
  }),
  async execute(input, ctx): Promise<EvidenceResult> {
    const browser = requireBrowser(ctx);
    if (input.filename !== undefined) {
      assertEvidencePath(ctx.runDir, input.filename);
    }
    const initiatingPageUrl = browser.currentUrl(input.pageId);
    const response = await browser.download(
      input.ref !== undefined
        ? { ref: input.ref, ...(input.pageId !== undefined ? { pageId: input.pageId } : {}) }
        : { url: input.url!, ...(input.pageId !== undefined ? { pageId: input.pageId } : {}) },
    );
    if (
      response.status !== undefined
      && (response.status < 200 || response.status >= 300)
    ) {
      throw new Error(
        `Download request failed with HTTP ${response.status}: ${response.finalUrl}`,
      );
    }

    const filename = input.filename
      ?? `${ARTIFACTS_DIR}/${
        safeSuggestedFilename(response.suggestedFilename) ?? safeUrlBasename(response.finalUrl)
      }`;
    assertEvidencePath(ctx.runDir, filename);
    const sourceUrl = isHttpUrl(response.finalUrl)
      ? response.finalUrl
      : initiatingPageUrl;
    const entry = writeArtifact(ctx.runDir, filename, response.bytes, {
      sourceUrl,
      roles: input.roles ?? ['evidence'],
    });
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

  return safeBasename(decodedBasename);
}

function safeSuggestedFilename(filename: string | undefined): string | undefined {
  if (filename === undefined || filename.trim() === '') return undefined;
  return safeBasename(basename(filename));
}

function safeBasename(value: string): string {
  const safe = value
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/^\.+$/, '');
  return safe === '' ? 'download' : safe;
}

function isHttpUrl(url: string): boolean {
  try {
    const protocol = new URL(url).protocol;
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}
