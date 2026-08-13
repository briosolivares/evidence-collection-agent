import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ModelStreamEvent } from '../../src/model/streamAssembly.js';
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
            input: { file_path: 'artifacts/notes.md', content: 'hello evidence' },
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
      'run_dir',
      'tool_exec_start',
      'artifact_published',
      'tool_exec_end',
      'turn_start:2',
      'turn_end',
      'run_finished',
    ]);
    const runDirEvent = events.find((event) => event.type === 'run_dir');
    expect(runDirEvent).toMatchObject({ runDir: outcome.runDir });

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
    expect(readFileSync(join(outcome.runDir, 'artifacts/notes.md'), 'utf8')).toBe('hello evidence');
    const manifest = JSON.parse(
      readFileSync(join(outcome.runDir, 'manifest.json'), 'utf8'),
    ) as { artifacts: { filename: string }[]; finishedAt?: string };
    expect(manifest.artifacts.map((artifact) => artifact.filename)).toContain('artifacts/notes.md');
    expect(manifest.finishedAt).toBeDefined();
    expect(existsSync(join(outcome.runDir, 'metrics.json'))).toBe(true);
  });

  it('uses the same batch-enabled profile for model definitions and execution', async () => {
    const { events, onEvent } = collect();
    const factory = scriptedStreamFactory([
      scriptedResponse(
        [
          {
            type: 'tool_use',
            id: 'tu_batch',
            name: 'browser_batch',
            input: {
              actions: [
                { tool: 'navigate', input: { url: 'https://example.test/' } },
                { tool: 'inspect_page', input: {} },
              ],
            },
          },
        ],
        { input: 1000, output: 200 },
        'tool_use',
      ),
      scriptedResponse([{ type: 'text', text: 'Done.' }], {
        input: 1500,
        output: 40,
      }),
    ]);

    const handle = startRun('use a browser batch', {
      browser: stubBrowser(),
      onEvent,
      runsBaseDir,
      toolProfile: 'batch-enabled',
      createStream: factory.createStream,
    });
    await expect(handle.done).resolves.toMatchObject({ status: 'completed' });

    const firstParams = factory.calls[0]?.params as {
      tools?: Array<{ name: string }>;
    };
    expect(firstParams.tools?.map((tool) => tool.name).at(-1)).toBe('browser_batch');
    expect(events.filter((event) => event.type === 'tool_exec_start')).toEqual([
      expect.objectContaining({ name: 'browser_batch' }),
    ]);
    expect(events.filter((event) => event.type === 'tool_exec_end')).toEqual([
      expect.objectContaining({ ok: true }),
    ]);
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
            input: { file_path: 'artifacts/a.txt', content: 'x' },
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

  it('aborting mid-stream rejects the run and emits run_cancelled', async () => {
    const { events, onEvent } = collect();
    let sawDelta: () => void = () => {};
    const firstDelta = new Promise<void>((resolve) => {
      sawDelta = resolve;
    });

    // A stream that yields some prose, then hangs until the signal aborts.
    async function* hangingStream(
      signal: AbortSignal | undefined,
    ): AsyncGenerator<ModelStreamEvent> {
      const opening = scriptedResponse([{ type: 'text', text: 'Working on ' }], {
        input: 1,
        output: 1,
      }).slice(0, 3); // message_start, block_start, one delta
      yield* opening;
      sawDelta();
      await new Promise((_resolve, reject) => {
        const abort = () =>
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        if (signal === undefined) return;
        if (signal.aborted) abort();
        else signal.addEventListener('abort', abort, { once: true });
      });
    }

    const handle = startRun('long investigation', {
      browser: stubBrowser(),
      onEvent,
      runsBaseDir,
      createStream: (_params, signal) => hangingStream(signal),
    });

    await firstDelta;
    handle.cancel();
    const outcome = await handle.done;

    expect(outcome).toEqual({ status: 'cancelled' });
    expect(events.at(-1)?.type).toBe('run_cancelled');
    expect(events.some((event) => event.type === 'run_failed')).toBe(false);
  });

  it('aborting during a tool batch lets the batch settle before cancelling', async () => {
    const { events, onEvent } = collect();
    let releaseGoto: () => void = () => {};
    const gotoBlocked = new Promise<void>((resolve) => {
      releaseGoto = resolve;
    });
    let gotoStarted: () => void = () => {};
    const gotoStartedPromise = new Promise<void>((resolve) => {
      gotoStarted = resolve;
    });
    let gotoFinished = false;

    const browser = stubBrowser();
    browser.goto = async () => {
      gotoStarted();
      await gotoBlocked;
      gotoFinished = true;
    };

    const factory = scriptedStreamFactory([
      scriptedResponse(
        [
          {
            type: 'tool_use',
            id: 'tu_1',
            name: 'navigate',
            input: { url: 'https://example.com/slow' },
          },
        ],
        { input: 100, output: 20 },
        'tool_use',
      ),
      // A second scripted response exists but must never be requested: the
      // bridge's callModel checks the aborted signal at entry.
      scriptedResponse([{ type: 'text', text: 'should never stream' }], {
        input: 1,
        output: 1,
      }),
    ]);

    const handle = startRun('navigate somewhere slow', {
      browser,
      onEvent,
      runsBaseDir,
      createStream: factory.createStream,
    });

    await gotoStartedPromise;
    handle.cancel(); // mid-batch: the model call already returned
    expect(gotoFinished).toBe(false);
    releaseGoto();
    const outcome = await handle.done;

    expect(gotoFinished).toBe(true); // the batch settled first
    expect(outcome).toEqual({ status: 'cancelled' });
    expect(events.at(-1)?.type).toBe('run_cancelled');
    expect(factory.calls).toHaveLength(1); // no second model call
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
    expect(factory.calls[0]?.signal?.aborted).toBe(false);
  });
});

describe('startRun permission channel', () => {
  const askInput = {
    question: 'Did you finish logging in?',
    options: [{ label: 'Yes' }],
  };

  function askResponse() {
    return scriptedResponse(
      [{ type: 'tool_use', id: 'tu_ask', name: 'ask_user_question', input: askInput }],
      { input: 900, output: 40 },
      'tool_use',
    );
  }

  it('announces the pause, then resumes the run with the dialog answers', async () => {
    const { events, onEvent } = collect();
    const factory = scriptedStreamFactory([
      askResponse(),
      scriptedResponse([{ type: 'text', text: 'Resuming.' }], { input: 1000, output: 20 }),
    ]);
    const seen: unknown[] = [];

    const handle = startRun('needs a human', {
      browser: stubBrowser(),
      onEvent,
      runsBaseDir,
      createStream: factory.createStream,
      requestPermission: async (request) => {
        seen.push(request);
        return {
          behavior: 'allow',
          updatedInput: {
            ...(request.input as object),
            answers: { chosen: [], freeText: 'yes, all done' },
          },
        };
      },
    });
    const outcome = await handle.done;

    expect(outcome.status).toBe('completed');
    expect(seen).toEqual([{ toolName: 'ask_user_question', input: askInput }]);
    expect(
      events.find((event) => event.type === 'permission_request'),
    ).toMatchObject({ toolName: 'ask_user_question', input: askInput });
    // The tool executed with the merged answers and echoed them as prose —
    // the round-trip reached the model as an ordinary tool result.
    expect(events.find((event) => event.type === 'tool_exec_end')).toMatchObject({
      ok: true,
      result: 'User answered: "yes, all done"',
    });
  });

  it('cancel during a pause denies the question and ends run_cancelled', async () => {
    const { events, onEvent } = collect();
    const factory = scriptedStreamFactory([askResponse()]);
    let reachPause!: () => void;
    const paused = new Promise<void>((resolve) => {
      reachPause = resolve;
    });

    const handle = startRun('pause then cancel', {
      browser: stubBrowser(),
      onEvent,
      runsBaseDir,
      createStream: factory.createStream,
      // The dialog never answers — only the abort race can settle it.
      requestPermission: () => {
        reachPause();
        return new Promise(() => {});
      },
    });
    await paused;
    handle.cancel();
    const outcome = await handle.done;

    expect(outcome).toEqual({ status: 'cancelled' });
    expect(events.at(-1)?.type).toBe('run_cancelled');
  });

  it('fails closed without a dialog: no pause, and the model routes around it', async () => {
    const { events, onEvent } = collect();
    const factory = scriptedStreamFactory([
      askResponse(),
      scriptedResponse([{ type: 'text', text: 'Proceeding without the user.' }], {
        input: 1000,
        output: 20,
      }),
    ]);

    const handle = startRun('headless ask', {
      browser: stubBrowser(),
      onEvent,
      runsBaseDir,
      createStream: factory.createStream,
    });
    const outcome = await handle.done;

    expect(outcome.status).toBe('completed');
    expect(events.some((event) => event.type === 'permission_request')).toBe(false);
    // Execute never ran (no exec events); the model saw the structured
    // fail-closed error in its next request instead.
    expect(events.some((event) => event.type === 'tool_exec_start')).toBe(false);
    expect(JSON.stringify(factory.calls[1]?.params)).toContain(
      'does not support',
    );
  });
});
