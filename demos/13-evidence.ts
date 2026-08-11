// Demo for T13: capture a PNG and an authenticated linked download through
// the complete tool pipeline, then print their provenance manifest.
// Run with: npx tsx demos/13-evidence.ts

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import type { BrowserAdapter } from '../src/browser/adapter.js';
import { launchPersistentChrome } from '../src/browser/playwrightAdapter.js';
import {
  finalizeManifest,
  initManifest,
  MANIFEST_FILENAME,
} from '../src/run/artifacts.js';
import { generateRunId } from '../src/run/runId.js';
import { createRunDir } from '../src/run/runDir.js';
import { evidenceTools } from '../src/tools/evidenceTools.js';
import { observationTools } from '../src/tools/observationTools.js';
import { executeToolCall } from '../src/tools/pipeline.js';
import { createRegistry } from '../src/tools/registry.js';
import { startFixtureServer } from '../tests/fixtures/server.js';

const runDir = createRunDir('runs', generateRunId());
initManifest(runDir, 'demo: capture browser evidence from a local fixture');

const fixtureServer = await startFixtureServer();
const registry = createRegistry([...observationTools, ...evidenceTools]);
let browser: BrowserAdapter | undefined;

try {
  browser = await launchPersistentChrome({
    profileDir: resolve('chrome-profile'),
  });
  await browser.newTab();
  const ctx = { runDir, browser };

  async function call(name: string, input: unknown): Promise<string> {
    const result = await executeToolCall(
      registry,
      { id: `demo-${name}`, name, input },
      ctx,
    );
    if (result.isError) throw new Error(result.content);
    return result.content;
  }

  // The first page sets the cookie required by authenticated.bin.
  await call('navigate', { url: fixtureServer.url('/') });
  await call('navigate', { url: fixtureServer.url('/downloads.html') });
  const outline = await call('inspect_page', {});
  const downloadRef = refFor(
    outline,
    'link "Download authenticated evidence"',
  );

  console.log(
    await call('screenshot', {
      filename: 'evidence/download-page.png',
      fullPage: true,
    }),
  );
  console.log(
    await call('download', {
      ref: downloadRef,
      filename: 'evidence/authenticated.bin',
    }),
  );
} finally {
  const cleanup = await Promise.allSettled([
    browser?.closeTab(),
    browser?.close(),
    fixtureServer.close(),
  ]);
  finalizeManifest(runDir);

  const failure = cleanup.find(
    (result): result is PromiseRejectedResult => result.status === 'rejected',
  );
  if (failure !== undefined) throw failure.reason;
}

console.log(`\n${readFileSync(resolve(runDir, MANIFEST_FILENAME), 'utf8')}`);
console.log(
  `Verify the screenshot with: shasum -a 256 ${resolve(runDir, 'evidence/download-page.png')}`,
);

function refFor(outline: string, roleAndName: string): string {
  const escapedRoleAndName = roleAndName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = outline.match(
    new RegExp(`- ${escapedRoleAndName} \\[ref=([^\\]\\s]+)\\]`),
  );
  if (match?.[1] === undefined) {
    throw new Error(`No ref found for ${roleAndName} in:\n${outline}`);
  }
  return match[1];
}
