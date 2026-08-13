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
// { ok: false } with a notice and spawn nothing. (Plan item 10 polishes
// missing-binary notices further.)

import { spawn as nodeSpawn } from 'node:child_process';

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
}

const defaultSpawn: SpawnFn = (command, args, options) =>
  nodeSpawn(command, args, options);

/** Open the file in its default application (macOS `open`, Linux `xdg-open`). */
export function openPath(
  absPath: string,
  deps: OpenExternalDeps = {},
): Promise<OpenExternalResult> {
  const platform = deps.platform ?? process.platform;
  if (platform === 'darwin') return launch('open', [absPath], deps);
  if (platform === 'linux') return launch('xdg-open', [absPath], deps);
  return notSupported(`Opening files is not supported on ${platform}`);
}

/** Reveal the file in the file manager (macOS Finder via `open -R`). */
export function revealPath(
  absPath: string,
  deps: OpenExternalDeps = {},
): Promise<OpenExternalResult> {
  const platform = deps.platform ?? process.platform;
  if (platform === 'darwin') return launch('open', ['-R', absPath], deps);
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
  const platform = deps.platform ?? process.platform;
  if (platform === 'darwin') return launch('qlmanage', ['-p', absPath], deps);
  if (platform === 'linux') return launch('xdg-open', [absPath], deps);
  return notSupported(`Preview is not supported on ${platform}`);
}

function notSupported(message: string): Promise<OpenExternalResult> {
  return Promise.resolve({ ok: false, message });
}

function launch(
  command: string,
  args: string[],
  deps: OpenExternalDeps,
): Promise<OpenExternalResult> {
  const spawnFn = deps.spawn ?? defaultSpawn;
  return new Promise((resolve) => {
    let child: SpawnedChild;
    try {
      child = spawnFn(command, args, { stdio: 'ignore', detached: true });
    } catch (error) {
      resolve({ ok: false, message: launchFailure(command, error) });
      return;
    }
    // Unref before the outcome is known: the TUI must never be kept
    // alive by the child, and unref on a child that failed to spawn is
    // harmless. Resolution is idempotent, so a late 'error' after
    // 'spawn' cannot double-settle.
    child.unref();
    child.once('spawn', () => resolve({ ok: true }));
    child.once('error', (error) =>
      resolve({ ok: false, message: launchFailure(command, error) }),
    );
  });
}

function launchFailure(command: string, error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error);
  return `${command} failed to launch: ${detail}`;
}
