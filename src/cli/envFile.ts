/**
 * Narrow `.env` updates.
 *
 * Exactly one operation: set one key to one value, leaving every other byte of
 * the file alone. It exists because the login command has to persist a
 * Browserbase Context id, and the file it persists into is the same one holding
 * the user's API keys and comments. A round-trip through a parser would
 * normalize quoting, drop comments, and reorder lines — losing information
 * nobody asked us to touch, in a file the user edits by hand.
 *
 * So: line-oriented rewriting of the one matching line, an append when there is
 * none, and no reformatting of anything else.
 */
import { chmodSync, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';

/** Mode for a `.env` this code creates: it holds credentials, so owner-only. */
const NEW_ENV_FILE_MODE = 0o600;

/**
 * Set `key` to `value` in the env file at `path`.
 *
 * Rewrites the last assignment of `key` in place (last, because that is the one
 * `process.loadEnvFile` would have used), appends a fresh line when the key is
 * absent, and creates an owner-only file when `path` does not exist.
 *
 * Permissions are preserved deliberately: a `.env` that a user has chmodded to
 * 600 must not silently become 644 because a helper rewrote it.
 *
 * @param path - absolute path of the env file to update
 * @param key - variable name; assumed to be a plain identifier
 * @param value - value to store, written unquoted (a Browserbase Context id and
 *   an API key are both bare tokens); a value containing a newline is rejected
 *   rather than written, since it would silently become two settings
 * @returns nothing; the file on disk now assigns `key` exactly once more than
 *   or exactly as often as before, and resolves to `value`
 * @throws TypeError when `value` spans lines
 */
export function setEnvFileValue(path: string, key: string, value: string): void {
  if (/[\r\n]/.test(value)) {
    throw new TypeError(`refusing to write a multi-line value for ${key} into ${path}`);
  }

  const assignment = `${key}=${value}`;
  const existed = existsSync(path);
  const original = existed ? readFileSync(path, 'utf8') : '';
  const lines = original === '' ? [] : original.split('\n');

  // `export FOO=` and leading whitespace are both accepted by shells and appear
  // in real hand-edited files, so a rewrite has to recognize them or it would
  // append a second, shadowed assignment.
  const pattern = new RegExp(`^\\s*(?:export\\s+)?${escapeForRegExp(key)}\\s*=`);
  let lastMatch = -1;
  for (let index = 0; index < lines.length; index += 1) {
    if (pattern.test(lines[index]!)) lastMatch = index;
  }

  let updated: string;
  if (lastMatch !== -1) {
    lines[lastMatch] = assignment;
    updated = lines.join('\n');
  } else {
    // Append, keeping exactly one trailing newline whether or not the original
    // ended with one.
    const body = original === '' ? '' : original.endsWith('\n') ? original : `${original}\n`;
    updated = `${body}${assignment}\n`;
  }

  if (existed) {
    const mode = statSync(path).mode & 0o777;
    writeFileSync(path, updated);
    // writeFileSync leaves an existing file's mode alone, but restoring it
    // explicitly makes that independent of platform behavior.
    chmodSync(path, mode);
  } else {
    writeFileSync(path, updated, { mode: NEW_ENV_FILE_MODE });
  }
}

function escapeForRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
