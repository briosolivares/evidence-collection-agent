import { lstatSync } from 'node:fs';
import { join, posix, relative, resolve, sep } from 'node:path';

import { z } from 'zod';

import type { BrowserController, BrowserDownloadResult } from '../../browser/controller.js';
import {
  type ArtifactRole,
  type ManifestEntry,
  preflightArtifactWrite,
  SCRATCH_DIR,
  writeArtifact,
} from '../../run/artifacts.js';
import { NoFollowFileError, readFileNoFollow } from '../../run/noFollowFile.js';
import { resolveRunPath } from '../../run/runDir.js';
import { SCRATCH_WORKSPACE_MAX_FILE_BYTES } from '../../run/syncScratchWorkspace.js';
import type { ToolCtx, ToolDef } from '../registry.js';

const WORKSPACE_PREFIX = `${SCRATCH_DIR}/workspace/`;

const workspaceSourcePathSchema = z
  .string()
  .min(1)
  .refine(isCanonicalWorkspaceSourcePath, {
    message:
      'must be a canonical run-relative path beginning with "scratch/workspace/" ' +
      '(for example "scratch/workspace/report.csv"); copy the exact path returned ' +
      'by write_file or browser_execute changed_files',
  });

/**
 * One publication is bounded to the same per-file ceiling as the private
 * workspace from which file-mode publications are read. The limit is checked
 * from the opened file descriptor before reading and again while reading.
 */
export const MAX_PUBLISH_ARTIFACT_BYTES = SCRATCH_WORKSPACE_MAX_FILE_BYTES;

const roleSchema = z.enum(['requested_output', 'evidence']);
const rolesSchema = z
  .array(roleSchema)
  .min(1)
  .max(2)
  .superRefine((roles, ctx) => {
    if (new Set(roles).size !== roles.length) {
      ctx.addIssue({
        code: 'custom',
        message: 'roles must contain unique values',
      });
    }
  });

const httpUrlSchema = z.url().refine((value) => {
  const protocol = new URL(value).protocol;
  return protocol === 'http:' || protocol === 'https:';
}, 'URL must use HTTP or HTTPS');

const MODE_FIELDS = [
  'source_path',
  'content',
  'page_id',
  'full_page',
  'url',
  'backend_node_id',
] as const;

type ModeField = (typeof MODE_FIELDS)[number];

/**
 * A strict object with conditional checks, rather than a top-level union.
 * Anthropic requires every tool input schema to retain top-level
 * `type: "object"`; a discriminated union serializes as `anyOf` instead.
 */
export const publishArtifactInputSchema = z
  .strictObject({
    kind: z.enum(['file', 'text', 'screenshot', 'download']),
    artifact_path: z.string().min(1).describe('Run-relative destination under artifacts/.'),
    roles: rolesSchema.describe('One or both semantic roles: requested_output and evidence.'),
    source_url: z
      .url()
      .optional()
      .describe(
        'Source URL for file or text publication. Screenshot and download provenance is browser-derived.',
      ),
    source_path: workspaceSourcePathSchema
      .optional()
      .describe(
        'File-mode source as the exact canonical run-relative path returned by ' +
          'write_file or browser_execute changed_files. It must begin with ' +
          'scratch/workspace/ (for example scratch/workspace/report.csv).',
      ),
    content: z.string().optional().describe('Text-mode content, encoded exactly as UTF-8.'),
    page_id: z
      .string()
      .min(1)
      .optional()
      .describe('Browser page id for screenshot or download mode.'),
    full_page: z
      .boolean()
      .optional()
      .describe('Screenshot mode: capture the whole scrollable page.'),
    url: httpUrlSchema.optional().describe('Download mode: direct HTTP(S) resource URL.'),
    backend_node_id: z
      .number()
      .int()
      .min(1)
      .max(2_147_483_647)
      .optional()
      .describe('Download mode: accessibility backend DOM node id for a link or control.'),
  })
  .superRefine((input, ctx) => {
    const allowedByMode: Record<typeof input.kind, readonly ModeField[]> = {
      file: ['source_path'],
      text: ['content'],
      screenshot: ['page_id', 'full_page'],
      download: ['page_id', 'url', 'backend_node_id'],
    };

    for (const field of MODE_FIELDS) {
      if (input[field] !== undefined && !allowedByMode[input.kind].includes(field)) {
        ctx.addIssue({
          code: 'custom',
          path: [field],
          message: `${field} is not valid when kind is ${input.kind}`,
        });
      }
    }

    if (input.kind === 'file' && input.source_path === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['source_path'],
        message: 'source_path is required when kind is file',
      });
    }
    if (input.kind === 'text' && input.content === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['content'],
        message: 'content is required when kind is text',
      });
    }
    if (
      input.kind === 'download' &&
      (input.url === undefined) === (input.backend_node_id === undefined)
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['url'],
        message: 'download mode requires exactly one of url or backend_node_id',
      });
    }
    if (
      (input.kind === 'screenshot' || input.kind === 'download') &&
      input.source_url !== undefined
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['source_url'],
        message: `${input.kind} source_url is derived from the browser and cannot be supplied`,
      });
    }
  });

export type PublishArtifactInput = z.infer<typeof publishArtifactInputSchema>;

/**
 * Publish one generic artifact through the existing manifest chokepoint.
 *
 * The destination and semantic role set are checked before any browser work.
 * Browser-derived modes obtain both bytes and provenance from the provider-
 * neutral controller. File mode opens the private source without following
 * symlinks and copies the exact bytes read from that descriptor.
 */
export const publishArtifactTool: ToolDef<PublishArtifactInput> = {
  name: 'publish_artifact',
  description:
    'Publish one artifact with explicit semantic roles. Choose kind=file to copy exact bytes ' +
    'from an existing canonical run-relative scratch/workspace/ source_path. Choose kind=text ' +
    'to publish small final CSV, JSON, Markdown, or other UTF-8 content directly without an ' +
    'intermediate write_file call; choose kind=screenshot for browser PNG bytes or ' +
    'kind=download for browser-captured resource bytes. artifact_path must be under artifacts/. ' +
    'Screenshot and download source provenance is derived from the browser. When several ' +
    'independent outputs are already ready, you may issue multiple publish_artifact calls in ' +
    'the same assistant response; they execute sequentially. Overwriting is ' +
    'allowed only when the existing artifact has the same role set.',
  inputSchema: publishArtifactInputSchema,
  async execute(input, ctx): Promise<ManifestEntry> {
    assertNotCancelled(ctx.abortSignal);

    const roles = canonicalRoles(input.roles);
    const artifactPath = preflightArtifactWrite(ctx.runDir, input.artifact_path, roles);

    let bytes: Uint8Array;
    let sourceUrl: string | undefined;

    switch (input.kind) {
      case 'file':
        bytes = readWorkspaceSource(ctx.runDir, input.source_path!);
        sourceUrl = input.source_url;
        break;
      case 'text':
        bytes = Buffer.from(input.content!, 'utf8');
        sourceUrl = input.source_url;
        break;
      case 'screenshot': {
        const browser = requireBrowser(ctx.browser, input.kind);
        sourceUrl = browser.currentUrl(input.page_id);
        bytes = await abortable(
          browser.screenshot({
            fullPage: input.full_page ?? false,
            ...(input.page_id === undefined ? {} : { pageId: input.page_id }),
          }),
          ctx.abortSignal,
        );
        break;
      }
      case 'download': {
        const browser = requireBrowser(ctx.browser, input.kind);
        const initiatingPageUrl = browser.currentUrl(input.page_id);
        const response = await abortable(
          browser.download(
            input.backend_node_id === undefined
              ? {
                  url: input.url!,
                  ...(input.page_id === undefined ? {} : { pageId: input.page_id }),
                }
              : {
                  backendNodeId: input.backend_node_id,
                  ...(input.page_id === undefined ? {} : { pageId: input.page_id }),
                },
          ),
          ctx.abortSignal,
        );
        assertSuccessfulDownload(response);
        bytes = response.bytes;
        sourceUrl = isHttpUrl(response.finalUrl) ? response.finalUrl : initiatingPageUrl;
        break;
      }
    }

    assertNotCancelled(ctx.abortSignal);
    assertArtifactSize(bytes.byteLength);

    return writeArtifact(ctx.runDir, artifactPath, bytes, {
      roles,
      ...(sourceUrl === undefined ? {} : { sourceUrl }),
    });
  },
};

function canonicalRoles(roles: readonly ArtifactRole[]): ArtifactRole[] {
  return (['requested_output', 'evidence'] as const).filter((role) => roles.includes(role));
}

/**
 * Confine a source to scratch/workspace, reject symlink ancestors, and read
 * exact bytes from the same no-follow descriptor that was type/size checked.
 */
function readWorkspaceSource(runDir: string, requestedPath: string): Buffer {
  const absolutePath = resolveRunPath(runDir, requestedPath);
  const normalizedPath = relative(resolve(runDir), absolutePath).split(sep).join('/');
  if (normalizedPath !== requestedPath || !isCanonicalWorkspaceSourcePath(normalizedPath)) {
    throw new Error(
      'source_path must be the exact canonical run-relative path of a file under ' +
        `${WORKSPACE_PREFIX} (for example "scratch/workspace/report.csv"): ` +
        JSON.stringify(requestedPath),
    );
  }

  assertSourceAncestorsAreDirectories(runDir, normalizedPath);

  try {
    return readFileNoFollow(absolutePath, { maxBytes: MAX_PUBLISH_ARTIFACT_BYTES });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ELOOP') {
      throw new Error(`source_path is a symlink, which is never followed: ${normalizedPath}`);
    }
    if (error instanceof NoFollowFileError && error.kind === 'not_regular') {
      throw new Error(`source_path is not a regular file: ${normalizedPath}`);
    }
    if (
      error instanceof NoFollowFileError &&
      error.kind === 'max_bytes' &&
      error.phase === 'inspection'
    ) {
      throw new Error(
        `source_path exceeds the ${MAX_PUBLISH_ARTIFACT_BYTES}-byte publication limit: ` +
          `${normalizedPath} (${error.observedBytes} bytes)`,
      );
    }
    if (error instanceof NoFollowFileError && error.kind === 'max_bytes') {
      throw new Error(
        `source_path grew past the ${MAX_PUBLISH_ARTIFACT_BYTES}-byte publication limit ` +
          `while being read: ${normalizedPath}`,
      );
    }
    throw error;
  }
}

function isCanonicalWorkspaceSourcePath(value: string): boolean {
  return (
    value.startsWith(WORKSPACE_PREFIX) &&
    value.length > WORKSPACE_PREFIX.length &&
    !value.includes('\\') &&
    posix.normalize(value) === value
  );
}

function assertSourceAncestorsAreDirectories(runDir: string, normalizedPath: string): void {
  const segments = normalizedPath.split('/');
  let current = resolve(runDir);
  for (let index = 0; index < segments.length; index += 1) {
    current = join(current, segments[index]!);
    const stats = lstatSync(current);
    const display = segments.slice(0, index + 1).join('/');
    if (stats.isSymbolicLink()) {
      throw new Error(`source_path contains a symlink, which is never followed: ${display}`);
    }
    if (index < segments.length - 1 && !stats.isDirectory()) {
      throw new Error(`source_path ancestor is not a directory: ${display}`);
    }
  }
}

function requireBrowser(
  browser: BrowserController | undefined,
  kind: 'screenshot' | 'download',
): BrowserController {
  if (browser === undefined) {
    throw new Error(`publish_artifact kind=${kind} requires an active browser session`);
  }
  return browser;
}

function assertSuccessfulDownload(response: BrowserDownloadResult): void {
  if (response.status !== undefined && (response.status < 200 || response.status >= 300)) {
    throw new Error(`download request failed with HTTP ${response.status}: ${response.finalUrl}`);
  }
}

function isHttpUrl(value: string): boolean {
  try {
    const protocol = new URL(value).protocol;
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

function assertArtifactSize(byteLength: number): void {
  if (byteLength > MAX_PUBLISH_ARTIFACT_BYTES) {
    throw new Error(
      `artifact exceeds the ${MAX_PUBLISH_ARTIFACT_BYTES}-byte publication limit ` +
        `(${byteLength} bytes)`,
    );
  }
}

function cancelledError(): Error {
  const error = new Error('publish_artifact was cancelled before publication');
  error.name = 'AbortError';
  return error;
}

function assertNotCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw cancelledError();
}

/** Wait for a provider operation without publishing bytes after cancellation. */
function abortable<T>(operation: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined) return operation;
  assertNotCancelled(signal);

  return new Promise<T>((resolvePromise, rejectPromise) => {
    const settle = (callback: () => void): void => {
      signal.removeEventListener('abort', onAbort);
      callback();
    };
    const onAbort = (): void => settle(() => rejectPromise(cancelledError()));

    signal.addEventListener('abort', onAbort, { once: true });
    operation.then(
      (value) => settle(() => resolvePromise(value)),
      (error: unknown) => settle(() => rejectPromise(error)),
    );
    if (signal.aborted) onAbort();
  });
}
