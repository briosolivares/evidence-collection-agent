/**
 * Local persistent-profile Chrome provider.
 *
 * The launch half of the local lane: opening the persistent profile with the
 * right binary resolution, pinning Chrome's own download directory inside the
 * profile, and assembling a {@link PlaywrightBrowserController} on top. Split
 * from the controller so the other providers no longer import a peer
 * provider's file just to reach the shared controller class.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

import { chromium, type BrowserContext } from 'playwright';

import type { BrowserController } from './controller.js';
import { createChromiumTargetControl } from './chromiumTargetControl.js';
import { assembleBrowserController, prepareSessionPage } from './controllerAssembly.js';
import { PlaywrightBrowserController } from './playwrightBrowserController.js';
import type { BrowserSessionProvider } from './sessionProvider.js';

/** Configuration for browser sessions backed by persistent local Chrome. */
export interface LocalChromeBrowserSessionOptions {
  /** Absolute path to the persistent Chrome profile directory. */
  profileDir: string;
  /** Whether Chrome runs without a visible window; defaults to false. */
  headless?: boolean;
  /** Chrome/Chromium binary to launch. When omitted, Playwright
   * discovers system Google Chrome via its `chrome` channel. */
  executablePath?: string;
}

/** Launch the persistent-profile Chrome exactly as agent sessions do.
 * Exported so the `login` helper opens the SAME profile with the SAME
 * binary resolution — a second launch path would reintroduce the
 * logged-into-the-wrong-profile failure the helper exists to kill. */
export async function launchPersistentChrome(
  options: LocalChromeBrowserSessionOptions,
): Promise<BrowserContext> {
  if (!isAbsolute(options.profileDir)) {
    throw new TypeError('Browser profileDir must be an absolute path.');
  }
  // Must happen BEFORE the launch: Chrome reads this preference at startup.
  pinProfileDownloadDirectory(options.profileDir);
  return chromium.launchPersistentContext(options.profileDir, {
    ...(options.executablePath !== undefined
      ? { executablePath: options.executablePath }
      : { channel: 'chrome' }),
    headless: options.headless ?? false,
    // Keep an ephemeral loopback endpoint available for exact process-crash
    // and reattachment coverage. Managed production composition never reads
    // or exports the endpoint; command execution stays on the controller's
    // provider-neutral attached CDP sessions.
    args: ['--remote-debugging-port=0'],
  });
}

/**
 * Point Chrome's own download directory inside the profile.
 *
 * Chrome — not Playwright — decides where a download it handles itself lands,
 * and it reads `download.default_directory` from the profile's Preferences at
 * startup. Unset, that resolves to the OS Downloads folder, so a download the
 * run never consumes is written into the user's home directory and left there.
 * The test suite deposited one file per run that way.
 *
 * Playwright's own `downloadsPath` does not cover this: it governs downloads
 * Playwright accepts and hands back as `Download` objects, and the leaking
 * case is one Chrome writes on its own. Neither do the CDP
 * `set*DownloadBehavior` commands, which were measured and did not stop it.
 *
 * Merged rather than overwritten, and best-effort: this profile may be a real
 * logged-in one whose other preferences must survive, and a preferences file
 * this cannot parse must not stop a session from launching.
 *
 * Exported for its own test: the leak this closes was timing-dependent (the
 * producing test leaked only when run after the other 51 in its file), so the
 * merge and best-effort behavior are pinned directly rather than left to be
 * inferred from whether a full-suite run happens to stay clean.
 */
export function pinProfileDownloadDirectory(profileDir: string): void {
  try {
    const downloadDir = join(profileDir, 'downloads');
    mkdirSync(downloadDir, { recursive: true });
    const defaultDir = join(profileDir, 'Default');
    mkdirSync(defaultDir, { recursive: true });
    const prefsPath = join(defaultDir, 'Preferences');
    const existing: Record<string, unknown> = existsSync(prefsPath)
      ? (JSON.parse(readFileSync(prefsPath, 'utf8')) as Record<string, unknown>)
      : {};
    const download =
      typeof existing.download === 'object' && existing.download !== null
        ? (existing.download as Record<string, unknown>)
        : {};
    writeFileSync(
      prefsPath,
      JSON.stringify({
        ...existing,
        download: { ...download, default_directory: downloadDir, prompt_for_download: false },
      }),
    );
  } catch {
    // Best effort; see the note above.
  }
}

/** Creates persistent local Chrome sessions controlled through Playwright. */
export class LocalChromeBrowserSessionProvider implements BrowserSessionProvider {
  constructor(private readonly options: LocalChromeBrowserSessionOptions) {}

  async createSession(): Promise<BrowserController> {
    const context = await launchPersistentChrome(this.options);
    return assembleBrowserController({
      build: async (own) => {
        const preexistingSessionPage = await prepareSessionPage(context);
        const targetControl = own(
          await createChromiumTargetControl({
            context,
            anchorPage: preexistingSessionPage,
          }),
        );
        return new PlaywrightBrowserController({
          context,
          preexistingSessionPages: [preexistingSessionPage],
          targetControl,
        });
      },
      // The context IS the locally launched browser; closing it releases the
      // session, and a cleanup rejection propagates exactly as before.
      releaseSession: () => context.close(),
    });
  }
}
