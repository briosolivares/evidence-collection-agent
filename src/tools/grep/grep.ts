import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { z } from 'zod';

import { resolveRunPath } from '../../run/runDir.js';
import type { ToolDef } from '../registry.js';
import { splitLines } from '../shared/lines.js';
import { accessKey } from '../registry.js';

const grepInputSchema = z.strictObject({
  pattern: z
    .string()
    .describe(
      'The regular expression pattern to search for in file contents. ' +
        'A plain string without regex metacharacters matches literally.',
    ),
  path: z
    .string()
    .optional()
    .describe(
      'File or directory to search in, relative to the run directory. Defaults to the entire run directory.',
    ),
});

type GrepInput = z.infer<typeof grepInputSchema>;

/**
 * `grep` — search file contents in the run directory (read-only).
 *
 * Tests `pattern` (a JavaScript regular expression; plain strings match
 * literally) against every line of every file under `path` — a run-dir-
 * relative file or directory, defaulting to the whole run directory. Files
 * are read as UTF-8 text and visited in a deterministic depth-first
 * lexicographic order. Returns one line per match, formatted
 * `path:line: match` with the path run-dir-relative and lines 1-based; no
 * matches returns an empty result, never an error. An invalid pattern, an
 * escaping path, or a missing search path throws with a message naming the
 * problem — surfaced to the model as a structured error result by the
 * pipeline.
 */
export const grepTool: ToolDef<GrepInput> = {
  name: 'grep',
  description:
    'Searches file contents in the run directory with a regular expression. ' +
    'Returns matching lines as path:line: match. ' +
    'Optionally restrict the search to a file or directory with path.',
  inputSchema: grepInputSchema,
  getAccess: (input) => ({
    reads: [accessKey.file(input.path ?? '.')],
    writes: [],
  }),
  execute(input, ctx) {
    let regex: RegExp;
    try {
      regex = new RegExp(input.pattern);
    } catch (thrown) {
      const message = thrown instanceof Error ? thrown.message : String(thrown);
      throw new Error(`Invalid regular expression pattern: ${message}`);
    }

    const searchRoot =
      input.path !== undefined ? resolveRunPath(ctx.runDir, input.path) : resolve(ctx.runDir);
    if (!existsSync(searchRoot)) {
      throw new Error(`Search path does not exist: ${input.path ?? '.'}`);
    }

    const matches: string[] = [];
    for (const filePath of collectFiles(searchRoot)) {
      const relPath = relative(resolve(ctx.runDir), filePath);
      splitLines(readFileSync(filePath, 'utf8')).forEach((line, i) => {
        if (regex.test(line)) matches.push(`${relPath}:${i + 1}: ${line}`);
      });
    }
    return matches.join('\n');
  },
};

/** Collect every file under a path (itself, if it is a file), depth-first in
 * lexicographic order so results are deterministic across runs. */
function collectFiles(absPath: string): string[] {
  if (statSync(absPath).isFile()) return [absPath];
  const files: string[] = [];
  for (const name of readdirSync(absPath).sort()) {
    files.push(...collectFiles(join(absPath, name)));
  }
  return files;
}
