// Lightweight byte sniffing shared by the worker and verifier file readers.
// Extensions and transport media types are only hints: recognizable bytes
// always win so a mislabeled download is not described as the wrong format.

type ContentFormat = 'pdf' | 'spreadsheet' | 'image' | 'html' | 'json' | 'csv' | 'text';

interface ContentDetectionRequest {
  bytes: Uint8Array;
  mediaType?: string;
  filename?: string;
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
export function detectContentFormat(request: ContentDetectionRequest): ContentFormat {
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

/** Split text into lines on \n or \r\n; a trailing newline does not produce
 * a phantom empty final line (cat -n counts "a\nb\n" as two lines). */
export function splitLines(content: string): string[] {
  const lines = content.split(/\r?\n/);
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}
