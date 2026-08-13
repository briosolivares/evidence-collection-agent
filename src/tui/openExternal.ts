// Launch the OS-native handler for an artifact — open (o), reveal (r),
// Quick Look (Space) — without ever touching Ink's raw-mode TTY: every
// child is spawned with stdio:'ignore' + detached and unref'd
// immediately, so nothing can write into the frame and the TUI never
// waits on the child.
//
// Result contract: never throws, never rejects. Each function returns a
// Promise resolving to { ok: true } | { ok: false, message } that the
// caller renders as a notice line. The Promise settles on the *launch*
// outcome: node reports a missing binary asynchronously via the child's
// 'error' event (e.g. `spawn qlmanage ENOENT`), so we resolve on the
// first of 'spawn' (launched) or 'error' (failed) — testable by driving
// an injected fake child. The child's later lifetime is its own
// business. Unsupported platform/action combinations resolve
// { ok: false } with a notice and spawn nothing, and a path that does
// not exist on disk is refused up front the same way (Quick Look would
// otherwise "succeed" into a generic icon card). A missing binary
// (ENOENT) renders as a capability-named notice ("Quick Look isn't
// available here…"); every other launch failure keeps its raw detail.
//
// Ink-frame safety (verified for plan item 10): this module is the only
// spawn site in src/tui, every launch flows through the single launch()
// below, and the SpawnFn type pins the options literal to
// { stdio: 'ignore', detached: true } — a child gets /dev/null for all
// three stdio streams and its own process group, so it can never write
// into the raw-mode TTY or receive the TUI's terminal signals. qlmanage
// -p chattering on its own stdout is therefore harmless: that stream is
// /dev/null, not our frame.

import { spawn as nodeSpawn } from 'node:child_process';
import { statSync } from 'node:fs';

/** What the caller renders: success, or a one-line notice. */
export type OpenExternalResult = { ok: true } | { ok: false; message: string };

/** The exact slice of node's ChildProcess this module relies on. */
export interface SpawnedChild {
  once(event: 'spawn', listener: () => void): unknown;
  once(event: 'error', listener: (error: Error) => void): unknown;
  unref(): void;
}

/** Injectable spawn seam; the default is node:child_process spawn. */
export type SpawnFn = (
  command: string,
  args: readonly string[],
  options: { stdio: 'ignore'; detached: true },
) => SpawnedChild;

/** Dependencies, injectable for tests (spawn recorder, platform matrix). */
export interface OpenExternalDeps {
  /** Defaults to node:child_process spawn. */
  spawn?: SpawnFn;
  /** Defaults to process.platform. */
  platform?: string;
  /** File-existence probe; defaults to the real filesystem. */
  exists?: (absPath: string) => boolean;
}

const defaultSpawn: SpawnFn = (command, args, options) =>
  nodeSpawn(command, args, options);

const defaultExists = (absPath: string): boolean => {
  try {
    statSync(absPath);
    return true;
  } catch {
    return false;
  }
};

/**
 * The stat-before-launch gate: Quick Look renders a useless generic icon
 * card for a nonexistent path, and `open` fails after the fact — both
 * would read as {ok:true} under the launch-outcome contract. A missing
 * file (deleted mid-session, or the demo's fictional artifacts) becomes
 * a notice before anything spawns.
 */
function missingFile(
  verb: string,
  absPath: string,
  deps: OpenExternalDeps,
): Promise<OpenExternalResult> | undefined {
  const exists = deps.exists ?? defaultExists;
  if (exists(absPath)) return undefined;
  return Promise.resolve({
    ok: false,
    message: `Nothing to ${verb} — ${absPath} is missing on disk`,
  });
}

/** Open the file in its default application (macOS `open`, Linux `xdg-open`). */
export function openPath(
  absPath: string,
  deps: OpenExternalDeps = {},
): Promise<OpenExternalResult> {
  const missing = missingFile('open', absPath, deps);
  if (missing !== undefined) return missing;
  const platform = deps.platform ?? process.platform;
  if (platform === 'darwin')
    return launch({ command: 'open', args: [absPath], capability: 'Opening files' }, deps);
  if (platform === 'linux')
    return launch(
      {
        command: 'xdg-open',
        args: [absPath],
        capability: 'Opening files',
        remedy: 'install xdg-utils',
      },
      deps,
    );
  return notSupported(`Opening files is not supported on ${platform}`);
}

/** Reveal the file in the file manager (macOS Finder via `open -R`). */
export function revealPath(
  absPath: string,
  deps: OpenExternalDeps = {},
): Promise<OpenExternalResult> {
  const missing = missingFile('reveal', absPath, deps);
  if (missing !== undefined) return missing;
  const platform = deps.platform ?? process.platform;
  if (platform === 'darwin')
    return launch(
      { command: 'open', args: ['-R', absPath], capability: 'Reveal in Finder' },
      deps,
    );
  return notSupported(`Reveal in the file manager is not supported on ${platform}`);
}

/**
 * Preview the file: macOS Quick Look (`qlmanage -p`, the system preview,
 * identical to Finder's spacebar); Linux has no Quick Look, so Space
 * falls back to the default opener.
 */
export function quickLookPath(
  absPath: string,
  deps: OpenExternalDeps = {},
): Promise<OpenExternalResult> {
  const missing = missingFile('preview', absPath, deps);
  if (missing !== undefined) return missing;
  const platform = deps.platform ?? process.platform;
  if (platform === 'darwin')
    return launch(
      { command: 'qlmanage', args: ['-p', absPath], capability: 'Quick Look' },
      deps,
    );
  if (platform === 'linux')
    return launch(
      {
        command: 'xdg-open',
        args: [absPath],
        capability: 'Preview',
        remedy: 'install xdg-utils',
      },
      deps,
    );
  return notSupported(`Preview is not supported on ${platform}`);
}

/** One concrete launch: the command line plus how to talk about it when
 * the binary is missing. */
interface LaunchSpec {
  command: string;
  args: string[];
  /** Named in the missing-binary notice, e.g. "Quick Look". */
  capability: string;
  /** Optional missing-binary remedy, e.g. "install xdg-utils". */
  remedy?: string;
}

function notSupported(message: string): Promise<OpenExternalResult> {
  return Promise.resolve({ ok: false, message });
}

function launch(
  spec: LaunchSpec,
  deps: OpenExternalDeps,
): Promise<OpenExternalResult> {
  const spawnFn = deps.spawn ?? defaultSpawn;
  return new Promise((resolve) => {
    let child: SpawnedChild;
    try {
      child = spawnFn(spec.command, spec.args, { stdio: 'ignore', detached: true });
    } catch (error) {
      resolve({ ok: false, message: launchFailure(spec, error) });
      return;
    }
    // Unref before the outcome is known: the TUI must never be kept
    // alive by the child, and unref on a child that failed to spawn is
    // harmless. Resolution is idempotent, so a late 'error' after
    // 'spawn' cannot double-settle.
    child.unref();
    child.once('spawn', () => resolve({ ok: true }));
    child.once('error', (error) =>
      resolve({ ok: false, message: launchFailure(spec, error) }),
    );
  });
}

/**
 * A missing binary (ENOENT — node sets `code` on the 'error' event's
 * Error) gets a notice that names the capability and, when we know one,
 * the remedy; anything else keeps the command and the raw detail, which
 * is the only clue the user has for the odd failure.
 */
function launchFailure(spec: LaunchSpec, error: unknown): string {
  if (isMissingBinary(error)) {
    const remedy = spec.remedy === undefined ? '' : ` — ${spec.remedy}`;
    return `${spec.capability} isn't available here (${spec.command} not found${remedy})`;
  }
  const detail = error instanceof Error ? error.message : String(error);
  return `${spec.command} failed to launch: ${detail}`;
}

function isMissingBinary(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error as NodeJS.ErrnoException).code === 'ENOENT'
  );
}
