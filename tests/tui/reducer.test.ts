import { describe, expect, it } from 'vitest';

import {
  createInitialState,
  deriveSuggestions,
  HELP_TEXT,
  reduce,
  routeInput,
  unknownCommandNotice,
  type StoreAction,
} from '../../src/tui/store/reducer.js';
import type { ManifestEntry } from '../../src/run/artifacts.js';
import type { SessionState } from '../../src/tui/store/state.js';

describe('createInitialState', () => {
  it('starts idle with the banner as the first transcript item', () => {
    const state = createInitialState({ apiKeyPresent: true });
    expect(state.mode).toBe('idle');
    expect(state.transcript).toHaveLength(1);
    expect(state.transcript[0]).toMatchObject({ kind: 'banner', apiKeyPresent: true });
  });
});

describe('concurrent eval state', () => {
  it('tracks interleaved trials independently and removes only the completed row', () => {
    let state = createInitialState();
    state = reduce(state, {
      type: 'evals_started',
      tasks: ['alpha', 'beta'],
      k: 2,
      concurrency: 3,
    });
    state = reduce(state, {
      type: 'eval_trial_started',
      task: 'alpha',
      trial: 1,
      k: 2,
      requiresAuth: false,
    });
    state = reduce(state, {
      type: 'eval_trial_started',
      task: 'beta',
      trial: 1,
      k: 2,
      requiresAuth: true,
    });
    state = reduce(state, {
      type: 'eval_trial_progress',
      task: 'alpha',
      trial: 1,
      status: 'running navigate',
    });

    expect(Object.values(state.evalsLive ?? {})).toEqual([
      expect.objectContaining({ task: 'alpha', status: 'running navigate' }),
      expect.objectContaining({ task: 'beta', status: 'starting', requiresAuth: true }),
    ]);

    state = reduce(state, {
      type: 'eval_trial_done',
      task: 'alpha',
      trial: 1,
      k: 2,
      assertions: [{ name: 'ok', passed: true }],
      elapsedMs: 10,
    });
    expect(Object.values(state.evalsLive ?? {})).toEqual([
      expect.objectContaining({ task: 'beta' }),
    ]);
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

/** A published manifest entry, verbatim shape (roles present ⟺ published). */
function publishedEntry(
  overrides: Partial<ManifestEntry> & { filename: string },
): ManifestEntry {
  return {
    sha256: 'a'.repeat(64),
    roles: ['evidence'],
    capturedAt: '2026-08-12T10:00:00.000Z',
    ...overrides,
  };
}

/** The tracing seam's publish announcement for one manifest entry. */
function published(
  toolExecId: number,
  entry: ManifestEntry,
  sizeBytes: number | undefined = 128,
): StoreAction {
  return { type: 'artifact_published', entry, sizeBytes, toolExecId };
}

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
        reason: 'context_budget',
        runDir: '/runs/over',
        at: 100_000,
      },
    ]);
    expect(state.mode).toBe('idle');
    const last = state.transcript.at(-1);
    expect(last).toMatchObject({ kind: 'error' });
    expect((last as { message: string }).message).toContain('context budget');
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
    expect(
      fold([published(1, publishedEntry({ filename: 'artifacts/stray.png' }))], initial),
    ).toEqual(initial);
  });
});

// ————— Step 5: cancellation transitions —————

describe('reduce (cancellation)', () => {
  it('cancel_requested flips running to cancelling', () => {
    const state = fold([...started, { type: 'cancel_requested' }]);
    expect(state.mode).toBe('cancelling');
    expect(state.live).toBeDefined();
  });

  it('cancel_requested is a no-op outside running', () => {
    const idle = createInitialState();
    expect(reduce(idle, { type: 'cancel_requested' })).toEqual(idle);
    const cancelling = fold([...started, { type: 'cancel_requested' }]);
    expect(reduce(cancelling, { type: 'cancel_requested' })).toEqual(cancelling);
  });

  it('runs running → cancelling → idle with a persistent cancelled item', () => {
    let state = fold([
      ...started,
      { type: 'turn_start', turn: 1 },
      { type: 'turn_end', usage: { input: 9_000, output: 300 } },
    ]);
    state = reduce(state, { type: 'cancel_requested' });
    expect(state.mode).toBe('cancelling');
    state = reduce(state, { type: 'run_cancelled', at: 19_000 });
    expect(state.mode).toBe('idle');
    expect(state.live).toBeUndefined();
    expect(state.transcript.at(-1)).toMatchObject({
      kind: 'cancelled',
      elapsedMs: 18_000,
      tokens: 9_300,
    });
  });

  it('a non-abort rejection while cancelling still maps to an error item', () => {
    let state = fold([...started, { type: 'cancel_requested' }]);
    state = reduce(state, { type: 'run_failed', message: 'socket hang up', at: 3_000 });
    expect(state.mode).toBe('idle');
    expect(state.transcript.at(-1)).toMatchObject({
      kind: 'error',
      message: 'socket hang up',
    });
  });
});

// ————— Step 6: semantic upgrades and evidence —————

describe('reduce (semantic activity + evidence)', () => {
  it('upgrades a name-only pending line in place when exec starts', () => {
    const state = fold([
      ...started,
      { type: 'turn_start', turn: 1 },
      { type: 'tool_pending', name: 'navigate' },
      {
        type: 'tool_exec_start',
        id: 1,
        name: 'navigate',
        input: { url: 'https://www.sec.gov/cgi-bin/browse-edgar' },
      },
    ]);
    expect(state.live?.pendingTools).toHaveLength(1);
    expect(state.live?.pendingTools[0]).toMatchObject({
      execId: 1,
      line: 'Opening sec.gov/cgi-bin/browse-edgar',
      isEvidence: false,
    });
  });

  it('finalizes a publishing write_file as an evidence item', () => {
    const state = fold([
      ...started,
      { type: 'turn_start', turn: 1 },
      { type: 'tool_pending', name: 'write_file' },
      {
        type: 'tool_exec_start',
        id: 1,
        name: 'write_file',
        input: { file_path: 'artifacts/top5.csv', content: 'a,b' },
      },
      published(1, publishedEntry({ filename: 'artifacts/top5.csv', roles: ['requested_output'] }), 3),
      { type: 'tool_exec_end', id: 1, ok: true, result: 'Created top5.csv' },
    ]);
    const item = state.transcript.at(-1);
    expect(item).toMatchObject({
      kind: 'evidence',
      line: 'Evidence saved → artifacts/top5.csv',
    });
    // write_file records no sourceUrl, so the evidence line omits it.
    expect((item as { sourceUrl?: string }).sourceUrl).toBeUndefined();
  });

  it('a failed evidence tool finalizes as an error activity, not evidence', () => {
    const state = fold([
      ...started,
      { type: 'turn_start', turn: 1 },
      {
        type: 'tool_exec_start',
        id: 1,
        name: 'screenshot',
        input: { filename: 'page.png' },
      },
      { type: 'tool_exec_end', id: 1, ok: false, error: 'no browser' },
    ]);
    expect(state.transcript.at(-1)).toMatchObject({
      kind: 'activity',
      status: 'error',
      line: 'Captured page.png',
    });
  });

  it('stores compact verbose input/result detail on finalized lines', () => {
    const state = fold([
      ...started,
      { type: 'turn_start', turn: 1 },
      { type: 'tool_exec_start', id: 1, name: 'grep', input: { pattern: 'Q3' } },
      { type: 'tool_exec_end', id: 1, ok: true, result: 'notes.md:4: Q3 revenue' },
    ]);
    const item = state.transcript.at(-1);
    expect(item).toMatchObject({ kind: 'activity', status: 'ok' });
    expect((item as { verbose?: { input: string; result: string } }).verbose).toEqual({
      input: '{"pattern":"Q3"}',
      result: 'notes.md:4: Q3 revenue',
    });
  });
});

// ————— Plan item 2: publish-driven artifacts and evidence —————

describe('reduce (published artifacts)', () => {
  // A screenshot exec whose publish arrives before its end, per the
  // tracing seam's emission contract.
  const captured: StoreAction[] = [
    ...started,
    { type: 'turn_start', turn: 1 },
    {
      type: 'tool_exec_start',
      id: 1,
      name: 'screenshot',
      input: { filename: 'artifacts/page.png' },
    },
    published(
      1,
      publishedEntry({ filename: 'artifacts/page.png', sourceUrl: 'https://sec.gov/filings' }),
      10,
    ),
    { type: 'tool_exec_end', id: 1, ok: true, result: { path: 'artifacts/page.png', size: 10 } },
  ];

  it('upserts published artifacts by filename — a re-publish replaces in place', () => {
    const state = fold([
      ...captured,
      {
        type: 'tool_exec_start',
        id: 2,
        name: 'write_file',
        input: { file_path: 'artifacts/top5.csv', content: 'v1' },
      },
      published(2, publishedEntry({ filename: 'artifacts/top5.csv', sha256: '1'.repeat(64), roles: ['requested_output'] }), 2),
      { type: 'tool_exec_end', id: 2, ok: true },
      {
        type: 'tool_exec_start',
        id: 3,
        name: 'write_file',
        input: { file_path: 'artifacts/top5.csv', content: 'v2!' },
      },
      published(3, publishedEntry({ filename: 'artifacts/top5.csv', sha256: '2'.repeat(64), roles: ['requested_output'] }), 3),
      { type: 'tool_exec_end', id: 3, ok: true },
    ]);
    expect(state.artifacts.map((artifact) => artifact.entry.filename)).toEqual([
      'artifacts/page.png',
      'artifacts/top5.csv',
    ]);
    expect(state.artifacts[1]).toMatchObject({
      entry: { sha256: '2'.repeat(64), roles: ['requested_output'] },
      sizeBytes: 3,
    });
  });

  it('retains artifacts with full provenance after the run ends, clears them on the next run_started', () => {
    const finished = fold([
      ...captured,
      { type: 'run_finished', outcome: 'completed', runDir: '/runs/abc', at: 2_000 },
    ]);
    expect(finished.mode).toBe('idle');
    expect(finished.live).toBeUndefined();
    expect(finished.artifacts).toEqual([
      {
        entry: publishedEntry({ filename: 'artifacts/page.png', sourceUrl: 'https://sec.gov/filings' }),
        sizeBytes: 10,
      },
    ]);
    const next = reduce(finished, { type: 'run_started', task: 'again', at: 3_000 });
    expect(next.artifacts).toEqual([]);
  });

  it('an exec that published finalizes as evidence, sourceUrl lifted from the entry', () => {
    const state = fold(captured);
    expect(state.transcript.at(-1)).toMatchObject({
      kind: 'evidence',
      line: 'Captured artifacts/page.png',
      sourceUrl: 'https://sec.gov/filings',
    });
  });

  it('an exec that published nothing renders plain activity — the scratch-write fix', () => {
    const state = fold([
      ...started,
      { type: 'turn_start', turn: 1 },
      {
        type: 'tool_exec_start',
        id: 1,
        name: 'write_file',
        input: { file_path: 'scratch/notes.md', content: 'wip' },
      },
      { type: 'tool_exec_end', id: 1, ok: true, result: 'File created successfully at: scratch/notes.md' },
    ]);
    expect(state.transcript.at(-1)).toMatchObject({
      kind: 'activity',
      status: 'ok',
      line: 'Writing scratch/notes.md',
    });
    expect(state.artifacts).toEqual([]);
  });

  it('a publishing browser_batch finalizes as evidence, first entry with a sourceUrl winning', () => {
    const state = fold([
      ...started,
      { type: 'turn_start', turn: 1 },
      {
        type: 'tool_exec_start',
        id: 4,
        name: 'browser_batch',
        input: { actions: [{ tool: 'click', input: { ref: 'e1' } }] },
      },
      published(4, publishedEntry({ filename: 'artifacts/notes.csv', roles: ['requested_output'] })),
      published(4, publishedEntry({ filename: 'artifacts/shot.png', sourceUrl: 'https://x.test/b' })),
      { type: 'tool_exec_end', id: 4, ok: true },
    ]);
    expect(state.transcript.at(-1)).toMatchObject({
      kind: 'evidence',
      line: 'Running 1 browser steps',
      sourceUrl: 'https://x.test/b',
    });
    expect(state.artifacts).toHaveLength(2);
  });

  it('a publish clamps a stale cursor back into the list bounds', () => {
    // Artifacts can only shrink via run_started today; pin the
    // clamp-on-change contract against a synthetic stale cursor anyway.
    const stale: SessionState = {
      ...fold(captured),
      artifacts: [],
      artifactUi: { cursor: 5, view: 'rows' },
    };
    const next = reduce(
      stale,
      published(9, publishedEntry({ filename: 'artifacts/late.png' })),
    );
    expect(next.artifacts).toHaveLength(1);
    expect(next.artifactUi.cursor).toBe(0);
  });

  it('a failed exec renders error activity even when it published first', () => {
    const state = fold([
      ...started,
      { type: 'turn_start', turn: 1 },
      {
        type: 'tool_exec_start',
        id: 5,
        name: 'browser_batch',
        input: { actions: [{ tool: 'screenshot', input: {} }, { tool: 'click', input: {} }] },
      },
      published(5, publishedEntry({ filename: 'artifacts/partial.png', sourceUrl: 'https://x.test/a' })),
      { type: 'tool_exec_end', id: 5, ok: false, error: 'step 2 failed' },
    ]);
    expect(state.transcript.at(-1)).toMatchObject({ kind: 'activity', status: 'error' });
    // The capture itself is real and stays listed.
    expect(state.artifacts.map((artifact) => artifact.entry.filename)).toEqual([
      'artifacts/partial.png',
    ]);
  });
});

// ————— Plan item 4: artifact UI substate (rail selection + detail) —————

describe('reduce (artifact UI substate)', () => {
  const twoArtifacts: StoreAction[] = [
    ...started,
    { type: 'turn_start', turn: 1 },
    published(1, publishedEntry({ filename: 'artifacts/a.png' })),
    published(2, publishedEntry({ filename: 'artifacts/b.csv', roles: ['requested_output'] })),
  ];

  it('starts at cursor 0 in the rows view', () => {
    expect(createInitialState().artifactUi).toEqual({ cursor: 0, view: 'rows' });
  });

  it('artifact_nav moves the cursor, clamped at both ends', () => {
    let state = fold(twoArtifacts);
    state = reduce(state, { type: 'artifact_nav', delta: -1 });
    expect(state.artifactUi.cursor).toBe(0); // clamped at the top
    state = reduce(state, { type: 'artifact_nav', delta: 1 });
    expect(state.artifactUi.cursor).toBe(1);
    state = reduce(state, { type: 'artifact_nav', delta: 1 });
    expect(state.artifactUi.cursor).toBe(1); // clamped at the bottom
  });

  it('artifact_nav and artifact_open_detail are no-ops with no artifacts', () => {
    const state = fold(started);
    expect(reduce(state, { type: 'artifact_nav', delta: 1 })).toEqual(state);
    expect(reduce(state, { type: 'artifact_open_detail' })).toEqual(state);
  });

  it('open/close flip the detail view; a redundant close is a no-op', () => {
    let state = fold(twoArtifacts);
    state = reduce(state, { type: 'artifact_open_detail' });
    expect(state.artifactUi.view).toBe('detail');
    const closed = reduce(state, { type: 'artifact_close_detail' });
    expect(closed.artifactUi.view).toBe('rows');
    expect(reduce(closed, { type: 'artifact_close_detail' })).toEqual(closed);
  });

  it('closing the detail never touches the run — mode stays running', () => {
    let state = fold(twoArtifacts);
    state = reduce(state, { type: 'artifact_open_detail' });
    state = reduce(state, { type: 'artifact_close_detail' });
    expect(state.mode).toBe('running');
    expect(state.live).toBeDefined();
  });

  it('run_started resets the substate for the next run', () => {
    let state = fold(twoArtifacts);
    state = reduce(state, { type: 'artifact_nav', delta: 1 });
    state = reduce(state, { type: 'artifact_open_detail' });
    state = reduce(state, {
      type: 'run_finished',
      outcome: 'completed',
      runDir: '/runs/abc',
      at: 2_000,
    });
    state = reduce(state, { type: 'run_started', task: 'again', at: 3_000 });
    expect(state.artifactUi).toEqual({ cursor: 0, view: 'rows' });
  });
});

// ————— Plan item 6: completion summary + artifacts focus mode —————

describe('reduce (completion summary)', () => {
  const oneArtifact: StoreAction[] = [
    ...started,
    { type: 'turn_start', turn: 1 },
    { type: 'turn_end', usage: { input: 15_000, output: 3_700 } },
    published(1, publishedEntry({ filename: 'artifacts/page.png' })),
  ];

  it('run_finished (completed) records the summary the panel renders', () => {
    const state = fold([
      ...oneArtifact,
      {
        type: 'run_finished',
        outcome: 'completed',
        finalText: 'Here is the answer.',
        runDir: '/runs/abc',
        at: 43_000,
      },
    ]);
    expect(state.completedRun).toEqual({
      finalText: 'Here is the answer.',
      verb: 'Brewed',
      elapsedMs: 42_000,
      tokens: 18_700,
      runDir: '/runs/abc',
    });
  });

  it('a completion without finalText records a summary without it', () => {
    const state = fold([
      ...started,
      { type: 'run_finished', outcome: 'completed', runDir: '/runs/abc', at: 2_000 },
    ]);
    expect(state.completedRun).toBeDefined();
    expect(state.completedRun?.finalText).toBeUndefined();
  });

  it('the next run_started clears the previous summary', () => {
    let state = fold([
      ...started,
      { type: 'run_finished', outcome: 'completed', runDir: '/runs/abc', at: 2_000 },
    ]);
    state = reduce(state, { type: 'run_started', task: 'again', at: 3_000 });
    expect(state.completedRun).toBeUndefined();
  });

  it('budget_exceeded records no summary', () => {
    const state = fold([
      ...started,
      {
        type: 'run_finished',
        outcome: 'budget_exceeded',
        reason: 'max_turns',
        runDir: '/runs/over',
        at: 2_000,
      },
    ]);
    expect(state.completedRun).toBeUndefined();
  });

  it('a cancelled run records no summary but keeps its artifacts for /artifacts', () => {
    const state = fold([...oneArtifact, { type: 'run_cancelled', at: 2_000 }]);
    expect(state.completedRun).toBeUndefined();
    expect(state.artifacts).toHaveLength(1);
  });

  it('run end retains the live run dir — /artifacts opens files against it', () => {
    const state = fold([
      ...started,
      { type: 'run_dir', runDir: '/runs/abc' },
      { type: 'turn_start', turn: 1 },
      published(1, publishedEntry({ filename: 'artifacts/page.png' })),
      { type: 'run_cancelled', at: 2_000 },
    ]);
    expect(state.lastRunDir).toBe('/runs/abc');
    expect(state.completedRun).toBeUndefined();
  });

  it('the completion item digests the published artifacts, requested outputs first', () => {
    const state = fold([
      ...started,
      { type: 'turn_start', turn: 1 },
      published(1, publishedEntry({ filename: 'artifacts/page.png' }), 2_048),
      published(
        2,
        publishedEntry({ filename: 'artifacts/top5.csv', roles: ['requested_output'] }),
        96,
      ),
      { type: 'run_finished', outcome: 'completed', runDir: '/runs/abc', at: 2_000 },
    ]);
    expect(state.transcript.at(-1)).toMatchObject({
      kind: 'completion',
      artifacts: [
        { filename: 'artifacts/top5.csv', sizeBytes: 96, roles: ['requested_output'] },
        { filename: 'artifacts/page.png', sizeBytes: 2_048, roles: ['evidence'] },
      ],
    });
  });

  it('a completed eval trial records no summary — no panel between trials', () => {
    const state = fold([
      { type: 'evals_started', tasks: ['stub'], k: 1, concurrency: 1 },
      { type: 'run_started', task: 'stub', at: 0 },
      {
        type: 'run_finished',
        outcome: 'completed',
        finalText: 'done',
        runDir: '/runs/eval-trial',
        at: 9_000,
      },
    ]);
    expect(state.mode).toBe('evalsRunning');
    expect(state.completedRun).toBeUndefined();
  });
});

describe('reduce (artifacts focus mode)', () => {
  /** A completed run with two artifacts, requested output published last. */
  const completedWithArtifacts: StoreAction[] = [
    ...started,
    { type: 'turn_start', turn: 1 },
    published(1, publishedEntry({ filename: 'artifacts/a.png' })),
    published(2, publishedEntry({ filename: 'artifacts/b.csv', roles: ['requested_output'] })),
    {
      type: 'run_finished',
      outcome: 'completed',
      finalText: 'Saved.',
      runDir: '/runs/abc',
      at: 2_000,
    },
  ];

  it('artifacts_focus enters the mode from idle with a fresh selection', () => {
    let state = fold(completedWithArtifacts);
    // Leave stale selection behind to prove focus resets it.
    state = { ...state, artifactUi: { cursor: 1, view: 'detail' } };
    state = reduce(state, { type: 'artifacts_focus' });
    expect(state.mode).toBe('artifacts');
    expect(state.artifactUi).toEqual({ cursor: 0, view: 'rows' });
  });

  it('artifacts_focus is a no-op while a run is live or evals own the session', () => {
    const running = fold([
      ...started,
      { type: 'turn_start', turn: 1 },
      published(1, publishedEntry({ filename: 'artifacts/a.png' })),
    ]);
    expect(reduce(running, { type: 'artifacts_focus' })).toEqual(running);
    const evals = fold([
      { type: 'evals_started', tasks: ['stub'], k: 1, concurrency: 1 },
    ]);
    expect(reduce(evals, { type: 'artifacts_focus' })).toEqual(evals);
  });

  it('artifacts_focus is a no-op with nothing to browse', () => {
    const state = fold([
      ...started,
      { type: 'run_finished', outcome: 'completed', runDir: '/runs/abc', at: 2_000 },
    ]);
    expect(reduce(state, { type: 'artifacts_focus' })).toEqual(state);
  });

  it('artifacts_blur returns to idle, keeping the summary and artifacts', () => {
    let state = fold(completedWithArtifacts);
    state = reduce(state, { type: 'artifacts_focus' });
    state = reduce(state, { type: 'artifacts_blur' });
    expect(state.mode).toBe('idle');
    expect(state.completedRun).toBeDefined();
    expect(state.artifacts).toHaveLength(2);
    // Blur anywhere else changes nothing.
    expect(reduce(state, { type: 'artifacts_blur' })).toEqual(state);
  });

  it('closing an open detail card stays in artifacts mode (Esc precedence)', () => {
    let state = fold(completedWithArtifacts);
    state = reduce(state, { type: 'artifacts_focus' });
    state = reduce(state, { type: 'artifact_open_detail' });
    expect(state.artifactUi.view).toBe('detail');
    state = reduce(state, { type: 'artifact_close_detail' });
    expect(state.mode).toBe('artifacts');
    expect(state.artifactUi.view).toBe('rows');
  });
});

// ————— Composer substate: reducer-owned input, derived suggestions —————

describe('reduce (composer substate)', () => {
  it('starts with an empty, undismissed line', () => {
    expect(createInitialState().composer).toEqual({
      value: '',
      dismissed: false,
      selectedIndex: 0,
      completions: 0,
    });
  });

  it('composer_changed sets the value and re-arms panel + selection', () => {
    const state = fold([
      { type: 'composer_changed', value: '/e' },
      { type: 'suggest_nav', delta: 1 },
      { type: 'suggest_dismiss' },
      { type: 'composer_changed', value: '/ex' },
    ]);
    expect(state.composer).toMatchObject({
      value: '/ex',
      selectedIndex: 0,
      dismissed: false,
    });
  });

  it('deriveSuggestions filters while idle and hides on dismissal', () => {
    const typed = fold([{ type: 'composer_changed', value: '/e' }]);
    const view = deriveSuggestions(typed);
    expect(view.suggestions.map((entry) => entry.name)).toEqual(['/evals', '/exit']);
    expect(view).toMatchObject({
      panelVisible: true,
      cursor: 0,
      selected: { name: '/evals' },
    });
    const dismissed = reduce(typed, { type: 'suggest_dismiss' });
    expect(deriveSuggestions(dismissed)).toMatchObject({
      panelVisible: false,
      suggestions: [],
      selected: undefined,
    });
  });

  it('deriveSuggestions is empty outside idle — the composer is disabled there', () => {
    const typed = fold([{ type: 'composer_changed', value: '/e' }]);
    const running = fold(started, typed);
    expect(running.mode).toBe('running');
    // The typed line survives the mode change; only the panel hides.
    expect(running.composer.value).toBe('/e');
    expect(deriveSuggestions(running)).toMatchObject({
      panelVisible: false,
      suggestions: [],
    });
  });

  it('suggest_nav moves the selection, clamped at both ends', () => {
    let state = fold([{ type: 'composer_changed', value: '/e' }]);
    state = reduce(state, { type: 'suggest_nav', delta: -1 });
    expect(state.composer.selectedIndex).toBe(0); // clamped at the top
    state = reduce(state, { type: 'suggest_nav', delta: 1 });
    expect(state.composer.selectedIndex).toBe(1);
    state = reduce(state, { type: 'suggest_nav', delta: 1 });
    expect(state.composer.selectedIndex).toBe(1); // clamped at the bottom
  });

  it('suggest_nav and suggest_dismiss are no-ops with the panel hidden', () => {
    const idle = createInitialState(); // '' matches nothing
    expect(reduce(idle, { type: 'suggest_nav', delta: 1 })).toEqual(idle);
    expect(reduce(idle, { type: 'suggest_dismiss' })).toEqual(idle);
    const dismissed = fold([
      { type: 'composer_changed', value: '/e' },
      { type: 'suggest_dismiss' },
    ]);
    expect(reduce(dismissed, { type: 'suggest_nav', delta: 1 })).toEqual(dismissed);
  });

  it('composer_submitted clears the line, keeping the remount count', () => {
    let state = fold([
      { type: 'composer_changed', value: '/ev' },
      { type: 'tab_pressed' }, // completes → "/evals ", completions 1
    ]);
    state = reduce(state, { type: 'composer_submitted' });
    expect(state.composer).toEqual({
      value: '',
      dismissed: false,
      selectedIndex: 0,
      completions: 1,
    });
    // Idempotent: a second reset changes nothing.
    expect(reduce(state, { type: 'composer_submitted' })).toEqual(state);
  });
});

// ————— tab_pressed: the single Tab route and its precedence —————

describe('reduce (tab_pressed routing)', () => {
  /** A completed run with one artifact — the focusable-panel state. */
  const completedRun: StoreAction[] = [
    ...started,
    { type: 'turn_start', turn: 1 },
    published(1, publishedEntry({ filename: 'artifacts/a.png' })),
    {
      type: 'run_finished',
      outcome: 'completed',
      finalText: 'Saved.',
      runDir: '/runs/abc',
      at: 2_000,
    },
  ];

  it('completes the highlighted suggestion while the panel is up', () => {
    const state = fold([
      { type: 'composer_changed', value: '/e' },
      { type: 'suggest_nav', delta: 1 }, // /evals → /exit
      { type: 'tab_pressed' },
    ]);
    expect(state.composer).toMatchObject({
      value: '/exit ',
      selectedIndex: 0,
      completions: 1,
    });
    // The trailing space hides the panel; nothing was submitted.
    expect(deriveSuggestions(state).panelVisible).toBe(false);
    expect(state.mode).toBe('idle');
    expect(state.transcript).toHaveLength(1); // still just the banner
  });

  it('clamps a stale selection into the match list before completing', () => {
    const typed = fold([{ type: 'composer_changed', value: '/e' }]);
    const stale: SessionState = {
      ...typed,
      composer: { ...typed.composer, selectedIndex: 4 },
    };
    const state = reduce(stale, { type: 'tab_pressed' });
    expect(state.composer.value).toBe('/exit '); // suggestions[min(4, 1)]
    expect(state.composer.completions).toBe(1);
  });

  it('completion wins over artifacts focus when both would apply', () => {
    const state = fold([...completedRun, { type: 'composer_changed', value: '/ev' }]);
    expect(state.completedRun).toBeDefined();
    const next = reduce(state, { type: 'tab_pressed' });
    expect(next.mode).toBe('idle'); // not focused
    expect(next.composer).toMatchObject({ value: '/evals ', completions: 1 });
  });

  it('focuses the artifacts panel while idle with a completed run', () => {
    const state = reduce(fold(completedRun), { type: 'tab_pressed' });
    expect(state.mode).toBe('artifacts');
    expect(state.artifactUi).toEqual({ cursor: 0, view: 'rows' });
  });

  it('blurs back to idle from artifacts mode, summary kept', () => {
    let state = fold(completedRun);
    state = reduce(state, { type: 'tab_pressed' }); // focus
    state = reduce(state, { type: 'tab_pressed' }); // blur
    expect(state.mode).toBe('idle');
    expect(state.completedRun).toBeDefined();
    expect(state.artifacts).toHaveLength(1);
  });

  it('keeps the artifacts_focus guard: no artifacts, no focus', () => {
    const bare = fold([
      ...started,
      { type: 'run_finished', outcome: 'completed', runDir: '/runs/abc', at: 2_000 },
    ]);
    expect(bare.completedRun).toBeDefined();
    expect(reduce(bare, { type: 'tab_pressed' })).toEqual(bare);
  });

  it('is a no-op while idle without a completed run', () => {
    const idle = createInitialState();
    expect(reduce(idle, { type: 'tab_pressed' })).toEqual(idle);
  });

  it('is a no-op while a run is live', () => {
    const running = fold([...started, { type: 'turn_start', turn: 1 }]);
    expect(reduce(running, { type: 'tab_pressed' })).toEqual(running);
  });
});
