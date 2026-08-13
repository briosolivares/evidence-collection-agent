import type { Browser, Page } from 'playwright';

import {
  splitSourceLines,
  type AcceptedDocumentSource,
  type DocumentEvidenceLookup,
  type DocumentOutputSpec,
  type EvidenceMarker,
} from './documentSource.js';

// Turning an accepted, evidence-marked source into the published deliverable.
// Same inversion as renderTable.ts: the model writes the source, application
// code writes the file. What differs is what is being owned — not quoting and
// escaping, but the CITATION APPARATUS. The model never hand-maintains
// footnote numbers or hand-deletes its own markers, because both are
// mechanical and both fail silently when done by hand (a renumbered footnote
// pointing at the wrong record reads exactly like a correct one).
//
// Every renderer here is a pure function of an AcceptedDocumentSource, which
// only documentSource.ts can produce. That is the whole reason the type
// exists: it makes "these bytes were checked against the marked source"
// unforgeable, and it makes the Markdown, text, and PDF renderings of one
// document provably the same document — renderPdf calls renderDocument rather
// than re-deriving anything.
//
// Two presentations, one rule each:
//
//  - `hidden` deletes the markers. The published file must contain no raw
//    evidence id at all, so the removal also tidies the whitespace the marker
//    was holding open; otherwise a stripped citation leaves "the gap said .".
//  - `footnotes` replaces each marker with a stable number and appends a
//    readable source list. Numbers are assigned by first appearance, per id,
//    so re-rendering the same source always produces the same references.

/** Heading of the appended source list in footnote mode. */
export const SOURCES_HEADING = 'Sources';

/**
 * Render the finished text of a document output.
 *
 * @param spec - the contract's document output; its `format` selects the
 *   Markdown/plain flavor of the footnote apparatus and its
 *   `evidencePresentation` selects hidden or footnoted citations
 * @param accepted - a source that passed `validateDocumentEvidence`
 * @param lookup - resolves cited ids to their summary and source URL; used
 *   only by footnote mode, and required unconditionally so a caller cannot
 *   accidentally build a footnoted document with no way to describe its
 *   sources
 * @returns the exact text to publish, normalized to LF line endings, with no
 *   leading blank lines and exactly one trailing newline. For a `pdf`
 *   output this is the text the PDF is rendered FROM (see {@link renderPdf}),
 *   which is why one function serves all three formats
 */
export function renderDocument(
  spec: DocumentOutputSpec,
  accepted: AcceptedDocumentSource,
  lookup: DocumentEvidenceLookup,
): string {
  switch (spec.evidencePresentation) {
    case 'hidden':
      return renderHiddenEvidence(accepted.source, accepted.markers);
    case 'footnotes':
      return renderEvidenceFootnotes(accepted.source, accepted.markers, lookup, {
        // Only a Markdown deliverable gets a Markdown heading; a text file or
        // a PDF's text layer would show the `##` literally.
        style: spec.format === 'markdown' ? 'markdown' : 'plain',
      });
  }
}

/**
 * Strip every evidence marker, leaving prose a reader would not know was
 * marked.
 *
 * @param source - the marked source
 * @param markers - its markers, as parsed from that exact source (offsets are
 *   taken at face value; markers from a different string would corrupt the
 *   output, which is why callers pass an AcceptedDocumentSource's own pair)
 * @returns the source with all markers removed and the whitespace they held
 *   open closed up: a space before a marker is dropped when what follows is
 *   punctuation, whitespace, or the end of the line; trailing whitespace on a
 *   line a marker was removed from is trimmed; a line that held nothing but
 *   markers is deleted along with one adjacent blank line, so a citation on
 *   its own line does not leave a double paragraph break. No raw evidence id
 *   survives — that is the property this function exists for
 */
export function renderHiddenEvidence(
  source: string,
  markers: readonly EvidenceMarker[],
): string {
  return rewriteMarkers(source, markers, () => '');
}

/**
 * Replace every marker with a stable numbered reference and append a readable
 * source list.
 *
 * @param source - the marked source
 * @param markers - its markers, as parsed from that exact source
 * @param lookup - resolves each cited id to its summary and source URL
 * @param options - `style: 'markdown'` heads the list with `## Sources`;
 *   `'plain'` (the default) uses a bare `Sources` line, for text and PDF
 *   deliverables
 * @returns the source with each marker replaced by `[n]` (or `[n, m]` when
 *   one marker cites several records) and a source list appended, one line
 *   per number: the number, the evidence id, its one-line summary, and its
 *   source URL when it has one. Numbering is by first appearance per id, so a
 *   record cited three times is `[2]` all three times and re-rendering is
 *   byte-stable. An id the lookup cannot resolve is listed as unavailable
 *   rather than silently dropped — validation rules this out, and a renderer
 *   that hid it would turn a bug into a plausible-looking citation
 */
export function renderEvidenceFootnotes(
  source: string,
  markers: readonly EvidenceMarker[],
  lookup: DocumentEvidenceLookup,
  options: { style?: 'markdown' | 'plain' } = {},
): string {
  const numbers = new Map<string, number>();
  for (const marker of markers) {
    for (const id of marker.evidenceIds) {
      if (!numbers.has(id)) numbers.set(id, numbers.size + 1);
    }
  }

  const body = rewriteMarkers(source, markers, (marker) =>
    // A marker with no usable id is stripped rather than rendered as "[]".
    // validateDocumentEvidence rejects those, so this is the defensive branch
    // for direct callers of this renderer.
    marker.evidenceIds.length === 0
      ? ''
      : `[${marker.evidenceIds.map((id) => numbers.get(id)!).join(', ')}]`,
  );
  if (numbers.size === 0) return body;

  const heading = options.style === 'markdown' ? `## ${SOURCES_HEADING}` : SOURCES_HEADING;
  const entries = [...numbers.entries()].map(([id, number]) => {
    const evidence = lookup(id);
    if (evidence === undefined) {
      return `[${number}] ${id} — record unavailable in this run`;
    }
    const url = evidence.sourceUrl === undefined ? '' : ` (${evidence.sourceUrl})`;
    return `[${number}] ${id} — ${evidence.summary}${url}`;
  });
  return `${body}\n${heading}\n\n${entries.join('\n')}\n`;
}

/** A page dedicated to one PDF render. Narrow on purpose: the renderer must
 * be able to prove it disabled the network before loading anything, and must
 * not be able to reach a page it did not open. */
export interface PdfRenderPage {
  /** Block every network request this page could make. Called before any
   * content is loaded; a page that cannot honor this must throw, because a
   * "local" render that silently fetched a font or a tracking pixel is not
   * the deterministic, offline render the contract promises. */
  disableNetwork(): Promise<void>;
  /** Load the fixed local template, already filled in. */
  setHtml(html: string): Promise<void>;
  /** Render the loaded page to PDF bytes. */
  toPdf(): Promise<Uint8Array>;
  /** Release the page. Called exactly once per render, success or failure. */
  close(): Promise<void>;
}

/** What {@link renderPdf} needs from the runtime. */
export interface RenderPdfDeps {
  /**
   * Open a page dedicated to this one render. Must never hand back the
   * worker's selected page: rendering into it would navigate the agent's
   * browsing session away mid-run, invalidating every ref and observation the
   * model is holding — and the PDF would inherit that page's cookies,
   * extensions, and network policy instead of this renderer's.
   */
  openPage: () => Promise<PdfRenderPage>;
}

/**
 * Render a document output to PDF bytes.
 *
 * @param spec - the contract's document output (format `pdf`)
 * @param accepted - a source that passed `validateDocumentEvidence`
 * @param lookup - resolves cited ids for footnote mode
 * @param deps - supplies the dedicated page
 * @returns the PDF bytes, ready to publish. The text is produced by
 *   {@link renderDocument} — the same call the Markdown and text formats use
 *   — so a hidden-citation PDF contains no raw evidence id either, and a
 *   footnoted one carries the same numbered references as its text sibling
 * @throws whatever the page seam throws (launch failure, a page that cannot
 *   disable the network, a render timeout). The page is always closed; a
 *   close failure after a successful render is swallowed, since losing a
 *   rendered deliverable to a teardown error would be the worse outcome
 */
export async function renderPdf(
  spec: DocumentOutputSpec,
  accepted: AcceptedDocumentSource,
  lookup: DocumentEvidenceLookup,
  deps: RenderPdfDeps,
): Promise<Uint8Array> {
  const html = renderPdfHtml(spec, renderDocument(spec, accepted, lookup));
  const page = await deps.openPage();
  let bytes: Uint8Array;
  try {
    // Order is the contract: nothing is loaded until the network is off.
    await page.disableNetwork();
    await page.setHtml(html);
    bytes = await page.toPdf();
  } catch (thrown) {
    await closeQuietly(page);
    throw thrown;
  }
  await closeQuietly(page);
  return bytes;
}

/**
 * Fill the fixed local HTML template with one document's text.
 *
 * @param spec - the contract's document output; its filename becomes the
 *   document title, which is the only place the template varies besides the
 *   body
 * @param text - the rendered document text (from {@link renderDocument})
 * @returns a complete, self-contained HTML document: no external stylesheet,
 *   font, script, or image, and a `default-src 'none'` CSP so even a
 *   mis-wired page could not fetch one. The body is a deliberately small
 *   block-level Markdown reading — ATX headings, bullet and numbered lists,
 *   thematic breaks, and paragraphs whose internal line breaks are preserved.
 *   Inline syntax (emphasis, links, code spans) is NOT interpreted: it is
 *   escaped and shown literally, because a half-implemented inline parser
 *   would silently eat characters out of a deliverable
 */
export function renderPdfHtml(spec: DocumentOutputSpec, text: string): string {
  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    `<meta http-equiv="Content-Security-Policy" content="${PDF_CSP}">`,
    `<title>${escapeHtml(spec.filename)}</title>`,
    `<style>${PDF_STYLESHEET}</style>`,
    '</head>',
    '<body>',
    toHtmlBody(text),
    '</body>',
    '</html>',
    '',
  ].join('\n');
}

/**
 * Adapt a Playwright browser (or context) to the PDF page seam.
 *
 * @param source - anything that can open a fresh page. Prefer a `Browser`:
 *   its `newPage()` also creates a fresh context, so the render shares no
 *   cookies, storage, or service workers with the agent's session
 * @returns an `openPage` function for {@link RenderPdfDeps}. Each call opens
 *   a NEW page — the worker's selected page is unreachable from here by
 *   construction — routes every request to `abort`, prints with the fixed
 *   page setup below, and closes the page when the render is done
 */
export function createPlaywrightPdfPageOpener(
  source: Pick<Browser, 'newPage'>,
): () => Promise<PdfRenderPage> {
  return async (): Promise<PdfRenderPage> => {
    const page = await source.newPage();
    return {
      async disableNetwork(): Promise<void> {
        // Every request, including the ones a stray stylesheet or favicon
        // would make: the render must be a pure function of local bytes, and
        // an aborted request is observable in the trace while a silently
        // successful one is not.
        await page.route('**/*', (route) => {
          void route.abort('blockedbyclient');
        });
      },
      async setHtml(html: string): Promise<void> {
        await page.setContent(html, { waitUntil: 'load' });
        // Print media, so the stylesheet's @page rules and print colors are
        // what gets measured.
        await page.emulateMedia({ media: 'print' });
      },
      async toPdf(): Promise<Uint8Array> {
        return page.pdf(PDF_PAGE_OPTIONS);
      },
      async close(): Promise<void> {
        await page.close();
      },
    };
  };
}

/** Page setup for every rendered PDF. Fixed rather than contract-driven:
 * paper size and margins are presentation, and a deliverable that changed
 * shape between runs would be impossible to diff. Header and footer stay off
 * — Chrome's default footer stamps the print DATE into the file, which would
 * make two renders of identical text differ. */
const PDF_PAGE_OPTIONS: NonNullable<Parameters<Page['pdf']>[0]> = {
  format: 'Letter',
  printBackground: true,
  displayHeaderFooter: false,
  preferCSSPageSize: false,
  margin: { top: '0.75in', right: '0.75in', bottom: '0.75in', left: '0.75in' },
};

/** Belt and braces beside the route-abort: even a page that never routed
 * would have nothing to fetch. `style-src 'unsafe-inline'` is the one
 * allowance the inline stylesheet below needs. */
const PDF_CSP = "default-src 'none'; style-src 'unsafe-inline'";

/** The template's entire stylesheet. System fonts only — a webfont would be
 * a network fetch, and a missing one would silently change the layout. */
const PDF_STYLESHEET = [
  '@page { size: Letter; }',
  'body { font-family: -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;',
  ' font-size: 11pt; line-height: 1.45; color: #111; margin: 0; }',
  'h1 { font-size: 20pt; margin: 0 0 12pt; }',
  'h2 { font-size: 15pt; margin: 16pt 0 8pt; }',
  'h3 { font-size: 12.5pt; margin: 14pt 0 6pt; }',
  'h4, h5, h6 { font-size: 11pt; margin: 12pt 0 6pt; }',
  'p { margin: 0 0 8pt; }',
  'ul, ol { margin: 0 0 8pt; padding-left: 18pt; }',
  'li { margin: 0 0 3pt; }',
  'hr { border: 0; border-top: 1px solid #999; margin: 12pt 0; }',
  'h1, h2, h3, h4, h5, h6 { page-break-after: avoid; }',
].join('\n');

/** Rewrite every marker in a source, one line at a time.
 *
 * Line-scoped because a marker can never span a line break (see the grammar
 * in documentSource.ts): every removal or replacement is therefore a local
 * edit, and the only cross-line rule — dropping a line that held nothing but
 * markers — is decided with the neighbours in hand. */
function rewriteMarkers(
  source: string,
  markers: readonly EvidenceMarker[],
  replace: (marker: EvidenceMarker) => string,
): string {
  const lines = splitSourceLines(source);
  const rendered: string[] = [];
  /** Set when a marker-only line was dropped between two blank lines: the
   * next blank line is dropped with it so the paragraph break stays single. */
  let dropNextBlank = false;

  for (const line of lines) {
    const lineMarkers = markers.filter(
      (marker) => marker.start >= line.start && marker.start < line.end,
    );

    if (lineMarkers.length === 0) {
      if (dropNextBlank && line.text.trim() === '') {
        dropNextBlank = false;
        continue;
      }
      dropNextBlank = false;
      rendered.push(line.text);
      continue;
    }

    let out = '';
    let cursor = 0;
    let removedAny = false;
    for (const marker of lineMarkers) {
      out += line.text.slice(cursor, marker.start - line.start);
      cursor = marker.end - line.start;
      const replacement = replace(marker);
      if (replacement !== '') {
        out += replacement;
        continue;
      }
      removedAny = true;
      const after = line.text.slice(cursor);
      if (/[ \t]$/.test(out) && (after === '' || /^[\s.,;:!?)\]}'"’”]/.test(after))) {
        // "the gap [evidence:E1]." → "the gap." — the space was holding the
        // marker, not separating words.
        out = out.replace(/[ \t]+$/, '');
      } else if (out.trim() === '' && /^[ \t]/.test(after)) {
        // A marker at the start of a line takes the space that followed it,
        // so the sentence does not begin with a space.
        cursor += /^[ \t]+/.exec(after)![0].length;
      }
    }
    out += line.text.slice(cursor);
    if (removedAny) out = out.replace(/[ \t]+$/, '');

    if (out.trim() === '' && line.text.trim() !== '') {
      // The line was nothing but citation bookkeeping.
      dropNextBlank = rendered.length === 0 || rendered.at(-1)!.trim() === '';
      continue;
    }
    if (dropNextBlank && out.trim() === '') {
      dropNextBlank = false;
      continue;
    }
    dropNextBlank = false;
    rendered.push(out);
  }

  // LF endings, no leading blank lines, exactly one trailing newline: the
  // published bytes must depend on the text, not on the platform or on how
  // many times the model pressed return at the end.
  return `${rendered.join('\n').replace(/^\n+/, '').replace(/\s+$/, '')}\n`;
}

/** Close a render page without letting teardown mask the render's outcome. */
async function closeQuietly(page: PdfRenderPage): Promise<void> {
  try {
    await page.close();
  } catch {
    // A leaked page costs one tab in a short-lived browser; a thrown close
    // would cost the caller a rendered deliverable or the real error.
  }
}

/** The block-level Markdown subset the PDF template understands. Everything
 * else is escaped and shown as written. */
function toHtmlBody(text: string): string {
  const html: string[] = [];
  /** The open list element, so consecutive items share one list. */
  let list: 'ul' | 'ol' | undefined;
  /** Lines of the paragraph currently being accumulated. */
  let paragraph: string[] = [];

  const closeParagraph = (): void => {
    if (paragraph.length === 0) return;
    html.push(`<p>${paragraph.join('<br>')}</p>`);
    paragraph = [];
  };
  const closeList = (): void => {
    if (list === undefined) return;
    html.push(`</${list}>`);
    list = undefined;
  };
  const openList = (kind: 'ul' | 'ol'): void => {
    if (list === kind) return;
    closeList();
    html.push(`<${kind}>`);
    list = kind;
  };

  for (const line of text.split('\n')) {
    if (line.trim() === '') {
      closeParagraph();
      closeList();
      continue;
    }

    const heading = /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (heading !== null) {
      closeParagraph();
      closeList();
      const level = heading[1]!.length;
      html.push(`<h${level}>${escapeHtml(heading[2] ?? '')}</h${level}>`);
      continue;
    }

    if (/^ {0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) {
      closeParagraph();
      closeList();
      html.push('<hr>');
      continue;
    }

    const bullet = /^ {0,3}[-*+]\s+(.*)$/.exec(line);
    if (bullet !== null) {
      closeParagraph();
      openList('ul');
      html.push(`<li>${escapeHtml(bullet[1] ?? '')}</li>`);
      continue;
    }

    const numbered = /^ {0,3}\d+[.)]\s+(.*)$/.exec(line);
    if (numbered !== null) {
      closeParagraph();
      openList('ol');
      html.push(`<li>${escapeHtml(numbered[1] ?? '')}</li>`);
      continue;
    }

    // A continuation line inside a list item belongs to that item's text;
    // outside one it extends the current paragraph. Keeping the line break
    // (<br>) rather than joining with a space preserves a plain-text
    // document's deliberate wrapping, which Markdown's own rules would erase.
    closeList();
    paragraph.push(escapeHtml(line.trim()));
  }
  closeParagraph();
  closeList();
  return html.join('\n');
}

/** Escape the five characters that could change the template's structure. */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
