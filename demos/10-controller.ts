// Demo for T10: create a session through the configured browser provider
// (local Chrome by default) and drive it through the engine-neutral browser
// controller. Run with: npx tsx demos/10-controller.ts

import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { createBrowserSessionProvider, describeBrowserProvider } from '../src/browser/provider.js';

const DEMO_WINDOW_MS = 5_000;
const PROFILE_DIR = resolve('chrome-profile');

console.log(describeBrowserProvider({ profileDir: PROFILE_DIR }));
const browserSessionProvider = createBrowserSessionProvider({
  profileDir: PROFILE_DIR,
});
const browser = await browserSessionProvider.createSession();

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
