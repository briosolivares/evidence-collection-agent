import { createServer, type Server } from 'node:http';
import { inflateSync } from 'node:zlib';

import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  parseEvidenceMarkers,
  validateDocumentEvidence,
  type AcceptedDocumentSource,
  type CitedEvidence,
  type DocumentEvidenceLookup,
  type DocumentOutputSpec,
} from './documentSource.js';
import {
  createPlaywrightPdfPageOpener,
  renderDocument,
  renderEvidenceFootnotes,
  renderHiddenEvidence,
  renderPdf,
  renderPdfHtml,
  type PdfRenderPage,
} from './renderDocument.js';

function spec(overrides: Partial<DocumentOutputSpec> = {}): DocumentOutputSpec {
  return {
    id: 'brief',
    kind: 'document',
    filename: 'brief.md',
    format: 'markdown',
    evidenceRequirement: 'at_least_one',
    evidencePresentation: 'hidden',
    ...overrides,
  } as DocumentOutputSpec;
}

const ledger: Record<string, CitedEvidence> = {
  E1: { id: 'E1', summary: 'Member count from the directory header', sourceUrl: 'https://x.test/a' },
  E2: { id: 'E2', summary: 'Roster rows extracted from the table' },
  E7: { id: 'E7', summary: 'Filing date from the cover page', sourceUrl: 'https://x.test/c' },
  E777: { id: 'E777', summary: 'Roster count read from the page header' },
};
const lookup: DocumentEvidenceLookup = (id) => ledger[id];

/** Accept a source the way the tool does, so every renderer test runs on a
 * genuinely validated document rather than a hand-built stand-in. */
function accept(source: string, documentSpec = spec()): AcceptedDocumentSource {
  const result = validateDocumentEvidence(documentSpec, source, lookup);
  if (!result.ok) throw new Error(`fixture source rejected: ${result.errors.join('; ')}`);
  return result.document;
}

/** Markers parsed straight from a string, for the two renderers that take a
 * source and its markers directly. */
function markersOf(source: string) {
  return parseEvidenceMarkers(source);
}

describe('renderHiddenEvidence', () => {
  it('removes every marker, leaving no raw evidence id', () => {
    const source = 'The gap is real [evidence:E1]. So is the second [evidence:E2, E7].';
    const rendered = renderHiddenEvidence(source, markersOf(source));

    expect(rendered).toBe('The gap is real. So is the second.\n');
    expect(rendered).not.toMatch(/E\d/);
    expect(rendered).not.toContain('evidence:');
  });

  it('closes the whitespace a marker was holding open', () => {
    const cases: Array<[string, string]> = [
      ['Fact [evidence:E1].', 'Fact.\n'],
      ['Fact[evidence:E1].', 'Fact.\n'],
      ['Fact [evidence:E1] and more.', 'Fact and more.\n'],
      ['Fact [evidence:E1] [evidence:E2].', 'Fact.\n'],
      ['- Bullet [evidence:E1] text', '- Bullet text\n'],
      ['[evidence:E1] Leading marker.', 'Leading marker.\n'],
      ['Trailing marker [evidence:E1]   ', 'Trailing marker\n'],
      ['Quoted "so it goes" [evidence:E1]!', 'Quoted "so it goes"!\n'],
    ];
    for (const [source, expected] of cases) {
      expect(renderHiddenEvidence(source, markersOf(source))).toBe(expected);
    }
  });

  it('deletes a citation-only line without doubling the paragraph break', () => {
    const source = 'First paragraph.\n\n[evidence:E1]\n\nSecond paragraph.\n';
    expect(renderHiddenEvidence(source, markersOf(source))).toBe(
      'First paragraph.\n\nSecond paragraph.\n',
    );
  });

  it('keeps ordinary blank lines and markdown structure intact', () => {
    const source = ['# Report', '', '## Findings [evidence:E1]', '', '- One [evidence:E2]', '- Two', ''].join('\n');
    expect(renderHiddenEvidence(source, markersOf(source))).toBe(
      ['# Report', '', '## Findings', '', '- One', '- Two', ''].join('\n'),
    );
  });

  it('normalizes CRLF, drops leading blank lines, and ends in exactly one newline', () => {
    const source = '\r\n\r\nOne [evidence:E1].\r\nTwo.\r\n\r\n\r\n';
    expect(renderHiddenEvidence(source, markersOf(source))).toBe('One.\nTwo.\n');
  });

  it('leaves an unmarked document alone apart from the trailing newline', () => {
    expect(renderHiddenEvidence('Plain prose.', [])).toBe('Plain prose.\n');
  });
});

describe('renderEvidenceFootnotes', () => {
  it('numbers by first appearance, reuses a number for a repeated id, and lists the sources', () => {
    const source = 'A [evidence:E7]. B [evidence:E1]. C [evidence:E7].';
    const rendered = renderEvidenceFootnotes(source, markersOf(source), lookup);

    expect(rendered).toBe(
      [
        'A [1]. B [2]. C [1].',
        '',
        'Sources',
        '',
        '[1] E7 — Filing date from the cover page (https://x.test/c)',
        '[2] E1 — Member count from the directory header (https://x.test/a)',
        '',
      ].join('\n'),
    );
  });

  it('renders one marker citing several records as one reference', () => {
    const source = 'Both agree [evidence:E1, E2].';
    const rendered = renderEvidenceFootnotes(source, markersOf(source), lookup);

    expect(rendered).toContain('Both agree [1, 2].');
    // Never "[1][2]": in Markdown that is a reference-style link, not two
    // citations.
    expect(rendered).not.toContain('[1][2]');
    expect(rendered).toContain('[2] E2 — Roster rows extracted from the table');
  });

  it('omits the URL for a record that has none', () => {
    const source = 'Rows [evidence:E2].';
    expect(renderEvidenceFootnotes(source, markersOf(source), lookup)).toContain(
      '[1] E2 — Roster rows extracted from the table\n',
    );
  });

  it('heads the list the way the deliverable needs', () => {
    const source = 'A [evidence:E1].';
    expect(renderEvidenceFootnotes(source, markersOf(source), lookup, { style: 'markdown' })).toContain(
      '\n## Sources\n',
    );
    expect(renderEvidenceFootnotes(source, markersOf(source), lookup, { style: 'plain' })).toContain(
      '\nSources\n',
    );
  });

  it('says a record is unavailable rather than quietly dropping its footnote', () => {
    const source = 'Claim [evidence:E9].';
    const rendered = renderEvidenceFootnotes(source, markersOf(source), () => undefined);
    expect(rendered).toContain('Claim [1].');
    expect(rendered).toContain('[1] E9 — record unavailable in this run');
  });

  it('appends no source list when the document cites nothing', () => {
    expect(renderEvidenceFootnotes('Plain prose.', [], lookup)).toBe('Plain prose.\n');
  });
});

describe('renderDocument', () => {
  const source = '## Findings\n\nThe gap is real [evidence:E1].\n';

  it('follows the contract\'s presentation, not the caller\'s preference', () => {
    const hidden = renderDocument(spec(), accept(source), lookup);
    expect(hidden).toBe('## Findings\n\nThe gap is real.\n');

    const footnoted = renderDocument(
      spec({ evidencePresentation: 'footnotes' }),
      accept(source),
      lookup,
    );
    expect(footnoted).toContain('The gap is real [1].');
    expect(footnoted).toContain('## Sources');
  });

  it('uses a plain source heading for text and pdf deliverables', () => {
    for (const format of ['text', 'pdf'] as const) {
      const rendered = renderDocument(
        spec({ format, evidencePresentation: 'footnotes' }),
        accept(source),
        lookup,
      );
      expect(rendered).toContain('\nSources\n');
      expect(rendered).not.toContain('## Sources');
    }
  });
});

describe('renderPdfHtml', () => {
  const pdfSpec = spec({ format: 'pdf', filename: 'brief.pdf' });

  it('is self-contained: no external stylesheet, script, image, or font', () => {
    const html = renderPdfHtml(pdfSpec, '# Report\n\nBody text.\n');

    expect(html).not.toMatch(/<link|<script|<img|src=|@import|url\(/i);
    expect(html).toContain("default-src 'none'");
    expect(html).toContain('<title>brief.pdf</title>');
  });

  it('reads the block-level Markdown a document actually uses', () => {
    const html = renderPdfHtml(
      pdfSpec,
      [
        '# Report',
        '',
        '## Findings',
        '',
        'First line.',
        'Second line of the same paragraph.',
        '',
        '- One',
        '- Two',
        '',
        '1. First',
        '2. Second',
        '',
        '---',
        '',
        'Sources',
        '',
        '[1] E1 — Member count',
        '',
      ].join('\n'),
    );

    expect(html).toContain('<h1>Report</h1>');
    expect(html).toContain('<h2>Findings</h2>');
    expect(html).toContain('<p>First line.<br>Second line of the same paragraph.</p>');
    expect(html).toContain('<ul>\n<li>One</li>\n<li>Two</li>\n</ul>');
    expect(html).toContain('<ol>\n<li>First</li>\n<li>Second</li>\n</ol>');
    expect(html).toContain('<hr>');
    expect(html).toContain('[1] E1 — Member count');
  });

  it('escapes text that would otherwise change the template\'s structure', () => {
    const html = renderPdfHtml(pdfSpec, 'A <script>alert("x")</script> & an <b>attempt</b>.\n');

    expect(html).toContain('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;');
    expect(html).toContain('&amp;');
    expect(html).not.toMatch(/<script>alert/);
  });

  it('carries exactly the text renderDocument produced', () => {
    const accepted = accept('## Findings\n\nThe gap is real [evidence:E1].\n');
    const text = renderDocument(pdfSpec, accepted, lookup);
    const html = renderPdfHtml(pdfSpec, text);

    // The PDF's body is a rendering of the same accepted source, marker-free.
    expect(html).toContain('<p>The gap is real.</p>');
    expect(html).not.toMatch(/E\d/);
    expect(html).not.toContain('evidence:');
  });
});

/** A PdfRenderPage that records the order it was driven in. */
function recordingPage(options: { failOn?: 'setHtml' | 'toPdf' } = {}) {
  const calls: string[] = [];
  let html = '';
  const page: PdfRenderPage = {
    async disableNetwork(): Promise<void> {
      calls.push('disableNetwork');
    },
    async setHtml(value: string): Promise<void> {
      calls.push('setHtml');
      html = value;
      if (options.failOn === 'setHtml') throw new Error('setHtml exploded');
    },
    async toPdf(): Promise<Uint8Array> {
      calls.push('toPdf');
      if (options.failOn === 'toPdf') throw new Error('toPdf exploded');
      return Buffer.from('%PDF-fake', 'utf8');
    },
    async close(): Promise<void> {
      calls.push('close');
    },
  };
  return { page, calls, html: () => html };
}

describe('renderPdf', () => {
  const pdfSpec = spec({ format: 'pdf', filename: 'brief.pdf' });
  const accepted = accept('## Findings\n\nThe gap is real [evidence:E1].\n');

  it('disables the network before it loads anything, then renders and closes', async () => {
    const recorder = recordingPage();
    let opened = 0;

    const bytes = await renderPdf(pdfSpec, accepted, lookup, {
      openPage: async () => {
        opened += 1;
        return recorder.page;
      },
    });

    expect(Buffer.from(bytes).toString('utf8')).toBe('%PDF-fake');
    expect(recorder.calls).toEqual(['disableNetwork', 'setHtml', 'toPdf', 'close']);
    // One dedicated page per render — never a cached or shared handle.
    expect(opened).toBe(1);
    expect(recorder.html()).toContain('<p>The gap is real.</p>');
  });

  it('closes the page when the render fails, and propagates the failure', async () => {
    for (const failOn of ['setHtml', 'toPdf'] as const) {
      const recorder = recordingPage({ failOn });
      await expect(
        renderPdf(pdfSpec, accepted, lookup, { openPage: async () => recorder.page }),
      ).rejects.toThrow(`${failOn} exploded`);
      expect(recorder.calls.at(-1)).toBe('close');
    }
  });

  it('keeps the rendered bytes when only teardown fails', async () => {
    const recorder = recordingPage();
    const bytes = await renderPdf(pdfSpec, accepted, lookup, {
      openPage: async () => ({
        ...recorder.page,
        close: async () => {
          throw new Error('close exploded');
        },
      }),
    });
    expect(Buffer.from(bytes).toString('utf8')).toBe('%PDF-fake');
  });
});

// A real headless Chrome, driven exactly the way the runtime would drive it.
// The unit tests above prove the ORDER and the HTML; only a real browser can
// prove that this template actually becomes a PDF, that the route-abort really
// blocks a fetch, and that the render leaves the agent's own page alone.
describe('renderPdf in headless Chrome', () => {
  let browser: Browser;

  beforeAll(async () => {
    browser = await chromium.launch({ channel: 'chrome', headless: true });
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
  }, 30_000);

  const pdfSpec = spec({ format: 'pdf', filename: 'brief.pdf' });

  it(
    'renders the accepted source to real PDF bytes',
    async () => {
      const accepted = accept(
        '## Findings\n\nThe roster count matches the header [evidence:E777].\n',
      );
      const bytes = await renderPdf(pdfSpec, accepted, lookup, {
        openPage: createPlaywrightPdfPageOpener(browser),
      });

      const raw = Buffer.from(bytes);
      expect(raw.subarray(0, 5).toString('latin1')).toBe('%PDF-');
      expect(raw.subarray(-16).toString('latin1')).toContain('%%EOF');
      expect(raw.byteLength).toBeGreaterThan(1_000);
    },
    30_000,
  );

  it(
    'publishes no raw evidence id inside the PDF text layer',
    async () => {
      // The prose deliberately contains no digit and no capital E, so any
      // digit or "[" in the PDF's own character set could only have come from
      // a leaked "[evidence:E777]" marker.
      const source = '## Findings\n\nThe roster count matches the header [evidence:E777].\n';
      const bytes = await renderPdf(pdfSpec, accept(source), lookup, {
        openPage: createPlaywrightPdfPageOpener(browser),
      });
      const published = pdfCharacters(bytes);

      expect(published.size).toBeGreaterThan(0);
      expect([...published].filter((char) => /[0-9]/.test(char))).toEqual([]);
      for (const leaked of ['E', '[', ']', ':']) {
        expect(published.has(leaked)).toBe(false);
      }
      // The same extraction over a PDF of the UNRENDERED marked source finds
      // exactly those characters, so the assertion above is not vacuous.
      const control = await renderRawHtmlToPdf(browser, renderPdfHtml(pdfSpec, source));
      const leaked = pdfCharacters(control);
      expect(leaked.has('7')).toBe(true);
      expect(leaked.has('E')).toBe(true);
      expect(leaked.has('[')).toBe(true);
    },
    45_000,
  );

  it(
    'aborts every request the page would make',
    async () => {
      const probe = await startRequestProbe();
      try {
        const html = `<html><body><img src="${probe.url}/pixel.png"><p>body</p></body></html>`;

        // Control first: without the abort the probe is reachable, so a zero
        // count below means the abort worked, not that the page never tried.
        const reachable = await renderRawHtmlToPdf(browser, html, { disableNetwork: false });
        expect(Buffer.from(reachable).subarray(0, 5).toString('latin1')).toBe('%PDF-');
        expect(probe.hits()).toBeGreaterThan(0);

        const blocked = await renderRawHtmlToPdf(browser, html, { disableNetwork: true });
        expect(Buffer.from(blocked).subarray(0, 5).toString('latin1')).toBe('%PDF-');
        expect(probe.hits()).toBe(1);
      } finally {
        await probe.close();
      }
    },
    45_000,
  );

  it(
    "renders in its own page and leaves the worker's page untouched",
    async () => {
      const workerContext = await browser.newContext();
      const workerPage = await workerContext.newPage();
      await workerPage.goto('about:blank#worker');
      try {
        await renderPdf(pdfSpec, accept('Body [evidence:E1].\n'), lookup, {
          openPage: createPlaywrightPdfPageOpener(browser),
        });

        expect(workerPage.isClosed()).toBe(false);
        expect(workerPage.url()).toBe('about:blank#worker');
        // The render's own page is gone: nothing but the worker's page is left
        // open anywhere in the browser.
        expect(browser.contexts().flatMap((context) => context.pages())).toEqual([workerPage]);
      } finally {
        await workerContext.close();
      }
    },
    45_000,
  );
});

/** Render arbitrary HTML through the same Playwright seam the renderer uses.
 * Test-only: `renderPdf` never accepts HTML from a caller. */
async function renderRawHtmlToPdf(
  browser: Browser,
  html: string,
  options: { disableNetwork?: boolean } = {},
): Promise<Uint8Array> {
  const page = await createPlaywrightPdfPageOpener(browser)();
  try {
    if (options.disableNetwork !== false) await page.disableNetwork();
    await page.setHtml(html);
    return await page.toPdf();
  } finally {
    await page.close();
  }
}

/**
 * Every character a PDF's embedded fonts can draw, read from the ToUnicode
 * CMaps Chrome writes for its font subsets. A subset holds exactly the glyphs
 * the document uses, so this is how "the published PDF contains no evidence
 * id" is checked on binary output — the text streams themselves are glyph ids,
 * not searchable text.
 */
function pdfCharacters(bytes: Uint8Array): Set<string> {
  const raw = Buffer.from(bytes).toString('latin1');
  const characters = new Set<string>();
  for (const match of raw.matchAll(/stream\r?\n/g)) {
    const start = match.index + match[0].length;
    const end = raw.indexOf('endstream', start);
    if (end < 0) continue;
    const chunk = Buffer.from(raw.slice(start, end), 'latin1');
    let text: string;
    try {
      text = inflateSync(chunk).toString('latin1');
    } catch {
      text = chunk.toString('latin1');
    }
    for (const block of text.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
      for (const pair of (block[1] ?? '').matchAll(/<[0-9A-Fa-f]+>\s*<([0-9A-Fa-f]+)>/g)) {
        characters.add(String.fromCodePoint(Number.parseInt(pair[1]!, 16)));
      }
    }
    for (const block of text.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
      for (const range of (block[1] ?? '').matchAll(
        /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g,
      )) {
        const span = Number.parseInt(range[2]!, 16) - Number.parseInt(range[1]!, 16);
        const first = Number.parseInt(range[3]!, 16);
        for (let offset = 0; offset <= span; offset += 1) {
          characters.add(String.fromCodePoint(first + offset));
        }
      }
    }
  }
  return characters;
}

/** A loopback server that only counts requests, so "the page fetched
 * something" is directly observable. */
async function startRequestProbe(): Promise<{
  url: string;
  hits: () => number;
  close: () => Promise<void>;
}> {
  let hits = 0;
  const server: Server = createServer((_request, response) => {
    hits += 1;
    response.writeHead(200, { 'content-type': 'image/png' });
    response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('request probe did not bind a port');
  }
  return {
    url: `http://127.0.0.1:${address.port}`,
    hits: () => hits,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
