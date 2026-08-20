import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { FinishDefect, SettledFact } from '../../src/agent/completion/finishChecks.js';
import type {
  CorrectionFinding,
  IncompleteFinding,
  SurfacedArtifact,
  VerificationHistoryEntry,
} from '../../src/agent/verifier/verificationResult.schema.js';
import type { FinishInput } from '../../src/tools/finish/finish.js';
import { HARNESS_DIR } from '../../src/agent/checkpoint.js';
import {
  buildFindingsReportInputFromCheckpoint,
  renderFindingsReport,
  FINDINGS_REPORT_FILENAME,
  writeFindingsReport,
  type FindingsReportInput,
} from '../../src/agent/findingsReport.js';

function minimalInput(
  overrides: Partial<FindingsReportInput> = {},
): FindingsReportInput {
  return {
    phase: 'ready_for_model',
    settledFacts: [],
    structuralFindings: [],
    surfacedArtifacts: [],
    currentFindings: { kind: 'none' },
    verificationHistory: [],
    ...overrides,
  };
}

const FINISH: FinishInput = {
  summary: 'Published the report; one entity remains unconfirmed.',
  unresolved: [
    {
      requirement: 'Include Bob in the roster.',
      reason: 'The primary source only listed Alice.',
      attempts: ['Checked the primary listing.', 'Retried via the archive.'],
    },
  ],
};

const SETTLED_FACT: SettledFact = {
  outputId: 'report',
  code: 'table_shape',
  statement: 'report.csv parsed with exactly 1 data row.',
};

const STRUCTURAL_FINDING: FinishDefect = {
  code: 'hash_mismatch',
  message: 'artifacts/report.csv bytes did not match the recorded manifest hash.',
  outputId: 'report',
  artifactPath: 'artifacts/report.csv',
};

const SURFACED_ARTIFACT: SurfacedArtifact = {
  filename: 'artifacts/report.csv',
  sha256: 'a'.repeat(64),
  roles: ['requested_output'],
  capturedAt: '2026-08-18T00:00:00.000Z',
  sourceUrl: 'https://example.test/source',
};

const CORRECTION_FINDING: CorrectionFinding = {
  kind: 'research',
  requirement: 'Include Bob in the roster.',
  problem: 'The report only contains Alice.',
};

const INCOMPLETE_FINDING: IncompleteFinding = {
  requirement: 'Support the report with the requested source.',
  assessment: 'The source consistently returned access-denied; retries are unlikely to help.',
};

const HISTORY_ENTRY: VerificationHistoryEntry = {
  cycle: 1,
  completionReport: FINISH,
  surfacedEvidenceFingerprint: 'b'.repeat(64),
  findings: [CORRECTION_FINDING],
};

describe('renderFindingsReport', () => {
  it('is deterministic for identical input', () => {
    const input = minimalInput({
      completionReport: FINISH,
      settledFacts: [SETTLED_FACT],
      structuralFindings: [STRUCTURAL_FINDING],
      surfacedArtifacts: [SURFACED_ARTIFACT],
      currentFindings: { kind: 'correction', findings: [CORRECTION_FINDING] },
      verificationHistory: [HISTORY_ENTRY],
    });
    expect(renderFindingsReport(input)).toBe(renderFindingsReport(input));
  });

  it('marks the projection as an audit-only, non-machine-read file', () => {
    const rendered = renderFindingsReport(minimalInput());
    expect(rendered).toContain('Audit projection only');
    expect(rendered).toContain('never machine-read for control flow');
  });

  it('renders an active, non-terminal status without an outcome section', () => {
    const rendered = renderFindingsReport(
      minimalInput({ phase: 'verifying', verificationHistory: [HISTORY_ENTRY] }),
    );
    expect(rendered).toContain('- Phase: verifying');
    expect(rendered).toContain('Run is still active (1 correction cycle(s) recorded).');
    expect(rendered).not.toContain('- Outcome:');
  });

  it('renders a verified terminal outcome', () => {
    const rendered = renderFindingsReport(
      minimalInput({
        phase: 'terminal',
        outcome: { status: 'verified', finalText: FINISH.summary },
        completionReport: { summary: FINISH.summary, unresolved: [] },
      }),
    );
    expect(rendered).toContain('- Outcome: verified');
    expect(rendered).not.toContain('- Reason:');
  });

  it('renders an incomplete terminal outcome with its reason and detail', () => {
    const rendered = renderFindingsReport(
      minimalInput({
        phase: 'terminal',
        outcome: {
          status: 'incomplete',
          during: 'verifying',
          reason: 'verification_incomplete',
          detail: 'the evidence judge accepted the reported blocker(s).',
          finalText: FINISH.summary,
          unresolved: FINISH.unresolved,
        },
        completionReport: FINISH,
      }),
    );
    expect(rendered).toContain('- Outcome: incomplete');
    expect(rendered).toContain('- Reason: verification_incomplete');
    expect(rendered).toContain('- Detail: the evidence judge accepted the reported blocker(s).');
  });

  it('renders the completion report summary and every unresolved requirement with attempts', () => {
    const rendered = renderFindingsReport(minimalInput({ completionReport: FINISH }));
    expect(rendered).toContain(`- Summary: ${FINISH.summary}`);
    expect(rendered).toContain('### Unresolved requirements (1)');
    expect(rendered).toContain('Include Bob in the roster.');
    expect(rendered).toContain('Checked the primary listing.; Retried via the archive.');
  });

  it('reports no completion report as an explicit placeholder rather than omitting the section', () => {
    const rendered = renderFindingsReport(minimalInput());
    expect(rendered).toContain('_No completion report available yet._');
  });

  it('renders deterministic settled facts and structural findings with their output/path context', () => {
    const rendered = renderFindingsReport(
      minimalInput({
        settledFacts: [SETTLED_FACT],
        structuralFindings: [STRUCTURAL_FINDING],
      }),
    );
    expect(rendered).toContain('[report] table_shape: report.csv parsed with exactly 1 data row.');
    expect(rendered).toContain(
      '- hash_mismatch: artifacts/report.csv bytes did not match the recorded manifest hash. ' +
        '(output=report, path=artifacts/report.csv)',
    );
  });

  it('says none recorded for empty facts/findings sections', () => {
    const rendered = renderFindingsReport(minimalInput());
    const factsSection = rendered.split('## Deterministic settled facts')[1]!.split('##')[0]!;
    expect(factsSection).toContain('None recorded.');
    const structuralSection = rendered.split('## Structural findings')[1]!.split('##')[0]!;
    expect(structuralSection).toContain('None recorded.');
  });

  it('renders surfaced artifacts as a table with filename, hash, roles, and source', () => {
    const rendered = renderFindingsReport(
      minimalInput({ surfacedArtifacts: [SURFACED_ARTIFACT] }),
    );
    expect(rendered).toContain('## Surfaced artifacts (1)');
    expect(rendered).toContain(
      `| ${SURFACED_ARTIFACT.filename} | ${SURFACED_ARTIFACT.sha256} | requested_output | ` +
        `${SURFACED_ARTIFACT.capturedAt} | ${SURFACED_ARTIFACT.sourceUrl} |  |`,
    );
  });

  it('escapes pipe characters and newlines in artifact table cells', () => {
    const artifact: SurfacedArtifact = {
      ...SURFACED_ARTIFACT,
      filename: 'artifacts/weird|name\nwith-newline.csv',
    };
    const rendered = renderFindingsReport(minimalInput({ surfacedArtifacts: [artifact] }));
    expect(rendered).toContain('artifacts/weird\\|name with-newline.csv');
    expect(rendered).not.toContain('weird|name\nwith');
  });

  it('renders none/correction/incomplete current findings by kind', () => {
    expect(renderFindingsReport(minimalInput())).toContain('No open verifier findings.');

    const correction = renderFindingsReport(
      minimalInput({ currentFindings: { kind: 'correction', findings: [CORRECTION_FINDING] } }),
    );
    expect(correction).toContain('**research** — Include Bob in the roster.');

    const incomplete = renderFindingsReport(
      minimalInput({ currentFindings: { kind: 'incomplete', findings: [INCOMPLETE_FINDING] } }),
    );
    expect(incomplete).toContain('Support the report with the requested source.');
  });

  it('includes an artifact_repair finding evidence path list', () => {
    const finding: CorrectionFinding = {
      kind: 'artifact_repair',
      requirement: 'Fix the row.',
      problem: 'The row uses a placeholder value.',
      evidencePaths: ['artifacts/evidence.png'],
    };
    const rendered = renderFindingsReport(
      minimalInput({ currentFindings: { kind: 'correction', findings: [finding] } }),
    );
    expect(rendered).toContain('(evidence: artifacts/evidence.png)');
  });

  it('renders prior verification cycles with their fingerprint and findings', () => {
    const rendered = renderFindingsReport(
      minimalInput({ verificationHistory: [HISTORY_ENTRY] }),
    );
    expect(rendered).toContain('## Prior verification cycles (1)');
    expect(rendered).toContain('### Cycle 1');
    expect(rendered).toContain(`Surfaced-evidence fingerprint: ${HISTORY_ENTRY.surfacedEvidenceFingerprint}`);
  });

  it('elides unresolved requirements beyond the shared list bound', () => {
    const unresolved = Array.from({ length: 55 }, (_, index) => ({
      requirement: `Requirement ${index}`,
      reason: 'Blocked.',
      attempts: [] as string[],
    }));
    const rendered = renderFindingsReport(
      minimalInput({ completionReport: { summary: 'partial', unresolved } }),
    );
    expect(rendered).toContain('### Unresolved requirements (55)');
    expect(rendered).toContain('_(+5 more unresolved requirement(s), truncated)_');
    expect(rendered).not.toContain('Requirement 54');
  });

  it('elides surfaced artifacts beyond the artifact table bound', () => {
    const artifacts = Array.from({ length: 210 }, (_, index) => ({
      ...SURFACED_ARTIFACT,
      filename: `artifacts/file-${index}.csv`,
    }));
    const rendered = renderFindingsReport(minimalInput({ surfacedArtifacts: artifacts }));
    expect(rendered).toContain('## Surfaced artifacts (210)');
    expect(rendered).toContain('_(+10 more artifact(s), truncated)_');
    expect(rendered).not.toContain('file-209.csv');
  });

  it('elides prior verification cycles beyond the shared list bound', () => {
    const history = Array.from({ length: 52 }, (_, index) => ({
      ...HISTORY_ENTRY,
      cycle: index + 1,
    }));
    const rendered = renderFindingsReport(minimalInput({ verificationHistory: history }));
    expect(rendered).toContain('## Prior verification cycles (52)');
    expect(rendered).toContain('_(+2 more cycle(s), truncated)_');
    expect(rendered).not.toContain('### Cycle 52');
  });

  it('truncates one very long field with an explicit marker rather than growing unbounded', () => {
    const rendered = renderFindingsReport(
      minimalInput({
        completionReport: { summary: 'x'.repeat(20_000), unresolved: [] },
      }),
    );
    expect(rendered).toContain('[truncated]');
    expect(rendered.match(/x{4000,}/)?.[0].length ?? 0).toBeLessThan(20_000);
  });

  it('bounds the whole rendered document even when many capped sections add up', () => {
    // Each list section is already capped at 50 items, so exceeding the
    // whole-document bound requires volume across many verification-history
    // cycles (also capped at 50) rather than one oversized list.
    const bigFinding: CorrectionFinding = {
      kind: 'research',
      requirement: 'r'.repeat(1_000),
      problem: 'p'.repeat(1_000),
    };
    const verificationHistory: VerificationHistoryEntry[] = Array.from(
      { length: 50 },
      (_, cycle) => ({
        ...HISTORY_ENTRY,
        cycle: cycle + 1,
        findings: Array.from({ length: 50 }, () => bigFinding),
      }),
    );
    const rendered = renderFindingsReport(minimalInput({ verificationHistory }));
    expect(Buffer.byteLength(rendered, 'utf8')).toBeLessThanOrEqual(1_000_000);
    expect(rendered.endsWith('[truncated]')).toBe(true);
  });
});

describe('buildFindingsReportInputFromCheckpoint', () => {
  const COMMON = {
    version: 3 as const,
    revision: 1,
    updatedAt: '2026-08-18T00:00:00.000Z',
    configuration: {} as never,
    budget: {} as never,
    progress: { verifierCycles: 0, completionCheckFailures: 0 },
  };

  it('has nothing to render while still initializing', () => {
    const checkpoint = { ...COMMON, phase: 'initializing' as const } as never;
    expect(buildFindingsReportInputFromCheckpoint(checkpoint, [])).toBeUndefined();
  });

  it('has nothing to render for a failed or cancelled terminal outcome', () => {
    const failed = {
      ...COMMON,
      phase: 'terminal' as const,
      outcome: { status: 'failed' as const, during: 'checking' as const, message: 'boom' },
    } as never;
    expect(buildFindingsReportInputFromCheckpoint(failed, [])).toBeUndefined();

    const cancelled = {
      ...COMMON,
      phase: 'terminal' as const,
      outcome: {
        status: 'cancelled' as const,
        during: 'checking' as const,
        reason: 'run cancelled',
      },
    } as never;
    expect(buildFindingsReportInputFromCheckpoint(cancelled, [])).toBeUndefined();
  });

  it('reconstructs a verified terminal checkpoint using the caller-supplied re-run facts', () => {
    const checkpoint = {
      ...COMMON,
      phase: 'terminal' as const,
      outcome: { status: 'verified' as const, finalText: FINISH.summary },
    } as never;
    const facts = {
      finish: { summary: FINISH.summary, unresolved: [] },
      outputs: [],
      evidenceScreenshotPaths: [],
    } as never;
    const input = buildFindingsReportInputFromCheckpoint(checkpoint, [SURFACED_ARTIFACT], facts);
    expect(input).toMatchObject({
      phase: 'terminal',
      completionReport: { summary: FINISH.summary, unresolved: [] },
      surfacedArtifacts: [SURFACED_ARTIFACT],
      currentFindings: { kind: 'none' },
      verificationHistory: [],
    });
  });

  it('reconstructs an incomplete terminal checkpoint from the outcome alone', () => {
    const checkpoint = {
      ...COMMON,
      phase: 'terminal' as const,
      outcome: {
        status: 'incomplete' as const,
        during: 'verifying' as const,
        reason: 'verification_incomplete' as const,
        detail: 'a credible blocker remained.',
        finalText: FINISH.summary,
        unresolved: FINISH.unresolved,
      },
    } as never;
    const input = buildFindingsReportInputFromCheckpoint(checkpoint, []);
    expect(input).toMatchObject({
      phase: 'terminal',
      completionReport: FINISH,
      settledFacts: [],
      verificationHistory: [],
    });
  });

  it('reads the current verifying-phase facts and the last cycle findings from an active checkpoint', () => {
    const facts = {
      finish: FINISH,
      manifest: {
        task: 'Publish a one-column roster CSV.',
        entryCount: 1,
        verifiedPaths: ['artifacts/report.csv'],
        requestedOutputPaths: ['artifacts/report.csv'],
        evidencePaths: [],
      },
      outputs: [],
      evidenceScreenshotPaths: [],
    } as never;
    const checkpoint = {
      ...COMMON,
      phase: 'verifying' as const,
      contract: {} as never,
      worker: {} as never,
      verificationHistory: [HISTORY_ENTRY],
      pendingFinish: { turn: 1, call: {} as never, input: FINISH, assistantText: '' },
      pendingCheck: {
        status: 'passed' as const,
        attempt: 1,
        facts,
        structuralFindings: [STRUCTURAL_FINDING],
      },
      pendingVerifier: { cycle: 1, recovery: 'restart_read_only' as const },
    } as never;
    const input = buildFindingsReportInputFromCheckpoint(checkpoint, []);
    expect(input).toMatchObject({
      phase: 'verifying',
      completionReport: FINISH,
      structuralFindings: [STRUCTURAL_FINDING],
      currentFindings: { kind: 'correction', findings: [CORRECTION_FINDING] },
      verificationHistory: [HISTORY_ENTRY],
    });
    expect(input?.settledFacts.length).toBeGreaterThan(0);
  });

  it('falls back to the last cycle completion report when a ready-for-model checkpoint has no pending finish', () => {
    const checkpoint = {
      ...COMMON,
      phase: 'ready_for_model' as const,
      contract: {} as never,
      worker: {} as never,
      verificationHistory: [HISTORY_ENTRY],
    } as never;
    const input = buildFindingsReportInputFromCheckpoint(checkpoint, []);
    expect(input).toMatchObject({
      phase: 'ready_for_model',
      completionReport: FINISH,
      settledFacts: [],
      structuralFindings: [],
      currentFindings: { kind: 'correction', findings: [CORRECTION_FINDING] },
    });
  });

  it('has no completion report and no current findings for a fresh checkpoint with no history', () => {
    const checkpoint = {
      ...COMMON,
      phase: 'ready_for_model' as const,
      contract: {} as never,
      worker: {} as never,
    } as never;
    const input = buildFindingsReportInputFromCheckpoint(checkpoint, []);
    expect(input?.completionReport).toBeUndefined();
    expect(input?.currentFindings).toEqual({ kind: 'none' });
  });
});

describe('writeFindingsReport', () => {
  let runDir: string;

  beforeEach(() => {
    runDir = mkdtempSync(join(tmpdir(), 'findings-report-'));
    mkdirSync(join(runDir, HARNESS_DIR), { mode: 0o700 });
  });

  afterEach(() => {
    rmSync(runDir, { recursive: true, force: true });
  });

  it('writes the rendered markdown to harness/findings.md with private file permissions', () => {
    const input = minimalInput({ completionReport: FINISH });
    writeFindingsReport(runDir, input);
    const path = join(runDir, HARNESS_DIR, FINDINGS_REPORT_FILENAME);
    expect(readFileSync(path, 'utf8')).toBe(renderFindingsReport(input));
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it('rebuilds the whole file atomically rather than appending on a second write', () => {
    writeFindingsReport(runDir, minimalInput({ completionReport: FINISH }));
    const second = minimalInput({ phase: 'terminal', outcome: { status: 'verified', finalText: 'done' } });
    writeFindingsReport(runDir, second);
    const path = join(runDir, HARNESS_DIR, FINDINGS_REPORT_FILENAME);
    const content = readFileSync(path, 'utf8');
    expect(content).toBe(renderFindingsReport(second));
    expect(content).not.toContain(FINISH.summary);
  });
});
