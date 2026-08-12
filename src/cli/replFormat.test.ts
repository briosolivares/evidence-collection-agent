import { describe, expect, it } from 'vitest';

import type { ProgressEvent } from '../model/callModel.js';
import type { RunTaskResult } from './runTask.js';
import { formatProgressEvent, formatRunSummary } from './replFormat.js';

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
    const event: ProgressEvent = {
      type: 'retry',
      turn: 3,
      attempt: 2,
      delayMs: 2_100,
      reason: 'overloaded_error',
    };
    const line = formatProgressEvent(event);
    expect(line).toContain('turn 3');
    expect(line).toContain('2/4');
    expect(line).toContain('2.1s');
    expect(line).toContain('overloaded_error');
  });
});

describe('formatRunSummary', () => {
  it('reports the final message and run dir on a completed run', () => {
    const result: RunTaskResult = {
      runDir: '/runs/2026-08-10T00-00-00-abcd',
      status: 'completed',
      finalText: 'Wrote answer.md with the requested totals.',
    };
    const summary = formatRunSummary(result);
    expect(summary).toContain('Wrote answer.md with the requested totals.');
    expect(summary).toContain('/runs/2026-08-10T00-00-00-abcd');
  });

  it('reports the guard name and run dir on a budget_exceeded run', () => {
    const result: RunTaskResult = {
      runDir: '/runs/2026-08-10T00-00-00-efgh',
      status: 'budget_exceeded',
      reason: 'max_turns',
    };
    const summary = formatRunSummary(result);
    expect(summary).toContain('max_turns');
    expect(summary).toContain('/runs/2026-08-10T00-00-00-efgh');
  });
});
