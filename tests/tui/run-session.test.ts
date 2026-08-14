import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { CallModel, ModelResponse } from '../../src/loop/messages.js';
import type { ModelStreamEvent } from '../../src/model/streamAssembly.js';
import { startRun } from '../../src/tui/bridge/runSession.js';
import type { UiEvent } from '../../src/tui/store/state.js';
import { scriptedResponse, scriptedStreamFactory } from './streamFixtures.js';
import { stubBrowser } from './stubBrowser.js';

// These tests drive the REAL runTask (run directories, manifest, loop,
// tool pipeline) against a stub browser and fully scripted SDK streams —
// no live API, no Chrome. Every run goes through the initializer → worker
// → verifier harness now, so every test forces `contractAuthor: 'worker'`
// (the worker states its own contract, or none — see the minimal
// `{ outputs: [] }` contract below — skipping a live initializer network
// call) and, whenever a run is expected to reach verification, scripts
// `verifierCallModel` to report `verified` immediately.

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

/** A verifier response reporting `verified` (no findings) — the only
 * tool call the fake verifier's single scripted turn ever makes. */
function verifierVerified(): ModelResponse {
  return {
    content: [
      {
        type: 'tool_use',
        id: 'v1',
        name: 'report_verification',
        input: { status: 'verified', findings: [] },
      },
    ],
    stop_reason: 'tool_use',
    usage: { input_tokens: 10, output_tokens: 2 },
  };
}
const verifierCallModel: CallModel = async () => verifierVerified();

/** A minimal, always-valid output contract — one declared output, since the
 * schema requires at least one (`outputContractSchema.outputs.min(1)`) — for
 * tests whose point is the tool pipeline or progress events, not contract
 * validation. Required before any tool but `set_output_contract` may run
 * (the contract-first gate). */
const contractResponse = () =>
  scriptedResponse(
    [
      {
        type: 'tool_use',
        id: 'tu_contract',
        name: 'set_output_contract',
        input: {
          contract: {
            outputs: [{ id: 'notes', kind: 'screenshots', count: { minimum: 1 } }],
          },
        },
      },
    ],
    { input: 100, output: 20 },
    'tool_use',
  );

const submitResponse = (summary = 'Done.') =>
  scriptedResponse(
    [{ type: 'tool_use', id: 'tu_submit', name: 'submit_for_verification', input: { summary } }],
    { input: 1500, output: 40 },
    'tool_use',
  );

describe('startRun (RunSession bridge)', () => {
  it('re-emits all four progress events in order for a text-only run', async () => {
    const { events, onEvent } = collect();
    const factory = scriptedStreamFactory([
      scriptedResponse(
        [
          { type: 'text', text: 'Answer ready.' },
          {
            type: 'tool_use',
            id: 'tu_submit',
            name: 'submit_for_verification',
            input: { summary: 'Answer ready.' },
          },
        ],
        { input: 1200, output: 180 },
        'tool_use',
      ),
    ]);

    const handle = startRun('simple question', {
      browser: stubBrowser(),
      onEvent,
      runsBaseDir,
      harness: { contractAuthor: 'worker', verifierCallModel },
      createStream: factory.createStream,
      now: () => 42,
    });
    const outcome = await handle.done;

    expect(outcome.status).toBe('verified');
    if (outcome.status !== 'verified') throw new Error('unreachable');
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
      outcome: 'verified',
      finalText: 'Answer ready.',
      runDir: outcome.runDir,
      at: 42,
    });
  });

  it('orders turns and tool_pending faithfully across a multi-turn tool run', async () => {
    const { events, onEvent } = collect();
    const factory = scriptedStreamFactory([
      contractResponse(),
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
      scriptedResponse(
        [{ type: 'tool_use', id: 'tu_submit', name: 'submit_for_verification', input: { summary: 'Done.' } }],
        { input: 2400, output: 60, cacheRead: 900 },
        'tool_use',
      ),
    ]);

    const browser = stubBrowser();
    const handle = startRun('save my notes', {
      browser,
      onEvent,
      runsBaseDir,
      harness: { contractAuthor: 'worker', verifierCallModel },
      createStream: factory.createStream,
    });
    const outcome = await handle.done;
    expect(outcome.status).toBe('verified');
    if (outcome.status !== 'verified') throw new Error('unreachable');

    const types = events.map((event) => event.type);
    expect(types[0]).toBe('run_started');
    expect(types.at(-1)).toBe('run_finished');

    // write_file's tool_pending arrives after the contract turn settles and
    // before the write_file batch's own turn_end.
    const writePendingIndex = events.findIndex(
      (event) => event.type === 'tool_pending' && event.name === 'write_file',
    );
    const turnEnds = events.filter((event) => event.type === 'turn_end');
    expect(turnEnds).toHaveLength(3);
    const secondTurnEndIndex = events.indexOf(turnEnds[1]!);
    expect(writePendingIndex).toBeGreaterThan(-1);
    expect(writePendingIndex).toBeLessThan(secondTurnEndIndex);

    // write_file executed through the real pipeline: exec start, an
    // artifact_published receipt, then exec end — in that order, and
    // before the final submission turn starts.
    const execStart = events.findIndex(
      (event) => event.type === 'tool_exec_start' && event.name === 'write_file',
    );
    const published = events.findIndex((event) => event.type === 'artifact_published');
    const execEnd = events.findIndex(
      (event, index) => event.type === 'tool_exec_end' && index > execStart,
    );
    expect(execStart).toBeGreaterThan(-1);
    expect(execStart).toBeLessThan(published);
    expect(published).toBeLessThan(execEnd);

    const runDirEvent = events.find((event) => event.type === 'run_dir');
    expect(runDirEvent).toMatchObject({ runDir: outcome.runDir });

    // Usage totals are faithful per turn, including cache reads.
    expect(turnEnds[1]).toMatchObject({ usage: { input: 1000, output: 200 } });
    expect(turnEnds[2]).toMatchObject({ usage: { input: 2400, output: 60, cacheRead: 900 } });

    // The real pipeline ran: the artifact and manifest exist on disk.
    expect(readFileSync(join(outcome.runDir, 'artifacts/notes.md'), 'utf8')).toBe('hello evidence');
    const manifest = JSON.parse(
      readFileSync(join(outcome.runDir, 'manifest.json'), 'utf8'),
    ) as { artifacts: { filename: string }[]; finishedAt?: string };
    expect(manifest.artifacts.map((artifact) => artifact.filename)).toContain('artifacts/notes.md');
    expect(manifest.finishedAt).toBeDefined();
    expect(existsSync(join(outcome.runDir, 'metrics.json'))).toBe(true);
  });

  it('offers the real worker tool surface and executes browser_action for real', async () => {
    const { events, onEvent } = collect();
    const factory = scriptedStreamFactory([
      contractResponse(),
      scriptedResponse(
        [
          {
            type: 'tool_use',
            id: 'tu_action',
            name: 'browser_action',
            input: { actions: [{ op: 'navigate', url: 'https://example.test/' }] },
          },
        ],
        { input: 1000, output: 200 },
        'tool_use',
      ),
      // The contract's one declared output is a screenshot (min. 1); a real
      // capture here is what lets the completion check pass and the run
      // reach the verifier at all — its own turn, since a batch mixing a
      // browser_action with a screenshot call is a distinct scheduling case
      // this test isn't about.
      scriptedResponse(
        [{ type: 'tool_use', id: 'tu_shot', name: 'screenshot', input: { filename: 'artifacts/page.png' } }],
        { input: 300, output: 40 },
        'tool_use',
      ),
      submitResponse(),
    ]);

    const handle = startRun('use the browser', {
      browser: stubBrowser(),
      onEvent,
      runsBaseDir,
      harness: { contractAuthor: 'worker', verifierCallModel },
      createStream: factory.createStream,
    });
    await expect(handle.done).resolves.toMatchObject({ status: 'verified' });

    // runSession.ts now drives every run through runTask's own real
    // toolchain (see its module header) rather than a locally-built
    // approximation — browser_action and bash must both be on the wire so
    // the model can call them.
    const firstParams = factory.calls[0]?.params as {
      tools?: Array<{ name: string }>;
    };
    const toolNames = firstParams.tools?.map((tool) => tool.name) ?? [];
    expect(toolNames).toContain('browser_action');
    expect(toolNames).toContain('bash');

    const actionStart = events.findIndex(
      (event) => event.type === 'tool_exec_start' && event.name === 'browser_action',
    );
    expect(actionStart).toBeGreaterThan(-1);
    const actionEnd = events.find(
      (event, index) => event.type === 'tool_exec_end' && index > actionStart,
    );
    expect(actionEnd).toMatchObject({ ok: true });
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
      harness: { contractAuthor: 'worker' },
      createStream: factory.createStream,
      maxTurns: 1,
    });
    const outcome = await handle.done;

    expect(outcome.status).toBe('incomplete');
    if (outcome.status !== 'incomplete') throw new Error('unreachable');
    expect(outcome.reason).toBe('budget_exceeded');
    expect(events.at(-1)).toMatchObject({
      type: 'run_finished',
      outcome: 'incomplete',
      reason: 'budget_exceeded',
    });
  });

  it('maps a non-abort failure to run_failed', async () => {
    const { events, onEvent } = collect();
    const handle = startRun('doomed', {
      browser: stubBrowser(),
      onEvent,
      runsBaseDir,
      harness: { contractAuthor: 'worker' },
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
      harness: { contractAuthor: 'worker' },
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
    let releaseAction: () => void = () => {};
    const actionBlocked = new Promise<void>((resolve) => {
      releaseAction = resolve;
    });
    let actionStarted: () => void = () => {};
    const actionStartedPromise = new Promise<void>((resolve) => {
      actionStarted = resolve;
    });
    let actionFinished = false;

    const browser = stubBrowser();
    const defaultBrowserAction = browser.browserAction.bind(browser);
    browser.browserAction = (async (request: Parameters<typeof browser.browserAction>[0]) => {
      actionStarted();
      await actionBlocked;
      actionFinished = true;
      return defaultBrowserAction(request);
    }) as typeof browser.browserAction;

    const factory = scriptedStreamFactory([
      contractResponse(),
      scriptedResponse(
        [
          {
            type: 'tool_use',
            id: 'tu_1',
            name: 'browser_action',
            input: { actions: [{ op: 'navigate', url: 'https://example.com/slow' }] },
          },
        ],
        { input: 100, output: 20 },
        'tool_use',
      ),
      // A third scripted response exists but must never be requested: the
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
      harness: { contractAuthor: 'worker' },
      createStream: factory.createStream,
    });

    await actionStartedPromise;
    handle.cancel(); // mid-batch: the model call already returned
    expect(actionFinished).toBe(false);
    releaseAction();
    const outcome = await handle.done;

    expect(actionFinished).toBe(true); // the batch settled first
    expect(outcome).toEqual({ status: 'cancelled' });
    expect(events.at(-1)?.type).toBe('run_cancelled');
    expect(factory.calls).toHaveLength(2); // contract, then the browser_action call — no third
  });

  it('passes the abort signal to every stream request', async () => {
    const { onEvent } = collect();
    const factory = scriptedStreamFactory([submitResponse('ok')]);
    const handle = startRun('check signal', {
      browser: stubBrowser(),
      onEvent,
      runsBaseDir,
      harness: { contractAuthor: 'worker', verifierCallModel },
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

  // The contract's one declared output is a screenshot (min. 1); any test
  // whose run reaches submission needs a real capture first, or the
  // completion check rejects the submission and demands a correction the
  // scripted factory has no response for.
  function screenshotResponse() {
    return scriptedResponse(
      [{ type: 'tool_use', id: 'tu_shot', name: 'screenshot', input: { filename: 'artifacts/page.png' } }],
      { input: 300, output: 40 },
      'tool_use',
    );
  }

  it('announces the pause, then resumes the run with the dialog answers', async () => {
    const { events, onEvent } = collect();
    const factory = scriptedStreamFactory([
      contractResponse(),
      screenshotResponse(),
      askResponse(),
      submitResponse('Resuming.'),
    ]);
    const seen: unknown[] = [];

    const handle = startRun('needs a human', {
      browser: stubBrowser(),
      onEvent,
      runsBaseDir,
      harness: { contractAuthor: 'worker', verifierCallModel },
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

    expect(outcome.status).toBe('verified');
    expect(seen).toEqual([{ toolName: 'ask_user_question', input: askInput }]);
    expect(
      events.find((event) => event.type === 'permission_request'),
    ).toMatchObject({ toolName: 'ask_user_question', input: askInput });
    // The tool executed with the merged answers and echoed them as prose —
    // the round-trip reached the model as an ordinary tool result.
    const askExecStart = events.find(
      (event) => event.type === 'tool_exec_start' && event.name === 'ask_user_question',
    ) as { id?: number } | undefined;
    expect(
      events.find(
        (event) => event.type === 'tool_exec_end' && event.id === askExecStart?.id,
      ),
    ).toMatchObject({
      ok: true,
      result: 'User answered: "yes, all done"',
    });
  });

  it('cancel during a pause denies the question and ends run_cancelled', async () => {
    const { events, onEvent } = collect();
    const factory = scriptedStreamFactory([contractResponse(), askResponse()]);
    let reachPause!: () => void;
    const paused = new Promise<void>((resolve) => {
      reachPause = resolve;
    });

    const handle = startRun('pause then cancel', {
      browser: stubBrowser(),
      onEvent,
      runsBaseDir,
      harness: { contractAuthor: 'worker' },
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
      contractResponse(),
      screenshotResponse(),
      askResponse(),
      submitResponse('Proceeding without the user.'),
    ]);

    const handle = startRun('headless ask', {
      browser: stubBrowser(),
      onEvent,
      runsBaseDir,
      harness: { contractAuthor: 'worker', verifierCallModel },
      createStream: factory.createStream,
    });
    const outcome = await handle.done;

    expect(outcome.status).toBe('verified');
    expect(events.some((event) => event.type === 'permission_request')).toBe(false);
    // ask_user_question never ran (the contract call is the only exec); the
    // model saw the structured fail-closed error in its next request instead.
    expect(
      events.some(
        (event) => event.type === 'tool_exec_start' && event.name === 'ask_user_question',
      ),
    ).toBe(false);
    expect(JSON.stringify(factory.calls[3]?.params)).toContain(
      'does not support',
    );
  });
});
