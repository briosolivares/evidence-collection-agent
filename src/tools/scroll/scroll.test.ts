import { describe, expect, it } from 'vitest';

import {
  BROWSER_TEST_TIMEOUT_MS,
  setupBrowserToolSuite,
} from '../../../tests/helpers/browserToolSuite.js';
import { observationTools } from '../index.js';
import { executeToolCall } from '../pipeline.js';
import { createRegistry } from '../registry.js';
import { scrollTool } from './scroll.js';

describe('scroll tool', () => {
  const suite = setupBrowserToolSuite('scroll-tool');
  const registry = createRegistry([...observationTools, scrollTool]);

  function call(name: string, input: unknown) {
    return executeToolCall(
      registry,
      { id: `call-${name}`, name, input },
      { runDir: suite.runDir(), browser: suite.adapter() },
    );
  }

  it(
    'scrolls one viewport so a fresh inspection sees lazy-loaded content',
    async () => {
      await call('navigate', { url: suite.server().url('/lazy-load.html') });
      const before = await call('inspect_page', {});
      expect(before.isError).toBe(false);
      expect(before.content).not.toContain('Lazy evidence item 20');

      const scrolled = await call('scroll', {});
      expect(scrolled).toMatchObject({ isError: false });
      expect(scrollTool.readOnly).toBe(false);

      const after = await call('inspect_page', {});
      expect(after.isError).toBe(false);
      expect(after.content).toContain('Lazy evidence item 20');
    },
    BROWSER_TEST_TIMEOUT_MS,
  );
});
