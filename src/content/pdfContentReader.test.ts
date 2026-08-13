import { describe, expect, it } from 'vitest';

import {
  createPdfContentReader,
  DEFAULT_PDF_PAGE_SPAN,
  MAX_PDF_PAGE_SPAN,
  type PdfjsLike,
  type PdfMetadata,
} from './pdfContentReader.js';

// Driven against a fake pdfjs so the adapter's own behaviour — page
// provenance, line grouping, bounded ranges, continuation, cancellation — is
// tested deterministically rather than through a real PDF's quirks.

/** One page's positioned text fragments: [text, x, y]. */
type FakePage = Array<[string, number, number]>;

function fakePdfjs(pages: FakePage[], onPage?: (pageNumber: number) => void): PdfjsLike {
  return {
    getDocument: () => ({
      promise: Promise.resolve({
        numPages: pages.length,
        getPage: async (pageNumber: number) => {
          onPage?.(pageNumber);
          const fragments = pages[pageNumber - 1] ?? [];
          return {
            getTextContent: async () => ({
              items: fragments.map(([str, x, y]) => ({
                str,
                transform: [1, 0, 0, 1, x, y],
                width: str.length * 5,
                height: 10,
              })),
            }),
          };
        },
      }),
    }),
  };
}

const PDF_BYTES = new Uint8Array(Buffer.from('%PDF-1.7 fake', 'latin1'));

function reader(pages: FakePage[], onPage?: (page: number) => void) {
  return createPdfContentReader({ loadPdfjs: async () => fakePdfjs(pages, onPage) });
}

describe('createPdfContentReader', () => {
  it('groups positioned fragments into reading-order lines', async () => {
    // Two visual lines, each split into fragments, delivered out of order.
    const observation = await reader([
      [
        ['World', 60, 700],
        ['Hello', 10, 700],
        ['second line', 10, 680],
      ],
    ]).read({ bytes: PDF_BYTES });

    // Fragments on one baseline join left-to-right; higher y comes first.
    expect(observation.text).toContain('Hello World');
    const lines = (observation.metadata as PdfMetadata).lines;
    expect(lines.map((line) => line.text)).toEqual(['Hello World', 'second line']);
    expect(lines[0]).toMatchObject({ page: 1, line: 1 });
    expect(lines[1]).toMatchObject({ page: 1, line: 2 });
  });

  it('keeps a bounding box per line so text can be located again', async () => {
    const observation = await reader([[['Hello', 10, 700]]]).read({ bytes: PDF_BYTES });
    const [line] = (observation.metadata as PdfMetadata).lines;
    expect(line?.bbox?.[0]).toBe(10);
    expect(line?.bbox?.[1]).toBe(700);
  });

  it('labels every slice with its page range', async () => {
    const pages: FakePage[] = Array.from({ length: 3 }, (_, index) => [
      [`page ${index + 1} text`, 10, 700],
    ]);
    const single = await reader(pages).read({ bytes: PDF_BYTES, range: { from: 2, to: 2 } });
    expect(single.locator).toBe('page 2');
    expect(single.text).toContain('--- page 2 ---');

    const span = await reader(pages).read({ bytes: PDF_BYTES, range: { from: 1, to: 3 } });
    expect(span.locator).toBe('pages 1-3');
    // Page markers keep provenance inside the text itself.
    expect(span.text).toContain('--- page 1 ---');
    expect(span.text).toContain('--- page 3 ---');
  });

  it('defaults to a bounded span and names the continuation', async () => {
    const pages: FakePage[] = Array.from({ length: DEFAULT_PDF_PAGE_SPAN + 4 }, (_, index) => [
      [`p${index + 1}`, 10, 700],
    ]);
    const observation = await reader(pages).read({ bytes: PDF_BYTES });

    expect((observation.metadata as PdfMetadata).pagesRead).toEqual({
      from: 1,
      to: DEFAULT_PDF_PAGE_SPAN,
    });
    expect(observation.continuation).toEqual({
      from: DEFAULT_PDF_PAGE_SPAN + 1,
      to: DEFAULT_PDF_PAGE_SPAN + 4,
    });
    expect(observation.total).toBe(DEFAULT_PDF_PAGE_SPAN + 4);
  });

  it('omits the continuation once the last page is covered', async () => {
    const observation = await reader([[['only', 10, 700]]]).read({ bytes: PDF_BYTES });
    expect(observation.continuation).toBeUndefined();
  });

  it('clamps an over-large request to the hard ceiling', async () => {
    const pages: FakePage[] = Array.from({ length: MAX_PDF_PAGE_SPAN + 10 }, () => [
      ['x', 10, 700],
    ]);
    const observation = await reader(pages).read({
      bytes: PDF_BYTES,
      range: { from: 1, to: MAX_PDF_PAGE_SPAN + 10 },
    });
    expect((observation.metadata as PdfMetadata).pagesRead.to).toBe(MAX_PDF_PAGE_SPAN);
    // More remains, so a continuation is offered rather than silently dropped.
    expect(observation.continuation).toBeDefined();
  });

  it('clamps to the real page count rather than inventing pages', async () => {
    const observation = await reader([[['one', 10, 700]]]).read({
      bytes: PDF_BYTES,
      range: { from: 1, to: 50 },
    });
    expect((observation.metadata as PdfMetadata).pagesRead).toEqual({ from: 1, to: 1 });
  });

  it('rejects a range beyond the document', async () => {
    await expect(
      reader([[['one', 10, 700]]]).read({ bytes: PDF_BYTES, range: { from: 5, to: 6 } }),
    ).rejects.toThrow(/has 1 page/);
  });

  it('rejects an invalid range before parsing anything', async () => {
    await expect(
      reader([[['one', 10, 700]]]).read({ bytes: PDF_BYTES, range: { from: 0, to: 2 } }),
    ).rejects.toThrow(/range\.from/);
  });

  it('stops between pages when cancelled, rather than finishing the parse', async () => {
    const controller = new AbortController();
    const visited: number[] = [];
    const pages: FakePage[] = Array.from({ length: 5 }, () => [['x', 10, 700]]);

    const pending = reader(pages, (pageNumber) => {
      visited.push(pageNumber);
      if (pageNumber === 2) controller.abort();
    }).read({ bytes: PDF_BYTES, range: { from: 1, to: 5 }, signal: controller.signal });

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    // It did not grind through all five pages after the abort.
    expect(visited.length).toBeLessThan(5);
  });

  it('skips whitespace-only fragments', async () => {
    const observation = await reader([
      [
        ['   ', 10, 700],
        ['real', 20, 700],
      ],
    ]).read({ bytes: PDF_BYTES });
    expect((observation.metadata as PdfMetadata).lines.map((l) => l.text)).toEqual(['real']);
  });
});
