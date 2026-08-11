/** A CSV document split into its header row and data rows. */
export interface ParsedCsv {
  /** Header cell text, in column order, quotes and escaping resolved. */
  header: string[];
  /** Data rows (every row after the header), each in column order. */
  rows: string[][];
}

/**
 * Parse CSV text (RFC 4180-shaped: comma-delimited, fields optionally
 * wrapped in double quotes with `""` as an escaped quote, quoted fields may
 * contain commas or newlines) into a header row and data rows.
 *
 * @param text - raw file content of a CSV document
 * @returns the first row as `header`, every subsequent row as `rows`; a
 *   trailing newline does not produce a phantom empty final row
 * @throws if `text` contains no rows at all (empty or whitespace-only input)
 */
export function parseCsv(text: string): ParsedCsv {
  const rows = parseCsvRows(text);
  if (rows.length === 0) {
    throw new Error('CSV text has no rows (empty file)');
  }
  const [header, ...dataRows] = rows;
  return { header: header!, rows: dataRows };
}

/**
 * Parse CSV text into raw rows of cells, header included — the primitive
 * `parseCsv` builds on. Exposed separately because some callers (e.g. a
 * "does this look like a CSV at all" check) want rows without assuming any
 * row is a header.
 *
 * @param text - raw file content of a CSV document
 * @returns one array of cell strings per row, in document order; an empty
 *   or whitespace-only document returns an empty array
 */
export function parseCsvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let inQuotes = false;
  // Whether the current row has seen at least one character since the last
  // row break, so a lone trailing "\n" at EOF doesn't emit a phantom row.
  let rowHasContent = false;

  const endCell = (): void => {
    row.push(cell);
    cell = '';
  };
  const endRow = (): void => {
    endCell();
    rows.push(row);
    row = [];
    rowHasContent = false;
  };

  for (let i = 0; i < text.length; i++) {
    const char = text[i]!;

    if (inQuotes) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cell += char;
      }
      rowHasContent = true;
      continue;
    }

    if (char === '"') {
      inQuotes = true;
      rowHasContent = true;
    } else if (char === ',') {
      endCell();
      rowHasContent = true;
    } else if (char === '\r') {
      // Bare \r or the \r of \r\n: the following \n (if any) is consumed
      // on the next loop iteration and closes the row on its own.
      continue;
    } else if (char === '\n') {
      endRow();
    } else {
      cell += char;
      rowHasContent = true;
    }
  }
  if (rowHasContent) {
    endRow();
  }
  return rows;
}
