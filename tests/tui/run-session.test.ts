import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { startRun } from '../../src/tui/bridge/runSession.js';
import type { UiEvent } from '../../src/tui/store/state.js';
import { scriptedResponse, scriptedStreamFactory } from './streamFixtures.js';
import { stubBrowser } from './stubBrowser.js';

// These tests drive the REAL runTask (run directories, manifest, loop,
// tool pipeline) against a stub browser and fully scripted SDK streams —
// no live API, no Chrome.

let runsBaseDir: string;

beforeEach(() => {
  runsBaseDir = mkdtempSync(join(tmpdir(), 'sherlock-bridge-'));
});

afterEach(() => {
  rmSync(runsBaseDir, { recursive: true, force: true });
});

function collect(): { events: UiEvent[]; onEvent: (event: UiEvent) => void } {
  const events: UiEvent[] = [];
  return { events, onEvent: (event) => events.push(event) };
}

describe('startRun (RunSession bridge)', () => {
  it('re-emits all four progress events in order for a text-only run', async () => {
    const { events, onEvent } = collect();
    const factory = scriptedStreamFactory([
      scriptedResponse([{ type: 'text', text: 'Answer ready.' }], { input: 1200, output: 180 }),
    ]);

    const handle = startRun('simple question', {
      browser: stubBrowser(),
      onEvent,
      runsBaseDir,
      createStream: factory.createStream,
      now: () => 42,
    });
    const outcome = await handle.done;

    expect(outcome.status).toBe('completed');
    if (outcome.status !== 'completed') throw new Error('unreachable');
    expect(outcome.finalText).toBe('Answer ready.');
    expect(outcome.runDir.startsWith(runsBaseDir)).toBe(true);

    const types = events.map((event) => event.type);
    expect(types[0]).toBe('run_started');
    expect(types[1]).toBe('turn_start');
    expect(types.at(-2)).toBe('turn_end');
    expect(types.at(-1)).toBe('run_finished');
    const deltas = events.filter((event) => event.type === 'text_delta');
    expect(deltas.map((event) => event.text).join('')).toBe('Answer ready.');

    const finished = events.at(-1);
    expect(finished).toMatchObject({
      type: 'run_finished',
      outcome: 'completed',
      finalText: 'Answer ready.',
      runDir: outcome.runDir,
      at: 42,
    });
  });

  it('orders turns and tool_pending faithfully across a two-turn tool run', async () => {
    const { events, onEvent } = collect();
    const factory = scriptedStreamFactory([
      scriptedResponse(
        [
          { type: 'text', text: 'Saving the notes.' },
          {
            type: 'tool_use',
            id: 'tu_1',
            name: 'write_file',
            input: { file_path: 'notes.md', content: 'hello evidence' },
          },
        ],
        { input: 1000, output: 200 },
        'tool_use',
      ),
      scriptedResponse([{ type: 'text', text: 'Done.' }], {
        input: 2400,
        output: 60,
        cacheRead: 900,
      }),
    ]);

    const browser = stubBrowser();
    const handle = startRun('save my notes', {
      browser,
      onEvent,
      runsBaseDir,
      createStream: factory.createStream,
    });
    const outcome = await handle.done;
    expect(outcome.status).toBe('completed');
    if (outcome.status !== 'completed') throw new Error('unreachable');

    const types = events.map((event) =>
      event.type === 'turn_start' ? `turn_start:${event.turn}` : event.type,
    );
    const compact = types.filter((type) => type !== 'text_delta');
    expect(compact).toEqual([
      'run_started',
      'turn_start:1',
      'tool_pending',
      'turn_end',
      'turn_start:2',
      'turn_end',
      'run_finished',
    ]);

    // tool_pending arrives after turn 1's prose and before its turn_end.
    const pendingIndex = events.findIndex((event) => event.type === 'tool_pending');
    const firstTurnEnd = events.findIndex((event) => event.type === 'turn_end');
    expect(events[pendingIndex]).toMatchObject({ name: 'write_file' });
    expect(pendingIndex).toBeLessThan(firstTurnEnd);

    // Usage totals are faithful per turn, including cache reads.
    const usages = events.filter((event) => event.type === 'turn_end');
    expect(usages[0]).toMatchObject({ usage: { input: 1000, output: 200 } });
    expect(usages[1]).toMatchObject({ usage: { input: 2400, output: 60, cacheRead: 900 } });

    // The real pipeline ran: the artifact and manifest exist on disk.
    expect(readFileSync(join(outcome.runDir, 'notes.md'), 'utf8')).toBe('hello evidence');
    const manifest = JSON.parse(
      readFileSync(join(outcome.runDir, 'manifest.json'), 'utf8'),
    ) as { artifacts: { filename: string }[]; finishedAt?: string };
    expect(manifest.artifacts.map((artifact) => artifact.filename)).toContain('notes.md');
    expect(manifest.finishedAt).toBeDefined();
    expect(existsSync(join(outcome.runDir, 'metrics.json'))).toBe(true);
  });

  it('maps budget exhaustion to a distinct outcome and event', async () => {
    const { events, onEvent } = collect();
    const factory = scriptedStreamFactory([
      scriptedResponse(
        [
          {
            type: 'tool_use',
            id: 'tu_1',
            name: 'write_file',
            input: { file_path: 'a.txt', content: 'x' },
          },
        ],
        { input: 500, output: 50 },
        'tool_use',
      ),
    ]);

    const handle = startRun('never finishes', {
      browser: stubBrowser(),
      onEvent,
      runsBaseDir,
      createStream: factory.createStream,
      maxTurns: 1,
    });
    const outcome = await handle.done;

    expect(outcome.status).toBe('budget_exceeded');
    if (outcome.status !== 'budget_exceeded') throw new Error('unreachable');
    expect(outcome.reason).toBe('max_turns');
    expect(events.at(-1)).toMatchObject({
      type: 'run_finished',
      outcome: 'budget_exceeded',
      reason: 'max_turns',
    });
  });

  it('maps a non-abort failure to run_failed', async () => {
    const { events, onEvent } = collect();
    const handle = startRun('doomed', {
      browser: stubBrowser(),
      onEvent,
      runsBaseDir,
      createStream: () => {
        throw new Error('api unreachable');
      },
    });
    const outcome = await handle.done;
    expect(outcome).toEqual({ status: 'failed', message: 'api unreachable' });
    expect(events.at(-1)).toMatchObject({ type: 'run_failed', message: 'api unreachable' });
  });

  it('passes the abort signal to every stream request', async () => {
    const { onEvent } = collect();
    const factory = scriptedStreamFactory([
      scriptedResponse([{ type: 'text', text: 'ok' }], { input: 10, output: 5 }),
    ]);
    const handle = startRun('check signal', {
      browser: stubBrowser(),
      onEvent,
      runsBaseDir,
      createStream: factory.createStream,
    });
    await handle.done;
    expect(factory.calls).toHaveLength(1);
    expect(factory.calls[0]?.signal).toBeInstanceOf(AbortSignal);
    expect(factory.calls[0]?.signal.aborted).toBe(false);
  });
});
