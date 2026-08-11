import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createTuiTracing } from '../../src/tui/bridge/tuiTracing.js';
import type { RunTracing } from '../../src/tracing/runTracing.js';
import { createRegistry, type ToolCtx } from '../../src/tools/registry.js';
import type { UiEvent } from '../../src/tui/store/state.js';
import { z } from 'zod';

let runDir: string;

beforeEach(() => {
  runDir = mkdtempSync(join(tmpdir(), 'sherlock-tracing-'));
});

afterEach(() => {
  rmSync(runDir, { recursive: true, force: true });
});

function makeDelegate() {
  const executedThroughDelegate: string[] = [];
  const delegate: RunTracing = {
    wrapCallModel: vi.fn((callModel) => callModel),
    wrapRegistry: vi.fn((registry) => {
      // Wrap each tool so delegate-level execution is observable.
      const wrapped = new Map();
      for (const [name, tool] of registry) {
        wrapped.set(name, {
          ...tool,
          execute: async (input: unknown, ctx: ToolCtx) => {
            executedThroughDelegate.push(tool.name);
            return tool.execute(input, ctx);
          },
        });
      }
      return wrapped;
    }),
    traceRun: vi.fn((_task, operation) => operation()),
    flush: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
  };
  return { delegate, executedThroughDelegate };
}

function makeRegistry() {
  return createRegistry([
    {
      name: 'echo',
      description: 'echoes',
      inputSchema: z.object({ value: z.string() }),
      readOnly: true,
      execute: async (input: { value: string }) => `echo:${input.value}`,
    },
    {
      name: 'boom',
      description: 'always fails',
      inputSchema: z.object({}),
      readOnly: true,
      execute: async () => {
        throw new Error('kaboom');
      },
    },
    {
      name: 'write_file',
      description: 'fake evidence writer',
      inputSchema: z.object({ file_path: z.string() }),
      readOnly: false,
      execute: async (input: { file_path: string }) => ({ path: input.file_path, size: 3 }),
    },
  ]);
}

describe('createTuiTracing', () => {
  it('emits validated input and success results, capturing runDir once', async () => {
    const events: UiEvent[] = [];
    const { delegate, executedThroughDelegate } = makeDelegate();
    const tracing = createTuiTracing({ onEvent: (event) => events.push(event), delegate });

    const wrapped = tracing.wrapRegistry(makeRegistry());
    const ctx: ToolCtx = { runDir };
    const echo = wrapped.get('echo')!;
    await echo.execute({ value: 'one' }, ctx);
    await echo.execute({ value: 'two' }, ctx);

    // runDir captured exactly once, from the first execution.
    const runDirEvents = events.filter((event) => event.type === 'run_dir');
    expect(runDirEvents).toEqual([{ type: 'run_dir', runDir }]);
    expect(events[0]).toEqual({ type: 'run_dir', runDir });

    const starts = events.filter((event) => event.type === 'tool_exec_start');
    const ends = events.filter((event) => event.type === 'tool_exec_end');
    expect(starts).toHaveLength(2);
    expect(starts[0]).toMatchObject({ name: 'echo', input: { value: 'one' } });
    expect(ends[0]).toMatchObject({ id: starts[0]!.id, ok: true, result: 'echo:one' });
    expect(starts[1]!.id).not.toBe(starts[0]!.id);

    // Execution flowed through the delegate's wrapped registry.
    expect(delegate.wrapRegistry).toHaveBeenCalledTimes(1);
    expect(executedThroughDelegate).toEqual(['echo', 'echo']);
  });

  it('marks errors and rethrows them to the pipeline', async () => {
    const events: UiEvent[] = [];
    const { delegate } = makeDelegate();
    const tracing = createTuiTracing({ onEvent: (event) => events.push(event), delegate });
    const wrapped = tracing.wrapRegistry(makeRegistry());

    await expect(
      wrapped.get('boom')!.execute({}, { runDir }),
    ).rejects.toThrow('kaboom');
    expect(events.at(-1)).toMatchObject({
      type: 'tool_exec_end',
      ok: false,
      error: 'kaboom',
    });
  });

  it('attaches the manifest sourceUrl to evidence tool results', async () => {
    writeFileSync(
      join(runDir, 'manifest.json'),
      JSON.stringify({
        task: 't',
        startedAt: 'now',
        artifacts: [
          {
            filename: 'top5.csv',
            sha256: 'abc',
            sourceUrl: 'https://news.ycombinator.com/',
            capturedAt: 'now',
          },
        ],
      }),
    );
    const events: UiEvent[] = [];
    const { delegate } = makeDelegate();
    const tracing = createTuiTracing({ onEvent: (event) => events.push(event), delegate });
    const wrapped = tracing.wrapRegistry(makeRegistry());

    await wrapped.get('write_file')!.execute({ file_path: 'top5.csv' }, { runDir });
    expect(events.at(-1)).toMatchObject({
      type: 'tool_exec_end',
      ok: true,
      sourceUrl: 'https://news.ycombinator.com/',
    });
  });

  it('delegates every other tracing surface', async () => {
    const { delegate } = makeDelegate();
    const tracing = createTuiTracing({ onEvent: () => {}, delegate });

    const callModel = async () => ({ content: [], stop_reason: null, usage: { input_tokens: 0, output_tokens: 0 } });
    tracing.wrapCallModel(callModel, 'model-x');
    expect(delegate.wrapCallModel).toHaveBeenCalledWith(callModel, 'model-x');

    await tracing.traceRun('task', async () => 'result');
    expect(delegate.traceRun).toHaveBeenCalledTimes(1);

    await tracing.flush();
    await tracing.close();
    expect(delegate.flush).toHaveBeenCalledTimes(1);
    expect(delegate.close).toHaveBeenCalledTimes(1);
  });
});
