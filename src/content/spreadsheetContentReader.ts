import {
  assertContentRange,
  throwIfAborted,
  type ContentObservation,
  type ContentReadRequest,
  type ContentReader,
} from './contentReader.js';

// Spreadsheet cells with exact addresses, and with the distinction that
// matters most in a spreadsheet: DISPLAYED value versus UNDERLYING value.
//
// A cell showing "42%" may hold 0.42; a cell showing "Mar 4" may hold a
// serial date; a cell showing "1,234" may hold 1234 or the string "1,234". A
// run that copies the displayed text into a numeric column produces a
// deliverable that is wrong in a way nobody notices. Both are therefore
// reported, and the caller chooses deliberately.
//
// exceljs is loaded lazily: most runs never open a workbook.

/** Rows read per call when the caller names no range. */
export const DEFAULT_SPREADSHEET_ROW_SPAN = 50;

/** Hard ceiling per call. */
export const MAX_SPREADSHEET_ROW_SPAN = 500;

/** One cell, with its address and both readings. */
export interface SpreadsheetCell {
  /** A1-style address within its sheet. */
  address: string;
  /** What a person reading the sheet sees. */
  displayed: string;
  /** What the cell actually holds, when it differs from `displayed`. */
  underlying?: string | number | boolean | null;
  /** The formula, when the cell is computed. */
  formula?: string;
}

/** What a spreadsheet observation adds to the shared shape. */
export interface SpreadsheetMetadata extends Record<string, unknown> {
  /** Every sheet in the workbook, so the caller can choose the next one. */
  sheetNames: string[];
  sheetName: string;
  rowsRead: { from: number; to: number };
  rowCount: number;
  cells: SpreadsheetCell[];
}

/** The exceljs surface this adapter uses, declared locally so it can be
 * tested against a fake. */
export interface ExcelJsLike {
  Workbook: new () => {
    xlsx: { load(data: Uint8Array): Promise<unknown> };
    worksheets: Array<{
      name: string;
      rowCount: number;
      getRow(rowNumber: number): {
        eachCell(
          options: { includeEmpty: boolean },
          callback: (cell: ExcelCellLike, columnNumber: number) => void,
        ): void;
      };
    }>;
  };
}

/** One exceljs cell, as much of it as this adapter reads. */
export interface ExcelCellLike {
  address?: string;
  text?: string;
  value?: unknown;
  formula?: string;
}

/** Options; the loader and sheet selection are the caller's choices. */
export interface SpreadsheetContentReaderOptions {
  loadExcelJs?: () => Promise<ExcelJsLike>;
  /** Which sheet to read when the request names none; defaults to the first. */
  defaultSheet?: string;
}

/**
 * Create the spreadsheet adapter.
 *
 * Reads a bounded row range from one sheet, reporting each cell's exact
 * address, displayed text, and — when they differ — underlying value and
 * formula. The observation lists every sheet name so the caller can move on
 * deliberately rather than guessing.
 */
export function createSpreadsheetContentReader(
  options: SpreadsheetContentReaderOptions = {},
): ContentReader {
  const loadExcelJs =
    options.loadExcelJs ??
    (async (): Promise<ExcelJsLike> => {
      const module = await import('exceljs');
      return (module.default ?? module) as unknown as ExcelJsLike;
    });

  return {
    name: 'spreadsheet',
    formats: ['spreadsheet'],
    async read(request: ContentReadRequest): Promise<ContentObservation> {
      throwIfAborted(request.signal);
      const excel = await loadExcelJs();
      throwIfAborted(request.signal);

      const workbook = new excel.Workbook();
      await workbook.xlsx.load(request.bytes);
      throwIfAborted(request.signal);

      const sheetNames = workbook.worksheets.map((sheet) => sheet.name);
      if (sheetNames.length === 0) throw new Error('workbook contains no sheets');

      const wanted = options.defaultSheet;
      const sheet =
        wanted === undefined
          ? workbook.worksheets[0]!
          : (workbook.worksheets.find((candidate) => candidate.name === wanted) ??
            (() => {
              throw new Error(
                `workbook has no sheet named ${JSON.stringify(wanted)}; sheets: ${sheetNames.join(', ')}`,
              );
            })());

      const rowCount = sheet.rowCount;
      const requested =
        request.range ?? { from: 1, to: Math.min(Math.max(rowCount, 1), DEFAULT_SPREADSHEET_ROW_SPAN) };
      assertContentRange(requested);
      const from = requested.from;
      const to = Math.min(requested.to, Math.max(rowCount, 1), from + MAX_SPREADSHEET_ROW_SPAN - 1);

      const cells: SpreadsheetCell[] = [];
      const lines: string[] = [];
      for (let rowNumber = from; rowNumber <= to; rowNumber += 1) {
        throwIfAborted(request.signal);
        const row = sheet.getRow(rowNumber);
        const rowCells: string[] = [];
        row.eachCell({ includeEmpty: true }, (cell, columnNumber) => {
          const address = cell.address ?? `${columnLetter(columnNumber)}${rowNumber}`;
          const displayed = cell.text ?? '';
          const underlying = normalizeValue(cell.value);
          const differs =
            underlying !== null && underlying !== undefined && String(underlying) !== displayed;
          cells.push({
            address,
            displayed,
            ...(differs ? { underlying } : {}),
            ...(cell.formula === undefined ? {} : { formula: cell.formula }),
          });
          rowCells.push(displayed);
        });
        lines.push(rowCells.join('\t'));
      }

      const metadata: SpreadsheetMetadata = {
        sheetNames,
        sheetName: sheet.name,
        rowsRead: { from, to },
        rowCount,
        cells,
      };
      return {
        format: 'spreadsheet',
        text: lines.join('\n'),
        locator: `${sheet.name}!${from}-${to}`,
        ...(to < rowCount
          ? {
              continuation: {
                from: to + 1,
                to: Math.min(rowCount, to + DEFAULT_SPREADSHEET_ROW_SPAN),
              },
            }
          : {}),
        total: rowCount,
        metadata,
      };
    },
  };
}

/** Reduce an exceljs value to something JSON-safe, preserving the
 * distinction the caller needs (a formula result, a date, a plain scalar). */
function normalizeValue(value: unknown): string | number | boolean | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    // A computed cell: exceljs reports { formula, result }.
    if ('result' in record) return normalizeValue(record['result']);
    // Rich text: concatenate the runs.
    if (Array.isArray(record['richText'])) {
      return (record['richText'] as Array<{ text?: string }>)
        .map((run) => run.text ?? '')
        .join('');
    }
    if ('text' in record) return normalizeValue(record['text']);
  }
  return String(value);
}

/** 1-based column number to its A1 letter(s). */
function columnLetter(columnNumber: number): string {
  let remaining = columnNumber;
  let letters = '';
  while (remaining > 0) {
    const remainder = (remaining - 1) % 26;
    letters = String.fromCharCode(65 + remainder) + letters;
    remaining = Math.floor((remaining - 1) / 26);
  }
  return letters;
}
