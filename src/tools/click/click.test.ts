import { describe, expect, it } from 'vitest';

import {
  BROWSER_TEST_TIMEOUT_MS,
  setupBrowserToolSuite,
} from '../../../tests/helpers/browserToolSuite.js';
import { refFor } from '../../../tests/helpers/outline.js';
import { observationTools } from '../index.js';
import { executeToolCall } from '../pipeline.js';
import { createRegistry } from '../registry.js';
import { clickTool } from './click.js';

describe('click tool', () => {
  const suite = setupBrowserToolSuite('click-tool');
  const registry = createRegistry([...observationTools, clickTool]);

  function call(name: string, input: unknown) {
    return executeToolCall(
      registry,
      { id: `call-${name}`, name, input },
      { runDir: suite.runDir(), browser: suite.adapter() },
    );
  }

  it(
    'clicks by ref, with effects visible through a fresh inspection',
    async () => {
      await call('navigate', { url: suite.server().url('/') });
      const before = await call('inspect_page', {});
      expect(before.isError).toBe(false);
      const buttonRef = refFor(before.content, 'button "Announce ready"');
      const linkRef = refFor(before.content, 'link "Visit second page"');

      const clicked = await call('click', { ref: buttonRef });
      expect(clicked).toMatchObject({ isError: false });
      expect(clicked.content).toContain(`ref=${buttonRef}`);
      expect(clicked.content).toContain('button "Announce ready"');

      const after = await call('inspect_page', {});
      expect(after.isError).toBe(false);
      expect(after.content).toContain('Ready');

      // The semantic confirmation is captured before the click, so it still
      // names a link that disappears when its click navigates away.
      const navigated = await call('click', { ref: linkRef });
      expect(navigated).toMatchObject({ isError: false });
      expect(navigated.content).toContain('link "Visit second page"');
      const destination = await call('inspect_page', {});
      expect(destination.content).toContain('Second fixture page');
    },
    BROWSER_TEST_TIMEOUT_MS,
  );

  it(
    'turns a stale ref into a structured error directing a fresh inspection',
    async () => {
      await call('navigate', { url: suite.server().url('/') });
      const inspected = await call('inspect_page', {});
      const staleRef = refFor(inspected.content, 'button "Announce ready"');
      await call('navigate', { url: suite.server().url('/second.html') });

      const result = await call('click', { ref: staleRef });

      expect(result).toMatchObject({
        isError: true,
        errorKind: 'execution_error',
      });
      expect(result.content).toContain(staleRef);
      expect(result.content).toContain('inspect_page');
    },
    BROWSER_TEST_TIMEOUT_MS,
  );
});
