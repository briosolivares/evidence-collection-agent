import {
  assertContentRange,
  throwIfAborted,
  type ContentObservation,
  type ContentReadRequest,
  type ContentReader,
} from './contentReader.js';

// PDF text with page provenance. A run that cites "the filing says X" must be
// able to say WHICH PAGE says it, or the claim is unverifiable — so every
// slice carries its page range, and per-line positions are preserved so a
// later reader can find the text again.
//
// pdfjs-dist is loaded lazily. It is a heavy dependency and most runs never
// touch a PDF; importing it at module load would tax every run for a
// capability few need.

/** Pages read per call when the caller names no range. Small: a bounded
 * chunk the model can actually use beats a whole document it cannot. */
export const DEFAULT_PDF_PAGE_SPAN = 5;

/** Hard ceiling per call, whatever the caller asks for. */
export const MAX_PDF_PAGE_SPAN = 25;

/** One extracted line, with enough geometry to locate it on the page. */
export interface PdfLine {
  page: number;
  /** 1-based line index within the page, in reading order. */
  line: number;
  text: string;
  /** Page-space bounding box [x, y, width, height], when available. */
  bbox?: [number, number, number, number];
}

/** What a PDF observation adds to the shared shape. */
export interface PdfMetadata extends Record<string, unknown> {
  pageCount: number;
  pagesRead: { from: number; to: number };
  lines: PdfLine[];
}

/** The pdfjs surface this adapter uses — declared locally so the adapter can
 * be tested against a fake without loading the real library. */
export interface PdfjsLike {
  getDocument(source: { data: Uint8Array }): {
    promise: Promise<{
      numPages: number;
      getPage(pageNumber: number): Promise<{
        getTextContent(): Promise<{
          items: Array<{ str?: string; transform?: number[]; width?: number; height?: number }>;
        }>;
      }>;
    }>;
  };
}

/** Options for the adapter; the loader is a test seam. */
export interface PdfContentReaderOptions {
  /** Supplies pdfjs. Defaults to a lazy import of pdfjs-dist. */
  loadPdfjs?: () => Promise<PdfjsLike>;
}

/**
 * Create the PDF adapter.
 *
 * Reads a bounded page range and returns its text with page and line
 * locators. The observation's `continuation` names the next range when pages
 * remain, so a 400-page document is read deliberately rather than all at
 * once.
 */
export function createPdfContentReader(options: PdfContentReaderOptions = {}): ContentReader {
  const loadPdfjs =
    options.loadPdfjs ??
    (async (): Promise<PdfjsLike> => {
      // Lazy and legacy-build: the Node build avoids the worker setup the
      // browser bundle expects.
      const module = (await import('pdfjs-dist/legacy/build/pdf.mjs')) as unknown as PdfjsLike;
      return module;
    });

  return {
    name: 'pdf',
    formats: ['pdf'],
    async read(request: ContentReadRequest): Promise<ContentObservation> {
      throwIfAborted(request.signal);
      const pdfjs = await loadPdfjs();
      throwIfAborted(request.signal);

      const document = await pdfjs.getDocument({ data: request.bytes }).promise;
      const pageCount = document.numPages;

      const requested = request.range ?? { from: 1, to: Math.min(pageCount, DEFAULT_PDF_PAGE_SPAN) };
      assertContentRange(requested);
      if (requested.from > pageCount) {
        throw new Error(
          `PDF has ${pageCount} page(s); requested range starts at ${requested.from}`,
        );
      }
      const from = requested.from;
      const to = Math.min(requested.to, pageCount, from + MAX_PDF_PAGE_SPAN - 1);

      const lines: PdfLine[] = [];
      const pageTexts: string[] = [];
      for (let pageNumber = from; pageNumber <= to; pageNumber += 1) {
        // Between pages, not just between documents: a cancelled OCR-scale
        // parse must stop promptly, not after finishing everything.
        throwIfAborted(request.signal);
        const page = await document.getPage(pageNumber);
        const content = await page.getTextContent();
        const pageLines = groupItemsIntoLines(content.items, pageNumber);
        lines.push(...pageLines);
        pageTexts.push(
          `--- page ${pageNumber} ---\n${pageLines.map((line) => line.text).join('\n')}`,
        );
      }

      const metadata: PdfMetadata = { pageCount, pagesRead: { from, to }, lines };
      return {
        format: 'pdf',
        text: pageTexts.join('\n\n'),
        locator: from === to ? `page ${from}` : `pages ${from}-${to}`,
        ...(to < pageCount
          ? { continuation: { from: to + 1, to: Math.min(pageCount, to + DEFAULT_PDF_PAGE_SPAN) } }
          : {}),
        total: pageCount,
        metadata,
      };
    },
  };
}

/**
 * Group pdfjs text items into lines by their vertical position.
 *
 * pdfjs emits positioned fragments, not lines: a naive join produces one
 * unreadable paragraph and loses the row structure that makes a table or a
 * member list legible. Items whose baseline differs by less than a tolerance
 * belong to the same visual line.
 */
function groupItemsIntoLines(
  items: ReadonlyArray<{ str?: string; transform?: number[]; width?: number; height?: number }>,
  page: number,
): PdfLine[] {
  const rows = new Map<number, Array<{ x: number; text: string; width: number; height: number }>>();

  for (const item of items) {
    const text = item.str ?? '';
    if (text.trim() === '') continue;
    const transform = item.transform ?? [];
    const x = typeof transform[4] === 'number' ? transform[4] : 0;
    const y = typeof transform[5] === 'number' ? transform[5] : 0;
    // Quantize the baseline so sub-pixel jitter does not split a line.
    const key = Math.round(y / 2) * 2;
    const row = rows.get(key) ?? [];
    row.push({ x, text, width: item.width ?? 0, height: item.height ?? 0 });
    rows.set(key, row);
  }

  // Top-to-bottom: PDF user space grows upward, so descending y is reading
  // order.
  const orderedKeys = [...rows.keys()].sort((a, b) => b - a);
  return orderedKeys.map((key, index) => {
    const row = rows.get(key)!.sort((a, b) => a.x - b.x);
    const minX = row[0]!.x;
    const maxRight = Math.max(...row.map((cell) => cell.x + cell.width));
    const height = Math.max(...row.map((cell) => cell.height));
    return {
      page,
      line: index + 1,
      text: row.map((cell) => cell.text).join(' ').replace(/\s+/g, ' ').trim(),
      bbox: [minX, key, maxRight - minX, height] as [number, number, number, number],
    };
  });
}
