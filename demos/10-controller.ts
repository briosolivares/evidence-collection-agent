// Demo for T10: create a session through the configured browser provider
// (local Chrome by default) and drive it through the engine-neutral browser
// controller. Run with: npx tsx demos/10-controller.ts

import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { createBrowserSessionProvider, describeBrowserProvider } from '../src/browser/provider.js';
import { createBusyResourceRegistry } from '../src/tools/registry.js';

const DEMO_WINDOW_MS = 5_000;
const PROFILE_DIR = resolve('chrome-profile');

console.log(describeBrowserProvider({ profileDir: PROFILE_DIR, localMode: 'managed' }));
const browserSessionProvider = createBrowserSessionProvider({
  localMode: 'managed',
  profileDir: PROFILE_DIR,
});
const browser = await browserSessionProvider.createSession();
browser.setBusyRegistry?.(createBusyResourceRegistry());
if (browser.prepareTaskPage === undefined) {
  throw new Error('Configured browser provider lacks task-page preparation');
}

let commandSession: Awaited<ReturnType<typeof browser.openCommandSession>> | undefined;
try {
  await browser.prepareTaskPage({
    ownershipId: `controller-demo-${process.pid}`,
    startUrl: 'https://example.com',
  });
  commandSession = await browser.openCommandSession();
  const title = (await commandSession.send('Runtime.evaluate', {
    expression: 'document.title',
    returnByValue: true,
  })) as { result?: { value?: unknown } };
  const accessibility = (await commandSession.send(
    'Accessibility.getFullAXTree',
  )) as { nodes?: unknown[] };

  console.log(`Title: ${String(title.result?.value ?? '')}`);
  console.log(`URL: ${browser.currentUrl()}`);
  console.log(`Accessibility nodes: ${accessibility.nodes?.length ?? 0}`);
  console.log(`Keeping Chrome open for ${DEMO_WINDOW_MS / 1_000} seconds...`);

  await delay(DEMO_WINDOW_MS);
} finally {
  await commandSession?.close().catch(() => undefined);
  await browser.closeTaskPages();
  await browser.close();
}
