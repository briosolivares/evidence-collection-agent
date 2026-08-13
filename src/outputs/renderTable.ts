import { stringify } from 'csv-stringify/sync';
import { format as formatDate } from 'date-fns';
import { TZDate } from '@date-fns/tz';

import type { OutputColumn, OutputSpec } from '../contracts/outputContract.js';
import type { OutputTable } from './outputTable.js';

// Rendering a table output. The contract decides the columns and their
// order; application code decides the bytes. The model never emits CSV
// syntax, which is the point: quoting, escaping, delimiters, and date
// formatting are the exact places hand-written output goes subtly wrong, and
// they are all mechanical.
//
// Formatter versions are pinned (csv-stringify, date-fns, @date-fns/tz) so a
// dependency bump cannot silently change a deliverable's bytes.
//
// One deliberate non-behavior: this renderer does NOT defuse
// formula-leading strings by prefixing them. A leading =, +, -, or @ is
// rejected at row validation instead (see outputTable.ts), because quietly
// rewriting a requested value changes the data the run was asked to produce.
// CSV quoting alone is not a formula safeguard — Excel parses a quoted
// leading = as a formula anyway — so the only honest options are "reject" or
// "alter the value", and rejecting keeps the artifact faithful.

/** Render a table to the bytes its contract format requires. */
export function renderOutputTable(
  spec: Extract<OutputSpec, { kind: 'table' }>,
  table: OutputTable,
): string {
  switch (spec.format) {
    case 'csv':
      return renderCsv(spec, table);
    case 'json':
      return renderJson(spec, table);
    case 'markdown':
      return renderMarkdownTable(spec, table);
  }
}

/**
 * CSV with a header row of exactly the contract's columns in order.
 *
 * @returns RFC 4180 CSV ending in one newline. Only declared columns appear,
 *   in declared order, whatever order the row's own keys happen to be in —
 *   so an extra key that slipped past validation still cannot reach the file
 */
export function renderCsv(
  spec: Extract<OutputSpec, { kind: 'table' }>,
  table: OutputTable,
): string {
  const columns = spec.columns.map((column) => column.name);
  const records = table.rows.map((row) =>
    spec.columns.map((column) => renderCell(column, row.values[column.name])),
  );
  return stringify([columns, ...records], { record_delimiter: '\n' });
}

/**
 * JSON: an array of row objects whose keys are the contract's columns in
 * order. Values keep their JSON types (numbers as numbers, booleans as
 * booleans) rather than being stringified — a JSON consumer expects that.
 */
export function renderJson(
  spec: Extract<OutputSpec, { kind: 'table' }>,
  table: OutputTable,
): string {
  const records = table.rows.map((row) => {
    const record: Record<string, string | number | boolean | null> = {};
    for (const column of spec.columns) {
      const value = row.values[column.name];
      record[column.name] =
        column.type === 'date' || column.type === 'datetime'
          ? renderCell(column, value)
          : (value ?? null);
    }
    return record;
  });
  return `${JSON.stringify(records, null, 2)}\n`;
}

/**
 * A GitHub-flavored Markdown pipe table. Cell contents have `|` escaped and
 * newlines replaced with spaces, since a literal newline would break the row
 * structure and a literal pipe would invent a column.
 */
export function renderMarkdownTable(
  spec: Extract<OutputSpec, { kind: 'table' }>,
  table: OutputTable,
): string {
  const columns = spec.columns.map((column) => column.name);
  const header = `| ${columns.join(' | ')} |`;
  const divider = `| ${columns.map(() => '---').join(' | ')} |`;
  const rows = table.rows.map((row) => {
    const cells = spec.columns.map((column) =>
      renderCell(column, row.values[column.name])
        .replace(/\|/g, '\\|')
        .replace(/\r?\n/g, ' '),
    );
    return `| ${cells.join(' | ')} |`;
  });
  return `${[header, divider, ...rows].join('\n')}\n`;
}

/** One cell as text: dates through their declared format and timezone,
 * booleans as true/false, null/undefined as empty. */
function renderCell(
  column: OutputColumn,
  value: string | number | boolean | null | undefined,
): string {
  if (value === null || value === undefined) return '';
  if (column.type === 'date' || column.type === 'datetime') {
    return renderDateCell(column, value);
  }
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return String(value);
}

/**
 * A date/datetime cell in the column's declared format, interpreted in its
 * declared IANA timezone when one is given.
 *
 * An unparseable value is returned verbatim rather than replaced or thrown
 * on: validation already rejects unparseable dates, so reaching here means
 * the value came from somewhere that bypassed it, and emitting the original
 * is more debuggable than emitting "Invalid Date".
 */
function renderDateCell(
  column: Extract<OutputColumn, { type: 'date' | 'datetime' }>,
  value: string | number | boolean,
): string {
  const raw = String(value);
  const parsed = column.timezone === undefined ? new Date(raw) : new TZDate(raw, column.timezone);
  if (Number.isNaN(parsed.getTime())) return raw;

  switch (column.format.kind) {
    case 'iso_date':
      return formatDate(parsed, 'yyyy-MM-dd');
    case 'iso_datetime':
      // Full ISO 8601. When a timezone is declared, TZDate's own ISO string
      // carries that offset; otherwise this is UTC.
      return parsed.toISOString();
    case 'unicode_pattern':
      // UTS #35 tokens are date-fns's own pattern language, so the declared
      // pattern is passed through verbatim. `locale` is deliberately not
      // applied as a date-fns locale object: doing so would mean bundling
      // every locale and letting a contract choose one at runtime, which is
      // a larger surface than the current tasks need. Numeric and ISO-shaped
      // patterns render identically either way; a month-name pattern renders
      // in English. Recorded as a known limitation rather than a silent
      // difference — see the T7 notes in the implementation plan.
      return formatDate(parsed, column.format.pattern);
  }
}
