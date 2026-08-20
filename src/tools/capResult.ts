import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';

import { SCRATCH_DIR, writeArtifact } from '../run/artifacts.js';
import { resolveRunPath } from '../run/runDir.js';

/**
 * Default maximum size in bytes of a tool result before it is offloaded to
 * disk. Mirrors Claude Code's per-tool persistence threshold
 * (DEFAULT_MAX_RESULT_SIZE_CHARS = 50,000): roughly 12k tokens — large
 * enough that ordinary results are untouched, small enough that one result
 * can never flood the context window.
 */
export const DEFAULT_MAX_RESULT_BYTES = 50_000;

/**
 * Maximum size in bytes of the preview an offloaded result leaves behind.
 * Mirrors Claude Code's PREVIEW_SIZE_BYTES = 2,000: enough to show the
 * model what kind of output it is, cheap enough to keep in context.
 */
export const PREVIEW_MAX_BYTES = 2_000;

/**
 * Maximum combined size in bytes of one message's tool results — the batch
 * cap the loop enforces on top of the per-result cap. 4× the per-result
 * default, mirroring Claude Code's MAX_TOOL_RESULTS_PER_MESSAGE_CHARS
 * ratio; without it, 5 parallel reads × 50k bytes can land ~250k bytes
 * (~60k tokens) in a single user message with every result individually
 * legal. Deliberately bytes, not chars, like DEFAULT_MAX_RESULT_BYTES
 * above: bytes are the stricter token proxy (Claude Code itself estimates
 * at 4 bytes/token) and match the offload file mechanics — do not "fix"
 * this to chars. Messages are evaluated independently: 150k this turn and
 * 150k next turn are both untouched.
 */
export const MAX_TOOL_RESULTS_PER_MESSAGE_BYTES = 200_000;

/** Run-dir subdirectory that holds offloaded tool output — private agent
 * working state, so it lives under scratch/. */
export const OFFLOAD_DIR = `${SCRATCH_DIR}/tool-output`;

/** File extension for offloaded tool output (always model-readable text). */
const OFFLOAD_EXT = '.txt';

/**
 * The model-facing replacement for an oversize tool result: a short preview
 * of the original output plus the run-dir-relative path holding all of it.
 */
export interface OffloadedResult {
  /** The opening portion of the original output — at most
   * min(PREVIEW_MAX_BYTES, the cap) bytes, always whole UTF-8 characters. */
  preview: string;
  /** Run-dir-relative path of the file holding the complete output, usable
   * directly with read_file. */
  offloadedTo: string;
  /** Human/model-readable explanation: the output's size, the cap it broke,
   * and how to read the rest. */
  note: string;
}

/**
 * Bound a tool result's size (pipeline stage 5). Results at or under the cap
 * pass through untouched; oversize results are written — complete — to a
 * numbered file under scratch/tool-output/ in the run directory (via
 * writeArtifact, so the manifest records its hash) and replaced by a
 * preview + path the model can follow up on with read_file.
 *
 * @param runDir - absolute path to a run directory whose manifest has been
 *   initialized (offloading throws otherwise, writing nothing)
 * @param toolName - name of the tool that produced the result; must be a
 *   registry-style name safe as a filename segment (no path separators)
 * @param result - the tool's normalized model-facing output text
 * @param maxBytes - the cap: a positive integer number of UTF-8 bytes
 *   (throws otherwise)
 * @returns `result` itself, unchanged, when its UTF-8 byte length is at or
 *   under `maxBytes`. Otherwise an OffloadedResult whose `offloadedTo` file
 *   exists inside the run directory containing the complete original output
 *   (hashed into the manifest), and whose preview is a prefix of the
 *   original that never splits a multi-byte character and, when the output
 *   is line-shaped, ends on a whole line. Each offload gets a fresh file:
 *   scratch/tool-output/<toolName>-<n>.txt, where n counts up from one past the
 *   highest number already on disk for that tool and the file is claimed
 *   with an exclusive create — so concurrent offloads (parallel read-only
 *   tools, T8) can never clobber each other
 */
export function capResult(
  runDir: string,
  toolName: string,
  result: string,
  maxBytes: number,
): string | OffloadedResult {
  if (!Number.isInteger(maxBytes) || maxBytes <= 0) {
    throw new Error(`maxBytes must be a positive integer, got ${maxBytes}`);
  }

  const sizeBytes = Buffer.byteLength(result, 'utf8');
  if (sizeBytes <= maxBytes) return result;

  return offloadResult(
    runDir,
    toolName,
    result,
    `over this tool's ${maxBytes}-byte limit`,
    Math.min(PREVIEW_MAX_BYTES, maxBytes),
  );
}

/**
 * Offload a result unconditionally: write it — complete — to a fresh
 * numbered file under scratch/tool-output/ (via writeArtifact, so the
 * manifest records its hash) and return the preview + path replacement. This is
 * capResult's offload path exposed for callers that decide *themselves*
 * that a result must go to disk — the loop's per-message batch cap
 * (MAX_TOOL_RESULTS_PER_MESSAGE_BYTES), where each result passed its own
 * per-tool cap but the batch's combined size did not.
 *
 * @param runDir - absolute path to a run directory whose manifest has been
 *   initialized (throws otherwise, writing nothing)
 * @param toolName - name of the tool that produced the result; must be a
 *   registry-style name safe as a filename segment (no path separators)
 * @param result - the tool's normalized model-facing output text
 * @param limitDescription - why the result is being offloaded, completing
 *   the sentence "Output was N bytes, …" in the replacement's note
 * @param previewMaxBytes - preview size cap; defaults to PREVIEW_MAX_BYTES
 * @returns an OffloadedResult exactly as capResult would produce for an
 *   oversize result (see capResult's contract for the file-naming and
 *   preview guarantees)
 */
export function offloadResult(
  runDir: string,
  toolName: string,
  result: string,
  limitDescription: string,
  previewMaxBytes: number = PREVIEW_MAX_BYTES,
): OffloadedResult {
  const sizeBytes = Buffer.byteLength(result, 'utf8');
  const { relPath, absPath } = reserveOffloadPath(runDir, toolName);
  try {
    writeArtifact(runDir, relPath, Buffer.from(result, 'utf8'));
  } catch (thrown) {
    // Don't leave the empty reservation behind as an untracked file.
    rmSync(absPath, { force: true });
    throw thrown;
  }

  return {
    preview: buildPreview(result, previewMaxBytes),
    offloadedTo: relPath,
    note:
      `Output was ${sizeBytes} bytes, ${limitDescription}. ` +
      `The complete output is saved at ${relPath} in the run directory — ` +
      `use read_file on that path to read the rest, with offset/limit for windows.`,
  };
}

/**
 * Claim a fresh offload filename for a tool:
 * scratch/tool-output/<toolName>-<n>.txt.
 * Scans the offload directory for the highest existing n, then creates the
 * next file exclusively, advancing past any concurrent claimer. The
 * returned path names a now-existing empty file no other call can receive.
 */
function reserveOffloadPath(
  runDir: string,
  toolName: string,
): { relPath: string; absPath: string } {
  const offloadDirAbs = resolveRunPath(runDir, OFFLOAD_DIR);
  mkdirSync(offloadDirAbs, { recursive: true });

  // First candidate: one past the highest index already on disk for this
  // tool, so a deleted or raced file is never silently reused.
  const prefix = `${toolName}-`;
  let n = 1;
  for (const entry of readdirSync(offloadDirAbs)) {
    if (!entry.startsWith(prefix) || !entry.endsWith(OFFLOAD_EXT)) continue;
    const index = Number(entry.slice(prefix.length, -OFFLOAD_EXT.length));
    if (Number.isInteger(index) && index >= n) n = index + 1;
  }

  for (;;) {
    const relPath = `${OFFLOAD_DIR}/${toolName}-${n}${OFFLOAD_EXT}`;
    const absPath = resolveRunPath(runDir, relPath);
    try {
      // Exclusive create claims the index; EEXIST means a concurrent offload
      // won the race for it, so move on to the next number.
      writeFileSync(absPath, '', { flag: 'wx' });
      return { relPath, absPath };
    } catch (thrown) {
      if ((thrown as NodeJS.ErrnoException).code !== 'EEXIST') throw thrown;
      n += 1;
    }
  }
}

/**
 * Take the opening portion of a text for use as a preview: at most maxBytes
 * of UTF-8, never splitting a multi-byte character, and — following Claude
 * Code's convention — cut back to the last line boundary when a newline
 * falls in the second half of the window, so the preview doesn't end
 * mid-line.
 */
function buildPreview(text: string, maxBytes: number): string {
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.length <= maxBytes) return text;

  // Walk the cut point back off any UTF-8 continuation bytes (0b10xxxxxx)
  // so a character straddling the boundary is dropped whole, never sliced.
  let end = maxBytes;
  while (end > 0 && (bytes[end]! & 0b1100_0000) === 0b1000_0000) end -= 1;
  const hardCut = bytes.subarray(0, end).toString('utf8');

  const lastNewline = hardCut.lastIndexOf('\n');
  return lastNewline > hardCut.length / 2 ? hardCut.slice(0, lastNewline) : hardCut;
}
