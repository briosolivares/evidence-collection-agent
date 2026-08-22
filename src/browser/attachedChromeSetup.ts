/**
 * Bounded first-use setup for attaching Sherlock to a user's local Chrome.
 *
 * The endpoint is a session-control capability. This module is its complete
 * discovery boundary: it may pass the value to the attached provider, but no
 * status message, diagnostic, or thrown error contains it.
 */

import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { homedir } from 'node:os';
import { createConnection } from 'node:net';
import { join, posix, win32 } from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';

import {
  AttachedChromeBrowserSessionProvider,
  AttachedChromeSessionError,
} from './attachedChromeBrowserSessionProvider.js';
import { ATTACHED_CHROME_ENDPOINT_ENV_VAR } from './cdpEndpoint.js';
import { resolveRealChromePath } from './localChromeExecutable.js';
import type { BrowserController } from './controller.js';
import type { BrowserSessionCreationOptions, BrowserSessionProvider } from './sessionProvider.js';

export { ATTACHED_CHROME_ENDPOINT_ENV_VAR } from './cdpEndpoint.js';
export const ATTACHED_CHROME_SETUP_URL = 'chrome://inspect/#remote-debugging';

const DEFAULT_SETUP_TIMEOUT_MS = 60_000;
const DEFAULT_CONNECTION_TIMEOUT_MS = 30_000;
const DISCOVERY_POLL_MS = 250;
const OPEN_SETUP_TIMEOUT_MS = 5_000;
const MAX_ACTIVE_PORT_BYTES = 4_096;

/** A safe operator-facing error which never carries a discovered endpoint. */
class AttachedChromeSetupError extends Error {}

/** An explicit loopback endpoint, or undefined when automatic discovery wins. */
export function attachedChromeEndpoint(
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  const value = env[ATTACHED_CHROME_ENDPOINT_ENV_VAR]?.trim();
  return value === undefined || value === '' ? undefined : value;
}

/** Chrome stable's default user-data directory, matching Playwright's channel discovery. */
export function defaultChromeUserDataDir(
  options: { platform?: string; home?: string; localAppData?: string } = {},
): string | undefined {
  const platform = options.platform ?? process.platform;
  const home = options.home ?? homedir();

  switch (platform) {
    case 'darwin':
      return posix.join(home, 'Library', 'Application Support', 'Google', 'Chrome');
    case 'linux':
      return posix.join(home, '.config', 'google-chrome');
    case 'win32':
      return win32.join(
        options.localAppData ?? process.env.LOCALAPPDATA ?? win32.join(home, 'AppData', 'Local'),
        'Google',
        'Chrome',
        'User Data',
      );
    default:
      return undefined;
  }
}

function parseDevToolsActivePort(contents: string): string | undefined {
  const [rawPort, rawPath] = contents.split(/\r?\n/u);
  if (rawPort === undefined || !/^\d{1,5}$/u.test(rawPort.trim())) return undefined;

  const port = Number(rawPort.trim());
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) return undefined;

  const browserPath = rawPath?.trim() || '/devtools/browser';
  if (!/^\/devtools\/browser(?:\/[A-Za-z0-9._~-]+)?$/u.test(browserPath)) {
    return undefined;
  }

  return `ws://127.0.0.1:${port}${browserPath}`;
}

/**
 * Read Chrome's bounded, local discovery record.
 *
 * The returned value is deliberately consumed only by this module's provider
 * wrapper. Callers should observe readiness through setup-state messages,
 * never by logging or persisting this endpoint.
 */
export async function discoverAttachedChromeEndpoint(
  userDataDir: string | undefined = defaultChromeUserDataDir(),
  isPortReachable: (port: number) => Promise<boolean> = probeLoopbackPort,
): Promise<string | undefined> {
  if (userDataDir === undefined) return undefined;

  const activePortPath = join(userDataDir, 'DevToolsActivePort');
  let handle;
  try {
    handle = await open(
      activePortPath,
      constants.O_RDONLY | (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW),
    );
  } catch (error) {
    if (isMissingFile(error)) return undefined;
    throw new AttachedChromeSetupError('Could not read Chrome remote-debugging discovery state.');
  }

  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > MAX_ACTIVE_PORT_BYTES) {
      throw new AttachedChromeSetupError('Chrome remote-debugging discovery state is invalid.');
    }

    const buffer = Buffer.alloc(Math.min(MAX_ACTIVE_PORT_BYTES + 1, stat.size + 1));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > MAX_ACTIVE_PORT_BYTES) {
      throw new AttachedChromeSetupError('Chrome remote-debugging discovery state is invalid.');
    }
    const endpoint = parseDevToolsActivePort(buffer.subarray(0, bytesRead).toString('utf8'));
    if (endpoint === undefined) return undefined;
    const port = Number(new URL(endpoint).port);
    return (await isPortReachable(port)) ? endpoint : undefined;
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/** A stale DevToolsActivePort file must not suppress Chrome first-use setup. */
function probeLoopbackPort(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    let settled = false;
    const finish = (reachable: boolean): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(reachable);
    };
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
    socket.setTimeout(DISCOVERY_POLL_MS, () => finish(false));
  });
}

function isMissingFile(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'ENOENT'
  );
}

/** Open Chrome's own remote-debugging permission page without automating it. */
export async function openAttachedChromeSetupPage(executablePath?: string): Promise<void> {
  const chromePath = resolveRealChromePath(executablePath);
  if (chromePath === undefined) {
    throw new AttachedChromeSetupError(
      'Could not find Chrome to open its remote-debugging setup page. ' +
        'Set SHERLOCK_CHROME_PATH to the Chrome executable and retry.',
    );
  }

  let child;
  try {
    child = spawn(chromePath, [ATTACHED_CHROME_SETUP_URL], {
      detached: true,
      stdio: 'ignore',
    });
  } catch {
    throw new AttachedChromeSetupError('Could not open Chrome remote-debugging setup.');
  }

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      child.unref();
      reject(
        new AttachedChromeSetupError('Timed out while opening Chrome remote-debugging setup.'),
      );
    }, OPEN_SETUP_TIMEOUT_MS);

    const cleanup = (): void => {
      clearTimeout(timer);
      child.off('spawn', opened);
      child.off('error', failed);
    };
    const opened = (): void => {
      cleanup();
      child.unref();
      resolve();
    };
    const failed = (): void => {
      cleanup();
      reject(new AttachedChromeSetupError('Could not open Chrome remote-debugging setup.'));
    };

    child.once('spawn', opened);
    child.once('error', failed);
  });
}

type AttachedProviderFactory = (
  endpoint: string,
  connectionTimeoutMs: number,
) => BrowserSessionProvider;

/** Dependencies and policy for the first-use attached-browser flow. */
export interface AttachedChromeSetupBrowserSessionOptions {
  explicitEndpoint?: string;
  executablePath?: string;
  /** Optional default observer. Interactive session callers normally supply
   * their current run observer to createSession() so lazy setup lands in the
   * right transcript. */
  onSetupState?: (message: string) => void;
  setupTimeoutMs?: number;
  connectionTimeoutMs?: number;
  /** Test seams. Production uses Chrome's stable default profile. */
  discoverEndpoint?: () => Promise<string | undefined>;
  openSetupPage?: () => Promise<void>;
  createAttachedProvider?: AttachedProviderFactory;
  wait?: (milliseconds: number) => Promise<void>;
  now?: () => number;
}

/**
 * Provider wrapper which resolves attachment without exposing its endpoint.
 *
 * A configured endpoint is probed first. If unavailable, Sherlock tries
 * Chrome stable's supported local discovery. First use opens Chrome's setup
 * page and waits for the user — it never clicks or accepts permission itself.
 */
export class AttachedChromeSetupBrowserSessionProvider implements BrowserSessionProvider {
  private readonly explicitProvider: BrowserSessionProvider | undefined;
  private readonly executablePath: string | undefined;
  private readonly defaultOnSetupState: ((message: string) => void) | undefined;
  private readonly setupTimeoutMs: number;
  private readonly connectionTimeoutMs: number;
  private readonly discoverEndpoint: () => Promise<string | undefined>;
  private readonly openSetupPage: () => Promise<void>;
  private readonly createAttachedProvider: AttachedProviderFactory;
  private readonly wait: (milliseconds: number) => Promise<void>;
  private readonly now: () => number;

  constructor(options: AttachedChromeSetupBrowserSessionOptions) {
    this.setupTimeoutMs = positiveInteger(
      options.setupTimeoutMs ?? DEFAULT_SETUP_TIMEOUT_MS,
      'setupTimeoutMs',
    );
    this.connectionTimeoutMs = positiveInteger(
      options.connectionTimeoutMs ?? DEFAULT_CONNECTION_TIMEOUT_MS,
      'connectionTimeoutMs',
    );
    this.executablePath = options.executablePath;
    this.defaultOnSetupState = options.onSetupState;
    this.discoverEndpoint = options.discoverEndpoint ?? discoverAttachedChromeEndpoint;
    this.openSetupPage =
      options.openSetupPage ?? (() => openAttachedChromeSetupPage(this.executablePath));
    this.createAttachedProvider =
      options.createAttachedProvider ??
      ((endpoint, connectionTimeoutMs) =>
        new AttachedChromeBrowserSessionProvider({
          cdpEndpoint: endpoint,
          connectionTimeoutMs,
        }));
    this.wait = options.wait ?? ((milliseconds) => delay(milliseconds));
    this.now = options.now ?? (() => performance.now());

    // Construct now so an unsafe explicit endpoint fails before any setup
    // state, discovery read, process spawn, or connection attempt.
    this.explicitProvider =
      options.explicitEndpoint === undefined
        ? undefined
        : this.createAttachedProvider(
            options.explicitEndpoint,
            Math.min(this.connectionTimeoutMs, this.setupTimeoutMs),
          );
  }

  async createSession(options: BrowserSessionCreationOptions = {}): Promise<BrowserController> {
    const onSetupState = options.onSetupState ?? this.defaultOnSetupState;
    if (onSetupState === undefined) {
      throw new TypeError('Attached Chrome setup requires an onSetupState callback.');
    }
    const deadline = this.now() + this.setupTimeoutMs;

    if (this.explicitProvider !== undefined) {
      try {
        return await this.explicitProvider.createSession();
      } catch {
        onSetupState(
          'Configured attached Chrome endpoint was unavailable; trying local Chrome discovery.',
        );
      }
    }

    const alreadyEnabled = await this.discoverEndpoint();
    if (alreadyEnabled !== undefined) {
      return this.connectDiscovered(alreadyEnabled, deadline, onSetupState);
    }

    onSetupState(`Opening ${ATTACHED_CHROME_SETUP_URL} in Chrome.`);
    await this.openSetupPage();
    onSetupState(
      'In Chrome, enable “Allow remote debugging for this browser instance”. ' +
        `Sherlock will wait up to ${Math.ceil(this.setupTimeoutMs / 1_000)} seconds and will ` +
        'not click the permission prompt for you.',
    );

    for (;;) {
      const remaining = deadline - this.now();
      if (remaining <= 0) throw setupTimeoutError();

      const endpoint = await this.discoverEndpoint();
      if (endpoint !== undefined) {
        return this.connectDiscovered(endpoint, deadline, onSetupState);
      }

      await this.wait(Math.min(DISCOVERY_POLL_MS, remaining));
    }
  }

  private async connectDiscovered(
    endpoint: string,
    deadline: number,
    onSetupState: (message: string) => void,
  ): Promise<BrowserController> {
    const remaining = deadline - this.now();
    if (remaining <= 0) throw setupTimeoutError();

    onSetupState(
      'Chrome remote debugging is ready. Approve Chrome’s connection prompt to continue.',
    );
    const provider = this.createAttachedProvider(
      endpoint,
      Math.max(1, Math.floor(Math.min(this.connectionTimeoutMs, remaining))),
    );
    try {
      return await provider.createSession();
    } catch (error) {
      // The attached provider's own errors are written to be shown; anything
      // else (Playwright, transport) may carry the endpoint and stays opaque.
      const detail = error instanceof AttachedChromeSessionError ? ` ${error.message}` : '';
      throw new AttachedChromeSetupError(
        `Chrome remote debugging was discovered, but Sherlock could not attach.${detail} ` +
          `If Chrome showed a connection prompt, approve it and retry; otherwise open ` +
          `${ATTACHED_CHROME_SETUP_URL} and confirm remote debugging is still enabled.`,
      );
    }
  }
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`Attached Chrome ${name} must be a positive integer.`);
  }
  return value;
}

function setupTimeoutError(): AttachedChromeSetupError {
  return new AttachedChromeSetupError(
    'Timed out waiting for Chrome remote debugging. ' +
      `Open ${ATTACHED_CHROME_SETUP_URL}, enable ` +
      '“Allow remote debugging for this browser instance”, and retry Sherlock.',
  );
}
