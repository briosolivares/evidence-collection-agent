import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ModelStreamEvent } from '../../src/model/streamAssembly.js';
import { startRun } from '../../src/tui/bridge/runSession.js';
import { scriptedResponse } from './streamFixtures.js';
import { stubBrowser } from './stubBrowser.js';

// The design's cancellation artifact contract: the core's `finally` still
// finalizes the manifest on the abort path, while metrics.json is written
// only on the loop's normal return — so a cancelled run has
// manifest.finishedAt but NO metrics.json (that is "stopped", not
// "crashed", for the /runs browser).

let runsBaseDir: string;

beforeEach(() => {
  runsBaseDir = mkdtempSync(join(tmpdir(), 'sherlock-cancel-'));
});

afterEach(() => {
  rmSync(runsBaseDir, { recursive: true, force: true });
});

describe('cancellation artifacts', () => {
  it('a cancelled run keeps a finalized manifest and omits metrics.json', async () => {
    let sawDelta: () => void = () => {};
    const firstDelta = new Promise<void>((resolve) => {
      sawDelta = resolve;
    });

    async function* hangingStream(signal: AbortSignal): AsyncGenerator<ModelStreamEvent> {
      yield* scriptedResponse([{ type: 'text', text: 'Investigating ' }], {
        input: 1,
        output: 1,
      }).slice(0, 3);
      sawDelta();
      await new Promise((_resolve, reject) => {
        const abort = () =>
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
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
    expect(existsSync(join(runDir, 'metrics.json'))).toBe(false);
  });
});
