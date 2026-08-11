import { describe, expect, it } from 'vitest';

import { buildEdgarDocumentUrl, parseSubmissions, type EdgarFiling } from './edgarClient.js';

// A canned SEC submissions.json fixture, shaped like the real
// data.sec.gov/submissions/CIK##########.json response's filings.recent
// parallel-array structure, with a handful of filings including the target
// 8-K and some decoys (wrong form, wrong date, both wrong).
const SUBMISSIONS_FIXTURE = {
  cik: '320193',
  name: 'Apple Inc.',
  filings: {
    recent: {
      accessionNumber: [
        '0000320193-26-000010', // 10-K, wrong form
        '0000320193-26-000009', // 8-K, wrong date
        '0000320193-26-000008', // the target
        '0000320193-25-000099', // 8-K, wrong date
      ],
      form: ['10-K', '8-K', '8-K', '8-K'],
      filingDate: ['2026-02-10', '2026-02-01', '2026-01-29', '2025-11-01'],
      primaryDocument: ['aapl-10k.htm', 'aapl-8k-0201.htm', 'aapl-8k-0129.htm', 'aapl-8k-1101.htm'],
    },
  },
};

describe('parseSubmissions', () => {
  it('finds the filing matching both form and filing date', () => {
    const filing = parseSubmissions(SUBMISSIONS_FIXTURE, '8-K', '2026-01-29');
    expect(filing).toEqual({
      accessionNumber: '0000320193-26-000008',
      form: '8-K',
      filingDate: '2026-01-29',
      primaryDocument: 'aapl-8k-0129.htm',
    });
  });

  it('throws when no filing matches both criteria', () => {
    expect(() => parseSubmissions(SUBMISSIONS_FIXTURE, '8-K', '2099-01-01')).toThrow(
      /no 8-K filing dated 2099-01-01/,
    );
  });

  it('throws when filings.recent is missing', () => {
    expect(() => parseSubmissions({ cik: '320193' }, '8-K', '2026-01-29')).toThrow(
      /filings\.recent/,
    );
  });

  it('throws when the parallel arrays have mismatched lengths', () => {
    const malformed = {
      filings: {
        recent: {
          accessionNumber: ['0000320193-26-000008'],
          form: ['8-K', '10-K'],
          filingDate: ['2026-01-29'],
          primaryDocument: ['aapl-8k.htm'],
        },
      },
    };
    expect(() => parseSubmissions(malformed, '8-K', '2026-01-29')).toThrow(/mismatched lengths/);
  });

  it('throws when a required array field holds non-strings', () => {
    const malformed = {
      filings: {
        recent: {
          accessionNumber: [12345],
          form: ['8-K'],
          filingDate: ['2026-01-29'],
          primaryDocument: ['aapl-8k.htm'],
        },
      },
    };
    expect(() => parseSubmissions(malformed, '8-K', '2026-01-29')).toThrow(/accessionNumber/);
  });
});

describe('buildEdgarDocumentUrl', () => {
  const filing: EdgarFiling = {
    accessionNumber: '0000320193-26-000008',
    form: '8-K',
    filingDate: '2026-01-29',
    primaryDocument: 'aapl-8k-0129.htm',
  };

  it('strips the CIK leading zeros and the accession number dashes', () => {
    expect(buildEdgarDocumentUrl('0000320193', filing)).toBe(
      'https://www.sec.gov/Archives/edgar/data/320193/000032019326000008/aapl-8k-0129.htm',
    );
  });

  it('accepts a CIK already without leading zeros', () => {
    expect(buildEdgarDocumentUrl('320193', filing)).toBe(
      'https://www.sec.gov/Archives/edgar/data/320193/000032019326000008/aapl-8k-0129.htm',
    );
  });
});
