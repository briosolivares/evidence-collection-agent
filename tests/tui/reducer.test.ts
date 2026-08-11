import { describe, expect, it } from 'vitest';

import {
  createInitialState,
  HELP_TEXT,
  reduce,
  routeInput,
  unknownCommandNotice,
  type StoreAction,
} from '../../src/tui/store/reducer.js';
import type { SessionState } from '../../src/tui/store/state.js';

describe('createInitialState', () => {
  it('starts idle with the banner as the first transcript item', () => {
    const state = createInitialState({ apiKeyPresent: true });
    expect(state.mode).toBe('idle');
    expect(state.transcript).toHaveLength(1);
    expect(state.transcript[0]).toMatchObject({ kind: 'banner', apiKeyPresent: true });
  });
});

describe('routeInput', () => {
  it('routes plain text as a task, trimmed', () => {
    expect(routeInput('  find the filings  ')).toEqual({
      kind: 'task',
      text: 'find the filings',
    });
  });

  it('routes /help and /exit', () => {
    expect(routeInput('/help')).toEqual({ kind: 'help' });
    expect(routeInput('/exit')).toEqual({ kind: 'exit' });
    expect(routeInput('/help me please')).toEqual({ kind: 'help' });
  });

  it('routes unrecognized slash commands as unknown', () => {
    expect(routeInput('/frobnicate')).toEqual({
      kind: 'unknown',
      command: '/frobnicate',
    });
  });
});

describe('reduce (session store, step 2 scope)', () => {
  it('appends a user_task on submit and keeps idle mode', () => {
    const state = reduce(createInitialState(), {
      type: 'submit_task',
      text: 'find the filings',
    });
    expect(state.mode).toBe('idle');
    expect(state.transcript.at(-1)).toMatchObject({
      kind: 'user_task',
      text: 'find the filings',
    });
  });

  it('appends notices and keeps idle mode', () => {
    const state = reduce(createInitialState(), { type: 'notice', text: HELP_TEXT });
    expect(state.mode).toBe('idle');
    expect(state.transcript.at(-1)).toMatchObject({ kind: 'notice', text: HELP_TEXT });
  });

  it('handles an unknown command as a gentle notice, staying idle', () => {
    const routed = routeInput('/frobnicate');
    expect(routed.kind).toBe('unknown');
    const notice = unknownCommandNotice('/frobnicate');
    const state = reduce(createInitialState(), { type: 'notice', text: notice });
    expect(state.mode).toBe('idle');
    expect(state.transcript.at(-1)).toMatchObject({ kind: 'notice' });
    expect(notice).toContain('/frobnicate');
    expect(notice).toContain('/help');
  });

  it('assigns monotonically increasing item ids', () => {
    let state = createInitialState();
    state = reduce(state, { type: 'submit_task', text: 'one' });
    state = reduce(state, { type: 'notice', text: 'two' });
    const ids = state.transcript.map((item) => item.id);
    expect(ids).toEqual([...ids].sort((a, b) => a - b));
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('finalized transcript entries persist through later submissions', () => {
    let state = createInitialState();
    state = reduce(state, { type: 'submit_task', text: 'first task' });
    const firstItem = state.transcript.at(-1);
    state = reduce(state, { type: 'submit_task', text: 'second task' });
    expect(state.transcript).toContain(firstItem);
    expect(state.transcript.at(-1)).toMatchObject({ kind: 'user_task', text: 'second task' });
  });
});

// ————— Step 3: full UiEvent sequences (live region + finalization) —————

function fold(actions: StoreAction[], initial?: SessionState): SessionState {
  return actions.reduce(reduce, initial ?? createInitialState());
}

const started: StoreAction[] = [
  { type: 'submit_task', text: 'investigate' },
  { type: 'run_started', task: 'investigate', at: 1_000 },
];

describe('reduce (run lifecycle events)', () => {
  it('run_started enters running mode with fresh live state', () => {
    const state = fold(started);
    expect(state.mode).toBe('running');
    expect(state.live).toMatchObject({
      streamingText: '',
      pendingTools: [],
      startedAt: 1_000,
      tokens: { settled: 0, estimate: 0 },
      turn: 0,
    });
  });

  it('accumulates streaming text and grows the token estimate in-turn', () => {
    const state = fold([
      ...started,
      { type: 'turn_start', turn: 1 },
      { type: 'text_delta', text: 'Looking at ' },
      { type: 'text_delta', text: 'the filings.' },
    ]);
    expect(state.live?.streamingText).toBe('Looking at the filings.');
    expect(state.live?.tokens.estimate).toBeCloseTo(23 / 4);
    expect(state.live?.tokens.settled).toBe(0);
  });

  it('finalizes streaming text when a tool batch starts', () => {
    const state = fold([
      ...started,
      { type: 'turn_start', turn: 1 },
      { type: 'text_delta', text: 'Opening the page now.' },
      { type: 'tool_pending', name: 'navigate' },
    ]);
    expect(state.transcript.at(-1)).toMatchObject({
      kind: 'agent_text',
      text: 'Opening the page now.',
    });
    expect(state.live?.streamingText).toBe('');
    expect(state.live?.pendingTools).toHaveLength(1);
    expect(state.live?.pendingTools[0]).toMatchObject({ name: 'navigate' });
  });

  it('finalizes streaming text at turn end and snaps tokens to settled usage', () => {
    const state = fold([
      ...started,
      { type: 'turn_start', turn: 1 },
      { type: 'text_delta', text: 'All done here.' },
      { type: 'turn_end', usage: { input: 1200, output: 300 } },
    ]);
    expect(state.transcript.at(-1)).toMatchObject({
      kind: 'agent_text',
      text: 'All done here.',
    });
    expect(state.live?.tokens).toEqual({ settled: 1500, estimate: 1500 });
  });

  it('sums settled usage across turns (input + output)', () => {
    const state = fold([
      ...started,
      { type: 'turn_start', turn: 1 },
      { type: 'turn_end', usage: { input: 1000, output: 200, cacheRead: 900 } },
      { type: 'turn_start', turn: 2 },
      { type: 'turn_end', usage: { input: 2000, output: 300 } },
    ]);
    expect(state.live?.tokens.settled).toBe(3500);
  });

  it('finalizes a pending tool line when its execution ends ok', () => {
    const state = fold([
      ...started,
      { type: 'turn_start', turn: 1 },
      { type: 'tool_pending', name: 'navigate' },
      { type: 'turn_end', usage: { input: 100, output: 10 } },
      { type: 'tool_exec_start', id: 7, name: 'navigate', input: { url: 'https://a.test' } },
      { type: 'tool_exec_end', id: 7, ok: true },
    ]);
    expect(state.live?.pendingTools).toHaveLength(0);
    expect(state.transcript.at(-1)).toMatchObject({ kind: 'activity', status: 'ok' });
  });

  it('marks a failed execution as an error activity line', () => {
    const state = fold([
      ...started,
      { type: 'turn_start', turn: 1 },
      { type: 'tool_pending', name: 'click' },
      { type: 'tool_exec_start', id: 1, name: 'click', input: { ref: 'e1' } },
      { type: 'tool_exec_end', id: 1, ok: false, error: 'ref not found' },
    ]);
    expect(state.transcript.at(-1)).toMatchObject({ kind: 'activity', status: 'error' });
  });

  it('creates a pending line from exec start when the stream announced none', () => {
    const state = fold([
      ...started,
      { type: 'turn_start', turn: 1 },
      { type: 'tool_exec_start', id: 3, name: 'grep', input: { pattern: 'Q3' } },
    ]);
    expect(state.live?.pendingTools).toHaveLength(1);
    expect(state.live?.pendingTools[0]).toMatchObject({ name: 'grep', execId: 3 });
  });

  it('settles dangling pending lines as retried at the next turn_start', () => {
    const state = fold([
      ...started,
      { type: 'turn_start', turn: 1 },
      { type: 'tool_pending', name: 'navigate' },
      { type: 'turn_end', usage: { input: 100, output: 10 } },
      { type: 'turn_start', turn: 2 },
    ]);
    expect(state.live?.pendingTools).toHaveLength(0);
    expect(state.transcript.at(-1)).toMatchObject({
      kind: 'activity',
      status: 'retried',
    });
  });

  it('run_finished (completed) appends the completion item and returns to idle', () => {
    const state = fold([
      ...started,
      { type: 'turn_start', turn: 1 },
      { type: 'text_delta', text: 'Here is the answer.' },
      { type: 'turn_end', usage: { input: 15_000, output: 3_700 } },
      {
        type: 'run_finished',
        outcome: 'completed',
        finalText: 'Here is the answer.',
        runDir: '/runs/abc',
        at: 43_000,
      },
    ]);
    expect(state.mode).toBe('idle');
    expect(state.live).toBeUndefined();
    expect(state.transcript.at(-1)).toMatchObject({
      kind: 'completion',
      verb: 'Brewed',
      elapsedMs: 42_000,
      tokens: 18_700,
      runDir: '/runs/abc',
    });
  });

  it('run_finished uses the configured completion verb', () => {
    const state = fold(
      [
        ...started,
        {
          type: 'run_finished',
          outcome: 'completed',
          runDir: '/runs/abc',
          at: 2_000,
        },
      ],
      createInitialState({ completionVerb: 'Distilled' }),
    );
    expect(state.transcript.at(-1)).toMatchObject({ kind: 'completion', verb: 'Distilled' });
  });

  it('run_finished (budget_exceeded) appends a distinct error item', () => {
    const state = fold([
      ...started,
      { type: 'turn_start', turn: 1 },
      { type: 'turn_end', usage: { input: 200_000, output: 60_000 } },
      {
        type: 'run_finished',
        outcome: 'budget_exceeded',
        reason: 'token_budget',
        runDir: '/runs/over',
        at: 100_000,
      },
    ]);
    expect(state.mode).toBe('idle');
    const last = state.transcript.at(-1);
    expect(last).toMatchObject({ kind: 'error' });
    expect((last as { message: string }).message).toContain('token budget');
    expect((last as { message: string }).message).toContain('/runs/over');
  });

  it('run_cancelled preserves elapsed and token estimates in the cancelled item', () => {
    const state = fold([
      ...started,
      { type: 'turn_start', turn: 1 },
      { type: 'turn_end', usage: { input: 9_000, output: 300 } },
      { type: 'turn_start', turn: 2 },
      { type: 'text_delta', text: 'x'.repeat(400) },
      { type: 'run_cancelled', at: 19_000 },
    ]);
    expect(state.mode).toBe('idle');
    expect(state.transcript.at(-1)).toMatchObject({
      kind: 'cancelled',
      elapsedMs: 18_000,
      tokens: 9_400,
    });
  });

  it('run_failed appends an error item and returns to idle', () => {
    const state = fold([
      ...started,
      { type: 'turn_start', turn: 1 },
      { type: 'run_failed', message: 'browser died', at: 5_000 },
    ]);
    expect(state.mode).toBe('idle');
    expect(state.live).toBeUndefined();
    expect(state.transcript.at(-1)).toMatchObject({ kind: 'error', message: 'browser died' });
  });

  it('settles dangling pending lines when the run ends', () => {
    const state = fold([
      ...started,
      { type: 'turn_start', turn: 1 },
      { type: 'tool_pending', name: 'navigate' },
      { type: 'run_cancelled', at: 2_000 },
    ]);
    const retried = state.transcript.filter(
      (item) => item.kind === 'activity' && item.status === 'retried',
    );
    expect(retried).toHaveLength(1);
  });

  it('ignores run events while no run is live', () => {
    const initial = createInitialState();
    expect(fold([{ type: 'text_delta', text: 'stray' }], initial)).toEqual(initial);
    expect(fold([{ type: 'turn_end', usage: { input: 1, output: 1 } }], initial)).toEqual(initial);
  });
});
