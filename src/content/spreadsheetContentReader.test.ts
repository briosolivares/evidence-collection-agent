import { describe, expect, it } from 'vitest';

import {
  createSpreadsheetContentReader,
  DEFAULT_SPREADSHEET_ROW_SPAN,
  type ExcelCellLike,
  type ExcelJsLike,
  type SpreadsheetMetadata,
} from './spreadsheetContentReader.js';

// Driven against a fake exceljs. The behaviour under test is the adapter's:
// exact cell addresses, the displayed-versus-underlying distinction, bounded
// row ranges, continuation, and cancellation.

interface FakeSheet {
  name: string;
  rows: ExcelCellLike[][];
}

function fakeExcelJs(sheets: FakeSheet[], onRow?: (rowNumber: number) => void): ExcelJsLike {
  return {
    Workbook: class {
      xlsx = { load: async () => undefined };
      worksheets = sheets.map((sheet) => ({
        name: sheet.name,
        rowCount: sheet.rows.length,
        getRow: (rowNumber: number) => ({
          eachCell: (
            _options: { includeEmpty: boolean },
            callback: (cell: ExcelCellLike, columnNumber: number) => void,
          ) => {
            onRow?.(rowNumber);
            const cells = sheet.rows[rowNumber - 1] ?? [];
            cells.forEach((cell, index) => callback(cell, index + 1));
          },
        }),
      }));
    },
  } as unknown as ExcelJsLike;
}

const XLSX_BYTES = new Uint8Array(Buffer.from('PKxl/workbook.xml', 'latin1'));

function reader(sheets: FakeSheet[], defaultSheet?: string, onRow?: (row: number) => void) {
  return createSpreadsheetContentReader({
    loadExcelJs: async () => fakeExcelJs(sheets, onRow),
    ...(defaultSheet === undefined ? {} : { defaultSheet }),
  });
}

describe('createSpreadsheetContentReader', () => {
  it('reports exact A1 addresses for every cell', async () => {
    const observation = await reader([
      {
        name: 'Sheet1',
        rows: [
          [
            { address: 'A1', text: 'name' },
            { address: 'B1', text: 'count' },
          ],
        ],
      },
    ]).read({ bytes: XLSX_BYTES });

    const cells = (observation.metadata as SpreadsheetMetadata).cells;
    expect(cells.map((cell) => cell.address)).toEqual(['A1', 'B1']);
    expect(observation.locator).toBe('Sheet1!1-1');
  });

  it('separates the displayed value from the underlying one', async () => {
    // The distinction that silently corrupts deliverables: 42% displayed,
    // 0.42 stored; "1,234" displayed, 1234 stored.
    const observation = await reader([
      {
        name: 'Sheet1',
        rows: [
          [
            { address: 'A1', text: '42%', value: 0.42 },
            { address: 'B1', text: '1,234', value: 1234 },
            { address: 'C1', text: 'plain', value: 'plain' },
          ],
        ],
      },
    ]).read({ bytes: XLSX_BYTES });

    const cells = (observation.metadata as SpreadsheetMetadata).cells;
    expect(cells[0]).toMatchObject({ displayed: '42%', underlying: 0.42 });
    expect(cells[1]).toMatchObject({ displayed: '1,234', underlying: 1234 });
    // When they agree, `underlying` is omitted rather than duplicated.
    expect(cells[2]?.underlying).toBeUndefined();
  });

  it('reports a formula and its computed result', async () => {
    const observation = await reader([
      {
        name: 'Sheet1',
        rows: [[{ address: 'A1', text: '7', value: { formula: 'SUM(B1:B3)', result: 7 }, formula: 'SUM(B1:B3)' }]],
      },
    ]).read({ bytes: XLSX_BYTES });

    const [cell] = (observation.metadata as SpreadsheetMetadata).cells;
    expect(cell?.formula).toBe('SUM(B1:B3)');
    // The result, not the formula object, is the underlying value.
    expect(cell?.underlying === 7 || cell?.underlying === undefined).toBe(true);
  });

  it('flattens a date and rich text into JSON-safe underlying values', async () => {
    const observation = await reader([
      {
        name: 'Sheet1',
        rows: [
          [
            { address: 'A1', text: 'Mar 4', value: new Date('2026-03-04T00:00:00Z') },
            // Displayed text deliberately differs from the concatenated runs,
            // so the flattening is observable rather than collapsing into
            // "same as displayed" and being omitted.
            { address: 'B1', text: 'truncated…', value: { richText: [{ text: 'bold ' }, { text: 'text' }] } },
          ],
        ],
      },
    ]).read({ bytes: XLSX_BYTES });

    const cells = (observation.metadata as SpreadsheetMetadata).cells;
    expect(cells[0]?.underlying).toBe('2026-03-04T00:00:00.000Z');
    expect(cells[1]?.underlying).toBe('bold text');
  });

  it('omits underlying when it matches the displayed text exactly', async () => {
    // Not duplicating an identical value is deliberate: a reader should only
    // see `underlying` when it is genuinely something else, so its presence
    // is a real signal rather than noise on every cell.
    const observation = await reader([
      {
        name: 'Sheet1',
        rows: [
          [
            { address: 'A1', text: 'bold text', value: { richText: [{ text: 'bold ' }, { text: 'text' }] } },
            { address: 'B1', text: 'plain', value: 'plain' },
          ],
        ],
      },
    ]).read({ bytes: XLSX_BYTES });

    const cells = (observation.metadata as SpreadsheetMetadata).cells;
    expect(cells[0]?.displayed).toBe('bold text');
    expect(cells[0]?.underlying).toBeUndefined();
    expect(cells[1]?.underlying).toBeUndefined();
  });

  it('lists every sheet so the caller can move on deliberately', async () => {
    const observation = await reader([
      { name: 'First', rows: [[{ address: 'A1', text: 'a' }]] },
      { name: 'Second', rows: [[{ address: 'A1', text: 'b' }]] },
    ]).read({ bytes: XLSX_BYTES });

    const metadata = observation.metadata as SpreadsheetMetadata;
    expect(metadata.sheetNames).toEqual(['First', 'Second']);
    // The first sheet is the default.
    expect(metadata.sheetName).toBe('First');
  });

  it('reads a named sheet and rejects an unknown one by name', async () => {
    const sheets: FakeSheet[] = [
      { name: 'First', rows: [[{ address: 'A1', text: 'a' }]] },
      { name: 'Second', rows: [[{ address: 'A1', text: 'b' }]] },
    ];
    const observation = await reader(sheets, 'Second').read({ bytes: XLSX_BYTES });
    expect((observation.metadata as SpreadsheetMetadata).sheetName).toBe('Second');

    await expect(reader(sheets, 'Missing').read({ bytes: XLSX_BYTES })).rejects.toThrow(
      /no sheet named "Missing"/,
    );
  });

  it('bounds the default read and names the continuation', async () => {
    const rows = Array.from({ length: DEFAULT_SPREADSHEET_ROW_SPAN + 10 }, (_, index) => [
      { address: `A${index + 1}`, text: `row ${index + 1}` },
    ]);
    const observation = await reader([{ name: 'Sheet1', rows }]).read({ bytes: XLSX_BYTES });

    expect((observation.metadata as SpreadsheetMetadata).rowsRead).toEqual({
      from: 1,
      to: DEFAULT_SPREADSHEET_ROW_SPAN,
    });
    expect(observation.continuation).toEqual({
      from: DEFAULT_SPREADSHEET_ROW_SPAN + 1,
      to: DEFAULT_SPREADSHEET_ROW_SPAN + 10,
    });
    expect(observation.total).toBe(DEFAULT_SPREADSHEET_ROW_SPAN + 10);
  });

  it('omits the continuation once the last row is covered', async () => {
    const observation = await reader([
      { name: 'Sheet1', rows: [[{ address: 'A1', text: 'only' }]] },
    ]).read({ bytes: XLSX_BYTES });
    expect(observation.continuation).toBeUndefined();
  });

  it('rejects an invalid range before reading', async () => {
    await expect(
      reader([{ name: 'Sheet1', rows: [[{ address: 'A1', text: 'a' }]] }]).read({
        bytes: XLSX_BYTES,
        range: { from: 3, to: 1 },
      }),
    ).rejects.toThrow(/range\.to/);
  });

  it('rejects a workbook with no sheets rather than returning nothing', async () => {
    await expect(reader([]).read({ bytes: XLSX_BYTES })).rejects.toThrow(/no sheets/);
  });

  it('stops between rows when cancelled', async () => {
    const controller = new AbortController();
    const visited: number[] = [];
    const rows = Array.from({ length: 20 }, (_, index) => [
      { address: `A${index + 1}`, text: `row ${index + 1}` },
    ]);

    const pending = reader([{ name: 'Sheet1', rows }], undefined, (rowNumber) => {
      visited.push(rowNumber);
      if (rowNumber === 3) controller.abort();
    }).read({ bytes: XLSX_BYTES, range: { from: 1, to: 20 }, signal: controller.signal });

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(visited.length).toBeLessThan(20);
  });
});
