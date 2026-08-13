import { describe, expect, it } from 'vitest';

import { mergeResearchResults } from './mergeResearchResults.js';
import type {
  ResearchCandidateRow,
  ResearchEvidenceRecord,
  ResearchJobResult,
  ResearchJobStatus,
} from './researchJob.js';

// Pure-function tests over fixture job results: no runner, no model, no
// browser. What is under test is the merge POLICY — deterministic order,
// namespaced identity, reported overlap, validated citations — and each of
// those is a decision that must hold regardless of how the jobs ran.

function evidence(jobId: string, id: string): ResearchEvidenceRecord {
  return {
    id,
    kind: 'javascript_extraction',
    summary: `${jobId} captured ${id}`,
    sourceUrl: `https://example.com/${jobId}`,
    recordedAt: '2026-08-13T12:00:00.000Z',
    path: `scratch/research-jobs/${jobId}/scratch/evidence/${id}.json`,
    sha256: 'f'.repeat(64),
    detail: { captured: id },
  };
}

function row(over: Partial<ResearchCandidateRow> = {}): ResearchCandidateRow {
  return {
    rowId: 'acme',
    values: { name: 'Acme', founded: 1999 },
    evidenceIds: ['E1'],
    ...over,
  };
}

function jobResult(
  jobId: string,
  over: Partial<Omit<ResearchJobResult, 'jobId'>> = {},
): ResearchJobResult {
  const status: ResearchJobStatus = over.status ?? 'completed';
  return {
    jobId,
    entity: over.entity ?? `entity-${jobId}`,
    status,
    rows: over.rows ?? [row()],
    evidence: over.evidence ?? [evidence(jobId, 'E1')],
    limitations: over.limitations ?? [],
    usage: over.usage ?? {
      turns: 2,
      inputTokens: 100,
      outputTokens: 40,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      toolCalls: 3,
      wallClockMs: 1_000,
    },
    jobDir: over.jobDir ?? `scratch/research-jobs/${jobId}`,
    ...(over.failure === undefined ? {} : { failure: over.failure }),
  };
}

describe('mergeResearchResults ordering and identity', () => {
  it('imports in lexicographic job order whatever order the jobs finished in', () => {
    const alpha = jobResult('a-job', { rows: [row({ rowId: 'alpha' })] });
    const bravo = jobResult('b-job', { rows: [row({ rowId: 'bravo' })] });
    const charlie = jobResult('c-job', { rows: [row({ rowId: 'charlie' })] });

    const finishedOutOfOrder = mergeResearchResults([charlie, alpha, bravo]);
    const finishedInOrder = mergeResearchResults([alpha, bravo, charlie]);

    expect(finishedOutOfOrder.rows.map((r) => r.rowId)).toEqual([
      'a-job:alpha',
      'b-job:bravo',
      'c-job:charlie',
    ]);
    // The whole merge is reproducible, not just the row order — a merge that
    // depended on arrival order would give two identical runs different
    // deliverables.
    expect(JSON.stringify(finishedOutOfOrder)).toBe(JSON.stringify(finishedInOrder));
  });

  it('namespaces row ids so two jobs choosing the same id cannot collide', () => {
    // Both jobs picked the row id "acme" for DIFFERENT companies, which is
    // exactly the accident an unnamespaced merge would silently resolve by
    // keeping whichever landed last.
    const first = jobResult('j1', {
      rows: [row({ rowId: 'acme', dedupeKey: 'acme-usa', values: { name: 'Acme USA' } })],
    });
    const second = jobResult('j2', {
      rows: [row({ rowId: 'acme', dedupeKey: 'acme-gmbh', values: { name: 'Acme GmbH' } })],
    });

    const merged = mergeResearchResults([first, second]);

    expect(merged.rows.map((r) => r.rowId)).toEqual(['j1:acme', 'j2:acme']);
    expect(merged.conflicts).toEqual([]);
    expect(merged.duplicates).toEqual([]);
  });

  it('guards every imported row against a lost update', () => {
    const merged = mergeResearchResults([jobResult('j1')]);

    // expectedVersion 0 means "must not exist yet": these ids are new by
    // construction, so a stored row at any version means something else
    // already wrote it and the coordinator must hear about it.
    expect(merged.rows.map((r) => r.expectedVersion)).toEqual([0]);
  });
});

describe('mergeResearchResults overlap', () => {
  it('imports an agreeing overlap once and reports it, unioning the evidence', () => {
    // Real overlap: two independent jobs both researched Acme and agree.
    const first = jobResult('j1', {
      rows: [row({ rowId: 'acme', evidenceIds: ['E1'] })],
      evidence: [evidence('j1', 'E1')],
    });
    const second = jobResult('j2', {
      rows: [row({ rowId: 'acme', evidenceIds: ['E1'] })],
      evidence: [evidence('j2', 'E1')],
    });

    const merged = mergeResearchResults([second, first]);

    expect(merged.rows).toHaveLength(1);
    expect(merged.rows[0]!.rowId).toBe('j1:acme');
    // Two independent proofs of the same values is better evidence than one;
    // dropping the loser's citation would throw that away.
    expect(merged.rows[0]!.evidenceIds).toEqual(['j1:E1', 'j2:E1']);
    expect(merged.duplicates).toEqual([
      {
        dedupeKey: 'acme',
        importedRowId: 'j1:acme',
        importedJobId: 'j1',
        duplicateRowIds: ['j2:acme'],
      },
    ]);
    expect(merged.jobs.find((job) => job.jobId === 'j2')!.rowsImported).toBe(0);
  });

  it('imports NOTHING for a disagreeing overlap and reports both candidates', () => {
    const first = jobResult('j1', {
      rows: [row({ rowId: 'acme', values: { name: 'Acme', founded: 1999 } })],
    });
    const second = jobResult('j2', {
      rows: [row({ rowId: 'acme', values: { name: 'Acme', founded: 2001 } })],
    });

    const merged = mergeResearchResults([first, second]);

    // Never the last writer, and never the first either: a disagreement is a
    // research finding the coordinator has to settle.
    expect(merged.rows).toEqual([]);
    expect(merged.conflicts).toHaveLength(1);
    expect(merged.conflicts[0]!.dedupeKey).toBe('acme');
    expect(merged.conflicts[0]!.disagreeingColumns).toEqual(['founded']);
    expect(merged.conflicts[0]!.candidates.map((c) => c.jobId)).toEqual(['j1', 'j2']);
    expect(merged.conflicts[0]!.candidates.map((c) => c.values.founded)).toEqual([1999, 2001]);
    expect(merged.jobs.map((job) => job.rowsInConflict)).toEqual([1, 1]);
  });

  it('counts a missing column as a disagreement, not as an empty value', () => {
    const first = jobResult('j1', { rows: [row({ values: { name: 'Acme', founded: 1999 } })] });
    const second = jobResult('j2', { rows: [row({ values: { name: 'Acme' } })] });

    const merged = mergeResearchResults([first, second]);

    expect(merged.conflicts[0]!.disagreeingColumns).toEqual(['founded']);
    expect(merged.rows).toEqual([]);
  });

  it('treats a string and a number for one cell as a disagreement', () => {
    const first = jobResult('j1', { rows: [row({ values: { name: 'Acme', founded: 1999 } })] });
    const second = jobResult('j2', { rows: [row({ values: { name: 'Acme', founded: '1999' } })] });

    const merged = mergeResearchResults([first, second]);

    expect(merged.conflicts[0]!.disagreeingColumns).toEqual(['founded']);
  });

  it('matches dedupe keys across incidental spacing and case', () => {
    const first = jobResult('j1', { rows: [row({ rowId: 'Jane  Doe' })] });
    const second = jobResult('j2', { rows: [row({ rowId: 'jane doe' })] });

    const merged = mergeResearchResults([first, second]);

    expect(merged.rows).toHaveLength(1);
    expect(merged.duplicates).toHaveLength(1);
    expect(merged.duplicates[0]!.dedupeKey).toBe('jane doe');
  });

  it('prefers an explicit dedupeKey over the row id', () => {
    const first = jobResult('j1', { rows: [row({ rowId: 'row-1', dedupeKey: 'acme' })] });
    const second = jobResult('j2', { rows: [row({ rowId: 'row-2', dedupeKey: 'acme' })] });

    const merged = mergeResearchResults([first, second]);

    expect(merged.rows.map((r) => r.rowId)).toEqual(['j1:row-1']);
    expect(merged.duplicates[0]!.duplicateRowIds).toEqual(['j2:row-2']);
  });
});

describe('mergeResearchResults citation validation', () => {
  it('rejects a row citing evidence its job never recorded, keeping the siblings', () => {
    const liar = jobResult('j1', {
      rows: [
        row({ rowId: 'good', evidenceIds: ['E1'] }),
        row({ rowId: 'invented', evidenceIds: ['E9'] }),
      ],
      evidence: [evidence('j1', 'E1')],
    });
    const honest = jobResult('j2', { rows: [row({ rowId: 'other' })] });

    const merged = mergeResearchResults([liar, honest]);

    expect(merged.rows.map((r) => r.rowId)).toEqual(['j1:good', 'j2:other']);
    expect(merged.rejected).toEqual([
      {
        jobId: 'j1',
        rowId: 'invented',
        reason: 'unknown_evidence',
        detail: expect.stringContaining('E9') as unknown as string,
      },
    ]);
    expect(merged.jobs.find((job) => job.jobId === 'j1')!.rowsRejected).toBe(1);
  });

  it('accepts a citation the coordinator already holds', () => {
    const job = jobResult('j1', {
      rows: [row({ evidenceIds: ['E1', 'E42'] })],
      evidence: [evidence('j1', 'E1')],
    });

    const merged = mergeResearchResults([job], {
      evidenceExists: (id) => id === 'E42',
    });

    expect(merged.rejected).toEqual([]);
    // A coordinator-side id passes through unchanged; only job-local ids are
    // namespaced.
    expect(merged.rows[0]!.evidenceIds).toEqual(['j1:E1', 'E42']);
  });

  it('rejects a second row reusing one job’s row id', () => {
    const job = jobResult('j1', {
      rows: [row({ rowId: 'acme', values: { name: 'first' } }), row({ rowId: 'acme', values: { name: 'second' } })],
    });

    const merged = mergeResearchResults([job]);

    expect(merged.rows).toHaveLength(1);
    expect(merged.rows[0]!.values).toEqual({ name: 'first' });
    expect(merged.rejected[0]!.reason).toBe('duplicate_row_id_within_job');
  });

  it('rejects a valueless candidate', () => {
    const job = jobResult('j1', { rows: [row({ values: {} })] });

    const merged = mergeResearchResults([job]);

    expect(merged.rows).toEqual([]);
    expect(merged.rejected[0]!.reason).toBe('empty_values');
  });

  it('reports a contract-invalid row instead of poisoning the whole batch', () => {
    // The coordinator's upsert is atomic: without per-row rejection here, one
    // job's malformed row would reject every other job's rows with it.
    const bad = jobResult('j1', { rows: [row({ values: { name: 'Acme', founded: 'yesterday' } })] });
    const good = jobResult('j2', { rows: [row({ rowId: 'other' })] });

    const merged = mergeResearchResults([bad, good], {
      validateRowValues: (candidate) =>
        typeof candidate.values.founded === 'number' ? [] : ['column "founded" must be an integer'],
    });

    expect(merged.rows.map((r) => r.rowId)).toEqual(['j2:other']);
    expect(merged.rejected[0]).toMatchObject({
      jobId: 'j1',
      reason: 'invalid_values',
      detail: 'column "founded" must be an integer',
    });
  });
});

describe('mergeResearchResults with failed children', () => {
  it('keeps every successful child’s rows when a sibling fails or is cancelled', () => {
    const crashed = jobResult('j1', {
      status: 'failed',
      rows: [row({ rowId: 'should-be-ignored' })],
      evidence: [evidence('j1', 'E1')],
      limitations: ['the page 500ed before the table loaded'],
      failure: { reason: 'job_error', detail: 'model transport failure' },
    });
    const cancelled = jobResult('j2', {
      status: 'cancelled',
      rows: [],
      evidence: [evidence('j2', 'E1')],
      failure: { reason: 'cancelled', detail: 'run cancelled' },
    });
    const finished = jobResult('j3', { rows: [row({ rowId: 'acme' })] });

    const merged = mergeResearchResults([crashed, cancelled, finished]);

    // The one job that finished keeps its work in full.
    expect(merged.rows.map((r) => r.rowId)).toEqual(['j3:acme']);
    // A non-completed job contributes NO rows, even if its result carried
    // some — its report was never accepted.
    expect(merged.jobs.find((job) => job.jobId === 'j1')!.rowsProposed).toBe(0);
    // ...but the evidence it did capture, and what it said it could not
    // settle, are still indexed: a partial run's finished captures count.
    expect(merged.evidence.map((record) => record.evidenceId)).toEqual([
      'j1:E1',
      'j2:E1',
      'j3:E1',
    ]);
    expect(merged.limitations).toEqual([
      { jobId: 'j1', limitation: 'the page 500ed before the table loaded' },
    ]);
    expect(merged.jobs.map((job) => job.status)).toEqual(['failed', 'cancelled', 'completed']);
    expect(merged.jobs[0]!.failure).toEqual({
      reason: 'job_error',
      detail: 'model transport failure',
    });
  });

  it('reports a refused headed assignment without touching the others', () => {
    const refused = jobResult('j1', {
      status: 'refused',
      rows: [],
      evidence: [],
      failure: { reason: 'headed_work_stays_with_coordinator', detail: 'do it yourself' },
    });
    const finished = jobResult('j2');

    const merged = mergeResearchResults([refused, finished]);

    expect(merged.rows).toHaveLength(1);
    expect(merged.jobs[0]!.status).toBe('refused');
    expect(merged.jobs[0]!.failure!.reason).toBe('headed_work_stays_with_coordinator');
  });
});

describe('mergeResearchResults evidence import', () => {
  it('rewrites citations to the ids the run’s ledger issued, in deterministic order', () => {
    const issued: string[] = [];
    const first = jobResult('j1', {
      rows: [row({ rowId: 'a', evidenceIds: ['E1', 'E2'] })],
      evidence: [evidence('j1', 'E1'), evidence('j1', 'E2')],
    });
    const second = jobResult('j2', {
      rows: [row({ rowId: 'b', evidenceIds: ['E1'] })],
      evidence: [evidence('j2', 'E1')],
    });

    const merged = mergeResearchResults([second, first], {
      importEvidence: (record, jobId) => {
        issued.push(`${jobId}/${record.id}`);
        return `E${issued.length + 10}`;
      },
    });

    // Import order follows job order, so the ids the shared ledger issues are
    // reproducible across runs of the same results.
    expect(issued).toEqual(['j1/E1', 'j1/E2', 'j2/E1']);
    expect(merged.rows.map((r) => r.evidenceIds)).toEqual([['E11', 'E12'], ['E13']]);
    expect(merged.evidence.map((record) => [record.jobId, record.localId, record.evidenceId])).toEqual(
      [
        ['j1', 'E1', 'E11'],
        ['j1', 'E2', 'E12'],
        ['j2', 'E1', 'E13'],
      ],
    );
    // The record still points at the untouched bytes in the job's directory.
    expect(merged.evidence[0]!.path).toBe('scratch/research-jobs/j1/scratch/evidence/E1.json');
    expect(merged.evidence[0]!.sha256).toBe('f'.repeat(64));
  });
});
