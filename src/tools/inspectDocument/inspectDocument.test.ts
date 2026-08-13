import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createContentReaderRegistry, type ContentReader } from '../../content/contentReader.js';
import { initManifest } from '../../run/artifacts.js';
import { executeToolCall } from '../pipeline.js';
import { createRegistry, type ToolCtx, type ToolDef } from '../registry.js';
import {
  createInspectDocumentTool,
  type InspectDocumentResult,
} from './inspectDocument.js';

// Driven through executeToolCall, so validation and error shaping are
// exercised exactly as the model would experience them.

let runDir: string;
let ctx: ToolCtx;

/** A reader that reports what it was asked for, so routing and range
 * plumbing are observable without a real parser. */
function echoReader(name: string, formats: ContentReader['formats'], text?: string): ContentReader {
  return {
    name,
    formats,
    read: async (request) => ({
      format: formats[0]!,
      text: text ?? `${name}:${request.range?.from ?? 'default'}-${request.range?.to ?? 'default'}`,
      locator: `${name} slice`,
      continuation: { from: 9, to: 9 },
      total: 42,
      metadata: { readerName: name },
    }),
  };
}

function toolFor(readers: ContentReader[], maxInlineTextBytes?: number) {
  const tool = createInspectDocumentTool({
    registry: createContentReaderRegistry(readers),
    ...(maxInlineTextBytes === undefined ? {} : { maxInlineTextBytes }),
  });
  return createRegistry([tool as ToolDef]);
}

async function call(
  readers: ContentReader[],
  input: unknown,
  maxInlineTextBytes?: number,
) {
  return executeToolCall(
    toolFor(readers, maxInlineTextBytes),
    { id: 'c1', name: 'inspect_document', input },
    ctx,
  );
}

beforeEach(() => {
  runDir = mkdtempSync(join(tmpdir(), 'inspect-document-test-'));
  initManifest(runDir, 'Read the filing.');
  ctx = { runDir };
});

afterEach(() => {
  rmSync(runDir, { recursive: true, force: true });
});

function writeDoc(relName: string, content: string): void {
  writeFileSync(join(runDir, relName), content, 'latin1');
}

describe('inspect_document', () => {
  it('routes by detected bytes, not by the filename', async () => {
    // The file claims to be a CSV; its bytes are a PDF.
    writeDoc('lying.csv', '%PDF-1.7 body');
    const result = await call([echoReader('pdf', ['pdf']), echoReader('csvish', ['csv'])], {
      path: 'lying.csv',
    });

    expect(result.isError).toBe(false);
    const payload = JSON.parse(result.content) as InspectDocumentResult;
    expect(payload.format).toBe('pdf');
    expect(payload.metadata?.['readerName']).toBe('pdf');
  });

  it('passes an explicit range through and returns the continuation', async () => {
    writeDoc('doc.pdf', '%PDF-1.7 body');
    const result = await call([echoReader('pdf', ['pdf'])], {
      path: 'doc.pdf',
      from: 3,
      to: 7,
    });
    const payload = JSON.parse(result.content) as InspectDocumentResult;

    expect(payload.text).toBe('pdf:3-7');
    expect(payload.continuation).toEqual({ from: 9, to: 9 });
    expect(payload.total).toBe(42);
    expect(payload.locator).toBe('pdf slice');
  });

  it('treats a lone `from` as a single-unit read', async () => {
    writeDoc('doc.pdf', '%PDF-1.7 body');
    const result = await call([echoReader('pdf', ['pdf'])], { path: 'doc.pdf', from: 4 });
    expect((JSON.parse(result.content) as InspectDocumentResult).text).toBe('pdf:4-4');
  });

  it('offloads large text instead of truncating it', async () => {
    // Truncation would make the model reason about half a document as though
    // it were whole; offloading keeps the whole thing reachable.
    writeDoc('doc.pdf', '%PDF-1.7 body');
    const big = 'x'.repeat(9_000);
    const result = await call([echoReader('pdf', ['pdf'], big)], { path: 'doc.pdf' }, 4_000);
    const payload = JSON.parse(result.content) as InspectDocumentResult;

    expect(payload.text).toBeUndefined();
    expect(payload.preview?.length).toBeGreaterThan(0);
    expect(payload.offloadedTo).toMatch(/^scratch\/tool-output\/inspect_document-\d+\.txt$/);
    expect(payload.note).toContain('inline limit');
    // Provenance survives the offload — the locator is still inline.
    expect(payload.locator).toBe('pdf slice');
  });

  it('refuses a path that escapes the run directory', async () => {
    const result = await call([echoReader('pdf', ['pdf'])], { path: '../../etc/passwd' });
    expect(result.isError).toBe(true);
  });

  it('reports a missing file and a directory clearly', async () => {
    const missing = await call([echoReader('pdf', ['pdf'])], { path: 'artifacts/nope.pdf' });
    expect(missing.isError).toBe(true);
    expect(missing.content).toMatch(/does not exist/);

    const dir = await call([echoReader('pdf', ['pdf'])], { path: 'artifacts' });
    expect(dir.isError).toBe(true);
    expect(dir.content).toMatch(/is a directory/);
  });

  it('reports an unsupported format rather than guessing', async () => {
    writeDoc('data.json', '{"a":1}');
    const result = await call([echoReader('pdf', ['pdf'])], { path: 'data.json' });
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/no content reader registered for json/);
  });

  it('rejects malformed input at the schema boundary', async () => {
    writeDoc('doc.pdf', '%PDF-1.7 body');
    for (const input of [
      { path: '' },
      { path: 'doc.pdf', from: 0 },
      { path: 'doc.pdf', to: 2.5 },
      { path: 'doc.pdf', surprise: true },
      {},
    ]) {
      const result = await call([echoReader('pdf', ['pdf'])], input);
      expect(result.isError).toBe(true);
    }
  });

  it('rejects a nonsensical inline limit at construction', () => {
    const registry = createContentReaderRegistry([echoReader('pdf', ['pdf'])]);
    for (const maxInlineTextBytes of [0, 100, -1, 2.5, Number.NaN]) {
      expect(() => createInspectDocumentTool({ registry, maxInlineTextBytes })).toThrow(
        /maxInlineTextBytes/,
      );
    }
  });
});
