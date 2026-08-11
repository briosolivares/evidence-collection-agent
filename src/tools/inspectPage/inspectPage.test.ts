import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  BROWSER_TEST_TIMEOUT_MS,
  setupBrowserToolSuite,
} from '../../../tests/helpers/browserToolSuite.js';
import { refFor } from '../../../tests/helpers/outline.js';
import { type OffloadedResult } from '../capResult.js';
import { navigateTool } from '../navigate/navigate.js';
import { executeToolCall } from '../pipeline.js';
import { createRegistry } from '../registry.js';
import { inspectPageTool } from './inspectPage.js';

describe('inspect_page tool', () => {
  const suite = setupBrowserToolSuite('inspect-page-tool');
  const registry = createRegistry([navigateTool, inspectPageTool]);

  function call(name: string, input: unknown) {
    return executeToolCall(
      registry,
      { id: `call-${name}`, name, input },
      { runDir: suite.runDir(), browser: suite.adapter() },
    );
  }

  it(
    'returns full-page interactive semantics and stable refs',
    async () => {
      await call('navigate', { url: suite.server().url('/') });

      const first = await call('inspect_page', {});
      const second = await call('inspect_page', {});

      expect(first.isError).toBe(false);
      expect(second.isError).toBe(false);
      expect(first.content).toContain(
        `URL: ${suite.server().url('/')}\nTitle: Browser Adapter Fixture\n\n`,
      );
      for (const roleAndName of [
        'link "Visit second page"',
        'button "Announce ready"',
        'textbox "Evidence query"',
        'button "Collect below-fold evidence"',
      ]) {
        expect(refFor(first.content, roleAndName)).toBe(
          refFor(second.content, roleAndName),
        );
      }
      expect(inspectPageTool.readOnly).toBe(true);
    },
    BROWSER_TEST_TIMEOUT_MS,
  );

  it(
    'offloads an oversized outline with a preview and complete file',
    async () => {
      await call('navigate', { url: suite.server().url('/oversized.html') });
      const uncapped = await call('inspect_page', {});
      expect(uncapped.isError).toBe(false);
      const smallCapRegistry = createRegistry([
        { ...inspectPageTool, maxBytes: 400 },
      ]);

      const result = await executeToolCall(
        smallCapRegistry,
        { id: 'call-oversized', name: 'inspect_page', input: {} },
        { runDir: suite.runDir(), browser: suite.adapter() },
      );

      expect(result.isError).toBe(false);
      const replacement = JSON.parse(result.content) as OffloadedResult;
      expect(replacement.preview).toContain('Oversized Outline Fixture');
      expect(replacement.offloadedTo).toMatch(/^tool-output\/inspect_page-/);
      const fullOutline = readFileSync(join(suite.runDir(), replacement.offloadedTo), 'utf8');
      expect(fullOutline).toBe(uncapped.content);
      expect(fullOutline).toContain('link "Evidence record 120"');
    },
    BROWSER_TEST_TIMEOUT_MS,
  );
});
