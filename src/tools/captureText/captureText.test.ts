import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createEvidenceStore,
  type EvidenceRecord,
  type EvidenceStore,
} from '../../evidence/evidenceStore.js';
import { initManifest } from '../../run/artifacts.js';
import type { ToolCtx, ToolDef } from '../registry.js';
import {
  CAPTURE_TEXT_TOOL_NAME,
  captureTextInputSchema,
  createCaptureTextTool,
  type CapturedPageText,
  type CaptureTextInput,
  type CaptureTextResult,
  type TextCaptureRequest,
} from './captureText.js';

/** The exact text a capture must preserve: leading space, a tab, a decimal,
 * and a trailing newline all survive byte for byte. */
const EXACT_TEXT = '  Q3 revenue\t1,234.50 USD\n';

let runDir: string;
let store: EvidenceStore;
/** Every request the seam received, so "the page was never touched" is
 * testable. */
let captures: TextCaptureRequest[];

beforeEach(() => {
  runDir = mkdtempSync(join(tmpdir(), 'capture-text-test-'));
  initManifest(runDir, 'capture the text');
  store = createEvidenceStore(runDir);
  captures = [];
});

afterEach(() => {
  rmSync(runDir, { recursive: true, force: true });
});

function ctx(): ToolCtx {
  return { runDir };
}

function captured(overrides: Partial<CapturedPageText> = {}): CapturedPageText {
  return {
    text: EXACT_TEXT,
    url: 'https://filings.test/q3',
    title: 'Q3 filing',
    pageId: 'page-1',
    documentId: 'doc-4',
    observationId: 7,
    locator: '[data-sherlock-el="el-12"]',
    ...overrides,
  };
}

function tool(
  answer: CapturedPageText | Error,
  options: { withStore?: boolean; textMaxBytes?: number } = {},
): ToolDef<CaptureTextInput> {
  return createCaptureTextTool({
    page: () => ({
      async captureText(request) {
        captures.push(request);
        if (answer instanceof Error) throw answer;
        return answer;
      },
    }),
    ...(options.withStore === false ? {} : { evidenceStore: () => store }),
    ...(options.textMaxBytes !== undefined ? { textMaxBytes: options.textMaxBytes } : {}),
  });
}

async function run(
  definition: ToolDef<CaptureTextInput>,
  input: CaptureTextInput = {},
): Promise<CaptureTextResult> {
  return (await definition.execute(input, ctx())) as CaptureTextResult;
}

function readRecord(path: string): EvidenceRecord & { detail: Record<string, unknown> } {
  return JSON.parse(readFileSync(join(runDir, path), 'utf8')) as EvidenceRecord & {
    detail: Record<string, unknown>;
  };
}

describe('capture_text contract', () => {
  it('is a named, read-only tool with a strict schema', () => {
    const definition = tool(captured());
    expect(definition.name).toBe(CAPTURE_TEXT_TOOL_NAME);
    // Read-only: declares a page READ and no writes, so it never conflicts
    // with another concurrent capture/observe of the same or another page.
    expect(definition.getAccess({})).toEqual({ reads: ['page:selected'], writes: [] });

    expect(captureTextInputSchema.safeParse({}).success).toBe(true);
    expect(captureTextInputSchema.safeParse({ pageId: 'page-1', elementId: 'el-1' }).success).toBe(
      true,
    );
    expect(captureTextInputSchema.safeParse({ pageId: '' }).success).toBe(false);
    expect(captureTextInputSchema.safeParse({ elementId: '' }).success).toBe(false);
    expect(captureTextInputSchema.safeParse({ ref: 'e12' }).success).toBe(false);
    expect(captureTextInputSchema.safeParse({ label: 'x'.repeat(201) }).success).toBe(false);
  });

  it('rejects a text budget that cannot fit the result envelope', () => {
    for (const invalid of [0, -1, 1.5, 45_000]) {
      expect(() =>
        createCaptureTextTool({
          page: () => ({ captureText: async () => captured() }),
          evidenceStore: () => store,
          textMaxBytes: invalid,
        }),
      ).toThrow();
    }
  });
});

describe('capture_text evidence', () => {
  it('saves the exact text, URL, and locator, and returns a citable id', async () => {
    const result = await run(tool(captured()), { elementId: 'el-12', pageId: 'page-1' });

    expect(result.evidenceId).toBe('E1');
    expect(existsSync(join(runDir, result.evidencePath))).toBe(true);
    expect(result.locator).toBe('[data-sherlock-el="el-12"]');
    expect(result.characters).toBe(EXACT_TEXT.length);
    expect(result.text).toBe(EXACT_TEXT);
    expect(result.observationId).toBe(7);

    const record = readRecord(result.evidencePath);
    expect(record.detail.recordType).toBe('web_text');
    // Byte-for-byte: whitespace and punctuation are exactly what the page
    // rendered, which is the whole point of a capture over an observation.
    expect(record.detail.text).toBe(EXACT_TEXT);
    expect(record.detail.url).toBe('https://filings.test/q3');
    expect(record.detail.locator).toBe('[data-sherlock-el="el-12"]');
    expect(record.detail.pageId).toBe('page-1');
    expect(record.detail.documentId).toBe('doc-4');
    expect(record.detail.observationId).toBe(7);
    expect(record.sourceUrl).toBe('https://filings.test/q3');
  });

  it('passes the page and element selection through, and defaults to the whole page', async () => {
    const definition = tool(captured({ locator: 'body' }));
    await run(definition, { pageId: 'page-2', elementId: 'el-3' });
    await run(definition);
    expect(captures).toEqual([{ pageId: 'page-2', elementId: 'el-3' }, {}]);
  });

  it('uses the caller label as the evidence summary, and describes the source otherwise', async () => {
    const labelled = await run(tool(captured()), { label: 'Q3 revenue row' });
    expect(readRecord(labelled.evidencePath).summary).toContain('Q3 revenue row');
    expect(readRecord(labelled.evidencePath).summary).toContain('https://filings.test/q3');

    const unlabelled = await run(tool(captured()));
    expect(readRecord(unlabelled.evidencePath).summary).toContain(
      `Captured ${EXACT_TEXT.length} characters`,
    );
  });

  it('offloads over-budget text while the record keeps it complete', async () => {
    const long = 'x'.repeat(5_000);
    const result = await run(tool(captured({ text: long }), { textMaxBytes: 1_000 }));

    expect(result.text).toBeUndefined();
    expect(result.characters).toBe(5_000);
    expect(readFileSync(join(runDir, result.offloaded!.offloadedTo), 'utf8')).toBe(long);
    // The evidence record is never truncated, whatever the model was shown.
    expect(readRecord(result.evidencePath).detail.text).toBe(long);
  });

  it('fails closed without an evidence ledger, before reading the page', async () => {
    await expect(run(tool(captured(), { withStore: false }))).rejects.toThrow(
      /needs an evidence ledger/,
    );
    expect(captures).toEqual([]);
  });

  it('explains an empty capture instead of recording a text-less record', async () => {
    const definition = tool(captured({ text: undefined as unknown as string }));
    await expect(run(definition)).rejects.toThrow(/read no text/);
    expect(store.list()).toHaveLength(0);
  });

  it('propagates a capture failure without consuming an evidence id', async () => {
    const definition = tool(new Error('Browser ref el-9 is unavailable'));
    await expect(run(definition)).rejects.toThrow(/el-9/);
    expect(store.list()).toHaveLength(0);
  });
});
