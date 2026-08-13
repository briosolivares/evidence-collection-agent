import { describe, expect, it } from 'vitest';

import type { OutputSpec } from '../contracts/outputContract.js';
import type { OutputTable } from './outputTable.js';
import {
  renderCsv,
  renderJson,
  renderMarkdownTable,
  renderOutputTable,
} from './renderTable.js';

type TableSpec = Extract<OutputSpec, { kind: 'table' }>;

function spec(overrides: Partial<TableSpec> = {}): TableSpec {
  return {
    id: 'roster',
    kind: 'table',
    filename: 'roster.csv',
    format: 'csv',
    columns: [
      { name: 'name', required: true, type: 'string' },
      { name: 'url', required: false, type: 'url' },
    ],
    rules: [],
    ...overrides,
  } as TableSpec;
}

function table(rows: Array<Record<string, string | number | boolean | null>>): OutputTable {
  return {
    outputId: 'roster',
    rows: rows.map((values, index) => ({
      rowId: `r${index + 1}`,
      values,
      evidenceIds: ['E1'],
      version: 1,
    })),
  };
}

describe('renderCsv', () => {
  it('writes the contract header in contract order, then rows', () => {
    const csv = renderCsv(spec(), table([{ name: 'Alpha', url: 'https://e.com/a' }]));
    expect(csv).toBe('name,url\nAlpha,https://e.com/a\n');
  });

  it('renders only declared columns, in declared order, whatever the row key order', () => {
    // The row's keys are reversed and carry an extra field; neither can
    // change the artifact's shape.
    const csv = renderCsv(
      spec(),
      table([{ url: 'https://e.com/a', extra: 'leaked', name: 'Alpha' } as never]),
    );
    expect(csv).toBe('name,url\nAlpha,https://e.com/a\n');
    expect(csv).not.toContain('leaked');
  });

  it('quotes and escapes commas, quotes, and newlines', () => {
    const csv = renderCsv(
      spec(),
      table([{ name: 'Alpha, Inc. "A"\nsecond line', url: 'https://e.com/a' }]),
    );
    // Round-trips: the field is quoted, inner quotes doubled.
    expect(csv).toContain('"Alpha, Inc. ""A""\nsecond line"');
    expect(csv.endsWith('\n')).toBe(true);
  });

  it('renders an empty table as a header-only file', () => {
    expect(renderCsv(spec(), table([]))).toBe('name,url\n');
  });

  it('renders null and undefined as empty cells', () => {
    expect(renderCsv(spec(), table([{ name: 'Alpha', url: null }]))).toBe('name,url\nAlpha,\n');
    expect(renderCsv(spec(), table([{ name: 'Alpha' } as never]))).toBe('name,url\nAlpha,\n');
  });

  it('uses \\n line endings deterministically, not the platform default', () => {
    const csv = renderCsv(spec(), table([{ name: 'A', url: 'https://e.com/a' }]));
    expect(csv).not.toContain('\r');
  });

  it('is byte-identical across repeated renders', () => {
    const data = table([{ name: 'Alpha', url: 'https://e.com/a' }]);
    expect(renderCsv(spec(), data)).toBe(renderCsv(spec(), data));
  });
});

describe('renderJson', () => {
  it('emits an array of objects with contract keys in order, preserving types', () => {
    const withTypes = spec({
      format: 'json',
      columns: [
        { name: 'name', required: true, type: 'string' },
        { name: 'count', required: false, type: 'integer' },
        { name: 'active', required: false, type: 'boolean' },
      ],
    } as Partial<TableSpec>);
    const json = renderJson(withTypes, table([{ name: 'Alpha', count: 3, active: true }]));

    expect(JSON.parse(json)).toEqual([{ name: 'Alpha', count: 3, active: true }]);
    // Key order follows the contract.
    expect(json.indexOf('"name"')).toBeLessThan(json.indexOf('"count"'));
    expect(json.endsWith('\n')).toBe(true);
  });

  it('emits missing values as null', () => {
    const json = renderJson(spec({ format: 'json' }), table([{ name: 'Alpha' } as never]));
    expect(JSON.parse(json)).toEqual([{ name: 'Alpha', url: null }]);
  });
});

describe('renderMarkdownTable', () => {
  it('emits a header, divider, and one row per record', () => {
    const md = renderMarkdownTable(
      spec({ format: 'markdown' }),
      table([{ name: 'Alpha', url: 'https://e.com/a' }]),
    );
    expect(md).toBe('| name | url |\n| --- | --- |\n| Alpha | https://e.com/a |\n');
  });

  it('escapes pipes and flattens newlines so the row structure survives', () => {
    const md = renderMarkdownTable(
      spec({ format: 'markdown' }),
      table([{ name: 'A | B\nC', url: 'https://e.com/a' }]),
    );
    const rowLine = md.split('\n')[2]!;
    expect(rowLine).toBe('| A \\| B C | https://e.com/a |');
    // Exactly header, divider, one row, trailing newline.
    expect(md.trimEnd().split('\n')).toHaveLength(3);
  });
});

describe('date columns', () => {
  const dateSpec = (format: unknown, timezone?: string): TableSpec =>
    spec({
      columns: [
        {
          name: 'when',
          required: true,
          type: 'date',
          format,
          ...(timezone === undefined ? {} : { timezone }),
        },
      ],
    } as Partial<TableSpec>);

  it('renders iso_date as yyyy-MM-dd', () => {
    const csv = renderCsv(
      dateSpec({ kind: 'iso_date' }),
      table([{ when: '2026-03-04T12:00:00Z' }]),
    );
    expect(csv).toBe('when\n2026-03-04\n');
  });

  it('renders a unicode_pattern verbatim through date-fns', () => {
    const csv = renderCsv(
      dateSpec({ kind: 'unicode_pattern', pattern: 'yyyy/MM/dd', locale: 'en-US' }),
      table([{ when: '2026-03-04T12:00:00Z' }]),
    );
    expect(csv).toBe('when\n2026/03/04\n');
  });

  it('interprets a value in the declared IANA timezone', () => {
    // 2026-03-04T02:00Z is still March 3rd in New York.
    const csv = renderCsv(
      dateSpec({ kind: 'iso_date' }, 'America/New_York'),
      table([{ when: '2026-03-04T02:00:00Z' }]),
    );
    expect(csv).toBe('when\n2026-03-03\n');
  });

  it('passes an unparseable date through rather than emitting Invalid Date', () => {
    const csv = renderCsv(dateSpec({ kind: 'iso_date' }), table([{ when: 'not a date' }]));
    expect(csv).toBe('when\nnot a date\n');
  });
});

describe('renderOutputTable', () => {
  it('dispatches on the contract format', () => {
    const data = table([{ name: 'Alpha', url: 'https://e.com/a' }]);
    expect(renderOutputTable(spec({ format: 'csv' }), data)).toContain('name,url');
    expect(renderOutputTable(spec({ format: 'json' }), data).trim().startsWith('[')).toBe(true);
    expect(renderOutputTable(spec({ format: 'markdown' }), data).startsWith('| name')).toBe(true);
  });
});
