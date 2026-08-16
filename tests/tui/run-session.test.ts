import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { BrowserController } from '../../src/browser/controller.js';
import type { CallModel, ModelResponse } from '../../src/loop/messages.js';
import type { ModelStreamEvent } from '../../src/model/streamAssembly.js';
import {
  startRun,
  type RunSessionDeps,
} from '../../src/tui/bridge/runSession.js';
import {
  createInitialState,
  reduce,
  type StoreAction,
} from '../../src/tui/store/reducer.js';
import type { UiEvent } from '../../src/tui/store/state.js';
import { scriptedResponse, scriptedStreamFactory } from './streamFixtures.js';
import { stubBrowser } from './stubBrowser.js';

// Public bridge coverage only: every case drives the real v3 runTask with an
// immutable initializer contract, a scripted worker stream, and an injected
// verifier. No live model, browser, or legacy runtime path is involved.

const TASK = 'Publish a one-row report.csv. Do not take screenshots.';
const REPORT_CONTENT = 'name\nAlice\n';
const ASK_INPUT = {
  question: 'Did you finish logging in?',
  context: 'Use the browser window that is already open.',
  options: [
    { label: 'Yes', description: 'The login is complete.' },
    { label: 'Not yet', description: 'More time is needed.' },
  ],
};

let runsBaseDir: string;

beforeEach(() => {
  runsBaseDir = mkdtempSync(join(tmpdir(), 'sherlock-bridge-'));
});

afterEach(() => {
  rmSync(runsBaseDir, { recursive: true, force: true });
});

const initializerCallModel: CallModel = async () => ({
  content: [
    {
      type: 'tool_use',
      id: 'contract-v3',
      name: 'set_output_contract',
      input: {
        contract: {
          outputs: [
            {
              id: 'report',
              kind: 'table',
              filename: 'report.csv',
              format: 'csv',
              columns: [{ name: 'name', required: true, type: 'string' }],
              rules: [{ type: 'exact_row_count', value: 1 }],
            },
          ],
        },
      },
    },
  ],
  stop_reason: 'tool_use',
  usage: { input_tokens: 100, output_tokens: 20 },
});

const verifierCallModel: CallModel = async () => verifierVerified();

function verifierVerified(): ModelResponse {
  return {
    content: [
      {
        type: 'tool_use',
        id: 'verification-v3',
        name: 'report_verification',
        input: { status: 'verified', findings: [] },
      },
    ],
    stop_reason: 'tool_use',
    usage: { input_tokens: 10, output_tokens: 2 },
  };
}

function publishResponse(prose?: string): ModelStreamEvent[] {
  return scriptedResponse(
    [
      ...(prose === undefined
        ? []
        : [{ type: 'text' as const, text: prose, chunk: 5 }]),
      {
        type: 'tool_use',
        id: 'publish-v3',
        name: 'publish_artifact',
        input: {
          kind: 'text',
          artifact_path: 'artifacts/report.csv',
          roles: ['requested_output'],
          content: REPORT_CONTENT,
        },
      },
    ],
    { input: 1_000, output: 200, cacheRead: 400 },
    'tool_use',
  );
}

function finishResponse(summary = 'Published report.csv.'): ModelStreamEvent[] {
  return scriptedResponse(
    [
      {
        type: 'tool_use',
        id: 'finish-v3',
        name: 'finish',
        input: {
          summary,
          limitations: [],
        },
      },
    ],
    { input: 1_200, output: 100 },
    'tool_use',
  );
}

function askResponse(): ModelStreamEvent[] {
  return scriptedResponse(
    [{ type: 'tool_use', id: 'ask-v3', name: 'ask_user', input: ASK_INPUT }],
    { input: 900, output: 40 },
    'tool_use',
  );
}

type StreamFactory = NonNullable<RunSessionDeps['createStream']>;

interface StartOptions {
  task?: string;
  browser?: BrowserController;
  maxTurns?: number;
  now?: () => number;
  requestPermission?: RunSessionDeps['requestPermission'];
  observeEvent?: (event: UiEvent) => void;
}

function startWithStream(
  createStream: StreamFactory,
  options: StartOptions = {},
) {
  const events: UiEvent[] = [];
  const handle = startRun(options.task ?? TASK, {
    browser: options.browser ?? stubBrowser(),
    runsBaseDir,
    harness: { initializerCallModel, verifierCallModel },
    createStream,
    onEvent: (event) => {
      events.push(event);
      options.observeEvent?.(event);
    },
    ...(options.maxTurns === undefined ? {} : { maxTurns: options.maxTurns }),
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.requestPermission === undefined
      ? {}
      : { requestPermission: options.requestPermission }),
  });
  return { events, handle };
}

function startScripted(
  responses: ModelStreamEvent[][],
  options: StartOptions = {},
) {
  const factory = scriptedStreamFactory(responses);
  return { ...startWithStream(factory.createStream, options), factory };
}

async function waitUntil(
  predicate: () => boolean,
  description: string,
): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error(`timed out waiting for ${description}`);
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}

describe('startRun v3 public bridge', () => {
  it('publishes and finishes with ordered progress, tracing, reducer state, and signals', async () => {
    const { events, factory, handle } = startScripted(
      [publishResponse('Publishing report.'), finishResponse()],
      { now: () => 42 },
    );

    const outcome = await handle.done;

    expect(outcome).toMatchObject({
      status: 'verified',
      finalText: 'Published report.csv.',
    });
    if (outcome.status !== 'verified') throw new Error('unreachable');
    expect(readFileSync(join(outcome.runDir, 'artifacts/report.csv'), 'utf8')).toBe(
      REPORT_CONTENT,
    );

    expect(events[0]).toMatchObject({ type: 'run_started', at: 42 });
    expect(events.find((event) => event.type === 'run_dir')).toMatchObject({
      runDir: outcome.runDir,
    });
    expect(
      events.filter((event) => event.type === 'turn_start').map((event) => event.turn),
    ).toEqual([1, 2]);
    expect(
      events.filter((event) => event.type === 'text_delta').map((event) => event.text).join(''),
    ).toBe('Publishing report.');
    expect(
      events.filter((event) => event.type === 'tool_pending').map((event) => event.name),
    ).toEqual(['publish_artifact', 'finish']);

    const turnEnds = events.filter((event) => event.type === 'turn_end');
    expect(turnEnds).toHaveLength(2);
    expect(turnEnds[0]).toMatchObject({
      usage: { input: 1_000, output: 200, cacheRead: 400 },
    });
    const publishPending = events.findIndex(
      (event) => event.type === 'tool_pending' && event.name === 'publish_artifact',
    );
    const publishExec = events.findIndex(
      (event) => event.type === 'tool_exec_start' && event.name === 'publish_artifact',
    );
    const published = events.findIndex((event) => event.type === 'artifact_published');
    const publishEnd = events.findIndex(
      (event, index) => event.type === 'tool_exec_end' && index > publishExec,
    );
    expect(publishPending).toBeLessThan(events.indexOf(turnEnds[0]!));
    expect(events.indexOf(turnEnds[0]!)).toBeLessThan(publishExec);
    expect(publishExec).toBeLessThan(published);
    expect(published).toBeLessThan(publishEnd);
    expect(events.at(-1)).toMatchObject({
      type: 'run_finished',
      outcome: 'verified',
      at: 42,
    });

    expect(factory.calls).toHaveLength(2);
    for (const call of factory.calls) {
      expect(call.signal).toBeInstanceOf(AbortSignal);
      expect(call.signal?.aborted).toBe(false);
    }

    const state = events.reduce(
      (current, event) => reduce(current, event as StoreAction),
      createInitialState(),
    );
    expect(state.transcript.at(-2)).toMatchObject({
      kind: 'activity',
      line: 'Submitting for verification',
      status: 'ok',
    });
    expect(state.transcript.at(-1)).toMatchObject({ kind: 'completion' });
  });

  it('maps a worker-turn budget stop to incomplete', async () => {
    const response = scriptedResponse(
      [
        {
          type: 'tool_use',
          id: 'write-v3',
          name: 'write_file',
          input: { file_path: 'scratch/note.txt', content: 'still working' },
        },
      ],
      { input: 500, output: 50 },
      'tool_use',
    );
    const { events, handle } = startScripted([response], { maxTurns: 1 });

    const outcome = await handle.done;

    expect(outcome).toMatchObject({
      status: 'incomplete',
      reason: 'budget_exceeded',
    });
    expect(events.at(-1)).toMatchObject({
      type: 'run_finished',
      outcome: 'incomplete',
      reason: 'budget_exceeded',
    });
  });

  it('maps a worker model failure to truthful incomplete', async () => {
    const { events, handle } = startWithStream(() => {
      throw new Error('api unreachable');
    });

    const outcome = await handle.done;

    expect(outcome).toMatchObject({
      status: 'incomplete',
      reason: 'worker_incomplete',
      detail: expect.stringContaining('api unreachable'),
    });
    expect(events.at(-1)).toMatchObject({
      type: 'run_finished',
      outcome: 'incomplete',
      reason: 'worker_incomplete',
      detail: expect.stringContaining('api unreachable'),
    });
  });

  it('cancels an in-flight worker stream without emitting run_failed', async () => {
    let sawDelta!: () => void;
    const firstDelta = new Promise<void>((resolve) => {
      sawDelta = resolve;
    });

    async function* hangingStream(
      signal: AbortSignal | undefined,
    ): AsyncGenerator<ModelStreamEvent> {
      yield* scriptedResponse(
        [{ type: 'text', text: 'Working on it.' }],
        { input: 1, output: 1 },
      ).slice(0, 3);
      sawDelta();
      await new Promise((_resolve, reject) => {
        const abort = () =>
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        if (signal?.aborted === true) abort();
        else signal?.addEventListener('abort', abort, { once: true });
      });
    }

    const { events, handle } = startWithStream((_params, signal) =>
      hangingStream(signal),
    );
    await firstDelta;
    handle.cancel();

    await expect(handle.done).resolves.toEqual({ status: 'cancelled' });
    expect(events.at(-1)?.type).toBe('run_cancelled');
    expect(events.some((event) => event.type === 'run_failed')).toBe(false);
  });

  it(
    'forwards cancellation into a running v3 bash command',
    async () => {
      const response = scriptedResponse(
        [
          {
            type: 'tool_use',
            id: 'bash-v3',
            name: 'bash',
            input: {
              command: 'touch bridge-started && sleep 30',
              timeout_ms: 60_000,
            },
          },
        ],
        { input: 100, output: 20 },
        'tool_use',
      );
      let runDir: string | undefined;
      const { events, handle } = startScripted([response], {
        observeEvent: (event) => {
          if (event.type === 'run_dir') runDir = event.runDir;
        },
      });

      await waitUntil(
        () =>
          runDir !== undefined &&
          existsSync(join(runDir, 'scratch/workspace/bridge-started')),
        'the bash child to start',
      );
      handle.cancel();

      await expect(handle.done).resolves.toEqual({ status: 'cancelled' });
      expect(events.some((event) => event.type === 'run_failed')).toBe(false);
      expect(
        events.find(
          (event) => event.type === 'tool_exec_start' && event.name === 'bash',
        ),
      ).toBeDefined();
    },
    10_000,
  );
});

describe('startRun v3 ask_user channel', () => {
  it('announces, answers, executes, and returns the answer to the worker', async () => {
    const seen: unknown[] = [];
    const { events, factory, handle } = startScripted(
      [publishResponse(), askResponse(), finishResponse('Resumed after login.')],
      {
        requestPermission: async (request) => {
          seen.push(request);
          return {
            behavior: 'allow',
            updatedInput: {
              ...(request.input as object),
              answers: { chosen: ['Yes'] },
            },
          };
        },
      },
    );

    await expect(handle.done).resolves.toMatchObject({ status: 'verified' });
    expect(seen).toEqual([{ toolName: 'ask_user', input: ASK_INPUT }]);
    expect(events.find((event) => event.type === 'permission_request')).toMatchObject({
      toolName: 'ask_user',
      input: ASK_INPUT,
    });
    const askStart = events.find(
      (event): event is Extract<UiEvent, { type: 'tool_exec_start' }> =>
        event.type === 'tool_exec_start' && event.name === 'ask_user',
    );
    expect(askStart).toBeDefined();
    if (askStart === undefined) throw new Error('ask_user did not execute');
    expect(
      events.find(
        (event) => event.type === 'tool_exec_end' && event.id === askStart.id,
      ),
    ).toMatchObject({ ok: true, result: 'User chose: "Yes".' });
    expect(JSON.stringify(factory.calls[2]?.params)).toContain('User chose: \\"Yes\\".');
  });

  it('cancels while the question is waiting for an answer', async () => {
    let reachedPause!: () => void;
    const paused = new Promise<void>((resolve) => {
      reachedPause = resolve;
    });
    const { events, handle } = startScripted([askResponse()], {
      requestPermission: () => {
        reachedPause();
        return new Promise(() => {});
      },
    });

    await paused;
    handle.cancel();

    await expect(handle.done).resolves.toEqual({ status: 'cancelled' });
    expect(events.at(-1)?.type).toBe('run_cancelled');
  });

  it('fails closed without a dialog and lets the worker finish honestly', async () => {
    const { events, factory, handle } = startScripted([
      publishResponse(),
      askResponse(),
      finishResponse('Finished without a human answer.'),
    ]);

    await expect(handle.done).resolves.toMatchObject({ status: 'verified' });
    expect(events.some((event) => event.type === 'permission_request')).toBe(false);
    expect(
      events.some(
        (event) => event.type === 'tool_exec_start' && event.name === 'ask_user',
      ),
    ).toBe(false);
    expect(JSON.stringify(factory.calls[2]?.params)).toContain(
      'environment does not support',
    );
  });
});
