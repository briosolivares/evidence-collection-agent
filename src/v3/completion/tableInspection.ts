import { isValid as isValidDate, parse as parseDate } from 'date-fns';

import type {
  OutputColumn,
  OutputSpec,
  TableRule,
} from '../../contracts/outputContract.js';
import type { V3FinishDefect, V3TableFact } from './types.js';

interface ParsedCell {
  raw: unknown;
  text: string;
  representation: 'text' | 'json';
}

interface ParsedTable {
  columns: string[];
  rows: Array<Record<string, ParsedCell>>;
  hasShapeDefects: boolean;
}

export const V3_TABLE_MAX_BYTES = 16 * 1024 * 1024;
export const V3_TABLE_MAX_ROWS = 100_000;
export const V3_TABLE_MAX_CELLS = 1_000_000;
export const V3_TABLE_MAX_DEFECTS = 100;

const TABLE_POLL_INTERVAL = 16 * 1024;

export interface TableInspectionLimits {
  maxBytes: number;
  maxRows: number;
  maxCells: number;
  maxDefects: number;
}

export interface TableInspectionOptions {
  /** Trusted cancellation/deadline guard. A thrown value propagates unchanged. */
  checkActive?: () => void;
  /** Tests may lower hard production ceilings, never raise them. */
  limits?: Partial<TableInspectionLimits>;
}

interface TableInspectionContext {
  output: Extract<OutputSpec, { kind: 'table' }>;
  artifactPath: string;
  limits: TableInspectionLimits;
  checkActive?: () => void;
  defects: V3FinishDefect[];
  halted: boolean;
}

const DEFAULT_TABLE_INSPECTION_LIMITS: TableInspectionLimits = {
  maxBytes: V3_TABLE_MAX_BYTES,
  maxRows: V3_TABLE_MAX_ROWS,
  maxCells: V3_TABLE_MAX_CELLS,
  maxDefects: V3_TABLE_MAX_DEFECTS,
};

export function inspectTable(
  output: Extract<OutputSpec, { kind: 'table' }>,
  artifactPath: string,
  bytes: Uint8Array,
  options: TableInspectionOptions = {},
): { defects: V3FinishDefect[]; fact?: V3TableFact } {
  const context: TableInspectionContext = {
    output,
    artifactPath,
    limits: resolveTableInspectionLimits(options.limits),
    ...(options.checkActive === undefined
      ? {}
      : { checkActive: options.checkActive }),
    defects: [],
    halted: false,
  };
  poll(context);
  if (bytes.byteLength > context.limits.maxBytes) {
    stopForLimit(
      context,
      'table_bytes_limit_exceeded',
      `${artifactPath} is ${bytes.byteLength} bytes, above the ` +
        `${context.limits.maxBytes}-byte deterministic table-inspection limit. ` +
        'Reduce or split the table before finishing.',
    );
    return { defects: context.defects };
  }
  if (output.columns.length > context.limits.maxCells) {
    stopForCellLimit(context, output.columns.length);
    return { defects: context.defects };
  }

  const text = decodeUtf8(bytes);
  poll(context);
  if (text === undefined) {
    recordDefect(
      context,
      'invalid_text_encoding',
      `${artifactPath} is not valid UTF-8 ${output.format} text. Re-publish it with the declared table encoding.`,
    );
    return { defects: context.defects };
  }
  if (text.trim().length === 0) {
    recordDefect(context, 'empty_output', `${artifactPath} contains no table content.`);
    return { defects: context.defects };
  }

  const parsed = parseDeclaredTable(text, context);
  if (parsed === undefined || context.halted) return { defects: context.defects };

  const expectedColumns = tableColumnNames(output.columns, context);
  if (!sameOrderedStrings(parsed.columns, expectedColumns, context)) {
    recordDefect(
      context,
      'column_mismatch',
      `${artifactPath} has columns [${parsed.columns.join(', ')}], but the contract requires exactly [${expectedColumns.join(', ')}] in that order.`,
    );
    return { defects: context.defects };
  }

  if (!parsed.hasShapeDefects) {
    validateCells(parsed.rows, context);
    if (!context.halted) validateRules(parsed.rows, context);
  }

  poll(context);
  if (context.defects.length > 0) return { defects: context.defects };
  return {
    defects: [],
    fact: {
      kind: 'table',
      outputId: output.id,
      artifactPath,
      format: output.format,
      columns: expectedColumns,
      rowCount: parsed.rows.length,
      satisfiedRules: tableRuleTypes(output.rules, context),
    },
  };
}

function parseDeclaredTable(
  text: string,
  context: TableInspectionContext,
): ParsedTable | undefined {
  const { output, artifactPath } = context;
  poll(context);
  switch (output.format) {
    case 'csv': {
      const parsed = parseCsvRecords(text, context);
      if (parsed === undefined) return undefined;
      if ('error' in parsed) {
        recordDefect(
          context,
          'unparseable_csv',
          `${artifactPath} is not valid CSV: ${parsed.error}.`,
        );
        return undefined;
      }
      if (parsed.records.length === 0) {
        recordDefect(
          context,
          'missing_table_header',
          `${artifactPath} contains no CSV header row.`,
        );
        return undefined;
      }
      const columns: string[] = [];
      for (let index = 0; index < parsed.records[0]!.length; index += 1) {
        pollEvery(context, index);
        columns.push(parsed.records[0]![index]!);
      }
      if (columns[0]?.startsWith('\uFEFF')) columns[0] = columns[0].slice(1);
      const rowCount = parsed.records.length - 1;
      if (normalizedCellsExceed(columns.length, rowCount, context)) {
        return undefined;
      }
      const rows: Array<Record<string, ParsedCell>> = [];
      let hasShapeDefects = false;
      for (let index = 0; index < rowCount; index += 1) {
        poll(context);
        const cells = parsed.records[index + 1]!;
        if (cells.length !== columns.length) {
          hasShapeDefects = true;
          if (!recordDefect(
            context,
            'row_shape_mismatch',
            `${artifactPath} CSV row ${index + 1} has ${cells.length} cell(s), but its header has ${columns.length}.`,
          )) {
            return undefined;
          }
        }
        rows.push(rowFromTextCells(columns, cells, context));
        if (context.halted) return undefined;
      }
      return { columns, rows, hasShapeDefects };
    }
    case 'json': {
      let value: unknown;
      try {
        value = JSON.parse(text);
      } catch (error) {
        recordDefect(
          context,
          'unparseable_json',
          `${artifactPath} is not valid JSON: ${errorMessage(error)}.`,
        );
        return undefined;
      }
      poll(context);
      if (!Array.isArray(value)) {
        recordDefect(
          context,
          'json_not_array',
          `${artifactPath} must contain one JSON array of row objects.`,
        );
        return undefined;
      }
      if (value.length > context.limits.maxRows) {
        stopForRowLimit(context, value.length);
        return undefined;
      }
      const expected = tableColumnNames(output.columns, context);
      if (normalizedCellsExceed(expected.length, value.length, context)) {
        return undefined;
      }
      const rows: Array<Record<string, ParsedCell>> = [];
      let observedCells = 0;
      let hasShapeDefects = false;
      for (let index = 0; index < value.length; index += 1) {
        poll(context);
        const row = value[index];
        if (typeof row !== 'object' || row === null || Array.isArray(row)) {
          hasShapeDefects = true;
          if (!recordDefect(
            context,
            'row_shape_mismatch',
            `${artifactPath} JSON row ${index + 1} must be an object with exactly the declared columns.`,
          )) {
            return undefined;
          }
          rows.push(emptyJsonRow(expected, context));
          if (context.halted) return undefined;
          continue;
        }
        const record = row as Record<string, unknown>;
        const keys = Object.keys(record);
        observedCells = safeAdd(observedCells, keys.length);
        if (observedCells > context.limits.maxCells) {
          stopForCellLimit(context, observedCells);
          return undefined;
        }
        if (!sameOrderedStrings(keys, expected, context)) {
          hasShapeDefects = true;
          if (!recordDefect(
            context,
            'row_shape_mismatch',
            `${artifactPath} JSON row ${index + 1} has keys [${keys.join(', ')}], but the contract requires exactly [${expected.join(', ')}] in that order.`,
          )) {
            return undefined;
          }
        }
        const normalized: Record<string, ParsedCell> = {};
        for (let columnIndex = 0; columnIndex < expected.length; columnIndex += 1) {
          pollEvery(context, columnIndex);
          const column = expected[columnIndex]!;
          const raw = record[column];
          normalized[column] = {
            raw,
            text: raw === null || raw === undefined ? '' : String(raw),
            representation: 'json',
          };
        }
        rows.push(normalized);
      }
      return { columns: expected, rows, hasShapeDefects };
    }
    case 'markdown': {
      const parsed = parseMarkdownTable(text, context);
      if (parsed === undefined) {
        if (!context.halted) {
          recordDefect(
            context,
            'missing_markdown_table',
            `${artifactPath} contains no Markdown pipe table with a header and separator row.`,
          );
        }
        return undefined;
      }
      if (normalizedCellsExceed(parsed.columns.length, parsed.rows.length, context)) {
        return undefined;
      }
      const rows: Array<Record<string, ParsedCell>> = [];
      let hasShapeDefects = false;
      for (let index = 0; index < parsed.rows.length; index += 1) {
        poll(context);
        const cells = parsed.rows[index]!;
        if (cells.length !== parsed.columns.length) {
          hasShapeDefects = true;
          if (!recordDefect(
            context,
            'row_shape_mismatch',
            `${artifactPath} Markdown row ${index + 1} has ${cells.length} cell(s), but its header has ${parsed.columns.length}.`,
          )) {
            return undefined;
          }
        }
        rows.push(rowFromTextCells(parsed.columns, cells, context));
        if (context.halted) return undefined;
      }
      return {
        columns: parsed.columns,
        rows,
        hasShapeDefects,
      };
    }
  }
}

function validateCells(
  rows: readonly Record<string, ParsedCell>[],
  context: TableInspectionContext,
): void {
  const { output, artifactPath } = context;
  for (const [rowIndex, row] of rows.entries()) {
    poll(context);
    for (let columnIndex = 0; columnIndex < output.columns.length; columnIndex += 1) {
      pollEvery(context, columnIndex);
      const column = output.columns[columnIndex]!;
      const cell = row[column.name] ?? {
        raw: undefined,
        text: '',
        representation: 'text' as const,
      };
      const blank =
        cell.raw === null ||
        cell.raw === undefined ||
        (typeof cell.raw === 'string' && cell.raw.trim() === '');
      if (blank) {
        if (column.required) {
          if (!recordDefect(
            context,
            'missing_required_value',
            `${artifactPath} row ${rowIndex + 1} has no value for required column ${JSON.stringify(column.name)}.`,
          )) return;
        }
        continue;
      }
      const message = invalidCellMessage(column, cell);
      if (message !== undefined) {
        if (!recordDefect(
          context,
          'invalid_column_value',
          `${artifactPath} row ${rowIndex + 1}, column ${JSON.stringify(column.name)} ${message}.`,
        )) return;
      }
    }
  }
}

function invalidCellMessage(column: OutputColumn, cell: ParsedCell): string | undefined {
  switch (column.type) {
    case 'string':
      if (cell.representation === 'json' && typeof cell.raw !== 'string') {
        return 'must be a string';
      }
      if (/^[=+\-@\t\r]/.test(cell.text)) {
        return `starts with a spreadsheet formula character (${JSON.stringify(cell.text[0])})`;
      }
      return undefined;
    case 'integer':
      if (cell.representation === 'json') {
        return typeof cell.raw === 'number' && Number.isInteger(cell.raw)
          ? undefined
          : 'must be an integer';
      }
      return /^[+-]?\d+$/.test(cell.text.trim()) ? undefined : 'must be an integer';
    case 'number':
      if (cell.representation === 'json') {
        return typeof cell.raw === 'number' && Number.isFinite(cell.raw)
          ? undefined
          : 'must be a finite number';
      }
      return cell.text.trim() !== '' && Number.isFinite(Number(cell.text))
        ? undefined
        : 'must be a finite number';
    case 'boolean':
      if (cell.representation === 'json') {
        return typeof cell.raw === 'boolean' ? undefined : 'must be a boolean';
      }
      return /^(?:true|false)$/i.test(cell.text.trim())
        ? undefined
        : 'must be true or false';
    case 'url':
      if (typeof cell.raw !== 'string') return 'must be an HTTP(S) URL string';
      try {
        const protocol = new URL(cell.raw).protocol;
        return protocol === 'http:' || protocol === 'https:'
          ? undefined
          : `must use HTTP(S), not ${protocol}`;
      } catch {
        return 'is not a valid URL';
      }
    case 'enum':
      if (typeof cell.raw !== 'string' || !column.values.includes(cell.raw)) {
        return `must be one of [${column.values.join(', ')}]`;
      }
      return undefined;
    case 'date':
      if (typeof cell.raw !== 'string') return 'must be a date string';
    case 'datetime':
      if (typeof cell.raw !== 'string') return `must be a ${column.type} string`;
      switch (column.format.kind) {
        case 'iso_date':
          return isIsoDate(cell.raw) ? undefined : 'must use a valid YYYY-MM-DD date';
        case 'iso_datetime':
          return /^\d{4}-\d{2}-\d{2}T/.test(cell.raw) &&
            !Number.isNaN(Date.parse(cell.raw))
            ? undefined
            : 'must use a valid ISO datetime';
        case 'unicode_pattern':
          return matchesUnicodeDatePattern(cell.raw, column.format.pattern)
            ? undefined
            : `must match ${column.type} pattern ${JSON.stringify(column.format.pattern)}`;
      }
  }
}

function validateRules(
  rows: readonly Record<string, ParsedCell>[],
  context: TableInspectionContext,
): void {
  const { output, artifactPath } = context;
  for (const rule of output.rules) {
    poll(context);
    switch (rule.type) {
      case 'exact_row_count':
        if (rows.length !== rule.value) {
          if (!recordDefect(
            context,
            'row_count_mismatch',
            `${artifactPath} has ${rows.length} data row(s); the contract requires exactly ${rule.value}.`,
          )) return;
        }
        break;
      case 'minimum_row_count':
        if (rows.length < rule.value) {
          if (!recordDefect(
            context,
            'row_count_below_minimum',
            `${artifactPath} has ${rows.length} data row(s); the contract requires at least ${rule.value}.`,
          )) return;
        }
        break;
      case 'unique': {
        const seen = new Map<string, number>();
        for (const [index, row] of rows.entries()) {
          poll(context);
          const values: string[] = [];
          for (let columnIndex = 0; columnIndex < rule.columns.length; columnIndex += 1) {
            pollEvery(context, columnIndex);
            values.push(row[rule.columns[columnIndex]!]?.text ?? '');
          }
          const key = JSON.stringify(values);
          const first = seen.get(key);
          if (first !== undefined) {
            if (!recordDefect(
              context,
              'duplicate_rows',
              `${artifactPath} rows ${first + 1} and ${index + 1} repeat the same [${rule.columns.join(', ')}] values, which must be unique.`,
            )) return;
            break;
          }
          seen.set(key, index);
        }
        break;
      }
      case 'matches_expected_values':
        validateExpectedValues(rows, rule, context);
        if (context.halted) return;
        break;
    }
  }
}

function validateExpectedValues(
  rows: readonly Record<string, ParsedCell>[],
  rule: Extract<TableRule, { type: 'matches_expected_values' }>,
  context: TableInspectionContext,
): void {
  const { artifactPath } = context;
  const present = new Set<string>();
  for (const row of rows) {
    poll(context);
    present.add(row[rule.column]?.text.trim() ?? '');
  }
  const missing: string[] = [];
  for (const value of rule.expected) {
    poll(context);
    if (!present.has(value)) missing.push(value);
  }
  if (missing.length > 0) {
    if (!recordDefect(
      context,
      'missing_expected_values',
      `${artifactPath} column ${JSON.stringify(rule.column)} is missing required value(s): ${formatValues(missing, context)}.`,
    )) return;
  }
  if (rule.exhaustive === true) {
    const allowed = new Set(rule.expected);
    const unexpected: string[] = [];
    for (const value of present) {
      poll(context);
      if (!allowed.has(value)) unexpected.push(value);
    }
    if (unexpected.length > 0) {
      recordDefect(
        context,
        'unexpected_values',
        `${artifactPath} column ${JSON.stringify(rule.column)} contains value(s) outside the contract's exhaustive set: ${formatValues(unexpected, context)}.`,
      );
    }
  }
}

function parseCsvRecords(
  text: string,
  context: TableInspectionContext,
): { records: string[][] } | { error: string } | undefined {
  const records: string[][] = [];
  let record: string[] = [];
  let field = '';
  let inQuotes = false;
  let closedQuote = false;
  let observedCells = 0;

  const finishField = (): boolean => {
    observedCells = safeAdd(observedCells, 1);
    if (observedCells > context.limits.maxCells) {
      stopForCellLimit(context, observedCells);
      return false;
    }
    record.push(field);
    field = '';
    closedQuote = false;
    return true;
  };
  const finishRecord = (skipTerminalEmpty = false): boolean => {
    if (skipTerminalEmpty && record.length === 0 && field === '' && !closedQuote) {
      return true;
    }
    if (records.length >= 1 && records.length > context.limits.maxRows) {
      stopForRowLimit(context, records.length);
      return false;
    }
    if (!finishField()) return false;
    records.push(record);
    record = [];
    return true;
  };

  for (let index = 0; index < text.length; index += 1) {
    pollEvery(context, index);
    const character = text[index]!;
    if (inQuotes) {
      if (character === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          inQuotes = false;
          closedQuote = true;
        }
      } else {
        field += character;
      }
      continue;
    }

    if (closedQuote && character !== ',' && character !== '\r' && character !== '\n') {
      return { error: `unexpected character ${JSON.stringify(character)} after a closing quote` };
    }
    if (character === '"') {
      if (field.length > 0) return { error: 'a quoted field begins after unquoted text' };
      inQuotes = true;
    } else if (character === ',') {
      if (!finishField()) return undefined;
    } else if (character === '\r' || character === '\n') {
      if (character === '\r' && text[index + 1] === '\n') index += 1;
      if (!finishRecord(index + 1 === text.length)) return undefined;
    } else {
      field += character;
    }
  }
  if (inQuotes) return { error: 'unterminated quoted field' };
  if (
    (field.length > 0 || record.length > 0 || closedQuote) &&
    !finishRecord()
  ) return undefined;
  return { records };
}

function parseMarkdownTable(
  text: string,
  context: TableInspectionContext,
): { columns: string[]; rows: string[][] } | undefined {
  let first = readMarkdownLine(text, 0);
  while (first !== undefined) {
    poll(context);
    const second = readMarkdownLine(text, first.nextOffset);
    if (second === undefined) return undefined;
    const columns = splitMarkdownRow(first.value, context);
    if (context.halted) return undefined;
    const separator = splitMarkdownRow(second.value, context);
    if (context.halted) return undefined;
    if (
      columns === undefined ||
      separator === undefined ||
      columns.length === 0 ||
      separator.length !== columns.length ||
      !isMarkdownSeparator(separator, context)
    ) {
      first = second;
      continue;
    }

    const normalizedColumns: string[] = [];
    for (let index = 0; index < columns.length; index += 1) {
      pollEvery(context, index);
      normalizedColumns.push(columns[index]!.trim());
    }
    const rows: string[][] = [];
    let observedCells = normalizedColumns.length;
    let next = readMarkdownLine(text, second.nextOffset);
    while (next !== undefined) {
      poll(context);
      if (next.value.trim() === '') break;
      const cells = splitMarkdownRow(next.value, context);
      if (context.halted) return undefined;
      if (cells === undefined) break;
      if (rows.length >= context.limits.maxRows) {
        stopForRowLimit(context, rows.length + 1);
        return undefined;
      }
      observedCells = safeAdd(observedCells, cells.length);
      if (observedCells > context.limits.maxCells) {
        stopForCellLimit(context, observedCells);
        return undefined;
      }
      const normalizedRow: string[] = [];
      for (let index = 0; index < cells.length; index += 1) {
        pollEvery(context, index);
        normalizedRow.push(cells[index]!.trim());
      }
      rows.push(normalizedRow);
      next = readMarkdownLine(text, next.nextOffset);
    }
    return { columns: normalizedColumns, rows };
  }
  return undefined;
}

interface MarkdownLine {
  value: string;
  nextOffset: number;
}

function readMarkdownLine(text: string, offset: number): MarkdownLine | undefined {
  if (offset >= text.length) return undefined;
  const newline = text.indexOf('\n', offset);
  const rawEnd = newline === -1 ? text.length : newline;
  const end = rawEnd > offset && text[rawEnd - 1] === '\r' ? rawEnd - 1 : rawEnd;
  return {
    value: text.slice(offset, end),
    nextOffset: newline === -1 ? text.length : newline + 1,
  };
}

function splitMarkdownRow(
  line: string,
  context: TableInspectionContext,
): string[] | undefined {
  const trimmed = line.trim();
  if (!trimmed.includes('|')) return undefined;
  const body = trimmed.startsWith('|') ? trimmed.slice(1) : trimmed;
  const withoutOuter = body.endsWith('|') ? body.slice(0, -1) : body;
  const cells: string[] = [];
  let cell = '';
  let escaped = false;
  for (let index = 0; index < withoutOuter.length; index += 1) {
    pollEvery(context, index);
    const character = withoutOuter[index]!;
    if (escaped) {
      cell += character;
      escaped = false;
    } else if (character === '\\') {
      escaped = true;
    } else if (character === '|') {
      cells.push(cell);
      if (cells.length > context.limits.maxCells) {
        stopForCellLimit(context, cells.length);
        return undefined;
      }
      cell = '';
    } else {
      cell += character;
    }
  }
  if (escaped) cell += '\\';
  cells.push(cell);
  if (cells.length > context.limits.maxCells) {
    stopForCellLimit(context, cells.length);
    return undefined;
  }
  return cells;
}

function isMarkdownSeparator(
  cells: readonly string[],
  context: TableInspectionContext,
): boolean {
  for (let index = 0; index < cells.length; index += 1) {
    pollEvery(context, index);
    if (!/^:?-{3,}:?$/.test(cells[index]!.trim())) return false;
  }
  return true;
}

function rowFromTextCells(
  columns: readonly string[],
  cells: readonly string[],
  context: TableInspectionContext,
): Record<string, ParsedCell> {
  const row: Record<string, ParsedCell> = {};
  for (let index = 0; index < columns.length; index += 1) {
    pollEvery(context, index);
    const column = columns[index]!;
    const text = cells[index] ?? '';
    row[column] = { raw: text, text, representation: 'text' };
  }
  return row;
}

function emptyJsonRow(
  columns: readonly string[],
  context: TableInspectionContext,
): Record<string, ParsedCell> {
  const row: Record<string, ParsedCell> = {};
  for (let index = 0; index < columns.length; index += 1) {
    pollEvery(context, index);
    const column = columns[index]!;
    row[column] = { raw: undefined, text: '', representation: 'json' };
  }
  return row;
}

function isIsoDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (match === null) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

function matchesUnicodeDatePattern(value: string, pattern: string): boolean {
  try {
    return isValidDate(parseDate(value, pattern, new Date(0)));
  } catch {
    return false;
  }
}

function sameOrderedStrings(
  left: readonly string[],
  right: readonly string[],
  context: TableInspectionContext,
): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    pollEvery(context, index);
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function tableColumnNames(
  columns: readonly OutputColumn[],
  context: TableInspectionContext,
): string[] {
  const names: string[] = [];
  for (let index = 0; index < columns.length; index += 1) {
    pollEvery(context, index);
    names.push(columns[index]!.name);
  }
  return names;
}

function tableRuleTypes(
  rules: readonly TableRule[],
  context: TableInspectionContext,
): Array<TableRule['type']> {
  const types: Array<TableRule['type']> = [];
  for (let index = 0; index < rules.length; index += 1) {
    pollEvery(context, index);
    types.push(rules[index]!.type);
  }
  return types;
}

function formatValues(
  values: readonly string[],
  context: TableInspectionContext,
): string {
  const rendered: string[] = [];
  for (let index = 0; index < values.length; index += 1) {
    pollEvery(context, index);
    rendered.push(JSON.stringify(values[index]));
  }
  return rendered.join(', ');
}

function decodeUtf8(bytes: Uint8Array): string | undefined {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

function defect(
  output: Extract<OutputSpec, { kind: 'table' }>,
  artifactPath: string,
  code: string,
  message: string,
): V3FinishDefect {
  return { code, message, outputId: output.id, artifactPath };
}

function resolveTableInspectionLimits(
  overrides: Partial<TableInspectionLimits> | undefined,
): TableInspectionLimits {
  const limits = { ...DEFAULT_TABLE_INSPECTION_LIMITS, ...overrides };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`${name} must be a positive safe integer, got ${value}`);
    }
    const hardMaximum = DEFAULT_TABLE_INSPECTION_LIMITS[
      name as keyof TableInspectionLimits
    ];
    if (value > hardMaximum) {
      throw new Error(`${name} cannot exceed the hard maximum ${hardMaximum}, got ${value}`);
    }
  }
  return limits;
}

function normalizedCellsExceed(
  columnCount: number,
  rowCount: number,
  context: TableInspectionContext,
): boolean {
  const rowAndHeaderCount = safeAdd(rowCount, 1);
  if (
    columnCount > 0 &&
    rowAndHeaderCount > Math.floor(context.limits.maxCells / columnCount)
  ) {
    stopForCellLimit(context, context.limits.maxCells + 1);
    return true;
  }
  return false;
}

function recordDefect(
  context: TableInspectionContext,
  code: string,
  message: string,
): boolean {
  const next = defect(context.output, context.artifactPath, code, message);
  if (context.defects.length < context.limits.maxDefects) {
    context.defects.push(next);
    return true;
  }

  context.defects[context.limits.maxDefects - 1] = defect(
    context.output,
    context.artifactPath,
    'table_defect_limit_exceeded',
    `${context.artifactPath} has more than ${context.limits.maxDefects} deterministic ` +
      'table defects. Inspection stopped at the bounded diagnostic limit; fix the ' +
      'reported issues and retry.',
  );
  context.halted = true;
  return false;
}

function stopForLimit(
  context: TableInspectionContext,
  code: string,
  message: string,
): void {
  const limitDefect = defect(context.output, context.artifactPath, code, message);
  if (context.defects.length < context.limits.maxDefects) {
    context.defects.push(limitDefect);
  } else {
    context.defects[context.limits.maxDefects - 1] = limitDefect;
  }
  context.halted = true;
}

function stopForRowLimit(
  context: TableInspectionContext,
  observedRows: number,
): void {
  stopForLimit(
    context,
    'table_row_limit_exceeded',
    `${context.artifactPath} contains at least ${observedRows} data rows, above the ` +
      `${context.limits.maxRows}-row deterministic table-inspection limit. ` +
      'Reduce or split the table before finishing.',
  );
}

function stopForCellLimit(
  context: TableInspectionContext,
  observedCells: number,
): void {
  stopForLimit(
    context,
    'table_cell_limit_exceeded',
    `${context.artifactPath} requires at least ${observedCells} header/data cells, ` +
      `above the ${context.limits.maxCells}-cell deterministic table-inspection ` +
      'limit. Reduce or split the table before finishing.',
  );
}

function poll(context: TableInspectionContext): void {
  context.checkActive?.();
}

function pollEvery(context: TableInspectionContext, index: number): void {
  if (index % TABLE_POLL_INTERVAL === 0) poll(context);
}

function safeAdd(left: number, right: number): number {
  return left > Number.MAX_SAFE_INTEGER - right
    ? Number.MAX_SAFE_INTEGER
    : left + right;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
