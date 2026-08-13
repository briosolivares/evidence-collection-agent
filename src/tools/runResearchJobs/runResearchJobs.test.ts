import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { OutputSpec } from '../../contracts/outputContract.js';
import { createEvidenceStore, type EvidenceStore } from '../../evidence/evidenceStore.js';
import { createOutputTableStore, type OutputTableStore } from '../../outputs/outputTable.js';
import type { ResearchMergeResult } from '../../research/mergeResearchResults.js';
import { FORBIDDEN_RESEARCH_TOOL_NAMES } from '../../research/researchRegistry.js';
import type {
  ResearchEvidenceRecord,
  ResearchJob,
  ResearchJobResult,
  ResearchJobRunner,
} from '../../research/researchJob.js';
import { initManifest, type Manifest } from '../../run/artifacts.js';
import { MANIFEST_FILENAME } from '../../run/artifacts.js';
import type { ToolCtx } from '../registry.js';
import {
  createRunResearchJobsTool,
  DEFAULT_RESEARCH_JOB_BUDGET,
  RUN_RESEARCH_JOBS_TOOL_NAME,
  type RunResearchJobsResult,
} from './runResearchJobs.js';

// The tool under test is the coordinator's seam: it turns assignments into
// jobs, hands them to the run-scoped runner, merges what comes back, imports
// the evidence, stages the full merge, and returns a bounded view. The runner
// itself is faked here — researchJob.test.ts covers the real one — so these
// tests can be exact about the tool's own contract, especially "nothing was
// applied to any output".

function evidenceRecord(jobId: string, id: string): ResearchEvidenceRecord {
  return {
    id,
    kind: 'javascript_extraction',
    summary: `${jobId} read the founding year`,
    sourceUrl: `https://example.com/${jobId}`,
    recordedAt: '2026-08-13T12:00:00.000Z',
    path: `scratch/research-jobs/${jobId}/scratch/evidence/${id}.json`,
    sha256: 'c'.repeat(64),
    detail: { founded: 1999 },
  };
}

function jobResult(
  jobId: string,
  over: Partial<Omit<ResearchJobResult, 'jobId'>> = {},
): ResearchJobResult {
  return {
    jobId,
    entity: over.entity ?? `entity-${jobId}`,
    status: over.status ?? 'completed',
    rows: over.rows ?? [
      { rowId: 'acme', values: { name: 'Acme', founded: 1999 }, evidenceIds: ['E1'] },
    ],
    evidence: over.evidence ?? [evidenceRecord(jobId, 'E1')],
    limitations: over.limitations ?? [],
    usage: over.usage ?? {
      turns: 3,
      inputTokens: 500,
      outputTokens: 90,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      toolCalls: 4,
      wallClockMs: 2_500,
    },
    jobDir: `scratch/research-jobs/${jobId}`,
    ...(over.failure === undefined ? {} : { failure: over.failure }),
  };
}

/** A runner that records what it was asked to run and replays canned
 * results, so the tool's own behavior is what is being measured. */
function fakeRunner(
  results: (jobs: readonly ResearchJob[]) => ResearchJobResult[],
): { runner: ResearchJobRunner; dispatched: ResearchJob[][] } {
  const dispatched: ResearchJob[][] = [];
  return {
    dispatched,
    runner: {
      maxConcurrentPublicJobs: 2,
      runJobs: async (jobs) => {
        dispatched.push([...jobs]);
        return results(jobs);
      },
    },
  };
}

const TABLE_SPEC: Extract<OutputSpec, { kind: 'table' }> = {
  id: 'partners',
  kind: 'table',
  filename: 'partners.csv',
  format: 'csv',
  columns: [
    { name: 'name', type: 'string', required: true },
    { name: 'founded', type: 'integer', required: true },
  ],
  rules: [],
};

function coordinatorTables(evidence: EvidenceStore): OutputTableStore {
  return createOutputTableStore({
    tableSpec: (outputId) => (outputId === TABLE_SPEC.id ? TABLE_SPEC : undefined),
    evidenceExists: (id) => evidence.get(id) !== undefined,
  });
}

let runDir: string;
let ctx: ToolCtx;

beforeEach(() => {
  runDir = mkdtempSync(join(tmpdir(), 'run-research-jobs-test-'));
  initManifest(runDir, 'List every partner firm.');
  ctx = { runDir };
});

afterEach(() => {
  rmSync(runDir, { recursive: true, force: true });
});

function manifest(): Manifest {
  return JSON.parse(readFileSync(join(runDir, MANIFEST_FILENAME), 'utf8')) as Manifest;
}

describe('run_research_jobs contract', () => {
  it('is a tool no research child may ever be handed', () => {
    // The runner enforces this list; the two strings must agree or the
    // recursion guard silently checks the wrong name.
    expect(FORBIDDEN_RESEARCH_TOOL_NAMES).toContain(RUN_RESEARCH_JOBS_TOOL_NAME);
  });

  it('runs alone: it spends the run’s budget and opens browser sessions', () => {
    const { runner } = fakeRunner(() => []);
    const tool = createRunResearchJobsTool({ runner, runDir });

    expect(tool.readOnly).toBe(false);
    expect(tool.getAccess!({ assignments: [] })).toEqual({
      reads: [],
      writes: ['evidence'],
      exclusive: true,
    });
  });

  it('rejects a dispatch the runner could not bound', () => {
    const { runner } = fakeRunner(() => []);
    const tool = createRunResearchJobsTool({ runner, runDir });

    expect(tool.inputSchema.safeParse({ assignments: [] }).success).toBe(false);
    expect(
      tool.inputSchema.safeParse({
        assignments: Array.from({ length: 9 }, () => ({ entity: 'e', instruction: 'i' })),
      }).success,
    ).toBe(false);
    // strictObject: an invented field is a misunderstanding worth reporting.
    expect(
      tool.inputSchema.safeParse({
        assignments: [{ entity: 'e', instruction: 'i', budget: { maxTurns: 900 } }],
      }).success,
    ).toBe(false);
    expect(
      tool.inputSchema.safeParse({
        assignments: [{ entity: 'e', instruction: 'i', headed: true }],
        outputId: 'partners',
      }).success,
    ).toBe(true);
  });
});

describe('run_research_jobs dispatch', () => {
  it('derives collision-free job ids and attaches the run’s per-job budget', async () => {
    const { runner, dispatched } = fakeRunner((jobs) => jobs.map((one) => jobResult(one.jobId)));
    const tool = createRunResearchJobsTool({ runner, runDir });

    await tool.execute(
      {
        assignments: [
          { entity: 'Acme Corp.', instruction: 'find the year' },
          // The same entity twice, which a model does do: the index prefix is
          // what keeps the ids — and therefore the directories and the row
          // namespaces — distinct.
          { entity: 'Acme Corp.', instruction: 'find the year again' },
          { entity: '株式会社', instruction: 'find the year' },
        ],
      },
      ctx,
    );

    expect(dispatched[0]!.map((one) => one.jobId)).toEqual([
      'j1-acme-corp',
      'j2-acme-corp',
      'j3',
    ]);
    expect(dispatched[0]!.every((one) => one.budget === DEFAULT_RESEARCH_JOB_BUDGET)).toBe(true);
    // Every derived id is a safe single path segment with no namespace
    // separator.
    for (const one of dispatched[0]!) {
      expect(one.jobId).toMatch(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/);
    }
  });

  it('passes a headed assignment through so the runner can refuse it', async () => {
    const { runner, dispatched } = fakeRunner((jobs) =>
      jobs.map((one) =>
        jobResult(one.jobId, {
          status: 'refused',
          rows: [],
          evidence: [],
          failure: { reason: 'headed_work_stays_with_coordinator', detail: 'do it yourself' },
        }),
      ),
    );
    const tool = createRunResearchJobsTool({ runner, runDir });

    const result = (await tool.execute(
      { assignments: [{ entity: 'Behind a login', instruction: 'read the dashboard', headed: true }] },
      ctx,
    )) as RunResearchJobsResult;

    expect(dispatched[0]![0]!.headed).toBe(true);
    expect(result.jobs[0]!.status).toBe('refused');
    expect(result.jobs[0]!.failure!.reason).toBe('headed_work_stays_with_coordinator');
    expect(result.rows).toEqual([]);
  });
});

describe('run_research_jobs merge and staging', () => {
  it('returns rows the coordinator can apply, citing ids the run’s ledger issued', async () => {
    const evidence = createEvidenceStore(runDir);
    const tables = coordinatorTables(evidence);
    const { runner } = fakeRunner(() => [
      jobResult('j1-alpha', {
        rows: [
          { rowId: 'alpha', values: { name: 'Alpha', founded: 1998 }, evidenceIds: ['E1'] },
        ],
      }),
      jobResult('j2-beta', {
        rows: [{ rowId: 'beta', values: { name: 'Beta', founded: 2004 }, evidenceIds: ['E1'] }],
        evidence: [evidenceRecord('j2-beta', 'E1')],
      }),
    ]);
    const tool = createRunResearchJobsTool({ runner, runDir, evidenceStore: evidence });

    const result = (await tool.execute(
      {
        assignments: [
          { entity: 'Alpha', instruction: 'find the year' },
          { entity: 'Beta', instruction: 'find the year' },
        ],
        outputId: 'partners',
      },
      ctx,
    )) as RunResearchJobsResult;

    // Each child's job-local E1 became a distinct id in the run's ledger...
    expect(result.rows.map((row) => row.evidenceIds)).toEqual([['E1'], ['E2']]);
    expect(evidence.get('E1')!.summary).toContain('[research job j1-alpha]');
    // ...which is what makes the rows applyable: the table store validates
    // citations against the RUN's ledger.
    const applied = tables.upsertOutputRows('partners', result.rows);
    expect(applied.ok).toBe(true);
    expect(tables.table('partners').rows.map((row) => row.rowId)).toEqual([
      'j1-alpha:alpha',
      'j2-beta:beta',
    ]);
    expect(result.outputId).toBe('partners');
  });

  it('applies nothing itself — the rows come back for the coordinator to write', async () => {
    const evidence = createEvidenceStore(runDir);
    const tables = coordinatorTables(evidence);
    const { runner } = fakeRunner(() => [jobResult('j1-alpha')]);
    const tool = createRunResearchJobsTool({ runner, runDir, evidenceStore: evidence });

    const result = (await tool.execute(
      { assignments: [{ entity: 'Alpha', instruction: 'find the year' }] },
      ctx,
    )) as RunResearchJobsResult;

    expect(result.rowCount).toBe(1);
    // The table the coordinator owns is untouched, and the result says so in
    // words the model reads.
    expect(tables.table('partners').rows).toEqual([]);
    expect(result.note).toContain('Nothing was written to any output');
    expect(result.note).toContain('upsert_output_rows');
  });

  it('reports a cross-job disagreement instead of importing either row', async () => {
    const evidence = createEvidenceStore(runDir);
    const { runner } = fakeRunner(() => [
      jobResult('j1-acme', {
        rows: [{ rowId: 'acme', values: { name: 'Acme', founded: 1999 }, evidenceIds: ['E1'] }],
      }),
      jobResult('j2-acme', {
        rows: [{ rowId: 'acme', values: { name: 'Acme', founded: 2001 }, evidenceIds: ['E1'] }],
      }),
    ]);
    const tool = createRunResearchJobsTool({ runner, runDir, evidenceStore: evidence });

    const result = (await tool.execute(
      {
        assignments: [
          { entity: 'Acme (filing)', instruction: 'find the year' },
          { entity: 'Acme (registry)', instruction: 'find the year' },
        ],
      },
      ctx,
    )) as RunResearchJobsResult;

    expect(result.rows).toEqual([]);
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0]!.disagreeingColumns).toEqual(['founded']);
    expect(result.conflicts[0]!.candidates.map((candidate) => candidate.jobId)).toEqual([
      'j1-acme',
      'j2-acme',
    ]);
    expect(result.note).toContain('settle every conflict yourself');
    expect(result.jobs.map((job) => job.rowsInConflict)).toEqual([1, 1]);
  });

  it('stages the complete merge as private working state', async () => {
    const evidence = createEvidenceStore(runDir);
    const { runner } = fakeRunner(() => [jobResult('j1-alpha')]);
    const tool = createRunResearchJobsTool({ runner, runDir, evidenceStore: evidence });

    const first = (await tool.execute(
      { assignments: [{ entity: 'Alpha', instruction: 'find the year' }] },
      ctx,
    )) as RunResearchJobsResult;
    const second = (await tool.execute(
      { assignments: [{ entity: 'Beta', instruction: 'find the year' }] },
      ctx,
    )) as RunResearchJobsResult;

    // One file per dispatch, so a second fan-out cannot overwrite the first
    // one's record.
    expect(first.mergePath).toBe('scratch/research-jobs/merge-1.json');
    expect(second.mergePath).toBe('scratch/research-jobs/merge-2.json');
    const staged = JSON.parse(
      readFileSync(join(runDir, first.mergePath), 'utf8'),
    ) as ResearchMergeResult;
    expect(staged.rows).toEqual(first.rows);
    expect(staged.evidence[0]!.path).toBe(
      'scratch/research-jobs/j1-alpha/scratch/evidence/E1.json',
    );
    // Under scratch/, so the manifest entry carries NO roles — the marker
    // that says "never graded, never shown".
    const entry = manifest().artifacts.find((one) => one.filename === join('scratch', 'research-jobs', 'merge-1.json'));
    expect(entry).toBeDefined();
    expect(entry!.roles).toBeUndefined();
  });

  it('bounds the inline view and says when it elided rows', async () => {
    const evidence = createEvidenceStore(runDir);
    const many = Array.from({ length: 60 }, (_unused, index) => ({
      rowId: `row-${index}`,
      values: { name: `Firm ${index}`, founded: 2000 + index },
      evidenceIds: ['E1'],
    }));
    const { runner } = fakeRunner(() => [jobResult('j1-alpha', { rows: many })]);
    const tool = createRunResearchJobsTool({ runner, runDir, evidenceStore: evidence });

    const result = (await tool.execute(
      { assignments: [{ entity: 'Alpha', instruction: 'find every year' }] },
      ctx,
    )) as RunResearchJobsResult;

    expect(result.rowCount).toBe(60);
    expect(result.rows).toHaveLength(50);
    expect(result.rowsTruncated).toBe(true);
    // The elided rows are not lost: the staged merge holds all of them.
    const staged = JSON.parse(
      readFileSync(join(runDir, result.mergePath), 'utf8'),
    ) as ResearchMergeResult;
    expect(staged.rows).toHaveLength(60);
    expect(result.note).toContain(result.mergePath);
  });

  it('keeps job-local citations when the run has no shared ledger to import into', async () => {
    const { runner } = fakeRunner(() => [jobResult('j1-alpha')]);
    const tool = createRunResearchJobsTool({ runner, runDir });

    const result = (await tool.execute(
      { assignments: [{ entity: 'Alpha', instruction: 'find the year' }] },
      ctx,
    )) as RunResearchJobsResult;

    // Namespaced rather than silently coordinator-shaped: a row citing
    // "j1-alpha:E1" is honestly unapplyable, which is better than one citing
    // an "E1" the run never issued.
    expect(result.rows[0]!.evidenceIds).toEqual(['j1-alpha:E1']);
  });

  it('reports a contract-invalid candidate instead of poisoning the batch', async () => {
    const evidence = createEvidenceStore(runDir);
    const { runner } = fakeRunner(() => [
      jobResult('j1-alpha', {
        rows: [
          { rowId: 'alpha', values: { name: 'Alpha', founded: 'yesterday' }, evidenceIds: ['E1'] },
        ],
      }),
      jobResult('j2-beta', {
        rows: [{ rowId: 'beta', values: { name: 'Beta', founded: 2004 }, evidenceIds: ['E1'] }],
        evidence: [evidenceRecord('j2-beta', 'E1')],
      }),
    ]);
    const tool = createRunResearchJobsTool({
      runner,
      runDir,
      evidenceStore: evidence,
      validateRowValues: (row) =>
        Number.isInteger(row.values.founded) ? [] : ['column "founded" must be an integer'],
    });

    const result = (await tool.execute(
      {
        assignments: [
          { entity: 'Alpha', instruction: 'find the year' },
          { entity: 'Beta', instruction: 'find the year' },
        ],
      },
      ctx,
    )) as RunResearchJobsResult;

    expect(result.rows.map((row) => row.rowId)).toEqual(['j2-beta:beta']);
    expect(result.rejected[0]).toMatchObject({ jobId: 'j1-alpha', reason: 'invalid_values' });
  });
});
