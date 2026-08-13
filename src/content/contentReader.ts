// Non-HTML evidence, made observable through the same bounded
// representation as everything else. A PDF, a spreadsheet, and a scanned
// image are all things a run legitimately has to read, and none of them is
// served usefully by "download it and hope".
//
// Two boundaries shape this registry:
//
//  1. Format is detected from TRUSTED BYTES plus the media type, never from a
//     filename extension alone. An extension is attacker- and
//     mistake-controlled; a magic number is what the file actually is. A
//     `.csv` that is really a PDF must be read as a PDF, and a `.pdf` that is
//     really HTML must not be handed to a PDF parser.
//  2. Every read is BOUNDED and resumable. An adapter returns a chunk plus an
//     explicit continuation range, so the model asks for the next range
//     rather than receiving a whole 400-page document it cannot use.

/** Content this registry can route. */
export type ContentFormat = 'pdf' | 'spreadsheet' | 'image' | 'html' | 'json' | 'csv' | 'text';

/** One bounded slice of a document, with enough provenance to cite it. */
export interface ContentObservation {
  format: ContentFormat;
  /** The slice's text, already bounded by the request. */
  text: string;
  /** Where this slice came from, precisely enough to re-read or cite:
   * `page 3`, `Sheet1!A1:D20`, `image 2`. */
  locator: string;
  /** The range that would continue this read, when more remains. Absent
   * means the document was fully covered. */
  continuation?: ContentRange;
  /** Total extent, when the adapter can determine it cheaply (page count,
   * sheet row count). */
  total?: number;
  /** Adapter-specific provenance the caller must not lose: OCR engine and
   * confidence, a spreadsheet's underlying vs displayed values, a PDF's
   * bounding boxes. */
  metadata?: Record<string, unknown>;
}

/** A bounded, 1-based, inclusive range. */
export interface ContentRange {
  from: number;
  to: number;
}

/** One read request. */
export interface ContentReadRequest {
  /** The bytes to read. */
  bytes: Uint8Array;
  /** Media type from the transport, when known — combined with the bytes to
   * decide the format, never trusted alone. */
  mediaType?: string;
  /** Filename, used only as a last-resort hint and never over the bytes. */
  filename?: string;
  /** Which slice to read; the adapter's own default when omitted. */
  range?: ContentRange;
  /** Cancellation for CPU-heavy parsing and OCR. */
  signal?: AbortSignal;
}

/** One format's reader. */
export interface ContentReader {
  /** Stable name, for diagnostics. */
  readonly name: string;
  /** The formats this reader handles. */
  readonly formats: readonly ContentFormat[];
  read(request: ContentReadRequest): Promise<ContentObservation>;
}

/** Routes a read to the adapter for its detected format. */
export interface ContentReaderRegistry {
  /** The format these bytes actually are. */
  detect(request: Pick<ContentReadRequest, 'bytes' | 'mediaType' | 'filename'>): ContentFormat;
  /** Read through the adapter for the detected format. */
  read(request: ContentReadRequest): Promise<ContentObservation>;
  /** The adapter registered for a format, if any. */
  readerFor(format: ContentFormat): ContentReader | undefined;
}

/** Thrown when no adapter handles a detected format. */
export class UnsupportedContentError extends Error {
  override readonly name = 'UnsupportedContentError';
  readonly format: ContentFormat;

  constructor(format: ContentFormat) {
    super(`no content reader registered for ${format}`);
    this.format = format;
  }
}

/** Validate a range: 1-based, inclusive, ordered, finite. */
export function assertContentRange(range: ContentRange): void {
  for (const [label, value] of [
    ['from', range.from],
    ['to', range.to],
  ] as const) {
    if (!Number.isInteger(value) || value < 1) {
      throw new Error(`range.${label} must be an integer >= 1, got ${value}`);
    }
  }
  if (range.to < range.from) {
    throw new Error(`range.to (${range.to}) must be >= range.from (${range.from})`);
  }
}

/**
 * Detect a format from bytes first, media type second, filename last.
 *
 * Magic numbers checked, written as hex rather than embedded literally (a raw
 * control byte in source makes `file(1)` report it as binary and makes
 * `grep -r` skip the whole file): `%PDF-` for PDF; the ZIP local-file header
 * 50 4B 03 04 combined with an `xl/` entry for XLSX — a bare ZIP is NOT
 * assumed to be a spreadsheet, since .docx and .odt are ZIPs too; D0 CF 11 E0
 * for legacy XLS/OLE2; and the PNG, JPEG, GIF, BMP, and WEBP signatures for
 * images. Text-shaped content then falls through to JSON/HTML/CSV/text by
 * cheap structural inspection.
 */
export function detectContentFormat(
  request: Pick<ContentReadRequest, 'bytes' | 'mediaType' | 'filename'>,
): ContentFormat {
  const bytes = request.bytes;

  if (startsWithAscii(bytes, '%PDF-')) return 'pdf';
  if (isZip(bytes)) {
    // Only a ZIP that actually contains a spreadsheet part is a spreadsheet;
    // .docx and .odt are ZIPs too.
    return containsAscii(bytes, 'xl/', 4096) ? 'spreadsheet' : 'text';
  }
  if (matchesBytes(bytes, [0xd0, 0xcf, 0x11, 0xe0])) return 'spreadsheet';
  if (isImage(bytes)) return 'image';

  // Text-shaped from here. The media type is a useful hint but does not
  // override structure: servers mislabel constantly.
  const head = decodeHead(bytes, 2048).trimStart();
  if (head.startsWith('{') || head.startsWith('[')) return 'json';
  if (/^<(?:!doctype html|html|\?xml|!--)/i.test(head)) return 'html';

  const mediaType = (request.mediaType ?? '').toLowerCase();
  if (mediaType.includes('json')) return 'json';
  if (mediaType.includes('html')) return 'html';
  if (mediaType.includes('csv')) return 'csv';

  // A first line of comma- or tab-separated fields, with a consistent field
  // count on the next line, reads as CSV; anything else is plain text.
  if (looksTabular(head)) return 'csv';
  if ((request.filename ?? '').toLowerCase().endsWith('.csv')) return 'csv';
  return 'text';
}

/** Build a registry over the given adapters. Later adapters override earlier
 * ones for the same format, so a caller can substitute one deliberately. */
export function createContentReaderRegistry(
  readers: readonly ContentReader[],
): ContentReaderRegistry {
  const byFormat = new Map<ContentFormat, ContentReader>();
  for (const reader of readers) {
    for (const format of reader.formats) byFormat.set(format, reader);
  }

  return {
    detect: (request) => detectContentFormat(request),
    readerFor: (format) => byFormat.get(format),
    async read(request) {
      if (request.range !== undefined) assertContentRange(request.range);
      const format = detectContentFormat(request);
      const reader = byFormat.get(format);
      if (reader === undefined) throw new UnsupportedContentError(format);
      return reader.read(request);
    },
  };
}

/** Whether a signal has already been aborted; adapters call this between
 * chunks so cancellation is observed without waiting for a whole parse. */
export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted === true) {
    throw Object.assign(new Error('content read aborted'), { name: 'AbortError' });
  }
}

function startsWithAscii(bytes: Uint8Array, prefix: string): boolean {
  if (bytes.length < prefix.length) return false;
  for (let index = 0; index < prefix.length; index += 1) {
    if (bytes[index] !== prefix.charCodeAt(index)) return false;
  }
  return true;
}

function matchesBytes(bytes: Uint8Array, signature: readonly number[]): boolean {
  if (bytes.length < signature.length) return false;
  return signature.every((byte, index) => bytes[index] === byte);
}

function isZip(bytes: Uint8Array): boolean {
  return matchesBytes(bytes, [0x50, 0x4b, 0x03, 0x04]);
}

function isImage(bytes: Uint8Array): boolean {
  return (
    matchesBytes(bytes, [0x89, 0x50, 0x4e, 0x47]) || // PNG
    matchesBytes(bytes, [0xff, 0xd8, 0xff]) || // JPEG
    matchesBytes(bytes, [0x47, 0x49, 0x46, 0x38]) || // GIF
    matchesBytes(bytes, [0x42, 0x4d]) || // BMP
    (matchesBytes(bytes, [0x52, 0x49, 0x46, 0x46]) && containsAscii(bytes, 'WEBP', 16))
  );
}

function containsAscii(bytes: Uint8Array, needle: string, withinBytes: number): boolean {
  return decodeHead(bytes, withinBytes).includes(needle);
}

function decodeHead(bytes: Uint8Array, limit: number): string {
  return Buffer.from(bytes.subarray(0, Math.min(bytes.length, limit))).toString('latin1');
}

/** A cheap CSV heuristic: the first two non-empty lines share a delimiter and
 * the same field count, and there is more than one field. */
function looksTabular(head: string): boolean {
  const lines = head.split(/\r?\n/).filter((line) => line.trim() !== '');
  if (lines.length < 2) return false;
  for (const delimiter of [',', '\t', ';']) {
    const first = lines[0]!.split(delimiter).length;
    if (first < 2) continue;
    if (lines[1]!.split(delimiter).length === first) return true;
  }
  return false;
}
