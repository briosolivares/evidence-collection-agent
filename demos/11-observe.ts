// Demo for T11: exercise navigate and inspect_page through the complete tool
// pipeline against the deterministic local fixture server.
// Run with: npx tsx demos/11-observe.ts

import { resolve } from 'node:path';

import { launchPersistentChrome } from '../src/browser/playwrightAdapter.js';
import { finalizeManifest, initManifest } from '../src/run/artifacts.js';
import { generateRunId } from '../src/run/runId.js';
import { createRunDir } from '../src/run/runDir.js';
import { observationTools } from '../src/tools/observationTools.js';
import { executeToolCall } from '../src/tools/pipeline.js';
import { createRegistry } from '../src/tools/registry.js';
import { startFixtureServer } from '../tests/fixtures/server.js';

const runDir = createRunDir('runs', generateRunId());
initManifest(runDir, 'demo: observe a local fixture page');

const fixtureServer = await startFixtureServer();
const browser = await launchPersistentChrome({
  profileDir: resolve('chrome-profile'),
});
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
