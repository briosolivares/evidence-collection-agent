import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { initManifest, writeArtifact, type ArtifactRole } from '../../src/run/artifacts.js';
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

  describe('artifact_published (manifest diff)', () => {
    // Tools that publish through the real writeArtifact pipeline, the way
    // screenshot/download/write_file (and browser_batch's inner registry)
    // do — the diff keys on the manifest, never on tool names.
    function makePublishingRegistry() {
      const publishInput = z.object({
        file_path: z.string(),
        content: z.string(),
        source_url: z.string().optional(),
        roles: z.array(z.enum(['requested_output', 'evidence'])),
      });
      type PublishInput = {
        file_path: string;
        content: string;
        source_url?: string;
        roles: ArtifactRole[];
      };
      const publish = (input: PublishInput, ctx: ToolCtx) =>
        writeArtifact(ctx.runDir, input.file_path, Buffer.from(input.content), {
          ...(input.source_url === undefined ? {} : { sourceUrl: input.source_url }),
          roles: input.roles,
        });
      return createRegistry([
        {
          name: 'publish',
          description: 'writes one published artifact',
          inputSchema: publishInput,
          readOnly: false,
          execute: async (input: PublishInput, ctx: ToolCtx) => {
            const entry = publish(input, ctx);
            return { path: entry.filename, size: input.content.length };
          },
        },
        {
          name: 'batch',
          description: 'browser_batch shape: several inner writes, one exec',
          inputSchema: z.object({ items: z.array(publishInput) }),
          readOnly: false,
          execute: async (input: { items: PublishInput[] }, ctx: ToolCtx) => {
            for (const item of input.items) publish(item, ctx);
            return { results: input.items.length };
          },
        },
        {
          name: 'offload',
          description: 'capResult shape: a private scratch write, no roles',
          inputSchema: z.object({ file_path: z.string(), content: z.string() }),
          readOnly: false,
          execute: async (
            input: { file_path: string; content: string },
            ctx: ToolCtx,
          ) => {
            writeArtifact(ctx.runDir, input.file_path, Buffer.from(input.content));
            return { path: input.file_path };
          },
        },
        {
          name: 'publish_boom',
          description: 'publishes, then fails',
          inputSchema: z.object({}),
          readOnly: false,
          execute: async (_input: unknown, ctx: ToolCtx) => {
            writeArtifact(ctx.runDir, 'artifacts/partial.png', Buffer.from('png'), {
              roles: ['evidence'],
            });
            throw new Error('batch step 3 failed');
          },
        },
      ]);
    }

    function setup() {
      initManifest(runDir, 'task under test');
      const events: UiEvent[] = [];
      const { delegate } = makeDelegate();
      const tracing = createTuiTracing({ onEvent: (event) => events.push(event), delegate });
      const wrapped = tracing.wrapRegistry(makePublishingRegistry());
      return { events, wrapped };
    }

    it('emits full provenance per publish, before that exec ends', async () => {
      const { events, wrapped } = setup();
      const ctx: ToolCtx = { runDir };
      const publish = wrapped.get('publish')!;
      // The three real publishers' shapes: screenshot and download are
      // evidence with a sourceUrl; write_file is a requested output.
      await publish.execute(
        { file_path: 'artifacts/page.png', content: 'png-bytes', source_url: 'https://sec.gov/filings', roles: ['evidence'] },
        ctx,
      );
      await publish.execute(
        { file_path: 'artifacts/10k.pdf', content: 'pdf-bytes!', source_url: 'https://sec.gov/10k.pdf', roles: ['evidence'] },
        ctx,
      );
      await publish.execute(
        { file_path: 'artifacts/top5.csv', content: 'a,b', roles: ['requested_output'] },
        ctx,
      );

      const published = events.filter((e) => e.type === 'artifact_published');
      expect(published).toHaveLength(3);
      expect(published[0]).toMatchObject({
        entry: {
          filename: 'artifacts/page.png',
          sourceUrl: 'https://sec.gov/filings',
          roles: ['evidence'],
        },
        sizeBytes: 'png-bytes'.length,
      });
      expect(published[0]!.entry.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(published[0]!.entry.capturedAt).not.toBe('');
      expect(published[2]).toMatchObject({
        entry: { filename: 'artifacts/top5.csv', roles: ['requested_output'] },
        sizeBytes: 3,
      });
      expect(published[2]!.entry.sourceUrl).toBeUndefined();

      // Each publish is linked to its exec and lands before that exec's
      // end event; tool_exec_end no longer carries a sourceUrl.
      const starts = events.filter((e) => e.type === 'tool_exec_start');
      const ends = events.filter((e) => e.type === 'tool_exec_end');
      published.forEach((event, i) => {
        expect(event.toolExecId).toBe(starts[i]!.id);
        expect(events.indexOf(event)).toBeLessThan(events.indexOf(ends[i]!));
      });
      for (const end of ends) expect(end).not.toHaveProperty('sourceUrl');
    });

    it('announces inner writes of a single execution (browser_batch shape)', async () => {
      const { events, wrapped } = setup();
      await wrapped.get('batch')!.execute(
        {
          items: [
            { file_path: 'artifacts/shot1.png', content: 'one', source_url: 'https://x.com/a', roles: ['evidence'] },
            { file_path: 'artifacts/shot2.png', content: 'two', source_url: 'https://x.com/b', roles: ['evidence'] },
          ],
        },
        { runDir },
      );
      const published = events.filter((e) => e.type === 'artifact_published');
      const start = events.find((e) => e.type === 'tool_exec_start')!;
      expect(published.map((e) => e.entry.filename)).toEqual([
        'artifacts/shot1.png',
        'artifacts/shot2.png',
      ]);
      expect(published.every((e) => e.toolExecId === start.id)).toBe(true);
    });

    it('never announces scratch entries', async () => {
      const { events, wrapped } = setup();
      await wrapped.get('offload')!.execute(
        { file_path: 'scratch/tool-output/inspect-1.json', content: '{"big":1}' },
        { runDir },
      );
      expect(events.filter((e) => e.type === 'artifact_published')).toEqual([]);
      expect(events.at(-1)).toMatchObject({ type: 'tool_exec_end', ok: true });
    });

    it('re-announces changed bytes to the same filename, not identical ones', async () => {
      const { events, wrapped } = setup();
      const ctx: ToolCtx = { runDir };
      const publish = wrapped.get('publish')!;
      const write = (content: string) =>
        publish.execute(
          { file_path: 'artifacts/top5.csv', content, roles: ['requested_output'] },
          ctx,
        );
      await write('v1');
      await write('v1'); // same bytes → same sha256 → no re-announcement
      await write('v2');

      const published = events.filter((e) => e.type === 'artifact_published');
      expect(published).toHaveLength(2);
      expect(published[0]!.entry.sha256).not.toBe(published[1]!.entry.sha256);
      expect(published.map((e) => e.entry.filename)).toEqual([
        'artifacts/top5.csv',
        'artifacts/top5.csv',
      ]);
    });

    it('surfaces artifacts a failing execution published before it threw', async () => {
      const { events, wrapped } = setup();
      await expect(
        wrapped.get('publish_boom')!.execute({}, { runDir }),
      ).rejects.toThrow('batch step 3 failed');
      const published = events.filter((e) => e.type === 'artifact_published');
      expect(published).toHaveLength(1);
      expect(published[0]!.entry.filename).toBe('artifacts/partial.png');
      expect(events.indexOf(published[0]!)).toBeLessThan(
        events.indexOf(events.find((e) => e.type === 'tool_exec_end')!),
      );
      expect(events.at(-1)).toMatchObject({ type: 'tool_exec_end', ok: false });
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
