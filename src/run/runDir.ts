import { mkdirSync } from 'node:fs';
import { isAbsolute, join, resolve, sep } from 'node:path';

/** Name of the harness-private directory (`run.lock`, `checkpoint.json`)
 * that AGENTS.md declares "never a valid model-supplied path" — kept as a
 * literal, not imported from agent/checkpoint.ts's HARNESS_DIR export, so
 * this leaf path-confinement module stays dependency-free. */
const HARNESS_DIR_SEGMENT = 'harness';

/**
 * Create the directory for a new run under the given base directory.
 *
 * @param baseDir - path (absolute or relative to the working directory) of
 *   the directory that holds all runs; created if it does not exist yet
 * @param runId - a non-empty single path segment (no path separators, not
 *   "." or "..") not already used under baseDir — throws otherwise, so an
 *   id collision or a malformed id can never touch an existing directory
 * @returns the absolute path of the newly created, empty run directory
 *   <baseDir>/<runId>
 */
export function createRunDir(baseDir: string, runId: string): string {
  const isSingleSegment = runId !== '' && runId !== '.' && runId !== '..' && !/[/\\]/.test(runId);
  if (!isSingleSegment) {
    throw new Error(`invalid run id (must be a single path segment): ${JSON.stringify(runId)}`);
  }

  const base = resolve(baseDir);
  mkdirSync(base, { recursive: true });

  const runDir = join(base, runId);
  // Non-recursive mkdir throws if the directory already exists — an id
  // collision is a bug worth failing fast on, never silently reusing.
  mkdirSync(runDir);
  return runDir;
}

/**
 * Resolve a relative path to its absolute location inside a run directory.
 * This is the single confinement chokepoint: every tool-supplied path must
 * pass through here before touching the filesystem.
 *
 * @param runDir - absolute path of the run directory confining the result
 * @param relPath - a relative path naming a location strictly inside runDir;
 *   throws if it is absolute, if it resolves to the run directory itself or
 *   anywhere outside it (e.g. "../escape" or "a/../../b"), or if it resolves
 *   inside the harness-private `harness/` directory — plain nested paths
 *   like "sub/file.csv" are allowed
 * @returns the absolute path of relPath inside runDir; the returned path is
 *   guaranteed to lie strictly within the run directory, outside `harness/`
 */
export function resolveRunPath(runDir: string, relPath: string): string {
  // Absolute paths are rejected outright — even one that happens to point
  // inside the run dir, since accepting it would invite callers to build
  // absolute paths themselves instead of staying relative.
  if (isAbsolute(relPath)) {
    throw new Error(`path must be relative, not absolute: ${JSON.stringify(relPath)}`);
  }

  const confinedRoot = resolve(runDir);
  const resolved = resolve(confinedRoot, relPath);

  // Every escaping traversal fails this one containment check. The trailing
  // separator keeps sibling dirs like <runDir>-evil out, and makes the run
  // dir itself (no separator after it) fail too.
  if (!resolved.startsWith(confinedRoot + sep)) {
    throw new Error(`path escapes the run directory: ${JSON.stringify(relPath)}`);
  }

  // harness/ is durable state private to the harness process (run.lock,
  // checkpoint.json) — AGENTS.md declares it "never a valid model-supplied
  // path". This is the one chokepoint every tool-supplied path passes
  // through, so the ban belongs here rather than repeated (or missed) in
  // every individual tool that resolves a model-supplied path.
  const relativeToRoot = resolved.slice(confinedRoot.length + sep.length);
  const firstSegment = relativeToRoot.split(sep)[0];
  if (firstSegment === HARNESS_DIR_SEGMENT) {
    throw new Error(
      `path is inside the harness-private directory, never a valid model-supplied path: ${JSON.stringify(relPath)}`,
    );
  }

  return resolved;
}
