import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, relative, resolve, sep } from 'node:path';

import type { SettledFact } from '../completion/completionCheck.js';
import { EVIDENCE_DIR } from '../evidence/evidenceStore.js';
import type { ImageBlock, ToolResultBlock, ToolUseBlock } from '../loop/messages.js';
import { ARTIFACTS_DIR, MANIFEST_FILENAME } from '../run/artifacts.js';
import { resolveRunPath } from '../run/runDir.js';
import { grepTool } from '../tools/grep/grep.js';
import { executeToolCall, type ToolCallResult } from '../tools/pipeline.js';
import { readFileTool } from '../tools/readFile/readFile.js';
import { createRegistry, type ToolCtx, type ToolDef, type ToolRegistry } from '../tools/registry.js';
import { CONTRACT_FILENAME, INTENT_FILENAME } from './initializer.js';

// The verifier's read-only inspection surface: its tool registry, its
// evidence-scope guard, its screenshot-as-image handling, and the assembly
// of its opening message. Control flow (the report_verification mini-loop)
// lives in verifier.ts; this module owns the I/O the verifier is allowed to
// perform — and, by omission, everything it is not: no browser, no writes,
// no working notes, no worker transcript. The one scratch/ subtree it may
// read is the evidence ledger; evidenceScopeError explains why.

/** Size cap for a verifier-viewed image, in raw file bytes. The API rejects
 * images over ~5MB of encoded data; 3.75MB of raw bytes is 5MB once
 * base64-encoded (4/3 inflation), so every accepted image stays inside the
 * API limit without any downscaling dependency. */
export const VERIFIER_MAX_IMAGE_BYTES = 3_750_000;

/** Per-dimension pixel ceiling for a verifier-viewed image — the API
 * rejects any image with a dimension over 8000px, and a byte cap alone does
 * not catch this: full-page screenshots are far taller than 8000px yet
 * compress well under the byte cap (measured live 2026-08-13: every
 * merged_prs validation trial 400-failed on the judge's first
 * screenshot-carrying request). Dimensions are read from the file header
 * (PNG IHDR / JPEG SOF) — no image-processing dependency. */
export const VERIFIER_MAX_IMAGE_DIMENSION_PX = 8000;

/**
 * Build the verifier's tool registry: read_file and grep only, in that
 * order — no browser, no write tools, nothing state-changing. The
 * report_verification result tool is deliberately NOT here: it never
 * executes through the pipeline; verifier.ts intercepts and validates it.
 */
export function createVerifierRegistry(): ToolRegistry {
  return createRegistry([readFileTool as ToolDef, grepTool as ToolDef]);
}

/**
 * Assemble the verifier's opening user message: the original task, the
 * contract, the manifest's raw content, and the artifacts/ listing —
 * everything the evidence diet promises up front, so tool calls can go
 * straight to specific files instead of discovering what exists.
 *
 * The contract arrives in one of two forms. When the run has a typed
 * `OutputContract` (T4), the latest revision AND the full revision history
 * are supplied: the verifier needs the history to tell evidence-driven
 * strengthening from drift that quietly weakened an original requirement,
 * which is a judgment only it can make. Otherwise the compatibility path
 * reads the prose INTENT.md/CONTRACT.md pair.
 *
 * The original task is always included, whichever form the contract takes —
 * checking task ↔ contract is what stops a mis-stated contract from
 * validating its own mistake.
 *
 * Code-settled facts are included when the caller has them (see
 * {@link SettledFact}). They are stated as facts, not hints: the verifier
 * must not re-derive a count that code already established from the same
 * bytes, because doing so can only introduce error — measured live, it cost
 * two correction cycles on a file that was correct.
 *
 * @param contracts - the run's contract history, when the run has one
 * @param settled - what the code checks positively established
 * @throws if no typed contract is supplied and INTENT.md or CONTRACT.md is
 *   missing — a run reaching the verifier with neither is a harness bug and
 *   must fail loudly
 */
export function buildVerificationInput(
  runDir: string,
  taskText: string,
  contracts?: { current: unknown; history: readonly unknown[] },
  settled: readonly SettledFact[] = [],
): string {
  const manifestRaw = readFileSync(join(runDir, MANIFEST_FILENAME), 'utf8');
  const artifactListing = listArtifactFiles(runDir);
  const artifactsSection =
    artifactListing.length > 0 ? artifactListing.join('\n') : '(no files published)';

  const contractSections =
    contracts === undefined
      ? [
          `# Intent (${INTENT_FILENAME})`,
          readRequiredRunDirFile(runDir, INTENT_FILENAME),
          '',
          `# Contract (${CONTRACT_FILENAME})`,
          readRequiredRunDirFile(runDir, CONTRACT_FILENAME),
        ]
      : [
          '# Output contract (current revision)',
          JSON.stringify(contracts.current, null, 2),
          '',
          '# Contract revision history',
          // Every revision in order, each with the basis its author gave.
          // A later revision that weakened an original explicit requirement
          // is visible here and nowhere else.
          contracts.history.length <= 1
            ? '(single revision — the contract was never changed)'
            : JSON.stringify(contracts.history, null, 2),
        ];

  return [
    '# Task',
    taskText,
    '',
    ...contractSections,
    '',
    `# Manifest (${MANIFEST_FILENAME})`,
    manifestRaw,
    '',
    `# Artifacts (${ARTIFACTS_DIR}/)`,
    artifactsSection,
    ...(settled.length === 0
      ? []
      : [
          '',
          '# Already established by code (do not re-derive or contradict)',
          'These were computed from the published bytes by the same checks that',
          'gate submission. They are settled. Spend your attention on what code',
          'cannot decide.',
          ...settled.map(
            (fact) =>
              `- ${fact.outputId === undefined ? '' : `${fact.outputId}: `}${fact.statement}`,
          ),
        ]),
  ].join('\n');
}

/**
 * Execute one turn's inspection tool_use blocks and convert the results to
 * tool_result blocks, in request order. Both allowed tools are read-only
 * and a call naming anything else is rejected by `executeToolCall` itself
 * (the registry's unknown_tool error), so `Promise.all` order preservation
 * is all the scheduling needed.
 */
export async function executeVerifierToolUses(
  registry: ToolRegistry,
  toolUses: readonly ToolUseBlock[],
  ctx: ToolCtx,
): Promise<ToolResultBlock[]> {
  return Promise.all(toolUses.map((block) => executeVerifierToolUse(registry, block, ctx)));
}

/**
 * Execute one verifier tool call: apply the evidence-scope guard (the
 * verifier grades only surfaced evidence), then delegate to the standard
 * pipeline. A call targeting a path outside the published-evidence scope
 * returns a steering error naming the boundary without executing anything.
 * Two adjustments: a grep with no path is redirected from the tool's own
 * default (the entire run directory — wider than the verifier may see) to
 * artifacts/, and a read_file whose in-scope target is an image is answered
 * with the image itself as a tool_result image block (published screenshots
 * are surfaced evidence, and the verifier's model has vision) instead of
 * being read as UTF-8 garbage by the text tool.
 */
async function executeVerifierToolUse(
  registry: ToolRegistry,
  block: ToolUseBlock,
  ctx: ToolCtx,
): Promise<ToolResultBlock> {
  const relPath = requestedPath(block);
  if (relPath !== undefined) {
    const scopeError = evidenceScopeError(ctx.runDir, relPath);
    if (scopeError !== null) {
      return { type: 'tool_result', tool_use_id: block.id, content: scopeError, is_error: true };
    }
    if (block.name === 'read_file') {
      const mediaType = IMAGE_MEDIA_TYPES[extname(relPath).toLowerCase()];
      if (mediaType !== undefined) {
        return readImageToolResult(block.id, ctx.runDir, relPath, mediaType);
      }
    }
  }
  const result = await executeToolCall(
    registry,
    { id: block.id, name: block.name, input: scopeGrepInput(block) },
    ctx,
  );
  return toResultBlock(result);
}

/** The image types the verifier can view, by lower-cased file extension —
 * exactly the formats the worker's screenshot tooling publishes. */
const IMAGE_MEDIA_TYPES: Record<string, ImageBlock['source']['media_type'] | undefined> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
};

/**
 * Answer a verifier read_file targeting a published image: the tool_result
 * carries a short text label plus the image as a base64 block. Bypasses the
 * text pipeline entirely — read_file would decode the bytes as UTF-8
 * garbage and capResult would offload them — with read_file's own error
 * wording for the two expected failures (missing file, directory) and a
 * steering error for an over-cap image (the verifier is told to treat
 * whatever it would have proven as unverified rather than to assume it).
 * Any offset/limit in the input is deliberately ignored: an image has no
 * lines to window.
 */
function readImageToolResult(
  toolUseId: string,
  runDir: string,
  relPath: string,
  mediaType: ImageBlock['source']['media_type'],
): ToolResultBlock {
  let bytes: Buffer;
  try {
    bytes = readFileSync(resolveRunPath(runDir, relPath));
  } catch (thrown) {
    const code = (thrown as NodeJS.ErrnoException).code;
    const message =
      code === 'ENOENT'
        ? `File does not exist: ${relPath}`
        : code === 'EISDIR'
          ? `Path is a directory, not a file: ${relPath}`
          : thrown instanceof Error
            ? thrown.message
            : String(thrown);
    return {
      type: 'tool_result',
      tool_use_id: toolUseId,
      content: `Tool "read_file" failed: ${message}`,
      is_error: true,
    };
  }
  if (bytes.byteLength > VERIFIER_MAX_IMAGE_BYTES) {
    return {
      type: 'tool_result',
      tool_use_id: toolUseId,
      content:
        `Image too large to view: ${relPath} is ${bytes.byteLength} bytes ` +
        `(limit ${VERIFIER_MAX_IMAGE_BYTES}). Treat whatever it would have proven as ` +
        'unverified unless another published artifact proves it.',
      is_error: true,
    };
  }
  const dimensions = imageDimensions(bytes, mediaType);
  if (dimensions === undefined) {
    // Unparseable header: the bytes are not a valid image of the type the
    // extension claims. Refusing here keeps known-bad data out of the API
    // request — one invalid image block 400-fails the verifier's turn.
    return {
      type: 'tool_result',
      tool_use_id: toolUseId,
      content:
        `Not a readable ${mediaType} image: ${relPath}. Treat whatever it would ` +
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
        `Image too large to view: ${relPath} is ${dimensions.width}x${dimensions.height} ` +
        `pixels (limit ${VERIFIER_MAX_IMAGE_DIMENSION_PX} per dimension). Treat whatever it ` +
        'would have proven as unverified unless another published artifact proves it.',
      is_error: true,
    };
  }
  return {
    type: 'tool_result',
    tool_use_id: toolUseId,
    content: [
      { type: 'text', text: `${relPath} (${mediaType}, ${bytes.byteLength} bytes):` },
      { type: 'image', source: { type: 'base64', media_type: mediaType, data: bytes.toString('base64') } },
    ],
  };
}

/** The 8-byte signature every PNG file opens with. */
const PNG_SIGNATURE = Buffer.from('89504e470d0a1a0a', 'hex');

/**
 * Read an image's pixel dimensions from its file header — a tiny fixed
 * parser instead of an image-processing dependency, since only the two
 * numbers the API's dimension limit is checked against are needed.
 *
 * @returns the dimensions, or undefined when the bytes do not parse as the
 *   claimed type (wrong signature, no SOF marker, truncated header)
 */
function imageDimensions(
  bytes: Buffer,
  mediaType: ImageBlock['source']['media_type'],
): { width: number; height: number } | undefined {
  return mediaType === 'image/png' ? pngDimensions(bytes) : jpegDimensions(bytes);
}

/** PNG dimensions: the IHDR chunk is required to be first, so width and
 * height sit at fixed offsets 16 and 20 (big-endian) after the 8-byte
 * signature and the chunk's own length/type fields. */
function pngDimensions(bytes: Buffer): { width: number; height: number } | undefined {
  if (bytes.length < 24 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE)) return undefined;
  if (bytes.toString('latin1', 12, 16) !== 'IHDR') return undefined;
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

/** JPEG dimensions: walk the marker segments from SOI until a
 * start-of-frame marker (0xC0–0xCF, excluding the non-frame 0xC4/0xC8/0xCC),
 * whose payload carries height then width, both big-endian, after the
 * 2-byte segment length and 1-byte precision. */
function jpegDimensions(bytes: Buffer): { width: number; height: number } | undefined {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return undefined;
  let offset = 2;
  while (offset + 9 <= bytes.length) {
    if (bytes[offset] !== 0xff) return undefined;
    const marker = bytes[offset + 1]!;
    // Standalone markers (RST0–RST7, another SOI) carry no length field.
    if (marker >= 0xd0 && marker <= 0xd8) {
      offset += 2;
      continue;
    }
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: bytes.readUInt16BE(offset + 5), width: bytes.readUInt16BE(offset + 7) };
    }
    offset += 2 + bytes.readUInt16BE(offset + 2);
  }
  return undefined;
}

/**
 * Best-effort extraction of the run-dir-relative path a verifier tool call
 * targets: read_file's `file_path`, grep's optional `path`. Missing or
 * non-string values (and unknown tool names) return undefined — the
 * pipeline's zod validation reports malformed input in full; the scope
 * guard only inspects paths that are actually there to inspect.
 */
function requestedPath(block: ToolUseBlock): string | undefined {
  const input = block.input as Record<string, unknown> | null | undefined;
  const field =
    block.name === 'read_file'
      ? input?.['file_path']
      : block.name === 'grep'
        ? input?.['path']
        : undefined;
  return typeof field === 'string' ? field : undefined;
}

/** The root files inside the verifier's evidence scope. Everything else at
 * the run-dir root (transcript, metrics, harness diagnostics) is
 * bookkeeping, not evidence. */
const ROOT_EVIDENCE_FILES: readonly string[] = [
  INTENT_FILENAME,
  CONTRACT_FILENAME,
  MANIFEST_FILENAME,
];

/**
 * The verifier's evidence-scope check: only surfaced evidence is readable —
 * files under artifacts/ and under scratch/evidence/, plus INTENT.md,
 * CONTRACT.md, and manifest.json at the run-dir root. Anywhere else
 * (the rest of scratch/, the transcript, metrics) is off-diet: graders never
 * see unpublished working files, so a verdict built on them would be a false
 * calibration; the boundary also keeps backpressure on the worker to publish
 * its proof, and keeps worker claims in scratch notes from self-confirming
 * as evidence.
 *
 * Why `scratch/evidence/` is inside the scope even though it is under
 * scratch/. The T6 ledger is where cited provenance lives: a typed row or a
 * document footnote cites `E3`, and the only record of what `E3` captured is
 * `scratch/evidence/E3.json`. Excluding it made every evidence-cited row
 * unprovable by construction — the verifier was required to check facts
 * against evidence and forbidden from reading the evidence, which can only
 * end in needs_correction. These records are also not the thing the boundary
 * exists to exclude: each one is written by the capture tool rather than
 * typed by the model, carries the source URL and timestamp of the capture,
 * and is hashed into the manifest, so it is provenance in the same sense a
 * published screenshot is. Model prose in the rest of scratch/ stays out.
 *
 * @returns null when `relPath` resolves inside the scope; the steering-error
 *   text to send back otherwise. A path that fails resolveRunPath's own
 *   confinement (absolute, or escaping the run dir) also returns null: the
 *   tool itself rejects it with the run-dir confinement error, and this
 *   guard adds the narrower boundary rather than re-reporting the wider one.
 */
export function evidenceScopeError(runDir: string, relPath: string): string | null {
  let resolved: string;
  try {
    resolved = resolveRunPath(runDir, relPath);
  } catch {
    return null;
  }
  const root = resolve(runDir);
  const inSubtree = (dir: string): boolean => {
    const dirRoot = join(root, dir);
    return resolved === dirRoot || resolved.startsWith(dirRoot + sep);
  };
  const isRootEvidenceFile = ROOT_EVIDENCE_FILES.some((name) => resolved === join(root, name));
  if (inSubtree(ARTIFACTS_DIR) || inSubtree(EVIDENCE_DIR) || isRootEvidenceFile) return null;
  return (
    `Outside the verifier's evidence scope: ${JSON.stringify(relPath)}. You may read only ` +
    `published evidence and recorded provenance: files under ${ARTIFACTS_DIR}/ and ` +
    `${EVIDENCE_DIR}/, plus ${INTENT_FILENAME}, ${CONTRACT_FILENAME}, and ` +
    `${MANIFEST_FILENAME} at the run-directory root. Other unpublished working files ` +
    'are not evidence — a claim proven only there is unproven.'
  );
}

/**
 * The verifier's grep input: a grep with no `path` is redirected to
 * artifacts/. The tool's own default scope is the entire run directory —
 * wider than the evidence scope — and an unscoped verifier grep means
 * "search all published evidence", which artifacts/ is. INTENT.md,
 * CONTRACT.md, and the manifest arrive in full in the opening message, so
 * excluding them from the default costs nothing, and an explicit path to
 * any of them still works. Non-object input, or input already carrying a
 * `path` key (string or not), passes through unchanged for the pipeline's
 * zod validation to judge.
 */
function scopeGrepInput(block: ToolUseBlock): unknown {
  if (block.name !== 'grep') return block.input;
  const input = block.input;
  if (typeof input !== 'object' || input === null || 'path' in input) return input;
  return { ...input, path: ARTIFACTS_DIR };
}

/** Convert one pipeline result into the API-shaped tool_result block the
 * model reads next turn; is_error appears only on failures. */
function toResultBlock(result: ToolCallResult): ToolResultBlock {
  return {
    type: 'tool_result',
    tool_use_id: result.toolCallId,
    content: result.content,
    ...(result.isError ? { is_error: true } : {}),
  };
}

/**
 * Read one required file from the run-dir root.
 *
 * @param filename - a fixed, harness-known filename at the run-dir root
 *   (never model- or worker-supplied, so no path-escape confinement is
 *   needed here)
 * @throws with a message naming the missing file if it does not exist
 */
function readRequiredRunDirFile(runDir: string, filename: string): string {
  try {
    return readFileSync(join(runDir, filename), 'utf8');
  } catch (thrown) {
    if ((thrown as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(
        `${filename} is missing from the run directory (${runDir}) — the harness must write ` +
          'the contract documents before the verifier runs.',
      );
    }
    throw thrown;
  }
}

/**
 * Recursively list every file under `<runDir>/artifacts/`, depth-first in
 * lexicographic order (deterministic listings make verifier behavior
 * reproducible run to run).
 *
 * @returns one line per file, `"<runDir-relative path> (<N> bytes)"`; an
 *   empty array if artifacts/ does not exist or is empty
 */
function listArtifactFiles(runDir: string): string[] {
  const artifactsDir = join(runDir, ARTIFACTS_DIR);
  if (!existsSync(artifactsDir)) return [];
  return collectFilesRecursive(artifactsDir).map((absPath) => {
    const relPath = relative(runDir, absPath);
    const { size } = statSync(absPath);
    return `${relPath} (${size} bytes)`;
  });
}

/** Depth-first, lexicographically-sorted absolute file paths under `absDir`
 * (directories themselves are not included). */
function collectFilesRecursive(absDir: string): string[] {
  const files: string[] = [];
  for (const name of readdirSync(absDir).sort()) {
    const absPath = join(absDir, name);
    if (statSync(absPath).isDirectory()) {
      files.push(...collectFilesRecursive(absPath));
    } else {
      files.push(absPath);
    }
  }
  return files;
}
