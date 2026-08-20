import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
} from 'node:fs';
import { extname, join, relative, resolve, sep } from 'node:path';

import { z } from 'zod';

import { detectContentFormat, splitLines } from '../../tools/contentReader.js';
import type { ImageBlock, ToolResultBlock, ToolUseBlock } from '../../model/messages.js';
import { ARTIFACTS_DIR } from '../../run/artifacts.js';
import { resolveRunPath } from '../../run/runDir.js';
import { executeToolCall, type ToolCallResult } from '../../tools/pipeline.js';
import {
  accessKey,
  createRegistry,
  type ToolCtx,
  type ToolDef,
  type ToolRegistry,
} from '../../tools/registry.js';

export const VERIFIER_MAX_FILE_BYTES = 16 * 1024 * 1024;
export const VERIFIER_MAX_GREP_BYTES = 64 * 1024 * 1024;
export const VERIFIER_MAX_RESULT_BYTES = 48 * 1024;
export const VERIFIER_MAX_FILES = 512;
/** 3.75MB of raw bytes stays within the API's ~5MB encoded-image limit. */
export const VERIFIER_MAX_IMAGE_BYTES = 3_750_000;
/** The API rejects an image with either dimension above 8,000 pixels. */
export const VERIFIER_MAX_IMAGE_DIMENSION_PX = 8_000;

const LINE_NUMBER_PAD = 6;
const READ_DEFAULT_LINES = 400;

export const verifierReadFileInputSchema = z.strictObject({
  file_path: z
    .string()
    .min(1)
    .max(1_024)
    .describe('Path to a surfaced UTF-8 text file or PNG/JPEG artifact'),
  offset: z.number().int().min(1).optional(),
  limit: z.number().int().min(1).max(1_000).optional(),
});

export const verifierGrepInputSchema = z.strictObject({
  pattern: z
    .string()
    .min(1)
    .max(512)
    .refine((value) => value.trim().length > 0, 'must not be blank')
    .describe('Literal text to find; this bounded verifier grep does not evaluate regex'),
  path: z
    .string()
    .min(1)
    .max(1_024)
    .optional()
    .describe('Published file or directory to search; defaults to artifacts/'),
  case_sensitive: z.boolean().optional(),
  max_results: z.number().int().min(1).max(200).optional(),
});

type ReadInput = z.infer<typeof verifierReadFileInputSchema>;
type GrepInput = z.infer<typeof verifierGrepInputSchema>;

export interface VerifierPathPolicy {
  readonly allowedArtifactPaths: ReadonlySet<string>;
}

export function createVerifierPathPolicy(
  allowedArtifactPaths: readonly string[] = [],
): VerifierPathPolicy {
  return {
    allowedArtifactPaths: new Set(allowedArtifactPaths.map(normalizeAllowedArtifactPath)),
  };
}

function createReadFileTool(policy: VerifierPathPolicy): ToolDef<ReadInput> {
  return {
    name: 'read_file',
    description:
      'Read a bounded window from a surfaced UTF-8 artifact. PNG/JPEG ' +
      'artifacts are returned as images. Only requested-output/evidence files are visible; use ' +
      'offset/limit for large text files.',
    inputSchema: verifierReadFileInputSchema,
    getAccess: (input) => ({
      reads: [accessKey.file(input.file_path)],
      writes: [],
    }),
    // Results are bounded in memory below. Infinity prevents the generic
    // pipeline from offloading and thereby mutating the run during verification.
    maxBytes: Number.MAX_SAFE_INTEGER,
    async execute(input, ctx) {
      throwIfAborted(ctx.abortSignal);
      const target = resolveSurfacedFile(ctx.runDir, input.file_path, policy);
      const bytes = await readRegularFileNoFollow(
        target.absolutePath,
        input.file_path,
        VERIFIER_MAX_FILE_BYTES,
        ctx.abortSignal,
      );
      const text = decodeText(bytes, input.file_path);
      const lines = splitLines(text);
      const offset = input.offset ?? 1;
      if (offset > lines.length) {
        return `The file has ${lines.length} line(s), shorter than offset ${offset}.`;
      }
      const limit = input.limit ?? READ_DEFAULT_LINES;
      const selected = lines.slice(offset - 1, offset - 1 + limit);
      const rendered = selected
        .map((line, index) => `${String(offset + index).padStart(LINE_NUMBER_PAD, ' ')}→${line}`)
        .join('\n');
      const more = offset - 1 + selected.length < lines.length;
      return boundText(
        rendered,
        more
          ? `\n[Window ended at line ${offset + selected.length - 1} of ${lines.length}; read the next offset to continue.]`
          : '',
      );
    },
  };
}

function createGrepTool(policy: VerifierPathPolicy): ToolDef<GrepInput> {
  return {
    name: 'grep',
    description:
      'Find bounded literal text matches in surfaced UTF-8 artifacts. ' +
      'Defaults to artifacts/. This is deliberately literal rather than regex so untrusted ' +
      'file content cannot trigger unbounded regular-expression work.',
    inputSchema: verifierGrepInputSchema,
    getAccess: (input) => ({
      reads: [accessKey.file(input.path ?? ARTIFACTS_DIR)],
      writes: [],
    }),
    maxBytes: Number.MAX_SAFE_INTEGER,
    async execute(input, ctx) {
      throwIfAborted(ctx.abortSignal);
      const givenPath = input.path ?? ARTIFACTS_DIR;
      const files = collectSurfacedFiles(ctx.runDir, givenPath, policy, VERIFIER_MAX_FILES);
      const needle =
        input.case_sensitive === false ? input.pattern.toLocaleLowerCase('en-US') : input.pattern;
      const maxResults = input.max_results ?? 100;
      const matches: string[] = [];
      let totalBytes = 0;

      for (const file of files) {
        throwIfAborted(ctx.abortSignal);
        const remaining = VERIFIER_MAX_GREP_BYTES - totalBytes;
        if (remaining <= 0) {
          throw new Error(
            `grep inspection exceeds ${VERIFIER_MAX_GREP_BYTES} total bytes; narrow path`,
          );
        }
        const bytes = await readRegularFileNoFollow(
          file.absolutePath,
          file.relativePath,
          Math.min(VERIFIER_MAX_FILE_BYTES, remaining),
          ctx.abortSignal,
        );
        totalBytes += bytes.length;
        const text = tryDecodeText(bytes, file.relativePath);
        if (text === undefined) continue;
        for (const [index, line] of splitLines(text).entries()) {
          throwIfAborted(ctx.abortSignal);
          const haystack = input.case_sensitive === false ? line.toLocaleLowerCase('en-US') : line;
          if (!haystack.includes(needle)) continue;
          matches.push(`${file.relativePath}:${index + 1}: ${line}`);
          if (matches.length >= maxResults) {
            return boundText(
              matches.join('\n'),
              `\n[Stopped at max_results=${maxResults}; narrow pattern or path for more.]`,
            );
          }
        }
      }
      return boundText(matches.join('\n'));
    },
  };
}

export function createVerifierRegistry(
  policy: VerifierPathPolicy = createVerifierPathPolicy(),
): ToolRegistry {
  return createRegistry([createReadFileTool(policy), createGrepTool(policy)]);
}

/** Execute inspection calls sequentially and without any write/offload
 * path. The same exact registry supplies both the API prefix and execution. */
export async function executeVerifierToolUses(
  registry: ToolRegistry,
  toolUses: readonly ToolUseBlock[],
  ctx: ToolCtx,
  policy: VerifierPathPolicy = createVerifierPathPolicy(),
): Promise<ToolResultBlock[]> {
  const results: ToolResultBlock[] = [];
  for (const block of toolUses) {
    throwIfAborted(ctx.abortSignal);
    if (block.name === 'read_file') {
      const parsed = verifierReadFileInputSchema.safeParse(block.input);
      if (parsed.success) {
        const mediaType = imageMediaType(parsed.data.file_path);
        if (mediaType !== undefined) {
          results.push(
            await readImageResult(
              block.id,
              ctx.runDir,
              parsed.data.file_path,
              mediaType,
              policy,
              ctx.abortSignal,
            ),
          );
          continue;
        }
      }
    }
    const result = await executeToolCall(
      registry,
      { id: block.id, name: block.name, input: block.input },
      ctx,
    );
    results.push(toResultBlock(result));
  }
  return results;
}

async function readImageResult(
  toolUseId: string,
  runDir: string,
  givenPath: string,
  mediaType: ImageBlock['source']['media_type'],
  policy: VerifierPathPolicy,
  signal?: AbortSignal,
): Promise<ToolResultBlock> {
  try {
    const target = resolveSurfacedFile(runDir, givenPath, policy);
    const bytes = await readRegularFileNoFollow(
      target.absolutePath,
      givenPath,
      VERIFIER_MAX_IMAGE_BYTES + 1,
      signal,
    );
    return verifierImageResultFromBytes(toolUseId, target.relativePath, mediaType, bytes);
  } catch (error) {
    if (isAbortError(error)) throw error;
    return {
      type: 'tool_result',
      tool_use_id: toolUseId,
      content: `Tool "read_file" failed: ${errorMessage(error)}`,
      is_error: true,
    };
  }
}

/** Build an API-safe image result from bytes already read through the
 * verifier's confinement and no-follow boundary. */
function verifierImageResultFromBytes(
  toolUseId: string,
  relativePath: string,
  mediaType: ImageBlock['source']['media_type'],
  bytes: Buffer,
): ToolResultBlock {
  if (bytes.byteLength > VERIFIER_MAX_IMAGE_BYTES) {
    return {
      type: 'tool_result',
      tool_use_id: toolUseId,
      content:
        `Image too large to view: ${relativePath} is ${bytes.byteLength} bytes ` +
        `(limit ${VERIFIER_MAX_IMAGE_BYTES}). Treat whatever it would have proven as ` +
        'unverified unless another published artifact proves it.',
      is_error: true,
    };
  }

  const dimensions = imageDimensions(bytes, mediaType);
  if (dimensions === undefined) {
    return {
      type: 'tool_result',
      tool_use_id: toolUseId,
      content:
        `Not a readable ${mediaType} image: ${relativePath}. Treat whatever it would ` +
        'have proven as unverified unless another published artifact proves it.',
      is_error: true,
    };
  }
  if (
    dimensions.width > VERIFIER_MAX_IMAGE_DIMENSION_PX ||
    dimensions.height > VERIFIER_MAX_IMAGE_DIMENSION_PX
  ) {
    return {
      type: 'tool_result',
      tool_use_id: toolUseId,
      content:
        `Image too large to view: ${relativePath} is ${dimensions.width}x${dimensions.height} ` +
        `pixels (limit ${VERIFIER_MAX_IMAGE_DIMENSION_PX} per dimension). Treat whatever it ` +
        'would have proven as unverified unless another published artifact proves it.',
      is_error: true,
    };
  }

  return {
    type: 'tool_result',
    tool_use_id: toolUseId,
    content: [
      {
        type: 'text',
        text: `${relativePath} (${mediaType}, ${bytes.byteLength} bytes):`,
      },
      {
        type: 'image',
        source: {
          type: 'base64',
          media_type: mediaType,
          data: bytes.toString('base64'),
        },
      },
    ],
  };
}

const PNG_SIGNATURE = Buffer.from('89504e470d0a1a0a', 'hex');

/** Read bounded PNG/JPEG dimensions without an image-processing dependency. */
function imageDimensions(
  bytes: Buffer,
  mediaType: ImageBlock['source']['media_type'],
): { width: number; height: number } | undefined {
  return mediaType === 'image/png' ? pngDimensions(bytes) : jpegDimensions(bytes);
}

function pngDimensions(bytes: Buffer): { width: number; height: number } | undefined {
  if (
    bytes.length < 24 ||
    !bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE) ||
    bytes.toString('latin1', 12, 16) !== 'IHDR'
  ) {
    return undefined;
  }
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

function jpegDimensions(bytes: Buffer): { width: number; height: number } | undefined {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) {
    return undefined;
  }
  let offset = 2;
  while (offset + 9 <= bytes.length) {
    if (bytes[offset] !== 0xff) return undefined;
    const marker = bytes[offset + 1]!;
    if (marker >= 0xd0 && marker <= 0xd8) {
      offset += 2;
      continue;
    }
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return {
        height: bytes.readUInt16BE(offset + 5),
        width: bytes.readUInt16BE(offset + 7),
      };
    }
    offset += 2 + bytes.readUInt16BE(offset + 2);
  }
  return undefined;
}

interface PublishedPath {
  absolutePath: string;
  relativePath: string;
}

function resolveSurfacedFile(
  runDir: string,
  givenPath: string,
  policy: VerifierPathPolicy,
): PublishedPath {
  const absolutePath = resolveRunPath(runDir, givenPath);
  const root = resolve(runDir);
  const relativePath = relative(root, absolutePath).split(sep).join('/');
  if (!policy.allowedArtifactPaths.has(relativePath)) {
    throw new Error(
      `outside verifier scope: ${JSON.stringify(givenPath)}; only surfaced requested-output and evidence files are readable`,
    );
  }
  assertNoSymlinkComponents(root, absolutePath, givenPath);
  return { absolutePath, relativePath };
}

function assertNoSymlinkComponents(root: string, absolutePath: string, givenPath: string): void {
  let cursor = root;
  for (const segment of relative(root, absolutePath).split(sep).filter(Boolean)) {
    cursor = join(cursor, segment);
    let stat;
    try {
      stat = lstatSync(cursor);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    if (stat.isSymbolicLink()) {
      throw new Error(`refusing symbolic-link path ${JSON.stringify(givenPath)}`);
    }
  }
}

function collectSurfacedFiles(
  runDir: string,
  givenPath: string,
  policy: VerifierPathPolicy,
  maximum: number,
): PublishedPath[] {
  const root = resolve(runDir);
  const requested = relative(root, resolveRunPath(runDir, givenPath)).split(sep).join('/');
  const prefix = requested === ARTIFACTS_DIR ? `${ARTIFACTS_DIR}/` : `${requested}/`;
  const matching = [...policy.allowedArtifactPaths]
    .filter((path) => path === requested || path.startsWith(prefix))
    .sort();
  if (matching.length === 0) {
    throw new Error(
      `outside verifier scope: ${JSON.stringify(givenPath)}; no surfaced files are available at that path`,
    );
  }
  if (matching.length > maximum) {
    throw new Error(`grep inspection exceeds ${maximum} files; narrow path`);
  }
  return matching.map((relativePath) => {
    const absolutePath = resolveRunPath(runDir, relativePath);
    assertNoSymlinkComponents(root, absolutePath, relativePath);
    return { absolutePath, relativePath };
  });
}

function normalizeAllowedArtifactPath(givenPath: string): string {
  if (
    !givenPath.startsWith(`${ARTIFACTS_DIR}/`) ||
    givenPath.includes('\\') ||
    givenPath.split('/').some((part) => part === '' || part === '.' || part === '..')
  ) {
    throw new Error(`invalid surfaced artifact path ${JSON.stringify(givenPath)}`);
  }
  return givenPath;
}

async function readRegularFileNoFollow(
  absolutePath: string,
  givenPath: string,
  maximumBytes: number,
  signal?: AbortSignal,
): Promise<Buffer> {
  throwIfAborted(signal);
  const flags =
    fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0);
  const fd = openSync(absolutePath, flags);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new Error(`${givenPath} is not a regular file`);
    if (stat.size > maximumBytes) {
      throw new Error(
        `${givenPath} is ${stat.size} bytes, above the ${maximumBytes}-byte verifier limit`,
      );
    }
    const chunks: Buffer[] = [];
    let total = 0;
    for (;;) {
      throwIfAborted(signal);
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, maximumBytes - total + 1));
      const count = readSync(fd, chunk, 0, chunk.length, null);
      if (count === 0) break;
      total += count;
      if (total > maximumBytes) {
        throw new Error(`${givenPath} grew above the ${maximumBytes}-byte verifier limit`);
      }
      chunks.push(chunk.subarray(0, count));
      if (total % (1024 * 1024) < chunk.length) await yieldToEventLoop();
    }
    throwIfAborted(signal);
    return Buffer.concat(chunks, total);
  } finally {
    closeSync(fd);
  }
}

function decodeText(bytes: Buffer, filename: string): string {
  const text = tryDecodeText(bytes, filename);
  if (text === undefined) {
    throw new Error(
      `${filename} is not bounded UTF-8 text; inspect it as its published binary type`,
    );
  }
  return text;
}

function tryDecodeText(bytes: Buffer, filename: string): string | undefined {
  const format = detectContentFormat({ bytes, filename });
  if (format === 'pdf' || format === 'spreadsheet' || format === 'image') {
    return undefined;
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

function boundText(content: string, suffix = ''): string {
  if (Buffer.byteLength(content + suffix, 'utf8') <= VERIFIER_MAX_RESULT_BYTES) {
    return content + suffix;
  }
  const marker =
    '\n[Result truncated in memory without writing run state; narrow path, pattern, offset, or limit.]';
  const budget = VERIFIER_MAX_RESULT_BYTES - Buffer.byteLength(marker, 'utf8');
  let low = 0;
  let high = content.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(content.slice(0, middle), 'utf8') <= budget) low = middle;
    else high = middle - 1;
  }
  return content.slice(0, low) + marker;
}

function imageMediaType(filePath: string): ImageBlock['source']['media_type'] | undefined {
  switch (extname(filePath).toLowerCase()) {
    case '.png':
      return 'image/png';
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    default:
      return undefined;
  }
}

function toResultBlock(result: ToolCallResult): ToolResultBlock {
  return {
    type: 'tool_result',
    tool_use_id: result.toolCallId,
    content: result.content,
    ...(result.isError ? { is_error: true } : {}),
  };
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  signal?.throwIfAborted();
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolveYield) => setImmediate(resolveYield));
}
