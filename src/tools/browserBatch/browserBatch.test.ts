import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  BROWSER_TEST_TIMEOUT_MS,
  setupBrowserToolSuite,
} from '../../../tests/helpers/browserToolSuite.js';
import { refFor } from '../../../tests/helpers/outline.js';
import { type Manifest } from '../../run/artifacts.js';
import { createProductionRegistry } from '../index.js';
import { executeToolCall } from '../pipeline.js';
import { createRegistry } from '../registry.js';
import { type EvidenceResult } from '../shared/evidence.js';
import {
  browserBatchTool,
  type BrowserBatchResult,
} from './browserBatch.js';

describe('browser_batch schema', () => {
  const registry = createRegistry([browserBatchTool]);

  it('rejects unsafe batch shapes before browser execution', async () => {
    const invalidInputs = [
      { actions: [] },
      {
        actions: Array.from({ length: 11 }, () => ({
          tool: 'scroll',
          input: {},
        })),
      },
      { actions: [{ tool: 'read_file', input: { file_path: 'notes.md' } }] },
      { actions: [{ tool: 'click', input: {} }] },
      { actions: [{ tool: 'scroll', input: {}, extra: true }] },
    ];

    for (const [index, input] of invalidInputs.entries()) {
      const result = await executeToolCall(
        registry,
        { id: `invalid-${index}`, name: 'browser_batch', input },
        { runDir: '/tmp/browser-batch-schema-test' },
      );
      expect(result, JSON.stringify(input)).toMatchObject({
        isError: true,
        errorKind: 'invalid_input',
      });
    }
  });
});

describe('browser_batch execution', () => {
  const suite = setupBrowserToolSuite('browser-batch-tool');
  const registry = createProductionRegistry('batch-enabled');

  function call(name: string, input: unknown) {
    return executeToolCall(
      registry,
      { id: `call-${name}`, name, input },
      { runDir: suite.runDir(), browser: suite.controller() },
    );
  }

  async function successfulCall(name: string, input: unknown): Promise<string> {
    const result = await call(name, input);
    if (result.isError) throw new Error(result.content);
    return result.content;
  }

  it(
    'executes ordered browser work and preserves evidence provenance',
    async () => {
      await successfulCall('navigate', { url: suite.server().url('/') });
      const before = await successfulCall('inspect_page', {});
      const inputRef = refFor(before, 'textbox "Evidence query"');
      const buttonRef = refFor(before, 'button "Announce ready"');

      const content = await successfulCall('browser_batch', {
        actions: [
          {
            tool: 'type',
            input: { ref: inputRef, text: 'quarterly controls' },
          },
          { tool: 'click', input: { ref: buttonRef } },
          { tool: 'inspect_page', input: {} },
          { tool: 'screenshot', input: { filename: 'artifacts/batch-evidence.png' } },
        ],
      });
      const batch = JSON.parse(content) as BrowserBatchResult;

      expect(batch.results.map(({ index, tool }) => ({ index, tool }))).toEqual([
        { index: 0, tool: 'type' },
        { index: 1, tool: 'click' },
        { index: 2, tool: 'inspect_page' },
        { index: 3, tool: 'screenshot' },
      ]);
      expect(batch.results[2]?.content).toContain('quarterly controls');
      expect(batch.results[2]?.content).toContain('Ready');

      const evidence = JSON.parse(
        batch.results[3]?.content ?? 'null',
      ) as EvidenceResult;
      expect(readFileSync(join(suite.runDir(), evidence.path)).byteLength).toBe(
        evidence.size,
      );
      const manifest = JSON.parse(
        readFileSync(join(suite.runDir(), 'manifest.json'), 'utf8'),
      ) as Manifest;
      expect(manifest.artifacts).toContainEqual(
        expect.objectContaining({
          filename: evidence.path,
          sourceUrl: suite.server().url('/'),
        }),
      );
    },
    BROWSER_TEST_TIMEOUT_MS,
  );

  it(
    'stops on the first error without rolling back completed actions',
    async () => {
      await successfulCall('navigate', { url: suite.server().url('/') });
      const before = await successfulCall('inspect_page', {});
      const inputRef = refFor(before, 'textbox "Evidence query"');

      const result = await call('browser_batch', {
        actions: [
          { tool: 'type', input: { ref: inputRef, text: 'kept after failure' } },
          { tool: 'click', input: { ref: 'e999999' } },
          { tool: 'navigate', input: { url: suite.server().url('/second.html') } },
        ],
      });

      expect(result).toMatchObject({
        isError: true,
        errorKind: 'execution_error',
      });
      expect(result.content).toContain('action 2/3 (click) after 1 completed action');
      expect(result.content).toContain('run inspect_page again');
      expect(result.content).toContain('were not rolled back');
      expect(suite.controller().currentUrl()).toBe(suite.server().url('/'));
      expect(await successfulCall('inspect_page', {})).toContain('kept after failure');
    },
    BROWSER_TEST_TIMEOUT_MS,
  );
});
