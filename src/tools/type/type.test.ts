import { describe, expect, it } from 'vitest';

import {
  BROWSER_TEST_TIMEOUT_MS,
  setupBrowserToolSuite,
} from '../../../tests/helpers/browserToolSuite.js';
import { refFor } from '../../../tests/helpers/outline.js';
import { observationTools } from '../index.js';
import { executeToolCall } from '../pipeline.js';
import { createRegistry } from '../registry.js';
import { typeTool } from './type.js';

describe('type tool', () => {
  const suite = setupBrowserToolSuite('type-tool');
  const registry = createRegistry([...observationTools, typeTool]);

  function call(name: string, input: unknown) {
    return executeToolCall(
      registry,
      { id: `call-${name}`, name, input },
      { runDir: suite.runDir(), browser: suite.controller() },
    );
  }

  it(
    'types by ref, with the value visible through a fresh inspection',
    async () => {
      await call('navigate', { url: suite.server().url('/') });
      const before = await call('inspect_page', {});
      expect(before.isError).toBe(false);
      const inputRef = refFor(before.content, 'textbox "Evidence query"');

      const typed = await call('type', {
        ref: inputRef,
        text: 'quarterly controls',
      });
      expect(typed).toMatchObject({ isError: false });
      expect(typed.content).toContain(`ref=${inputRef}`);
      expect(typed.content).toContain('textbox "Evidence query"');

      const after = await call('inspect_page', {});
      expect(after.isError).toBe(false);
      expect(after.content).toContain('quarterly controls');
    },
    BROWSER_TEST_TIMEOUT_MS,
  );

  it(
    'turns a stale ref into a structured error directing a fresh inspection',
    async () => {
      await call('navigate', { url: suite.server().url('/') });
      const inspected = await call('inspect_page', {});
      const staleRef = refFor(inspected.content, 'textbox "Evidence query"');
      await call('navigate', { url: suite.server().url('/second.html') });

      const result = await call('type', { ref: staleRef, text: 'anything' });

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
