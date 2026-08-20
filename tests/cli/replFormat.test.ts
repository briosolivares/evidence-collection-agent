import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { ProgressEvent } from '../../src/model/callModel.js';
import { initManifest, writeArtifact } from '../../src/run/artifacts.js';
import type { RunTaskResult } from '../../src/agent/runTask.js';
import { formatProgressEvent, formatRunSummary } from '../../src/cli/replFormat.js';

describe('formatProgressEvent', () => {
  it('renders turn_start with the turn number', () => {
    const event: ProgressEvent = { type: 'turn_start', turn: 3 };
    expect(formatProgressEvent(event)).toContain('3');
  });

  it('renders text_delta as the exact fragment, unmodified', () => {
    const event: ProgressEvent = { type: 'text_delta', turn: 1, text: 'Hello, world' };
    expect(formatProgressEvent(event)).toBe('Hello, world');
  });

  it('concatenating consecutive text_delta renders reproduces the joined prose', () => {
    const deltas: ProgressEvent[] = [
      { type: 'text_delta', turn: 1, text: 'The answer ' },
      { type: 'text_delta', turn: 1, text: 'is 42.' },
    ];
    expect(deltas.map(formatProgressEvent).join('')).toBe('The answer is 42.');
  });

  it('renders tool_use_start with the turn number and tool name', () => {
    const event: ProgressEvent = { type: 'tool_use_start', turn: 2, toolName: 'screenshot' };
    const line = formatProgressEvent(event);
    expect(line).toContain('2');
    expect(line).toContain('screenshot');
  });

  it('renders turn_end with the turn number and usage figures', () => {
    const event: ProgressEvent = {
      type: 'turn_end',
      turn: 4,
      usage: { input_tokens: 123, output_tokens: 45, cache_read_input_tokens: 678 },
    };
    const line = formatProgressEvent(event);
    expect(line).toContain('4');
    expect(line).toContain('123');
    expect(line).toContain('45');
    expect(line).toContain('678');
  });

  it('renders turn_end cache_read as 0 when the usage omits it', () => {
    const event: ProgressEvent = {
      type: 'turn_end',
      turn: 1,
      usage: { input_tokens: 10, output_tokens: 2 },
    };
    expect(formatProgressEvent(event)).toContain('cache_read=0');
  });

  it('renders turn_end cache_read as 0 when the usage reports it as null', () => {
    const event: ProgressEvent = {
      type: 'turn_end',
      turn: 1,
      usage: { input_tokens: 10, output_tokens: 2, cache_read_input_tokens: null },
    };
    expect(formatProgressEvent(event)).toContain('cache_read=0');
  });

  it('renders a retry event with the turn, attempt count, delay, and reason', () => {
    // The denominator comes from the event (the failure class's own
    // ceiling), not a constant — truncation retries run to 8, not 4.
    const event: ProgressEvent = {
      type: 'retry',
      turn: 3,
      attempt: 5,
      maxAttempts: 8,
      delayMs: 2_100,
      reason: 'truncated stream',
    };
    const line = formatProgressEvent(event);
    expect(line).toContain('turn 3');
    expect(line).toContain('5/8');
    expect(line).toContain('2.1s');
    expect(line).toContain('truncated stream');
  });
});

describe('formatRunSummary', () => {
  it('reports the final message and run dir on a verified run', () => {
    const result: RunTaskResult = {
      runDir: '/runs/2026-08-10T00-00-00-abcd',
      status: 'verified',
      finalText: 'Wrote answer.md with the requested totals.',
    };
    const summary = formatRunSummary(result);
    expect(summary).toContain('Wrote answer.md with the requested totals.');
    expect(summary).toContain('/runs/2026-08-10T00-00-00-abcd');
  });

  it('reports the worker response and unresolved requirements without internal diagnostics', () => {
    const result: RunTaskResult = {
      runDir: '/runs/2026-08-10T00-00-00-efgh',
      status: 'incomplete',
      reason: 'budget_exceeded',
      detail: 'max_turns exceeded',
      finalText: 'I saved the records available before access was denied.',
      unresolved: [
        {
          requirement: 'Include the private account records',
          reason: 'The account required an unavailable login.',
          attempts: ['Opened the account page'],
        },
      ],
    };
    const summary = formatRunSummary(result);
    expect(summary).toContain('I saved the records available');
    expect(summary).toContain('Include the private account records');
    expect(summary).not.toContain('budget_exceeded');
    expect(summary).not.toContain('max_turns exceeded');
    expect(summary).not.toContain('Opened the account page');
    expect(summary).toContain('/runs/2026-08-10T00-00-00-efgh');
  });

  it('lists every published manifest artifact for an incomplete run', () => {
    const runDir = mkdtempSync(join(tmpdir(), 'sherlock-repl-format-'));
    try {
      initManifest(runDir, 'Collect records');
      writeArtifact(runDir, 'artifacts/records.csv', Buffer.from('name\nAlice\n'), {
        roles: ['requested_output'],
      });
      writeArtifact(runDir, 'artifacts/source.png', Buffer.from('image'), {
        roles: ['evidence'],
      });
      writeArtifact(runDir, 'scratch/private.txt', Buffer.from('not surfaced'));

      const summary = formatRunSummary({
        runDir,
        status: 'incomplete',
        reason: 'worker_incomplete',
        detail: 'internal',
        finalText: 'Saved the available records.',
        unresolved: [],
      });

      expect(summary).toContain('artifacts/records.csv');
      expect(summary).toContain('artifacts/source.png');
      expect(summary).not.toContain('scratch/private.txt');
    } finally {
      rmSync(runDir, { recursive: true, force: true });
    }
  });
});
