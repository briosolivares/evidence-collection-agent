import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ModelStreamEvent } from '../../src/model/streamAssembly.js';
import { startRun } from '../../src/tui/bridge/runSession.js';
import { scriptedResponse } from './streamFixtures.js';
import { stubBrowser } from './stubBrowser.js';

// The cancellation artifact contract: cancellation is a durable terminal
// outcome, so both the finalized manifest and a `cancelled` metrics projection
// survive even though the public run promise maps it back to cancellation.

let runsBaseDir: string;

beforeEach(() => {
  runsBaseDir = mkdtempSync(join(tmpdir(), 'sherlock-cancel-'));
});

afterEach(() => {
  rmSync(runsBaseDir, { recursive: true, force: true });
});

describe('cancellation artifacts', () => {
  it('a cancelled run keeps a finalized manifest and cancelled metrics', async () => {
    let sawDelta: () => void = () => {};
    const firstDelta = new Promise<void>((resolve) => {
      sawDelta = resolve;
    });

    async function* hangingStream(
      signal: AbortSignal | undefined,
    ): AsyncGenerator<ModelStreamEvent> {
      yield* scriptedResponse([{ type: 'text', text: 'Investigating ' }], {
        input: 1,
        output: 1,
      }).slice(0, 3);
      sawDelta();
      await new Promise((_resolve, reject) => {
        const abort = () =>
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        if (signal === undefined) return;
        if (signal.aborted) abort();
        else signal.addEventListener('abort', abort, { once: true });
      });
    }

    const handle = startRun('a run to interrupt', {
      browser: stubBrowser(),
      onEvent: () => {},
      runsBaseDir,
      createStream: (_params, signal) => hangingStream(signal),
    });
    await firstDelta;
    handle.cancel();
    const outcome = await handle.done;
    expect(outcome).toEqual({ status: 'cancelled' });

    const runDirs = readdirSync(runsBaseDir);
    expect(runDirs).toHaveLength(1);
    const runDir = join(runsBaseDir, runDirs[0]!);

    const manifest = JSON.parse(readFileSync(join(runDir, 'manifest.json'), 'utf8')) as {
      task: string;
      finishedAt?: string;
    };
    expect(manifest.task).toBe('a run to interrupt');
    expect(manifest.finishedAt).toBeDefined();
    expect(existsSync(join(runDir, 'metrics.json'))).toBe(true);
    expect(
      JSON.parse(readFileSync(join(runDir, 'metrics.json'), 'utf8')),
    ).toMatchObject({ status: 'cancelled' });
  });
});
