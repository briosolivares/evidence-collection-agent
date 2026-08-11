import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { launchPersistentChrome } from '../src/browser/playwrightAdapter.js';

const DEMO_WINDOW_MS = 5_000;
const PROFILE_DIR = resolve('chrome-profile');

const browser = await launchPersistentChrome({ profileDir: PROFILE_DIR });

try {
  await browser.newTab();
  await browser.goto('https://example.com');

  console.log(`Title: ${await browser.title()}`);
  console.log(`URL: ${browser.currentUrl()}`);
  console.log(await browser.outline());
  console.log(`Keeping Chrome open for ${DEMO_WINDOW_MS / 1_000} seconds...`);

  await delay(DEMO_WINDOW_MS);
} finally {
  await browser.closeTab();
  await browser.close();
}
