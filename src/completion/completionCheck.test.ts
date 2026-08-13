import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { OutputContract, OutputSpec } from '../contracts/outputContract.js';
import { createOutputTableStore } from '../outputs/outputTable.js';
import { initManifest, writeArtifact } from '../run/artifacts.js';
import {
  renderTableOutputs,
  runCompletionCheck,
  validateEvidenceReferences,
  validateManifestIntegrity,
  validateTableCompleteness,
} from './completionCheck.js';

const TASK = 'Publish the widget roster.';

let runDir: string;

beforeEach(() => {
  runDir = mkdtempSync(join(tmpdir(), 'completion-check-test-'));
  initManifest(runDir, TASK);
});

afterEach(() => {
  rmSync(runDir, { recursive: true, force: true });
});

function tableSpec(overrides: Record<string, unknown> = {}): OutputSpec {
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
  } as OutputSpec;
}

function contract(outputs: OutputSpec[]): OutputContract {
  return { outputs } as OutputContract;
}

/** Publish a requested output through the real write path. */
function publish(filename: string, content: string): void {
  writeArtifact(runDir, `artifacts/${filename}`, Buffer.from(content, 'utf8'), {
    roles: ['requested_output'],
  });
}

function codes(result: { failures: Array<{ code: string }> }): string[] {
  return result.failures.map((failure) => failure.code);
}

describe('runCompletionCheck — table outputs', () => {
  it('passes a table matching its contract exactly', () => {
    publish('roster.csv', 'name,url\nAlpha,https://example.com/a\n');
    const result = runCompletionCheck(runDir, contract([tableSpec()]));
    expect(result).toEqual({ ok: true, failures: [] });
  });

  it('reports a missing required output', () => {
    const result = runCompletionCheck(runDir, contract([tableSpec()]));
    expect(codes(result)).toEqual(['missing_file']);
    expect(result.ok).toBe(false);
  });

  it('reports an empty output file', () => {
    publish('roster.csv', '');
    expect(codes(runCompletionCheck(runDir, contract([tableSpec()])))).toEqual(['empty_file']);
  });

  it('reports wrong column order, not just a wrong set', () => {
    publish('roster.csv', 'url,name\nhttps://example.com/a,Alpha\n');
    const result = runCompletionCheck(runDir, contract([tableSpec()]));
    expect(codes(result)).toContain('column_mismatch');
    expect(result.failures[0]?.message).toMatch(/in that order/);
  });

  it('reports an extra column', () => {
    publish('roster.csv', 'name,url,extra\nAlpha,https://example.com/a,x\n');
    expect(codes(runCompletionCheck(runDir, contract([tableSpec()])))).toContain(
      'column_mismatch',
    );
  });

  it('reports a blank value in a required column', () => {
    publish('roster.csv', 'name,url\n,https://example.com/a\n');
    expect(codes(runCompletionCheck(runDir, contract([tableSpec()])))).toContain(
      'missing_required_value',
    );
  });

  it('accepts a blank value in an optional column', () => {
    publish('roster.csv', 'name,url\nAlpha,\n');
    expect(runCompletionCheck(runDir, contract([tableSpec()])).ok).toBe(true);
  });

  it('parses quoted fields, doubled quotes, and embedded newlines', () => {
    publish('roster.csv', 'name,url\n"Alpha, Inc. ""A""","https://example.com/a"\n');
    expect(runCompletionCheck(runDir, contract([tableSpec()])).ok).toBe(true);

    publish('roster.csv', 'name,url\n"line one\nline two",https://example.com/a\n');
    const result = runCompletionCheck(
      runDir,
      contract([tableSpec({ rules: [{ type: 'exact_row_count', value: 1 }] })]),
    );
    // The embedded newline must not be counted as a second row.
    expect(result.ok).toBe(true);
  });

  it('reports an unterminated quoted field as unparseable', () => {
    publish('roster.csv', 'name,url\n"Alpha,https://example.com/a\n');
    expect(codes(runCompletionCheck(runDir, contract([tableSpec()])))).toEqual([
      'unparseable_csv',
    ]);
  });

  it('enforces exact and minimum row counts', () => {
    publish('roster.csv', 'name,url\nA,https://e.com/a\nB,https://e.com/b\n');
    expect(
      codes(
        runCompletionCheck(
          runDir,
          contract([tableSpec({ rules: [{ type: 'exact_row_count', value: 3 }] })]),
        ),
      ),
    ).toContain('row_count_mismatch');
    expect(
      codes(
        runCompletionCheck(
          runDir,
          contract([tableSpec({ rules: [{ type: 'minimum_row_count', value: 5 }] })]),
        ),
      ),
    ).toContain('row_count_below_minimum');
    expect(
      runCompletionCheck(
        runDir,
        contract([tableSpec({ rules: [{ type: 'minimum_row_count', value: 2 }] })]),
      ).ok,
    ).toBe(true);
  });

  it('enforces uniqueness across the declared columns', () => {
    publish('roster.csv', 'name,url\nA,https://e.com/a\nA,https://e.com/a\n');
    expect(
      codes(
        runCompletionCheck(
          runDir,
          contract([tableSpec({ rules: [{ type: 'unique', columns: ['name'] }] })]),
        ),
      ),
    ).toContain('duplicate_rows');
  });

  it('enforces expected values that must appear', () => {
    publish('roster.csv', 'name,url\nA,https://e.com/a\n');
    const result = runCompletionCheck(
      runDir,
      contract([
        tableSpec({
          rules: [
            {
              type: 'matches_expected_values',
              column: 'name',
              expected: ['A', 'B'],
              source: { kind: 'original_task' },
            },
          ],
        }),
      ]),
    );
    expect(codes(result)).toContain('missing_expected_values');
    expect(result.failures[0]?.message).toMatch(/\bB\b/);
  });

  it('reports leftover placeholder text', () => {
    publish('roster.csv', 'name,url\nTODO,https://e.com/a\n');
    expect(codes(runCompletionCheck(runDir, contract([tableSpec()])))).toContain(
      'placeholder_text',
    );
  });

  it('checks JSON and Markdown table formats too', () => {
    publish('roster.json', '[{"name":"A","url":"https://e.com/a"}]');
    expect(
      runCompletionCheck(
        runDir,
        contract([tableSpec({ filename: 'roster.json', format: 'json' })]),
      ).ok,
    ).toBe(true);

    publish('bad.json', '{"name":"A"}');
    expect(
      codes(
        runCompletionCheck(runDir, contract([tableSpec({ filename: 'bad.json', format: 'json' })])),
      ),
    ).toEqual(['json_not_array']);

    publish('roster.md', '| name | url |\n| --- | --- |\n| A | https://e.com/a |\n');
    expect(
      runCompletionCheck(
        runDir,
        contract([tableSpec({ filename: 'roster.md', format: 'markdown' })]),
      ).ok,
    ).toBe(true);
  });
});

describe('runCompletionCheck — documents and captures', () => {
  const docSpec = (overrides: Record<string, unknown> = {}): OutputSpec =>
    ({
      id: 'report',
      kind: 'document',
      filename: 'report.md',
      format: 'markdown',
      evidenceRequirement: 'at_least_one',
      evidencePresentation: 'hidden',
      ...overrides,
    }) as OutputSpec;

  it('reports a missing required section', () => {
    publish('report.md', '# Summary\nAll good.\n');
    const result = runCompletionCheck(
      runDir,
      contract([docSpec({ requiredSections: ['Summary', 'Findings'] })]),
    );
    expect(codes(result)).toEqual(['missing_section']);
    expect(result.failures[0]?.message).toMatch(/Findings/);
  });

  it('accepts a document carrying every required section', () => {
    publish('report.md', '# Summary\ntext\n\n# Findings\nmore\n');
    expect(
      runCompletionCheck(
        runDir,
        contract([docSpec({ requiredSections: ['Summary', 'Findings'] })]),
      ).ok,
    ).toBe(true);
  });

  it('counts published screenshots against an exact requirement', () => {
    writeArtifact(runDir, 'artifacts/shot-1.png', Buffer.from('x'), { roles: ['evidence'] });
    const spec = {
      id: 'shots',
      kind: 'screenshots',
      count: { exact: 2 },
      filenamePattern: 'shot-*.png',
    } as OutputSpec;

    expect(codes(runCompletionCheck(runDir, contract([spec])))).toEqual([
      'capture_count_mismatch',
    ]);

    writeArtifact(runDir, 'artifacts/shot-2.png', Buffer.from('y'), { roles: ['evidence'] });
    expect(runCompletionCheck(runDir, contract([spec])).ok).toBe(true);
  });

  it('ignores captures that do not match the required pattern', () => {
    writeArtifact(runDir, 'artifacts/other.png', Buffer.from('x'), { roles: ['evidence'] });
    const spec = {
      id: 'shots',
      kind: 'screenshots',
      count: { minimum: 1 },
      filenamePattern: 'shot-*.png',
    } as OutputSpec;
    expect(codes(runCompletionCheck(runDir, contract([spec])))).toEqual([
      'capture_count_below_minimum',
    ]);
  });

  it('does not count scratch files as published captures', () => {
    writeArtifact(runDir, 'scratch/shot-1.png', Buffer.from('x'));
    const spec = { id: 'shots', kind: 'screenshots', count: { minimum: 1 } } as OutputSpec;
    expect(codes(runCompletionCheck(runDir, contract([spec])))).toEqual([
      'capture_count_below_minimum',
    ]);
  });
});

describe('validateManifestIntegrity', () => {
  it('passes a manifest whose files all match their recorded hashes', () => {
    publish('roster.csv', 'name,url\nA,https://e.com/a\n');
    expect(validateManifestIntegrity(runDir)).toEqual([]);
  });

  it('reports a file that changed after it was recorded', () => {
    publish('roster.csv', 'name,url\nA,https://e.com/a\n');
    // Tamper with the bytes behind the manifest's back.
    writeFileSync(join(runDir, 'artifacts/roster.csv'), 'name,url\nTAMPERED,x\n');

    const failures = validateManifestIntegrity(runDir);
    expect(failures.map((f) => f.code)).toEqual(['hash_mismatch']);
    expect(failures[0]?.message).toMatch(/changed after it was recorded/);
  });

  it('reports a recorded file that no longer exists', () => {
    publish('roster.csv', 'name,url\nA,https://e.com/a\n');
    rmSync(join(runDir, 'artifacts/roster.csv'));
    expect(validateManifestIntegrity(runDir).map((f) => f.code)).toEqual([
      'missing_recorded_file',
    ]);
  });

  it('reports a missing manifest', () => {
    rmSync(join(runDir, 'manifest.json'));
    expect(validateManifestIntegrity(runDir).map((f) => f.code)).toEqual(['missing_manifest']);
  });

  it('reports an unparseable manifest', () => {
    writeFileSync(join(runDir, 'manifest.json'), '{not json');
    expect(validateManifestIntegrity(runDir).map((f) => f.code)).toEqual([
      'unparseable_manifest',
    ]);
  });
});

describe('runCompletionCheck — reporting', () => {
  it('collects failures across every output so one submission result fixes all', () => {
    publish('roster.csv', 'url,name\nhttps://e.com/a,A\n');
    const result = runCompletionCheck(
      runDir,
      contract([
        tableSpec(),
        {
          id: 'report',
          kind: 'document',
          filename: 'report.md',
          format: 'markdown',
          evidenceRequirement: 'at_least_one',
          evidencePresentation: 'hidden',
        } as OutputSpec,
      ]),
    );

    expect(result.ok).toBe(false);
    // The table's column order AND the document's absence are both reported.
    expect(codes(result)).toEqual(['column_mismatch', 'missing_file']);
    // Every failure names the output it belongs to.
    expect(result.failures.map((f) => f.outputId)).toEqual(['roster', 'report']);
  });
});

// --- T7: table rendering, completeness, and evidence -------------------------

describe('renderTableOutputs', () => {
  const spec = (overrides: Record<string, unknown> = {}): OutputSpec =>
    ({
      id: 'roster',
      kind: 'table',
      filename: 'roster.csv',
      format: 'csv',
      columns: [{ name: 'name', required: true, type: 'string' }],
      rules: [],
      ...overrides,
    }) as OutputSpec;

  function tableStore(outputs: OutputSpec[]) {
    return createOutputTableStore({
      tableSpec: (id) => outputs.find((o) => o.kind === 'table' && o.id === id) as never,
      evidenceExists: () => true,
    });
  }

  it('writes each table through writeArtifact with the requested_output role', () => {
    const outputs = [spec()];
    const tables = tableStore(outputs);
    tables.upsertOutputRows('roster', [
      { rowId: 'r1', values: { name: 'Alpha' }, evidenceIds: ['E1'] },
    ]);

    const failures = renderTableOutputs(runDir, contract(outputs), tables);
    expect(failures).toEqual([]);
    expect(readFileSync(join(runDir, 'artifacts/roster.csv'), 'utf8')).toBe('name\nAlpha\n');

    const manifest = JSON.parse(
      readFileSync(join(runDir, 'manifest.json'), 'utf8'),
    ) as { artifacts: Array<{ filename: string; roles?: string[]; completionStatus?: string }> };
    const entry = manifest.artifacts.find((a) => a.filename === 'artifacts/roster.csv');
    expect(entry?.roles).toEqual(['requested_output']);
    expect(entry?.completionStatus).toBe('complete');
  });

  it('marks a partial render partial while keeping the requested-output role', () => {
    const outputs = [spec()];
    const tables = tableStore(outputs);
    tables.upsertOutputRows('roster', [
      { rowId: 'r1', values: { name: 'Alpha' }, evidenceIds: ['E1'] },
    ]);

    renderTableOutputs(runDir, contract(outputs), tables, 'partial');
    const manifest = JSON.parse(
      readFileSync(join(runDir, 'manifest.json'), 'utf8'),
    ) as { artifacts: Array<{ filename: string; roles?: string[]; completionStatus?: string }> };
    const entry = manifest.artifacts.find((a) => a.filename === 'artifacts/roster.csv');
    // Still a requested output — a partial deliverable is still the
    // deliverable, just honestly labelled.
    expect(entry?.roles).toEqual(['requested_output']);
    expect(entry?.completionStatus).toBe('partial');
  });

  it('renders an empty table as a header-only file rather than failing', () => {
    const outputs = [spec()];
    renderTableOutputs(runDir, contract(outputs), tableStore(outputs));
    expect(readFileSync(join(runDir, 'artifacts/roster.csv'), 'utf8')).toBe('name\n');
  });
});

describe('validateTableCompleteness', () => {
  const ruled = {
    id: 'roster',
    kind: 'table',
    filename: 'roster.csv',
    format: 'csv',
    columns: [{ name: 'name', required: true, type: 'string' }],
    rules: [{ type: 'exact_row_count', value: 1 }],
  } as OutputSpec;

  function tableStore(outputs: OutputSpec[]) {
    return createOutputTableStore({
      tableSpec: (id) => outputs.find((o) => o.kind === 'table' && o.id === id) as never,
      evidenceExists: () => true,
    });
  }

  it('requires completeness evidence for a count-ruled table', () => {
    const tables = tableStore([ruled]);
    const failures = validateTableCompleteness(contract([ruled]), tables);
    expect(failures.map((f) => f.code)).toEqual(['missing_completeness_evidence']);
    // The message must explain WHY row count cannot prove population.
    expect(failures[0]?.message).toMatch(/cannot prove the number that exist/);
  });

  it('accepts a count-ruled table once completeness is recorded', () => {
    const tables = tableStore([ruled]);
    tables.setTableCompleteness('roster', { method: 'header states 1', evidenceIds: ['E1'] });
    expect(validateTableCompleteness(contract([ruled]), tables)).toEqual([]);
  });

  it('does not require completeness for an unruled table', () => {
    const unruled = { ...ruled, rules: [] } as OutputSpec;
    expect(validateTableCompleteness(contract([unruled]), tableStore([unruled]))).toEqual([]);
  });
});

describe('validateEvidenceReferences', () => {
  const spec = {
    id: 'roster',
    kind: 'table',
    filename: 'roster.csv',
    format: 'csv',
    columns: [{ name: 'name', required: true, type: 'string' }],
    rules: [],
  } as OutputSpec;

  it('reports rows whose evidence stopped resolving', () => {
    const tables = createOutputTableStore({
      tableSpec: () => spec as never,
      evidenceExists: () => true,
    });
    tables.upsertOutputRows('roster', [
      { rowId: 'r1', values: { name: 'Alpha' }, evidenceIds: ['E1'] },
    ]);

    // Evidence disappears between the upsert and the submission.
    const failures = validateEvidenceReferences(contract([spec]), tables, () => false);
    expect(failures.map((f) => f.code)).toEqual(['dangling_evidence']);
    expect(failures[0]?.message).toMatch(/row "r1"/);
  });

  it('passes when every cited id still resolves', () => {
    const tables = createOutputTableStore({
      tableSpec: () => spec as never,
      evidenceExists: () => true,
    });
    tables.upsertOutputRows('roster', [
      { rowId: 'r1', values: { name: 'Alpha' }, evidenceIds: ['E1'] },
    ]);
    expect(validateEvidenceReferences(contract([spec]), tables, () => true)).toEqual([]);
  });

  it('checks completeness evidence too', () => {
    const tables = createOutputTableStore({
      tableSpec: () => spec as never,
      evidenceExists: () => true,
    });
    tables.setTableCompleteness('roster', { method: 'counted', evidenceIds: ['E9'] });
    const failures = validateEvidenceReferences(contract([spec]), tables, () => false);
    expect(failures.map((f) => f.code)).toEqual(['dangling_completeness_evidence']);
  });
});
