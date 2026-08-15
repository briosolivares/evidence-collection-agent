import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { OutputContract, OutputSpec } from '../../contracts/outputContract.js';
import { initManifest, writeArtifact } from '../../run/artifacts.js';
import type { FinishInput } from '../tools/finish.js';
import {
  inspectManifest,
  V3_FINISH_MAX_MANIFEST_BYTES,
  V3_FINISH_MAX_MANIFEST_ENTRIES,
  V3_FINISH_SIGNATURE_BYTES,
} from './artifactInspection.js';
import {
  runV3FinishChecks,
  toV3SettledFacts,
  v3FinishFactsSchema,
} from './finishChecks.js';
import { inspectTable } from './tableInspection.js';

const TASK = 'Create the requested evidence package.';
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]);

let runDir: string;

beforeEach(() => {
  runDir = mkdtempSync(join(tmpdir(), 'v3-finish-checks-'));
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

function contract(...outputs: OutputSpec[]): OutputContract {
  return { outputs } as OutputContract;
}

function finish(paths: string[], limitations: string[] = []): FinishInput {
  return {
    summary: 'Created and checked every requested output.',
    artifacts: paths,
    limitations,
  };
}

function publish(
  artifactPath: string,
  bytes: Uint8Array | string,
  options: {
    roles?: Array<'requested_output' | 'evidence'>;
    sourceUrl?: string;
  } = {},
): void {
  writeArtifact(
    runDir,
    artifactPath,
    typeof bytes === 'string' ? Buffer.from(bytes, 'utf8') : bytes,
    {
      roles: options.roles ?? ['requested_output'],
      ...(options.sourceUrl === undefined ? {} : { sourceUrl: options.sourceUrl }),
    },
  );
}

function codes(result: ReturnType<typeof runV3FinishChecks>): string[] {
  return result.status === 'passed' ? [] : result.defects.map((defect) => defect.code);
}

describe('runV3FinishChecks — manifest and finish claims', () => {
  it('passes an exact CSV publication and returns structured verifier facts', () => {
    publish('artifacts/roster.csv', 'name,url\nAlpha,https://example.test/a\n');

    const result = runV3FinishChecks({
      runDir,
      contract: contract(tableSpec()),
      finish: finish(['artifacts/roster.csv']),
    });

    expect(result.status).toBe('passed');
    expect(result.defects).toEqual([]);
    expect(result.facts.manifest).toMatchObject({
      entryCount: 1,
      verifiedPaths: ['artifacts/roster.csv'],
      requestedOutputPaths: ['artifacts/roster.csv'],
    });
    expect(result.facts.outputs).toEqual([
      {
        kind: 'table',
        outputId: 'roster',
        artifactPath: 'artifacts/roster.csv',
        format: 'csv',
        columns: ['name', 'url'],
        rowCount: 1,
        satisfiedRules: [],
      },
    ]);
    expect(toV3SettledFacts(result.facts)).toEqual([
      expect.objectContaining({ code: 'manifest_integrity' }),
      expect.objectContaining({
        outputId: 'roster',
        code: 'table_shape',
        statement: expect.stringContaining('exactly 1 data row'),
      }),
    ]);
    expect(
      v3FinishFactsSchema.parse(JSON.parse(JSON.stringify(result.facts))),
    ).toEqual(result.facts);
    expect(
      v3FinishFactsSchema.safeParse({ ...result.facts, unrecognized: true }).success,
    ).toBe(false);
  });

  it('does not mutate the immutable contract or finish input', () => {
    publish('artifacts/roster.csv', 'name,url\nAlpha,\n');
    const expected = contract(tableSpec());
    const submitted = finish(['artifacts/roster.csv'], ['Source freshness is one day.']);
    const before = JSON.stringify({ expected, submitted });

    runV3FinishChecks({ runDir, contract: expected, finish: submitted });

    expect(JSON.stringify({ expected, submitted })).toBe(before);
  });

  it('rejects noncanonical, unmanifested, and evidence-only finish paths', () => {
    publish('artifacts/roster.csv', 'name,url\nAlpha,\n');
    publish('artifacts/support.txt', 'support', { roles: ['evidence'] });

    const result = runV3FinishChecks({
      runDir,
      contract: contract(tableSpec()),
      finish: finish([
        './artifacts/roster.csv',
        'artifacts/missing.csv',
        'artifacts/support.txt',
      ]),
    });

    expect(codes(result)).toEqual(
      expect.arrayContaining([
        'noncanonical_finish_artifact_path',
        'finish_artifact_not_manifested',
        'finish_artifact_not_requested_output',
        'finish_omits_requested_output',
      ]),
    );
  });

  it('rejects a finish path escaping the run directory', () => {
    const result = runV3FinishChecks({
      runDir,
      contract: contract(tableSpec()),
      finish: finish(['../outside.csv']),
    });
    expect(codes(result)).toContain('unsafe_finish_artifact_path');
  });

  it('reports hash drift and a recorded file that disappeared', () => {
    publish('artifacts/roster.csv', 'name,url\nAlpha,\n');
    writeFileSync(join(runDir, 'artifacts/roster.csv'), 'name,url\nTampered,\n');
    let result = runV3FinishChecks({
      runDir,
      contract: contract(tableSpec()),
      finish: finish(['artifacts/roster.csv']),
    });
    expect(codes(result)).toContain('hash_mismatch');

    rmSync(join(runDir, 'artifacts/roster.csv'));
    result = runV3FinishChecks({
      runDir,
      contract: contract(tableSpec()),
      finish: finish(['artifacts/roster.csv']),
    });
    expect(codes(result)).toContain('missing_recorded_file');
  });

  it('rejects manifest paths that become symlinks', () => {
    publish('artifacts/roster.csv', 'name,url\nAlpha,\n');
    const outside = join(runDir, 'outside.csv');
    writeFileSync(outside, 'name,url\nOutside,\n');
    rmSync(join(runDir, 'artifacts/roster.csv'));
    symlinkSync(outside, join(runDir, 'artifacts/roster.csv'));

    const result = runV3FinishChecks({
      runDir,
      contract: contract(tableSpec()),
      finish: finish(['artifacts/roster.csv']),
    });
    expect(codes(result)).toContain('artifact_symlink');
  });

  it('rejects missing and malformed manifests without throwing', () => {
    rmSync(join(runDir, 'manifest.json'));
    expect(
      codes(
        runV3FinishChecks({
          runDir,
          contract: contract(tableSpec()),
          finish: finish([], ['The run manifest is unavailable.']),
        }),
      ),
    ).toEqual(['missing_manifest']);

    writeFileSync(join(runDir, 'manifest.json'), '{broken');
    expect(
      codes(
        runV3FinishChecks({
          runDir,
          contract: contract(tableSpec()),
          finish: finish([], ['The run manifest is unavailable.']),
        }),
      ),
    ).toEqual(['unparseable_manifest']);
  });

  it('requires canonical UTC manifest timestamps and chronological provenance', () => {
    publish('artifacts/roster.csv', 'name,url\nAlpha,\n');
    const manifestPath = join(runDir, 'manifest.json');
    const original = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      startedAt: string;
      finishedAt?: string;
      artifacts: Array<{ capturedAt: string }>;
    };

    const noncanonicalStart = structuredClone(original);
    noncanonicalStart.startedAt = original.startedAt.replace('Z', '+00:00');
    writeFileSync(manifestPath, `${JSON.stringify(noncanonicalStart)}\n`);
    expect(
      codes(runV3FinishChecks({
        runDir,
        contract: contract(tableSpec()),
        finish: finish(['artifacts/roster.csv']),
      })),
    ).toContain('invalid_manifest_shape');

    const noncanonicalCapture = structuredClone(original);
    noncanonicalCapture.artifacts[0]!.capturedAt = original.artifacts[0]!.capturedAt.replace(
      /\.\d{3}Z$/,
      'Z',
    );
    writeFileSync(manifestPath, `${JSON.stringify(noncanonicalCapture)}\n`);
    expect(
      codes(runV3FinishChecks({
        runDir,
        contract: contract(tableSpec()),
        finish: finish(['artifacts/roster.csv']),
      })),
    ).toContain('invalid_manifest_entry');

    const outOfOrder = structuredClone(original);
    outOfOrder.artifacts[0]!.capturedAt = new Date(
      Date.parse(original.startedAt) - 1,
    ).toISOString();
    outOfOrder.finishedAt = new Date(Date.parse(original.startedAt) - 1).toISOString();
    writeFileSync(manifestPath, `${JSON.stringify(outOfOrder)}\n`);
    expect(
      codes(runV3FinishChecks({
        runDir,
        contract: contract(tableSpec()),
        finish: finish(['artifacts/roster.csv']),
      })),
    ).toContain('invalid_manifest_timestamp_order');
  });

  it('fails deterministically before parsing an oversized manifest', () => {
    writeFileSync(
      join(runDir, 'manifest.json'),
      Buffer.alloc(V3_FINISH_MAX_MANIFEST_BYTES + 1, 0x20),
    );

    const result = runV3FinishChecks({
      runDir,
      contract: contract(tableSpec()),
      finish: finish([], ['The provenance index exceeds the supported bound.']),
    });
    expect(codes(result)).toEqual(['manifest_bytes_limit_exceeded']);
  });

  it('fails deterministically before walking excessive manifest entries', () => {
    publish('artifacts/roster.csv', 'name,url\nAlpha,\n');
    const manifestPath = join(runDir, 'manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      artifacts: Array<Record<string, unknown>>;
    };
    manifest.artifacts = Array.from(
      { length: V3_FINISH_MAX_MANIFEST_ENTRIES + 1 },
      () => ({ ...manifest.artifacts[0] }),
    );
    writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`);

    const result = runV3FinishChecks({
      runDir,
      contract: contract(tableSpec()),
      finish: finish(['artifacts/roster.csv']),
    });
    expect(codes(result)).toEqual(['manifest_entry_limit_exceeded']);
  });

  it.each([
    ['roles', 42],
    ['sourceUrl', 42],
    ['completionStatus', 'invented'],
  ] as const)('returns a defect for malformed optional manifest field %s', (field, value) => {
    publish('artifacts/roster.csv', 'name,url\nAlpha,\n');
    const manifestPath = join(runDir, 'manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      artifacts: Array<Record<string, unknown>>;
    };
    manifest.artifacts[0]![field] = value;
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

    expect(() =>
      runV3FinishChecks({
        runDir,
        contract: contract(tableSpec()),
        finish: finish(['artifacts/roster.csv']),
      }),
    ).not.toThrow();
    const result = runV3FinishChecks({
      runDir,
      contract: contract(tableSpec()),
      finish: finish(['artifacts/roster.csv']),
    });
    expect(codes(result)).toContain('invalid_manifest_entry');
  });

  it('rejects malformed string source provenance', () => {
    publish('artifacts/roster.csv', 'name,url\nAlpha,\n', {
      sourceUrl: 'https://example.test/source',
    });
    const manifestPath = join(runDir, 'manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      artifacts: Array<{ sourceUrl?: string }>;
    };
    manifest.artifacts[0]!.sourceUrl = 'not a URL';
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

    const result = runV3FinishChecks({
      runDir,
      contract: contract(tableSpec()),
      finish: finish(['artifacts/roster.csv']),
    });
    expect(codes(result)).toContain('invalid_source_url');
  });

  it('requires finish to list every manifested requested output', () => {
    publish('artifacts/roster.csv', 'name,url\nAlpha,\n');
    const result = runV3FinishChecks({
      runDir,
      contract: contract(tableSpec()),
      finish: finish([]),
    });
    expect(codes(result)).toEqual(
      expect.arrayContaining(['empty_finish_claim', 'finish_omits_requested_output']),
    );
  });
});

describe('inspectManifest — bounded streaming content', () => {
  it('streams every hash but retains only selected published bytes, never scratch bytes', () => {
    publish('artifacts/roster.csv', 'name,url\nAlpha,\n');
    writeArtifact(runDir, 'scratch/workspace/private.txt', Buffer.from('private state'));

    const inspection = inspectManifest(runDir, {
      retainPublishedBytes: (_entry, artifactPath) => artifactPath === 'artifacts/roster.csv',
      publishedPrefixBytes: V3_FINISH_SIGNATURE_BYTES,
    });

    expect(inspection.defects).toEqual([]);
    expect(inspection.entries).toEqual([
      expect.objectContaining({
        canonicalPath: 'artifacts/roster.csv',
        integrityVerified: true,
        bytes: Buffer.from('name,url\nAlpha,\n'),
        contentPrefix: Buffer.from('name,url'),
      }),
      expect.objectContaining({
        canonicalPath: 'scratch/workspace/private.txt',
        integrityVerified: true,
      }),
    ]);
    const scratch = inspection.entries[1]!;
    expect(scratch.bytes).toBeUndefined();
    expect(scratch.contentPrefix).toBeUndefined();
  });

  it('reports aggregate and retained-byte limits without accepting unhashed content', () => {
    publish('artifacts/roster.csv', 'name,url\nAlpha,\n');

    const aggregate = inspectManifest(runDir, {
      limits: { maxTotalArtifactBytes: 1 },
    });
    expect(aggregate.manifest).toBeUndefined();
    expect(aggregate.entries).toEqual([]);
    expect(aggregate.defects.map((defect) => defect.code)).toContain(
      'artifact_inspection_bytes_exceeded',
    );

    const retained = inspectManifest(runDir, {
      retainPublishedBytes: () => true,
      publishedPrefixBytes: V3_FINISH_SIGNATURE_BYTES,
      limits: { maxRetainedPublishedBytes: 1 },
    });
    expect(retained.defects.map((defect) => defect.code)).toContain(
      'published_inspection_bytes_exceeded',
    );
    expect(retained.entries[0]).toMatchObject({
      canonicalPath: 'artifacts/roster.csv',
      integrityVerified: true,
    });
    expect(retained.entries[0]!.bytes).toBeUndefined();
  });

  it('propagates the trusted run guard between streamed hash chunks', () => {
    publish('artifacts/large.bin', Buffer.alloc(1024 * 1024, 0x5a));
    const interrupted = new Error('whole-run deadline reached');
    let checks = 0;

    let thrown: unknown;
    try {
      inspectManifest(runDir, {
        checkActive: () => {
          checks += 1;
          if (checks === 8) throw interrupted;
        },
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBe(interrupted);
    expect(checks).toBe(8);
  });

  it('propagates the trusted run guard while streaming the manifest itself', () => {
    const manifestPath = join(runDir, 'manifest.json');
    const raw = readFileSync(manifestPath);
    writeFileSync(
      manifestPath,
      Buffer.concat([raw, Buffer.alloc(1024 * 1024, 0x20)]),
    );
    const interrupted = new Error('terminal inspection deadline reached');
    let checks = 0;

    expect(() =>
      inspectManifest(runDir, {
        checkActive: () => {
          checks += 1;
          if (checks === 4) throw interrupted;
        },
      }),
    ).toThrow(interrupted);
    expect(checks).toBe(4);
  });
});

describe('runV3FinishChecks — generic tables', () => {
  it('accepts exact byte/row/cell boundaries and rejects the first excess', () => {
    const oneColumn = tableSpec({
      columns: [{ name: 'name', required: true, type: 'string' }],
    }) as Extract<OutputSpec, { kind: 'table' }>;
    const exact = Buffer.from('name\nAlpha\n');
    expect(
      inspectTable(oneColumn, 'artifacts/roster.csv', exact, {
        limits: { maxBytes: exact.byteLength, maxRows: 1, maxCells: 2 },
      }),
    ).toMatchObject({ defects: [], fact: { rowCount: 1 } });

    expect(
      inspectTable(oneColumn, 'artifacts/roster.csv', exact, {
        limits: { maxBytes: exact.byteLength - 1 },
      }).defects.map((defect) => defect.code),
    ).toEqual(['table_bytes_limit_exceeded']);

    const twoColumns = tableSpec({
      columns: [
        { name: 'a', required: true, type: 'string' },
        { name: 'b', required: false, type: 'string' },
      ],
    }) as Extract<OutputSpec, { kind: 'table' }>;
    expect(
      inspectTable(twoColumns, 'artifacts/roster.csv', Buffer.from('a,b\n1\n2\n'), {
        limits: { maxRows: 2, maxCells: 5 },
      }).defects.map((defect) => defect.code),
    ).toEqual(['table_cell_limit_exceeded']);
  });

  it.each([
    {
      format: 'csv' as const,
      bytes: Buffer.from('name\nAlpha\nBeta\n'),
    },
    {
      format: 'json' as const,
      bytes: Buffer.from('[{"name":"Alpha"},{"name":"Beta"}]'),
    },
    {
      format: 'markdown' as const,
      bytes: Buffer.from('| name |\n| --- |\n| Alpha |\n| Beta |\n'),
    },
  ])('bounds $format data rows before normalizing them', ({ format, bytes }) => {
    const spec = tableSpec({
      format,
      columns: [{ name: 'name', required: true, type: 'string' }],
    }) as Extract<OutputSpec, { kind: 'table' }>;
    const result = inspectTable(spec, `artifacts/roster.${format}`, bytes, {
      limits: { maxRows: 1 },
    });

    expect(result.defects.map((defect) => defect.code)).toEqual([
      'table_row_limit_exceeded',
    ]);
  });

  it('caps deterministic defect expansion with one stable terminal defect', () => {
    const spec = tableSpec({
      columns: [{ name: 'value', required: true, type: 'integer' }],
    }) as Extract<OutputSpec, { kind: 'table' }>;
    const exact = inspectTable(
      spec,
      'artifacts/roster.csv',
      Buffer.from('value\nbad-1\nbad-2\nbad-3\n'),
      { limits: { maxDefects: 3 } },
    );
    expect(exact.defects.map((defect) => defect.code)).toEqual([
      'invalid_column_value',
      'invalid_column_value',
      'invalid_column_value',
    ]);

    const exceeded = inspectTable(
      spec,
      'artifacts/roster.csv',
      Buffer.from('value\nbad-1\nbad-2\nbad-3\nbad-4\n'),
      { limits: { maxDefects: 3 } },
    );
    expect(exceeded.defects.map((defect) => defect.code)).toEqual([
      'invalid_column_value',
      'invalid_column_value',
      'table_defect_limit_exceeded',
    ]);
  });

  it('propagates the exact active-guard failure from a long CSV parse', () => {
    const spec = tableSpec({
      columns: [{ name: 'name', required: true, type: 'string' }],
    }) as Extract<OutputSpec, { kind: 'table' }>;
    const interrupted = new Error('table inspection deadline');
    let checks = 0;
    let thrown: unknown;

    try {
      inspectTable(
        spec,
        'artifacts/roster.csv',
        Buffer.from(`name\n${'x'.repeat(256 * 1024)}\n`),
        {
          checkActive: () => {
            checks += 1;
            if (checks === 20) throw interrupted;
          },
        },
      );
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBe(interrupted);
    expect(checks).toBe(20);
  });

  it('polls and propagates the active guard while validating table cells', () => {
    const spec = tableSpec({
      columns: [{ name: 'name', required: true, type: 'string' }],
    }) as Extract<OutputSpec, { kind: 'table' }>;
    const interrupted = new Error('table validation deadline');
    const rows = Array.from({ length: 10 }, (_, index) => `row-${index}`).join('\n');
    let checks = 0;
    let thrown: unknown;

    try {
      inspectTable(
        spec,
        'artifacts/roster.csv',
        Buffer.from(`name\n${rows}\n`),
        {
          checkActive: () => {
            checks += 1;
            if (checks === 36) throw interrupted;
          },
        },
      );
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBe(interrupted);
    expect(checks).toBe(36);
  });

  it('threads the finish guard through table parsing', () => {
    publish(
      'artifacts/roster.csv',
      `name\n${'x'.repeat(1024 * 1024)}\n`,
    );
    const interrupted = new Error('whole-run table deadline');
    let checks = 0;
    let thrown: unknown;

    try {
      runV3FinishChecks({
        runDir,
        contract: contract(
          tableSpec({
            columns: [{ name: 'name', required: true, type: 'string' }],
          }),
        ),
        finish: finish(['artifacts/roster.csv']),
        checkActive: () => {
          checks += 1;
          if (checks === 40) throw interrupted;
        },
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBe(interrupted);
    expect(checks).toBe(40);
  });

  it('rejects extra/reordered columns and malformed row widths', () => {
    publish('artifacts/roster.csv', 'url,name,extra\nhttps://e.test/a,Alpha,x\n');
    let result = runV3FinishChecks({
      runDir,
      contract: contract(tableSpec()),
      finish: finish(['artifacts/roster.csv']),
    });
    expect(codes(result)).toContain('column_mismatch');

    publish('artifacts/roster.csv', 'name,url\nAlpha,https://e.test/a,extra\n');
    result = runV3FinishChecks({
      runDir,
      contract: contract(tableSpec()),
      finish: finish(['artifacts/roster.csv']),
    });
    expect(codes(result)).toContain('row_shape_mismatch');
  });

  it('parses quoted CSV fields/newlines and enforces row/count/value rules', () => {
    publish(
      'artifacts/roster.csv',
      'name,url\n"Alpha, Inc.\nNorth",https://e.test/a\nBeta,https://e.test/b\n',
    );
    const spec = tableSpec({
      rules: [
        { type: 'exact_row_count', value: 2 },
        { type: 'unique', columns: ['name'] },
        {
          type: 'matches_expected_values',
          column: 'name',
          expected: ['Alpha, Inc.\nNorth', 'Beta'],
          exhaustive: true,
          source: { kind: 'original_task' },
        },
      ],
    });
    const result = runV3FinishChecks({
      runDir,
      contract: contract(spec),
      finish: finish(['artifacts/roster.csv']),
    });
    expect(result.status).toBe('passed');
    expect(result.facts.outputs[0]).toMatchObject({
      rowCount: 2,
      satisfiedRules: ['exact_row_count', 'unique', 'matches_expected_values'],
    });
  });

  it('validates required values and every declared primitive type', () => {
    const spec = tableSpec({
      columns: [
        { name: 'name', required: true, type: 'string' },
        { name: 'count', required: true, type: 'integer' },
        { name: 'score', required: true, type: 'number' },
        { name: 'active', required: true, type: 'boolean' },
        { name: 'url', required: true, type: 'url' },
        { name: 'state', required: true, type: 'enum', values: ['open', 'closed'] },
        {
          name: 'date',
          required: true,
          type: 'date',
          format: { kind: 'iso_date' },
        },
      ],
    });
    publish(
      'artifacts/roster.csv',
      'name,count,score,active,url,state,date\n,1.5,NaN,maybe,ftp://e.test,unknown,2026-02-31\n',
    );

    const result = runV3FinishChecks({
      runDir,
      contract: contract(spec),
      finish: finish(['artifacts/roster.csv']),
    });
    expect(codes(result).filter((code) => code === 'invalid_column_value')).toHaveLength(6);
    expect(codes(result)).toContain('missing_required_value');
  });

  it('checks JSON row key order and native JSON value types', () => {
    const spec = tableSpec({
      filename: 'roster.json',
      format: 'json',
      columns: [
        { name: 'name', required: true, type: 'string' },
        { name: 'count', required: true, type: 'integer' },
      ],
    });
    publish('artifacts/roster.json', '[{"count":"1","name":"Alpha"}]');
    const result = runV3FinishChecks({
      runDir,
      contract: contract(spec),
      finish: finish(['artifacts/roster.json']),
    });
    expect(codes(result)).toContain('row_shape_mismatch');
  });

  it('parses Markdown data rows rather than checking only the header', () => {
    const spec = tableSpec({
      filename: 'roster.md',
      format: 'markdown',
      rules: [{ type: 'exact_row_count', value: 2 }],
    });
    publish(
      'artifacts/roster.md',
      '| name | url |\n| --- | --- |\n| Alpha | https://e.test/a |\n| Beta | https://e.test/b |\n',
    );
    const result = runV3FinishChecks({
      runDir,
      contract: contract(spec),
      finish: finish(['artifacts/roster.md']),
    });
    expect(result.status).toBe('passed');
    expect(result.facts.outputs[0]).toMatchObject({ rowCount: 2 });
  });

  it('rejects placeholders and missing expected/exhaustive values together', () => {
    publish('artifacts/roster.csv', 'name,url\nTODO,\nUnexpected,\n');
    const spec = tableSpec({
      rules: [
        {
          type: 'matches_expected_values',
          column: 'name',
          expected: ['Alpha'],
          exhaustive: true,
          source: { kind: 'original_task' },
        },
      ],
    });
    const result = runV3FinishChecks({
      runDir,
      contract: contract(spec),
      finish: finish(['artifacts/roster.csv']),
    });
    expect(codes(result)).toEqual(
      expect.arrayContaining(['placeholder_text', 'missing_expected_values', 'unexpected_values']),
    );
  });
});

describe('runV3FinishChecks — documents and captures', () => {
  function documentSpec(overrides: Record<string, unknown> = {}): OutputSpec {
    return {
      id: 'report',
      kind: 'document',
      filename: 'report.md',
      format: 'markdown',
      evidenceRequirement: 'none',
      evidencePresentation: 'hidden',
      ...overrides,
    } as OutputSpec;
  }

  it('checks document encoding, required sections, and placeholders', () => {
    publish('artifacts/report.md', '# Summary\nTODO\n');
    const result = runV3FinishChecks({
      runDir,
      contract: contract(documentSpec({ requiredSections: ['Summary', 'Findings'] })),
      finish: finish(['artifacts/report.md']),
    });
    expect(codes(result)).toEqual(
      expect.arrayContaining(['placeholder_text', 'missing_required_section']),
    );
  });

  it('requires actual PDF bytes for a PDF document', () => {
    publish('artifacts/report.pdf', 'plain text');
    const result = runV3FinishChecks({
      runDir,
      contract: contract(documentSpec({ filename: 'report.pdf', format: 'pdf' })),
      finish: finish(['artifacts/report.pdf']),
    });
    expect(codes(result)).toContain('document_format_mismatch');
  });

  it('validates requested screenshot bytes, roles, provenance, pattern, and exact count', () => {
    publish('artifacts/shot-1.png', PNG, {
      roles: ['requested_output', 'evidence'],
      sourceUrl: 'https://example.test/source',
    });
    const spec = {
      id: 'shots',
      kind: 'screenshots',
      count: { exact: 1 },
      filenamePattern: 'shot-*.png',
    } as OutputSpec;
    const result = runV3FinishChecks({
      runDir,
      contract: contract(spec),
      finish: finish(['artifacts/shot-1.png']),
    });
    expect(result.status).toBe('passed');
    expect(result.facts.outputs[0]).toMatchObject({
      kind: 'screenshots',
      artifactPaths: ['artifacts/shot-1.png'],
      count: 1,
    });
  });

  it('rejects screenshot-shaped names with non-PNG bytes or missing provenance', () => {
    publish('artifacts/shot-1.png', 'not png');
    const spec = {
      id: 'shots',
      kind: 'screenshots',
      count: { minimum: 1 },
      filenamePattern: 'shot-*.png',
    } as OutputSpec;
    const result = runV3FinishChecks({
      runDir,
      contract: contract(spec),
      finish: finish(['artifacts/shot-1.png']),
    });
    expect(codes(result)).toEqual(
      expect.arrayContaining([
        'screenshot_format_mismatch',
        'missing_capture_source_url',
        'capture_count_below_minimum',
      ]),
    );
  });

  it('requires contract-requested captures to carry requested_output', () => {
    publish('artifacts/shot-1.png', PNG, {
      roles: ['evidence'],
      sourceUrl: 'https://example.test/source',
    });
    const spec = {
      id: 'shots',
      kind: 'screenshots',
      count: { minimum: 1 },
      filenamePattern: 'shot-*.png',
    } as OutputSpec;
    const result = runV3FinishChecks({
      runDir,
      contract: contract(spec),
      finish: finish([], ['The screenshot is not yet published as requested output.']),
    });
    expect(codes(result)).toEqual(
      expect.arrayContaining(['capture_wrong_role', 'capture_count_below_minimum']),
    );
  });

  it('validates download source patterns, inferred media types, and placeholder content', () => {
    publish('artifacts/report.pdf', Buffer.from('%PDF-body'), {
      sourceUrl: 'https://example.test/files/report.pdf',
    });
    const spec = {
      id: 'download',
      kind: 'download',
      count: { exact: 1 },
      filenamePattern: '*.pdf',
      allowedMediaTypes: ['application/pdf'],
      sourceUrlPattern: 'https://example.test/files/*',
    } as OutputSpec;
    const passing = runV3FinishChecks({
      runDir,
      contract: contract(spec),
      finish: finish(['artifacts/report.pdf']),
    });
    expect(passing.status).toBe('passed');

    publish('artifacts/report.pdf', 'TODO', {
      sourceUrl: 'https://other.test/report.pdf',
    });
    const failing = runV3FinishChecks({
      runDir,
      contract: contract(spec),
      finish: finish(['artifacts/report.pdf']),
    });
    expect(codes(failing)).toEqual(
      expect.arrayContaining([
        'download_source_mismatch',
        'download_media_type_mismatch',
        'placeholder_text',
        'capture_count_mismatch',
      ]),
    );
  });

  it('keeps unconstrained screenshot names separate from a media-constrained download', () => {
    publish('artifacts/source.png', PNG, {
      roles: ['requested_output', 'evidence'],
      sourceUrl: 'https://example.test/source',
    });
    publish('artifacts/report.pdf', Buffer.from('%PDF-body'), {
      sourceUrl: 'https://example.test/report.pdf',
    });
    const screenshots = {
      id: 'shots',
      kind: 'screenshots',
      count: { exact: 1 },
    } as OutputSpec;
    const download = {
      id: 'download',
      kind: 'download',
      count: { exact: 1 },
      allowedMediaTypes: ['application/pdf'],
    } as OutputSpec;

    const result = runV3FinishChecks({
      runDir,
      contract: contract(screenshots, download),
      finish: finish(['artifacts/source.png', 'artifacts/report.pdf']),
    });
    expect(result.status).toBe('passed');
    expect(result.facts.outputs.map((output) => [output.outputId, output.kind])).toEqual([
      ['shots', 'screenshots'],
      ['download', 'download'],
    ]);
    expect(
      v3FinishFactsSchema.parse(JSON.parse(JSON.stringify(result.facts))),
    ).toEqual(result.facts);
  });

  it('rejects one valid capture satisfying two unconstrained capture outputs', () => {
    publish('artifacts/source.png', PNG, {
      roles: ['requested_output', 'evidence'],
      sourceUrl: 'https://example.test/source',
    });
    const first = {
      id: 'first-shots',
      kind: 'screenshots',
      count: { exact: 1 },
    } as OutputSpec;
    const second = {
      id: 'second-shots',
      kind: 'screenshots',
      count: { exact: 1 },
    } as OutputSpec;
    const result = runV3FinishChecks({
      runDir,
      contract: contract(first, second),
      finish: finish(['artifacts/source.png']),
    });
    expect(codes(result)).toContain('ambiguous_capture_assignment');
  });

  it('requires generic evidence when a document contract requires it', () => {
    publish('artifacts/report.md', '# Summary\nSupported claim.\n');
    const result = runV3FinishChecks({
      runDir,
      contract: contract(documentSpec({ evidenceRequirement: 'at_least_one' })),
      finish: finish(['artifacts/report.md']),
    });
    expect(codes(result)).toContain('missing_document_evidence');
  });

  it('rejects stray requested outputs and requested-role helper proposals', () => {
    publish('artifacts/roster.csv', 'name,url\nAlpha,\n');
    mkdirSync(join(runDir, 'artifacts/helper-proposals'), { recursive: true });
    publish('artifacts/helper-proposals/helper.patch', 'diff --git a/a b/a\n');
    const result = runV3FinishChecks({
      runDir,
      contract: contract(tableSpec()),
      finish: finish([
        'artifacts/roster.csv',
        'artifacts/helper-proposals/helper.patch',
      ]),
    });
    expect(codes(result)).toEqual(
      expect.arrayContaining(['unexpected_requested_output', 'helper_proposal_wrong_role']),
    );
  });
});

describe('runV3FinishChecks — browser evidence and limitations', () => {
  beforeEach(() => {
    rmSync(runDir, { recursive: true, force: true });
    runDir = mkdtempSync(join(tmpdir(), 'v3-finish-checks-browser-'));
    initManifest(runDir, TASK, 'local');
  });

  it('requires a source-backed evidence screenshot for a browser-backed run', () => {
    publish('artifacts/roster.csv', 'name,url\nAlpha,\n');
    const result = runV3FinishChecks({
      runDir,
      contract: contract(tableSpec()),
      finish: finish(['artifacts/roster.csv']),
    });
    expect(codes(result)).toContain('missing_browser_evidence_screenshot');
  });

  it('accepts a verified evidence screenshot and reports it as a fact', () => {
    publish('artifacts/roster.csv', 'name,url\nAlpha,\n');
    publish('artifacts/source.png', PNG, {
      roles: ['evidence'],
      sourceUrl: 'https://example.test/source',
    });
    const result = runV3FinishChecks({
      runDir,
      contract: contract(tableSpec()),
      finish: finish(['artifacts/roster.csv']),
    });
    expect(result.status).toBe('passed');
    expect(result.facts.evidenceScreenshotPaths).toEqual(['artifacts/source.png']);
  });

  it('recognizes an exact eight-byte PNG signature as bounded evidence', () => {
    publish('artifacts/roster.csv', 'name,url\nAlpha,\n');
    publish('artifacts/source.png', PNG.subarray(0, 8), {
      roles: ['evidence'],
      sourceUrl: 'https://example.test/source',
    });
    const result = runV3FinishChecks({
      runDir,
      contract: contract(tableSpec()),
      finish: finish(['artifacts/roster.csv']),
    });
    expect(result.status).toBe('passed');
    expect(result.facts.evidenceScreenshotPaths).toEqual(['artifacts/source.png']);
  });

  it('allows an explicit screenshot access limitation without waiving required outputs', () => {
    publish('artifacts/roster.csv', 'name,url\nAlpha,\n');
    const limitation = 'Login access was denied, so a source page screenshot could not be captured.';
    const result = runV3FinishChecks({
      runDir,
      contract: contract(tableSpec()),
      finish: finish(['artifacts/roster.csv'], [limitation]),
    });
    expect(result.status).toBe('passed');
    expect(result.facts.finish.limitations).toEqual([limitation]);
  });

  it('rejects placeholder limitations', () => {
    publish('artifacts/roster.csv', 'name,url\nAlpha,\n');
    const result = runV3FinishChecks({
      runDir,
      contract: contract(tableSpec()),
      finish: finish(['artifacts/roster.csv'], ['TBD access limitation']),
    });
    expect(codes(result)).toEqual(
      expect.arrayContaining(['placeholder_limitation', 'missing_browser_evidence_screenshot']),
    );
  });
});
