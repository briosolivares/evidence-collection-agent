import { isAbsolute } from 'node:path';

import {
  chromium,
  type BrowserContext,
  type Download,
  type Locator,
  type Page,
  type Response,
} from 'playwright';

import {
  BrowserRefNotFoundError,
  type BrowserController,
  type BrowserDownloadResult,
  type BrowserDownloadTarget,
  type BrowserFetchResult,
  type BrowserScreenshotOptions,
} from './controller.js';
import type { BrowserSessionProvider } from './sessionProvider.js';

const ARIA_REF_PATTERN = /^(?:f\d+)?e\d+$/;
const DOWNLOAD_EVENT_TIMEOUT_MS = 5_000;
const DOWNLOAD_AFTER_NAVIGATION_ERROR_GRACE_MS = 1_000;
const SCROLL_SETTLE_MS = 50;

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
  return chromium.launchPersistentContext(options.profileDir, {
    ...(options.executablePath !== undefined
      ? { executablePath: options.executablePath }
      : { channel: 'chrome' }),
    headless: options.headless ?? false,
  });
}

/** Creates persistent local Chrome sessions controlled through Playwright. */
export class LocalChromeBrowserSessionProvider implements BrowserSessionProvider {
  constructor(private readonly options: LocalChromeBrowserSessionOptions) {}

  async createSession(): Promise<BrowserController> {
    const context = await launchPersistentChrome(this.options);

    try {
      await prepareSessionPage(context);
      return new PlaywrightBrowserController(context);
    } catch (error) {
      await context.close();
      throw error;
    }
  }
}

/** Playwright implementation of the engine-neutral browser controller. */
export class PlaywrightBrowserController implements BrowserController {
  private activePage: Page | undefined;
  private closePromise: Promise<void> | undefined;
  private closed = false;
  private tabLifecycle: Promise<void> = Promise.resolve();

  constructor(private readonly context: BrowserContext) {}

  newTab(): Promise<void> {
    return this.serializeTabLifecycle(async () => {
      this.requireOpenContext();
      if (this.activePage !== undefined && !this.activePage.isClosed()) {
        throw new Error('A browser task tab is already active; close it first.');
      }

      this.activePage = await this.context.newPage();
    });
  }

  closeTab(): Promise<void> {
    return this.serializeTabLifecycle(async () => {
      const page = this.activePage;
      this.activePage = undefined;
      if (page === undefined || page.isClosed()) {
        return;
      }

      await page.close();
    });
  }

  async goto(url: string): Promise<void> {
    assertHttpUrl(url);
    await this.requirePage().goto(url, { waitUntil: 'load' });
  }

  async outline(): Promise<string> {
    return this.requirePage().ariaSnapshot({ mode: 'ai' });
  }

  async click(ref: string): Promise<void> {
    const locator = await this.locatorForRef(ref);
    try {
      await locator.click();
    } catch (error) {
      throw await normalizeRefActionError(locator, ref, error);
    }
  }

  async type(ref: string, text: string): Promise<void> {
    const locator = await this.locatorForRef(ref);
    try {
      await locator.fill(text);
    } catch (error) {
      throw await normalizeRefActionError(locator, ref, error);
    }
  }

  async scroll(): Promise<void> {
    const page = this.requirePage();
    await page.evaluate(() => window.scrollBy(0, window.innerHeight));
    await page.waitForTimeout(SCROLL_SETTLE_MS);
  }

  async screenshot(
    options: BrowserScreenshotOptions = {},
  ): Promise<Uint8Array> {
    const bytes = await this.requirePage().screenshot({
      fullPage: options.fullPage ?? false,
      type: 'png',
    });
    return new Uint8Array(bytes);
  }

  async resolveHref(ref: string): Promise<string | null> {
    const locator = await this.locatorForRef(ref);
    try {
      return await locator.evaluate((element) => {
        const href = element.getAttribute('href');
        return href === null
          ? null
          : new URL(href, element.ownerDocument.baseURI).href;
      });
    } catch (error) {
      throw await normalizeRefActionError(locator, ref, error);
    }
  }

  async fetch(url: string): Promise<BrowserFetchResult> {
    this.requireOpenContext();
    assertHttpUrl(url);
    const response = await this.context.request.get(url);

    try {
      return {
        status: response.status(),
        headers: response.headers(),
        bytes: new Uint8Array(await response.body()),
      };
    } finally {
      await response.dispose();
    }
  }

  async download(target: BrowserDownloadTarget): Promise<BrowserDownloadResult> {
    this.requireOpenContext();

    if ('url' in target) {
      assertHttpUrl(target.url);
      return this.captureUrlThroughChrome(target.url);
    }

    const locator = await this.locatorForRef(target.ref);
    let href: string | null;
    try {
      href = await locator.evaluate((element) => {
        const value = element.getAttribute('href');
        return value === null ? null : new URL(value, element.ownerDocument.baseURI).href;
      });
    } catch (error) {
      throw await normalizeRefActionError(locator, target.ref, error);
    }

    if (href !== null && isHttpUrl(href)) {
      return this.captureUrlThroughChrome(href);
    }

    return this.captureClickDownload(locator, target.ref);
  }

  currentUrl(): string {
    return this.requirePage().url();
  }

  async title(): Promise<string> {
    return this.requirePage().title();
  }

  async close(): Promise<void> {
    if (this.closePromise !== undefined) {
      return this.closePromise;
    }

    this.closed = true;
    this.closePromise = this.serializeTabLifecycle(async () => {
      this.activePage = undefined;
      await this.context.close();
    });
    return this.closePromise;
  }

  private requireOpenContext(): void {
    if (this.closed) {
      throw new Error('Browser session is closed.');
    }
  }

  private requirePage(): Page {
    this.requireOpenContext();
    const page = this.activePage;
    if (page === undefined || page.isClosed()) {
      this.activePage = undefined;
      throw new Error('No browser task tab is active; call newTab() first.');
    }

    return page;
  }

  private async captureUrlThroughChrome(url: string): Promise<BrowserDownloadResult> {
    const referringUrl = this.requirePage().url();
    const capturePage = await this.context.newPage();

    try {
      const downloadOutcome = capturePage
        .waitForEvent('download', { timeout: 0 })
        .then((download) => ({ kind: 'download' as const, download }));
      const navigationOutcome = capturePage
        .goto(url, {
          waitUntil: 'commit',
          ...(isHttpUrl(referringUrl) ? { referer: referringUrl } : {}),
        })
        .then(
          (response) => ({ kind: 'response' as const, response }),
          (error: unknown) => ({ kind: 'navigation_error' as const, error }),
        );

      const outcome = await Promise.race([downloadOutcome, navigationOutcome]);
      if (outcome.kind === 'download') {
        return await readBrowserDownload(outcome.download);
      }

      if (outcome.kind === 'response') {
        if (outcome.response === null) {
          throw new Error(`Browser navigation produced no response: ${url}`);
        }
        return await readNavigationResponse(outcome.response);
      }

      const lateDownload = await Promise.race([
        downloadOutcome,
        delay(DOWNLOAD_AFTER_NAVIGATION_ERROR_GRACE_MS).then(() => undefined),
      ]);
      if (lateDownload !== undefined) {
        return await readBrowserDownload(lateDownload.download);
      }
      throw outcome.error;
    } finally {
      await capturePage.close();
    }
  }

  private async captureClickDownload(
    locator: Locator,
    ref: string,
  ): Promise<BrowserDownloadResult> {
    const page = this.requirePage();
    const downloadPromise = page.waitForEvent('download', {
      timeout: DOWNLOAD_EVENT_TIMEOUT_MS,
    });
    void downloadPromise.catch(() => undefined);
    let clickCompleted = false;

    try {
      await locator.click();
      clickCompleted = true;
      return await readBrowserDownload(await downloadPromise);
    } catch (error) {
      if (!clickCompleted) {
        throw await normalizeRefActionError(locator, ref, error);
      }
      throw new Error(
        `Browser ref ${ref} has no HTTP(S) href and did not start a browser download. ` +
          'Re-run inspect_page and choose a download link or control, or pass a verified direct URL.',
      );
    }
  }

  private async locatorForRef(ref: string): Promise<Locator> {
    if (!ARIA_REF_PATTERN.test(ref)) {
      throw new BrowserRefNotFoundError(ref);
    }

    const locator = this.requirePage().locator(`aria-ref=${ref}`);
    if ((await countRefMatches(locator)) !== 1) {
      throw new BrowserRefNotFoundError(ref);
    }

    return locator;
  }

  private serializeTabLifecycle<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tabLifecycle.then(operation);
    this.tabLifecycle = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

async function prepareSessionPage(context: BrowserContext): Promise<void> {
  const pages = context.pages();
  const sessionPage = pages[0] ?? (await context.newPage());

  for (const extraPage of pages.slice(1)) {
    await extraPage.close();
  }

  if (sessionPage.url() !== 'about:blank') {
    await sessionPage.goto('about:blank');
  }
}

async function normalizeRefActionError(
  locator: Locator,
  ref: string,
  error: unknown,
): Promise<unknown> {
  if ((await countRefMatches(locator)) === 0) {
    return new BrowserRefNotFoundError(ref);
  }

  return error;
}

async function countRefMatches(locator: Locator): Promise<number> {
  try {
    return await locator.count();
  } catch {
    return 0;
  }
}

function assertHttpUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new TypeError(`Browser URL must be absolute: ${url}`);
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new TypeError(`Browser URL must use HTTP or HTTPS: ${url}`);
  }
}

function isHttpUrl(url: string): boolean {
  try {
    const protocol = new URL(url).protocol;
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

async function readNavigationResponse(
  response: Response,
): Promise<BrowserDownloadResult> {
  const headers = response.headers();
  return {
    finalUrl: response.url(),
    status: response.status(),
    headers,
    bytes: new Uint8Array(await response.body()),
    ...(suggestedFilenameFromHeaders(headers) !== undefined
      ? { suggestedFilename: suggestedFilenameFromHeaders(headers) }
      : {}),
  };
}

async function readBrowserDownload(
  download: Download,
): Promise<BrowserDownloadResult> {
  const failure = await download.failure();
  if (failure !== null) {
    throw new Error(`Browser download failed: ${failure}`);
  }

  const stream = await download.createReadStream();
  if (stream === null) {
    throw new Error('Browser download completed without a readable byte stream.');
  }

  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  return {
    finalUrl: download.url(),
    headers: {},
    bytes: new Uint8Array(Buffer.concat(chunks)),
    suggestedFilename: download.suggestedFilename(),
  };
}

function suggestedFilenameFromHeaders(
  headers: Readonly<Record<string, string>>,
): string | undefined {
  const disposition = headers['content-disposition'];
  if (disposition === undefined) return undefined;

  const encoded = disposition.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
  if (encoded !== undefined) {
    try {
      return decodeURIComponent(encoded.trim());
    } catch {
      return encoded.trim();
    }
  }

  return disposition.match(/filename="([^"]+)"/i)?.[1]
    ?? disposition.match(/filename=([^;]+)/i)?.[1]?.trim();
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}
