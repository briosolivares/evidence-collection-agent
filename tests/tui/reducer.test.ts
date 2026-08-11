import { describe, expect, it } from 'vitest';

import {
  createInitialState,
  HELP_TEXT,
  reduce,
  routeInput,
  unknownCommandNotice,
} from '../../src/tui/store/reducer.js';

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
