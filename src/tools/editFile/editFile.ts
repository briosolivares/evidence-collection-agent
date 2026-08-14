import { lstatSync, readFileSync, type Stats } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { z } from 'zod';

import type { OutputSpec } from '../../contracts/outputContract.js';
import { ARTIFACTS_DIR, readManifest, writeArtifact, type ArtifactMeta } from '../../run/artifacts.js';
import { resolveRunPath } from '../../run/runDir.js';
import type { ToolCtx, ToolDef } from '../registry.js';
import { classifyWorkspacePath } from '../shared/evidence.js';
import { accessKey } from '../registry.js';

/** Refuse to load a file larger than this into memory for an in-place edit.
 * 64 MiB comfortably covers any legitimate scratch or artifact text file this
 * agent produces; anything bigger is almost certainly the wrong target for a
 * surgical string replacement. */
export const EDIT_FILE_MAX_BYTES = 64 * 1024 * 1024;

const editFileInputSchema = z.strictObject({
  file_path: z
    .string()
    .describe('Run-directory-relative path of an existing file under artifacts/ or scratch/ to edit'),
  old_string: z
    .string()
    .describe(
      'Exact text to find, copied verbatim from a prior read_file result. No normalization is ' +
        'performed — line endings, indentation, trailing whitespace, Unicode form, and quote ' +
        'style (straight vs curly) must match the file byte-for-byte. Must be non-empty, and must ' +
        'appear exactly once in the file unless replace_all is set.',
    ),
  new_string: z
    .string()
    .describe('Exact replacement text, inserted verbatim (no special character handling)'),
  replace_all: z
    .boolean()
    .optional()
    .describe(
      'Replace every occurrence of old_string instead of requiring exactly one. Defaults to false.',
    ),
});

type EditFileInput = z.infer<typeof editFileInputSchema>;

/** What the model gets back on success: the file that changed, and how many
 * places changed. The updated content hash already lives in the manifest
 * (readable via read_file or the manifest itself), so it is not repeated
 * here. */
export interface EditFileResult {
  /** Normalized run-directory-relative path that was edited. */
  file_path: string;
  /** Number of occurrences of old_string that were replaced. */
  replacement_count: number;
}

/**
 * `edit_file` — replace an exact, literal substring in an existing file
 * (state-changing).
 *
 * Deliberately narrow, and deliberately NOT fuzzy: this is a precision tool
 * for fixing or extending a file the agent has already read, not a general
 * text editor. It never creates a file (write_file owns creation and
 * anchorless insertion), never guesses at intent, and performs zero
 * normalization — no line-ending conversion, no whitespace trimming or
 * reindenting, no Unicode normalization, no straight/curly quote
 * translation, and no "close enough" fallback to a similar string. The exact
 * `old_string` the model supplies must appear in the file's exact current
 * bytes; if it does not, the model must read the file again and copy the
 * real text, never approximate it. This exactness also serves as a cheap
 * optimistic-concurrency guard: if the file no longer contains what the
 * model believes it read (edited by an earlier call, or never matching in
 * the first place), the edit fails loudly rather than silently applying to
 * the wrong location.
 *
 * A file that is the published output of a `table` or `document` contract
 * output is off-limits here — see `findContractProtectedOutput` below for why.
 *
 * Every check — existence, symlink/directory rejection, the size guard, the
 * contract-bound refusal, the UTF-8 round-trip proof, and the match count —
 * happens before a single byte is written, and the final read, validation,
 * replacement, and `writeArtifact()` call form one synchronous critical
 * section (no `await` anywhere in between). That matters for the same
 * optimistic-concurrency reason: an `await` between reading the file and
 * writing the replacement would open a window for another call to change the
 * file underneath this one, which would then overwrite that change based on
 * stale content.
 */
export const editFileTool: ToolDef<EditFileInput> = {
  name: 'edit_file',
  description:
    'Replace an exact, literal occurrence of old_string with new_string in an existing file ' +
    'under artifacts/ or scratch/. old_string must match the file\'s current bytes exactly — no ' +
    'normalization of line endings, whitespace, Unicode form, or quote style is performed — and ' +
    'must appear exactly once unless replace_all is set. Cannot create a file (use write_file for ' +
    'that) and cannot edit a file that is a contract-bound table or document output (use ' +
    'upsert_output_rows or write_document for those instead).',
  inputSchema: editFileInputSchema,
  readOnly: false,
  // The scheduler derives concurrency from this, not from readOnly: a
  // state-changing call must declare exactly what it touches so it can be
  // serialized against every other call that touches the same file or the
  // manifest.
  getAccess: (input) => ({
    reads: [],
    writes: [accessKey.file(input.file_path), accessKey.manifest()],
  }),
  execute(input, ctx): EditFileResult {
    // Resolve and classify at execution time — a schema check that passed
    // earlier says nothing about whether the file exists, or still exists,
    // right now.
    const area = classifyWorkspacePath(ctx.runDir, input.file_path);
    const absPath = resolveRunPath(ctx.runDir, input.file_path);
    const normalizedPath = relative(resolve(ctx.runDir), absPath);

    const stat = statOrThrow(absPath, input.file_path);
    if (stat.isSymbolicLink()) {
      throw new Error(
        `Cannot edit_file ${JSON.stringify(input.file_path)}: it is a symbolic link. ` +
          `edit_file only edits regular files and will not follow a link to one. Nothing was changed.`,
      );
    }
    if (stat.isDirectory()) {
      throw new Error(
        `Cannot edit_file ${JSON.stringify(input.file_path)}: it is a directory, not a file. ` +
          `Nothing was changed.`,
      );
    }
    if (!stat.isFile()) {
      throw new Error(
        `Cannot edit_file ${JSON.stringify(input.file_path)}: it is not a regular file. ` +
          `Nothing was changed.`,
      );
    }

    // Contract-bound refusal, resolved PER CALL (never cached), so a
    // contract revision accepted a moment ago applies to this very edit. A
    // contract-bound table or document output is rendered by the tool that
    // owns it (upsert_output_rows, write_document) from data or evidence
    // this codebase can check; if edit_file could also touch that same
    // published file, it would become a second, unchecked way to hand-edit a
    // rendered deliverable until it happens to pass the run's own completion
    // checks, defeating the whole point of routing outputs through an
    // owning, validating tool. A run with no output-contract store (the
    // legacy path, fixture tests) has nothing to protect this way.
    const protectedOutput = findContractProtectedOutput(ctx, normalizedPath);
    if (protectedOutput !== undefined) {
      const ownerTool = protectedOutput.kind === 'table' ? 'upsert_output_rows' : 'write_document';
      throw new Error(
        `Cannot edit_file ${JSON.stringify(input.file_path)}: it is the published output of ` +
          `contract-bound ${protectedOutput.kind} output ${JSON.stringify(protectedOutput.id)}. ` +
          `A contract-bound deliverable may only be written by the tool that owns it — use ` +
          `${ownerTool} instead of edit_file. Nothing was changed.`,
      );
    }

    // Size guard before allocating anything: check the stat already in hand,
    // never read the file first to find out it was too big.
    assertEditableSize(stat.size, input.file_path);

    const bytes = readFileSync(absPath);
    const text = decodeUtf8RoundTrip(bytes, input.file_path);

    if (input.old_string === '') {
      throw new Error(
        `edit_file requires a non-empty old_string to anchor the replacement in ` +
          `${JSON.stringify(input.file_path)}. To create a file, or to insert text with no ` +
          `existing anchor, use write_file instead. Nothing was changed.`,
      );
    }
    if (input.old_string === input.new_string) {
      throw new Error(
        `old_string and new_string are identical for ${JSON.stringify(input.file_path)}: this ` +
          `edit would be a no-op. Nothing was changed.`,
      );
    }

    // Literal, non-overlapping occurrence counting and replacement in one
    // step: splitting on a STRING separator (never a RegExp) is a plain
    // left-to-right scan with no special-character handling, so old_string
    // is matched exactly as written and new_string is inserted exactly as
    // written — "$&", "$1", "$'" and similar text carry no meaning here, the
    // way they would with String.prototype.replace.
    const segments = text.split(input.old_string);
    const count = segments.length - 1;

    if (count === 0) {
      throw new Error(
        `old_string was not found in ${JSON.stringify(input.file_path)}. No normalization is ` +
          `performed — edit_file will not match if the file's line endings, whitespace, ` +
          `indentation, Unicode form, or quote style (straight vs curly) differ from old_string ` +
          `even slightly. Read the file again and copy old_string exactly. Nothing was changed.`,
      );
    }
    if (input.replace_all !== true && count > 1) {
      throw new Error(
        `old_string matches ${count} locations in ${JSON.stringify(input.file_path)}, but ` +
          `edit_file requires exactly one match unless replace_all is set. Add more surrounding ` +
          `context to old_string to make it unique, or pass replace_all: true to replace every ` +
          `occurrence. Nothing was changed.`,
      );
    }

    const updated = Buffer.from(segments.join(input.new_string), 'utf8');

    // Everything from here down — resolving the write's metadata and
    // persisting it — is synchronous and must stay that way: no await may
    // appear between the read above and this write, or a concurrent call
    // could change the file in the gap and this write would silently
    // clobber it based on content that is no longer current.
    const meta = resolveEditMeta(ctx.runDir, area, normalizedPath, input.file_path);
    const entry = writeArtifact(ctx.runDir, normalizedPath, updated, meta);

    return { file_path: entry.filename, replacement_count: count };
  },
};

/** `lstatSync`, converting the one expected failure (missing path) into a
 * model-readable error naming the path; anything else propagates unchanged.
 * Uses `lstat` rather than `stat` so a symlink is reported as itself even
 * when it points at a real file — edit_file must refuse the link, not
 * transparently edit whatever it resolves to. */
function statOrThrow(absPath: string, givenPath: string): Stats {
  try {
    return lstatSync(absPath);
  } catch (thrown) {
    const code = (thrown as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      throw new Error(
        `Cannot edit_file ${JSON.stringify(givenPath)}: file does not exist. edit_file only ` +
          `modifies an existing file — use write_file to create one. Nothing was changed.`,
      );
    }
    throw thrown;
  }
}

/** Find the contract output (if any) whose published path is exactly the
 * file being edited. Only `table` and `document` outputs name a `filename`
 * that lands under `artifacts/`; `screenshots` and `download` outputs
 * describe a set of captures, not one file this tool could collide with.
 * Resolved fresh on every call — never memoized — so a contract revision
 * accepted between two edit_file calls changes the answer immediately. */
function findContractProtectedOutput(
  ctx: ToolCtx,
  normalizedPath: string,
): Extract<OutputSpec, { kind: 'table' | 'document' }> | undefined {
  const contract = ctx.outputContracts?.currentContract();
  if (contract === undefined) return undefined;
  return contract.outputs.find(
    (output): output is Extract<OutputSpec, { kind: 'table' | 'document' }> =>
      (output.kind === 'table' || output.kind === 'document') &&
      normalizedPath === join(ARTIFACTS_DIR, output.filename),
  );
}

/** Guard against loading an oversized file into memory. Takes the size alone
 * (not a `Stats` or an `fs` dependency) so tests can exercise the boundary
 * with a fabricated number instead of a real 64 MiB fixture file. */
export function assertEditableSize(sizeBytes: number, filePath: string): void {
  if (sizeBytes > EDIT_FILE_MAX_BYTES) {
    throw new Error(
      `Cannot edit_file ${JSON.stringify(filePath)}: it is ${sizeBytes} bytes, over the ` +
        `${EDIT_FILE_MAX_BYTES}-byte (64 MiB) edit_file limit. Nothing was changed.`,
    );
  }
}

/**
 * Decode bytes as UTF-8 and prove the decoding is lossless before trusting
 * it: re-encode the decoded string and require the result to reproduce the
 * original bytes exactly. `fatal: true` already rejects structurally invalid
 * UTF-8; the round-trip additionally catches anything fatal mode alone would
 * let through un-flagged, so a file this tool cannot represent losslessly is
 * refused outright instead of being silently corrupted by a lossy edit.
 * `ignoreBOM: true` decodes a leading UTF-8 BOM (EF BB BF) as the literal
 * U+FEFF character rather than stripping it, so the round-trip — and any
 * match against old_string — sees the BOM as real content, exactly as it
 * exists on disk.
 */
function decodeUtf8RoundTrip(bytes: Buffer, filePath: string): string {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new Error(
      `Cannot edit_file ${JSON.stringify(filePath)}: the file is not valid UTF-8 text. ` +
        `edit_file only supports UTF-8 files. Nothing was changed.`,
    );
  }
  const reencoded = Buffer.from(new TextEncoder().encode(text));
  if (!reencoded.equals(bytes)) {
    throw new Error(
      `Cannot edit_file ${JSON.stringify(filePath)}: decoding the file as UTF-8 did not ` +
        `reproduce its exact bytes (an unsupported or corrupted encoding). Nothing was changed.`,
    );
  }
  return text;
}

/** Resolve the `ArtifactMeta` the edited bytes are written with: no roles for
 * a private scratch file, or the existing published entry's roles — with
 * `sourceUrl` and `completionStatus` deliberately dropped — for an artifact.
 * Edited bytes are no longer an exact capture (dropping `sourceUrl`), and
 * must pass completion again from scratch (dropping `completionStatus`,
 * which this codebase otherwise carries forward unless explicitly cleared).
 */
function resolveEditMeta(
  runDir: string,
  area: 'artifacts' | 'scratch',
  normalizedPath: string,
  givenPath: string,
): ArtifactMeta {
  if (area === 'scratch') return {};

  const manifest = readManifest(runDir);
  const existing = manifest.artifacts.find((entry) => entry.filename === normalizedPath);
  if (existing === undefined) {
    throw new Error(
      `Cannot edit_file ${JSON.stringify(givenPath)}: it has no manifest entry, so its roles ` +
        `cannot be preserved. edit_file can only edit a published artifact that a manifest-` +
        `recording tool (e.g. write_file) already wrote. Nothing was changed.`,
    );
  }
  return { roles: existing.roles };
}
