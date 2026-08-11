import { isAbsolute } from 'node:path';

import {
  chromium,
  type BrowserContext,
  type Locator,
  type Page,
} from 'playwright';

import {
  BrowserRefNotFoundError,
  type BrowserAdapter,
  type BrowserFetchResult,
  type BrowserLaunchOptions,
  type BrowserScreenshotOptions,
} from './adapter.js';

const ARIA_REF_PATTERN = /^(?:f\d+)?e\d+$/;
const SCROLL_SETTLE_MS = 50;

/**
 * Launch a persistent local Chrome session behind the browser adapter.
 *
 * @param options - absolute profile directory and optional headless setting;
 *   headed mode is the product default, while tests may opt into headless
 * @returns an engine-neutral adapter with a live persistent browser session
 *   and no active task tab
 */
export async function launchPersistentChrome(
  options: BrowserLaunchOptions,
): Promise<BrowserAdapter> {
  if (!isAbsolute(options.profileDir)) {
    throw new TypeError('Browser profileDir must be an absolute path.');
  }

  const context = await chromium.launchPersistentContext(options.profileDir, {
    channel: 'chrome',
    headless: options.headless ?? false,
  });

  try {
    await prepareSessionPage(context);
    return new PlaywrightBrowserAdapter(context);
  } catch (error) {
    await context.close();
    throw error;
  }
}

class PlaywrightBrowserAdapter implements BrowserAdapter {
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
