// Demo for T11: exercise navigate and inspect_page through the complete tool
// pipeline against the deterministic local fixture server.
// Run with: npx tsx demos/11-observe.ts

import { resolve } from 'node:path';

import { LocalChromeBrowserSessionProvider } from '../src/browser/playwrightBrowserController.js';
import { finalizeManifest, initManifest } from '../src/run/artifacts.js';
import { generateRunId } from '../src/run/runId.js';
import { createRunDir } from '../src/run/runDir.js';
import { observationTools } from '../src/tools/index.js';
import { executeToolCall } from '../src/tools/pipeline.js';
import { createRegistry } from '../src/tools/registry.js';
import { startFixtureServer } from '../tests/fixtures/server.js';

const runDir = createRunDir('runs', generateRunId('demo observe'));
initManifest(runDir, 'demo: observe a local fixture page');

const fixtureServer = await startFixtureServer();
const browserSessionProvider = new LocalChromeBrowserSessionProvider({
  profileDir: resolve('chrome-profile'),
});
const browser = await browserSessionProvider.createSession();
const registry = createRegistry(observationTools);

try {
  await browser.newTab();
  const ctx = { runDir, browser };

  const navigated = await executeToolCall(
    registry,
    {
      id: 'demo-navigate',
      name: 'navigate',
      input: { url: fixtureServer.url('/') },
    },
    ctx,
  );
  if (navigated.isError) {
    throw new Error(navigated.content);
  }
  console.log(navigated.content);

  const inspected = await executeToolCall(
    registry,
    { id: 'demo-inspect', name: 'inspect_page', input: {} },
    ctx,
  );
  if (inspected.isError) {
    throw new Error(inspected.content);
  }
  console.log(`\n${inspected.content}`);
} finally {
  finalizeManifest(runDir);
  await browser.closeTab();
  await browser.close();
  await fixtureServer.close();
}
