import { describe, expect, it } from 'vitest';

import { formatEvalProgress, trialLabel } from './progress.js';

describe('eval CLI progress', () => {
  it('labels line-oriented lifecycle events with task and trial identity', () => {
    expect(
      formatEvalProgress('edgar', 2, 3, { type: 'turn_start', turn: 4 }),
    ).toBe('[edgar 2/3] turn 4 started\n');
    expect(
      formatEvalProgress('edgar', 2, 3, {
        type: 'tool_use_start',
        turn: 4,
        toolName: 'navigate',
      }),
    ).toBe('[edgar 2/3] turn 4 tool: navigate\n');
    expect(trialLabel('edgar', 2, 3)).toBe('[edgar 2/3]');
  });

  it('suppresses raw prose fragments that would interleave across trials', () => {
    expect(
      formatEvalProgress('edgar', 1, 3, { type: 'text_delta', turn: 1, text: 'fragment' }),
    ).toBeUndefined();
  });
});
