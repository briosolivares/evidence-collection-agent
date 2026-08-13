import { describe, expect, it } from 'vitest';

import {
  outputContractSchema,
  serializeContractRevision,
  setOutputContractInputSchema,
  validateContractRevision,
  type ContractRevisionBasis,
  type OutputContract,
  type OutputSpec,
} from './outputContract.js';

// Every cross-field rule lives in validateContractRevision() rather than in
// the Zod schema (refinements are dropped by z.toJSONSchema(), so the model
// would never see them). These tests therefore drive the validator, not the
// schema, for anything beyond raw shape.

/** A minimal valid table output. */
function tableOutput(overrides: Partial<Extract<OutputSpec, { kind: 'table' }>> = {}): OutputSpec {
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

function contract(outputs: OutputSpec[] = [tableOutput()]): OutputContract {
  return { outputs } as OutputContract;
}

/** Validate a first revision (no basis required). */
function firstRevision(c: OutputContract = contract()) {
  return validateContractRevision({ contract: c }, 1);
}

function errorsOf(result: ReturnType<typeof validateContractRevision>): string[] {
  if (result.ok) throw new Error('expected the revision to be rejected');
  return result.errors;
}

const EVIDENCE_BASIS: ContractRevisionBasis = {
  kind: 'evidence_discovery',
  summary: 'The roster page exposes an exact member count.',
  evidenceIds: ['E1'],
};

describe('outputContractSchema shape', () => {
  it('requires at least one output and at least one column per table', () => {
    expect(outputContractSchema.safeParse({ outputs: [] }).success).toBe(false);
    expect(
      outputContractSchema.safeParse(contract([tableOutput({ columns: [] })])).success,
    ).toBe(false);
  });

  it('rejects unknown keys anywhere in the contract', () => {
    expect(
      outputContractSchema.safeParse({ outputs: [tableOutput()], surprise: true }).success,
    ).toBe(false);
    expect(
      setOutputContractInputSchema.safeParse({ contract: contract(), extra: 1 }).success,
    ).toBe(false);
  });

  it('applies document evidence defaults so the stored form is always explicit', () => {
    const result = firstRevision(
      contract([
        {
          id: 'report',
          kind: 'document',
          filename: 'report.md',
          format: 'markdown',
        } as OutputSpec,
      ]),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    const doc = result.revision.contract.outputs[0] as Extract<OutputSpec, { kind: 'document' }>;
    expect(doc.evidenceRequirement).toBe('at_least_one');
    expect(doc.evidencePresentation).toBe('hidden');
  });
});

describe('validateContractRevision cross-field rules', () => {
  it('accepts a well-formed first revision', () => {
    const result = firstRevision();
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.revision.revision).toBe(1);
    expect(result.revision.basis).toBeUndefined();
  });

  it('rejects duplicate output ids', () => {
    const result = firstRevision(contract([tableOutput(), tableOutput({ filename: 'other.csv' })]));
    expect(errorsOf(result).join('\n')).toMatch(/duplicate output id/);
  });

  it('rejects two outputs claiming the same file', () => {
    const result = firstRevision(
      contract([tableOutput(), tableOutput({ id: 'second' })]),
    );
    expect(errorsOf(result).join('\n')).toMatch(/roster\.csv/);
  });

  it.each([
    ['a directory component', 'sub/roster.csv'],
    ['an absolute path', '/etc/passwd'],
    ['a parent traversal', '../roster.csv'],
    ['a bare dot', '.'],
    ['a parent dir', '..'],
    ['the manifest', 'manifest.json'],
    ['the metrics file', 'metrics.json'],
    ['the transcript', 'transcript.jsonl'],
  ])('rejects an unsafe filename: %s', (_label, filename) => {
    expect(errorsOf(firstRevision(contract([tableOutput({ filename })]))).length).toBeGreaterThan(0);
  });

  it('rejects a filename carrying a control character', () => {
    const result = firstRevision(contract([tableOutput({ filename: 'roster\u0001.csv' })]));
    expect(errorsOf(result).length).toBeGreaterThan(0);
  });

  it('rejects duplicate table columns', () => {
    const result = firstRevision(
      contract([
        tableOutput({
          columns: [
            { name: 'name', required: true, type: 'string' },
            { name: 'name', required: false, type: 'string' },
          ],
        }),
      ]),
    );
    expect(errorsOf(result).join('\n')).toMatch(/name/);
  });

  it('rejects a rule naming an undeclared column', () => {
    const result = firstRevision(
      contract([tableOutput({ rules: [{ type: 'unique', columns: ['missing'] }] as never })]),
    );
    expect(errorsOf(result).join('\n')).toMatch(/missing/);
  });

  it('rejects a minimum row count above an exact count', () => {
    const result = firstRevision(
      contract([
        tableOutput({
          rules: [
            { type: 'exact_row_count', value: 5 },
            { type: 'minimum_row_count', value: 9 },
          ] as never,
        }),
      ]),
    );
    expect(errorsOf(result).length).toBeGreaterThan(0);
  });

  it('rejects a non-positive or non-integer count', () => {
    for (const count of [0, -3, 2.5]) {
      const result = firstRevision(
        contract([tableOutput({ rules: [{ type: 'exact_row_count', value: count }] as never })]),
      );
      expect(errorsOf(result).length).toBeGreaterThan(0);
    }
  });

  it('rejects a download constrained by nothing', () => {
    const result = firstRevision(
      contract([
        { id: 'dl', kind: 'download', count: { minimum: 1 } } as OutputSpec,
      ]),
    );
    expect(errorsOf(result).join('\n')).toMatch(/download/i);
  });

  it('rejects per-section evidence with no required sections', () => {
    const result = firstRevision(
      contract([
        {
          id: 'report',
          kind: 'document',
          filename: 'report.md',
          format: 'markdown',
          evidenceRequirement: 'per_required_section',
        } as OutputSpec,
      ]),
    );
    expect(errorsOf(result).join('\n')).toMatch(/section/i);
  });

  it('rejects footnoted citations on a document requiring no evidence', () => {
    const result = firstRevision(
      contract([
        {
          id: 'report',
          kind: 'document',
          filename: 'report.md',
          format: 'markdown',
          evidenceRequirement: 'none',
          evidencePresentation: 'footnotes',
        } as OutputSpec,
      ]),
    );
    expect(errorsOf(result).length).toBeGreaterThan(0);
  });

  it('reports every problem at once so one correction can fix them all', () => {
    const result = firstRevision(
      contract([
        tableOutput({ filename: 'sub/roster.csv' }),
        tableOutput({ id: 'roster', filename: 'manifest.json' }),
      ]),
    );
    // Duplicate id, unsafe path, and reserved name are all named together.
    expect(errorsOf(result).length).toBeGreaterThanOrEqual(3);
  });
});

describe('validateContractRevision revision basis', () => {
  it('rejects a basis on revision 1 and requires one afterwards', () => {
    expect(
      errorsOf(validateContractRevision({ contract: contract(), revisionBasis: EVIDENCE_BASIS }, 1))
        .length,
    ).toBeGreaterThan(0);
    expect(errorsOf(validateContractRevision({ contract: contract() }, 2)).length).toBeGreaterThan(
      0,
    );
  });

  it('accepts each legitimate basis kind on a later revision', () => {
    const bases: ContractRevisionBasis[] = [
      EVIDENCE_BASIS,
      { kind: 'assumption_correction', summary: 'Chapters are per-campus, not per-state.' },
      { kind: 'user_clarification', summary: 'The user relaxed the date range.' },
    ];
    for (const basis of bases) {
      const result = validateContractRevision(
        { contract: contract(), revisionBasis: basis },
        2,
      );
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error('unreachable');
      expect(result.revision.revision).toBe(2);
      expect(result.revision.basis).toEqual(basis);
    }
  });

  it('requires supporting evidence ids on an evidence-discovery basis', () => {
    const result = validateContractRevision(
      {
        contract: contract(),
        revisionBasis: { kind: 'evidence_discovery', summary: 'Found it.', evidenceIds: [] },
      },
      2,
    );
    expect(errorsOf(result).length).toBeGreaterThan(0);
  });

  it('throws on a caller-supplied revision number that is not a positive integer', () => {
    for (const n of [0, -1, 1.5, Number.NaN, Infinity]) {
      expect(() => validateContractRevision({ contract: contract() }, n)).toThrow(
        /revisionNumber/,
      );
    }
  });
});

describe('serializeContractRevision', () => {
  it('is byte-identical for the same contract regardless of key order', () => {
    // The plan requires worker- and initializer-authored contracts to store
    // identically for the same input; canonical key ordering is what makes
    // that true even though the model chooses its own emission order.
    const a = firstRevision(contract());
    const reordered = validateContractRevision(
      {
        contract: {
          outputs: [
            {
              rules: [],
              columns: [
                { type: 'string', required: true, name: 'name' },
                { required: false, type: 'url', name: 'url' },
              ],
              format: 'csv',
              filename: 'roster.csv',
              kind: 'table',
              id: 'roster',
            },
          ],
        },
      },
      1,
    );
    expect(a.ok && reordered.ok).toBe(true);
    if (!a.ok || !reordered.ok) throw new Error('unreachable');
    expect(serializeContractRevision(a.revision)).toBe(
      serializeContractRevision(reordered.revision),
    );
  });

  it('preserves column order, which is semantic', () => {
    const result = firstRevision();
    if (!result.ok) throw new Error('unreachable');
    const serialized = serializeContractRevision(result.revision);
    expect(serialized.indexOf('"name"')).toBeLessThan(serialized.indexOf('"url"'));
  });

  it('ends in exactly one trailing newline', () => {
    const result = firstRevision();
    if (!result.ok) throw new Error('unreachable');
    const serialized = serializeContractRevision(result.revision);
    expect(serialized.endsWith('}\n')).toBe(true);
    expect(serialized.endsWith('\n\n')).toBe(false);
  });

  it('round-trips through JSON.parse to a deep-equal revision', () => {
    const result = firstRevision();
    if (!result.ok) throw new Error('unreachable');
    expect(JSON.parse(serializeContractRevision(result.revision))).toEqual(result.revision);
  });
});
