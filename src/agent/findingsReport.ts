import { Buffer } from 'node:buffer';
import { join } from 'node:path';

import { writeFileDurablyAtomic } from '../run/atomicFile.js';
import {
  toSettledFacts,
  type FinishDefect,
  type FinishFacts,
  type SettledFact,
} from './completion/finishChecks.js';
import type {
  CorrectionFinding,
  IncompleteFinding,
  SurfacedArtifact,
  VerificationHistoryEntry,
} from './verifier/verificationResult.schema.js';
import type { FinishInput } from '../tools/finish/finish.js';
import { HARNESS_DIR } from './checkpoint.js';
import type { Checkpoint, CheckpointPhase, DurableTerminalOutcome } from './checkpoint.schema.js';

export const FINDINGS_REPORT_FILENAME = 'findings.md';
export const FINDINGS_REPORT_PATH = `${HARNESS_DIR}/${FINDINGS_REPORT_FILENAME}`;

/** The verdict this audit projection is currently carrying, if any. `none`
 * covers a fresh run, a verified terminus, and every terminal reason that
 * never reached a typed verifier decision (budget/model/protocol failures
 * already narrate themselves through the terminal outcome's own detail). */
export type FindingsReportCurrentFindings =
  | { kind: 'none' }
  | { kind: 'correction'; findings: readonly CorrectionFinding[] }
  | { kind: 'incomplete'; findings: readonly IncompleteFinding[] };

/** Already-available typed data this projection renders. Every field is
 * durable checkpoint/verifier state or a cheap re-derivation of it (surfaced
 * artifacts from the manifest); nothing here triggers new data collection. */
export interface FindingsReportInput {
  phase: CheckpointPhase;
  /** Present only when `phase` is `'terminal'`. */
  outcome?: DurableTerminalOutcome;
  completionReport?: FinishInput;
  settledFacts: readonly SettledFact[];
  structuralFindings: readonly FinishDefect[];
  surfacedArtifacts: readonly SurfacedArtifact[];
  currentFindings: FindingsReportCurrentFindings;
  verificationHistory: readonly VerificationHistoryEntry[];
}

// Bounds below intentionally reuse the repo's existing diagnostic/schema
// scales rather than inventing new ones.
/** Matches `MAX_SAFE_DIAGNOSTIC_LENGTH` / the `boundedDiagnostic` cap used
 * for terminal-outcome detail strings elsewhere in the coordinator. */
const DIAGNOSTIC_FIELD_MAX_BYTES = 16_000;
/** Matches the `boundedNonBlank(4_000)` scale shared by verifier finding
 * and finish `unresolved` text fields. */
const TEXT_FIELD_MAX_BYTES = 4_000;
/** Matches the `.max(50)` list bound shared by finish/verifier schemas. */
const LIST_MAX_ITEMS = 50;
/** Surfaced artifacts mirror the whole manifest and are not upstream-
 * bounded; cap the rendered table so one run cannot make the projection
 * unreadable. */
const ARTIFACT_LIST_MAX_ITEMS = 200;
/** Whole-document backstop, the same order of magnitude as the largest
 * existing bounded text field (`MAX_TASK_LENGTH` in checkpoint.ts). */
const REPORT_MAX_BYTES = 1_000_000;

function truncateBytes(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return value;
  const marker = ' [truncated]';
  const kept = Math.max(0, maxBytes - Buffer.byteLength(marker, 'utf8'));
  return `${Buffer.from(value, 'utf8').subarray(0, kept).toString('utf8')}${marker}`;
}

function truncateList<T>(
  items: readonly T[],
  max: number,
): { kept: readonly T[]; omitted: number } {
  if (items.length <= max) return { kept: items, omitted: 0 };
  return { kept: items.slice(0, max), omitted: items.length - max };
}

function elisionLine(omitted: number, noun: string): string[] {
  return omitted > 0 ? [`_(+${omitted} more ${noun}, truncated)_`] : [];
}

function escapeCell(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

function renderUnresolved(entry: FinishInput['unresolved'][number], index: number): string {
  const { kept, omitted } = truncateList(entry.attempts, LIST_MAX_ITEMS);
  const attempts = kept.length > 0 ? kept.join('; ') : 'none recorded';
  const omittedNote = omitted > 0 ? ` (+${omitted} more, truncated)` : '';
  return (
    `${index + 1}. **${truncateBytes(entry.requirement, TEXT_FIELD_MAX_BYTES)}** — ` +
    `${truncateBytes(entry.reason, TEXT_FIELD_MAX_BYTES)}\n   - Attempts: ${attempts}${omittedNote}`
  );
}

function renderSettledFact(fact: SettledFact): string {
  const prefix = fact.outputId !== undefined ? `[${fact.outputId}] ` : '';
  return `- ${prefix}${fact.code}: ${truncateBytes(fact.statement, TEXT_FIELD_MAX_BYTES)}`;
}

function renderStructuralFinding(defect: FinishDefect): string {
  const context = [
    defect.outputId !== undefined ? `output=${defect.outputId}` : undefined,
    defect.artifactPath !== undefined ? `path=${defect.artifactPath}` : undefined,
  ].filter((value): value is string => value !== undefined);
  const suffix = context.length > 0 ? ` (${context.join(', ')})` : '';
  return `- ${defect.code}: ${truncateBytes(defect.message, TEXT_FIELD_MAX_BYTES)}${suffix}`;
}

function renderCorrectionFinding(finding: CorrectionFinding): string {
  const evidence =
    'evidencePaths' in finding && finding.evidencePaths.length > 0
      ? ` (evidence: ${finding.evidencePaths.join(', ')})`
      : '';
  return (
    `- **${finding.kind}** — ${truncateBytes(finding.requirement, TEXT_FIELD_MAX_BYTES)}: ` +
    `${truncateBytes(finding.problem, TEXT_FIELD_MAX_BYTES)}${evidence}`
  );
}

function renderIncompleteFinding(finding: IncompleteFinding): string {
  const evidence =
    finding.evidencePaths !== undefined && finding.evidencePaths.length > 0
      ? ` (evidence: ${finding.evidencePaths.join(', ')})`
      : '';
  return (
    `- ${truncateBytes(finding.requirement, TEXT_FIELD_MAX_BYTES)}: ` +
    `${truncateBytes(finding.assessment, TEXT_FIELD_MAX_BYTES)}${evidence}`
  );
}

function renderArtifactsTable(artifacts: readonly SurfacedArtifact[]): string[] {
  if (artifacts.length === 0) return ['_None surfaced._'];
  const { kept, omitted } = truncateList(artifacts, ARTIFACT_LIST_MAX_ITEMS);
  const header = [
    '| filename | sha256 | roles | capturedAt | sourceUrl | completionStatus |',
    '| --- | --- | --- | --- | --- | --- |',
  ];
  const rows = kept.map(
    (artifact) =>
      `| ${escapeCell(artifact.filename)} | ${artifact.sha256} | ` +
      `${artifact.roles.join(', ')} | ${escapeCell(artifact.capturedAt)} | ` +
      `${escapeCell(artifact.sourceUrl ?? '')} | ${artifact.completionStatus ?? ''} |`,
  );
  return [...header, ...rows, ...elisionLine(omitted, 'artifact(s)')];
}

function renderHistoryCycle(entry: VerificationHistoryEntry): string[] {
  const { kept, omitted } = truncateList(entry.findings, LIST_MAX_ITEMS);
  return [
    `### Cycle ${entry.cycle}`,
    '',
    `- Completion summary: ${truncateBytes(entry.completionReport.summary, TEXT_FIELD_MAX_BYTES)}`,
    `- Surfaced-evidence fingerprint: ${entry.surfacedEvidenceFingerprint}`,
    '- Findings:',
    ...kept.map(renderCorrectionFinding),
    ...elisionLine(omitted, 'finding(s)'),
  ];
}

/**
 * Render the complete audit projection as Markdown text. Pure: no model
 * calls, no filesystem/network access, no data collection beyond what the
 * caller already assembled. Deterministic — stable input order in, stable
 * output out; the only "timestamps" rendered are ones already carried by
 * the durable data (e.g. `capturedAt` on a surfaced artifact).
 */
export function renderFindingsReport(input: FindingsReportInput): string {
  const lines: string[] = [
    '# findings report',
    '',
    '_Audit projection only. Not a requested output, not part of the manifest, ' +
      'never machine-read for control flow._',
    '',
    '## Status',
    '',
    `- Phase: ${input.phase}`,
  ];

  if (input.phase === 'terminal' && input.outcome !== undefined) {
    lines.push(`- Outcome: ${input.outcome.status}`);
    if (input.outcome.status === 'incomplete') {
      lines.push(`- Reason: ${input.outcome.reason}`);
      lines.push(`- Detail: ${truncateBytes(input.outcome.detail, DIAGNOSTIC_FIELD_MAX_BYTES)}`);
    }
  } else {
    const cycleNote =
      input.verificationHistory.length > 0
        ? ` (${input.verificationHistory.length} correction cycle(s) recorded)`
        : '';
    lines.push(`- Run is still active${cycleNote}.`);
  }
  lines.push('', '## Worker completion report', '');

  if (input.completionReport === undefined) {
    lines.push('_No completion report available yet._', '');
  } else {
    const unresolved = input.completionReport.unresolved;
    const { kept, omitted } = truncateList(unresolved, LIST_MAX_ITEMS);
    lines.push(
      `- Summary: ${truncateBytes(input.completionReport.summary, TEXT_FIELD_MAX_BYTES)}`,
      '',
      `### Unresolved requirements (${unresolved.length})`,
      '',
    );
    if (kept.length === 0) {
      lines.push('None reported.', '');
    } else {
      lines.push(
        ...kept.map((entry, index) => renderUnresolved(entry, index)),
        ...elisionLine(omitted, 'unresolved requirement(s)'),
        '',
      );
    }
  }

  lines.push('## Deterministic settled facts', '');
  {
    const { kept, omitted } = truncateList(input.settledFacts, LIST_MAX_ITEMS);
    lines.push(
      ...(kept.length === 0
        ? ['None recorded.']
        : [...kept.map(renderSettledFact), ...elisionLine(omitted, 'fact(s)')]),
      '',
    );
  }

  lines.push('## Structural findings', '');
  {
    const { kept, omitted } = truncateList(input.structuralFindings, LIST_MAX_ITEMS);
    lines.push(
      ...(kept.length === 0
        ? ['None recorded.']
        : [...kept.map(renderStructuralFinding), ...elisionLine(omitted, 'finding(s)')]),
      '',
    );
  }

  lines.push(`## Surfaced artifacts (${input.surfacedArtifacts.length})`, '');
  lines.push(...renderArtifactsTable(input.surfacedArtifacts), '');

  lines.push('## Current verifier findings', '');
  if (input.currentFindings.kind === 'none') {
    lines.push('No open verifier findings.', '');
  } else if (input.currentFindings.kind === 'correction') {
    const { kept, omitted } = truncateList(input.currentFindings.findings, LIST_MAX_ITEMS);
    lines.push(...kept.map(renderCorrectionFinding), ...elisionLine(omitted, 'finding(s)'), '');
  } else {
    const { kept, omitted } = truncateList(input.currentFindings.findings, LIST_MAX_ITEMS);
    lines.push(...kept.map(renderIncompleteFinding), ...elisionLine(omitted, 'finding(s)'), '');
  }

  const { kept: historyKept, omitted: historyOmitted } = truncateList(
    input.verificationHistory,
    LIST_MAX_ITEMS,
  );
  lines.push(`## Prior verification cycles (${input.verificationHistory.length})`, '');
  lines.push(
    ...(historyKept.length === 0
      ? ['None recorded.']
      : [
          ...historyKept.flatMap((entry) => [...renderHistoryCycle(entry), '']),
          ...elisionLine(historyOmitted, 'cycle(s)'),
        ]),
  );

  return truncateBytes(lines.join('\n'), REPORT_MAX_BYTES);
}

/** Write the complete audit projection, rebuilding it atomically. Never
 * appends: a partial or torn write would misrepresent the run's durable
 * state, which this file only ever mirrors. */
export function writeFindingsReport(runDir: string, input: FindingsReportInput): void {
  const markdown = renderFindingsReport(input);
  writeFileDurablyAtomic(join(runDir, FINDINGS_REPORT_PATH), markdown, {
    fileMode: 0o600,
  });
}

/**
 * Reconstruct render input from a durable checkpoint alone, for the resume
 * paths: a fresh process has no in-memory verifying-cycle context, only
 * whatever the checkpoint captured. `verifiedFacts` is the caller's already
 * re-run deterministic finish-check facts for a resumed verified terminal
 * checkpoint (never freshly collected here); omit it otherwise. Returns
 * `undefined` when there is nothing meaningful to render yet (still
 * initializing) or the terminal outcome is not a verification decision
 * (`failed`/`cancelled`).
 */
export function buildFindingsReportInputFromCheckpoint(
  checkpoint: Checkpoint,
  surfacedArtifacts: readonly SurfacedArtifact[],
  verifiedFacts?: FinishFacts,
): FindingsReportInput | undefined {
  if (checkpoint.phase === 'initializing') return undefined;

  if (checkpoint.phase === 'terminal') {
    const { outcome } = checkpoint;
    if (outcome.status !== 'verified' && outcome.status !== 'incomplete') {
      return undefined;
    }
    return {
      phase: 'terminal',
      outcome,
      completionReport: {
        summary: outcome.finalText,
        unresolved: outcome.status === 'incomplete' ? outcome.unresolved : [],
      },
      settledFacts: verifiedFacts === undefined ? [] : toSettledFacts(verifiedFacts),
      structuralFindings: [],
      surfacedArtifacts,
      currentFindings: { kind: 'none' },
      verificationHistory: [],
    };
  }

  const verificationHistory = checkpoint.verificationHistory ?? [];
  const lastCycle = verificationHistory.at(-1);
  const pendingFinishInput =
    checkpoint.phase === 'checking' || checkpoint.phase === 'verifying'
      ? checkpoint.pendingFinish.input
      : undefined;
  const facts = checkpoint.phase === 'verifying' ? checkpoint.pendingCheck.facts : undefined;
  const structuralFindings =
    checkpoint.phase === 'verifying' ? (checkpoint.pendingCheck.structuralFindings ?? []) : [];
  const completionReport = pendingFinishInput ?? lastCycle?.completionReport;

  return {
    phase: checkpoint.phase,
    ...(completionReport === undefined ? {} : { completionReport }),
    settledFacts: facts === undefined ? [] : toSettledFacts(facts),
    structuralFindings,
    surfacedArtifacts,
    currentFindings:
      lastCycle === undefined
        ? { kind: 'none' }
        : { kind: 'correction', findings: lastCycle.findings },
    verificationHistory,
  };
}
