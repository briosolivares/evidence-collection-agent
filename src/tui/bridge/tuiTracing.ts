// The tracing seam adapter: a RunTracing whose wrapRegistry emits
// tool_exec_start/end UiEvents (validated input, success/error result),
// captures ctx.runDir mid-run, and announces published artifacts by
// diffing manifest.json after each execution — while DELEGATING every
// surface to the core's real tracing (default createRunTracing()) so
// Langfuse observability is preserved (design: the wrapper composes,
// never replaces).

import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import type { Manifest } from '../../run/artifacts.js';
import { createRunTracing, type RunTracing } from '../../tracing/runTracing.js';
import type { ToolCtx, ToolDef, ToolRegistry } from '../../tools/registry.js';
import type { UiEvent } from '../store/state.js';

/** Dependencies for the TUI tracing adapter. */
export interface TuiTracingDeps {
  /** Receives tool_exec_start/end, artifact_published, and the one-shot
   * run_dir event. */
  onEvent: (event: UiEvent) => void;
  /** The composed tracing implementation; defaults to createRunTracing()
   * (Langfuse from the environment, or a clean no-op). */
  delegate?: RunTracing;
}

/**
 * Create the TUI's RunTracing: emits UiEvents from every tool execution
 * and forwards all tracing responsibilities to the delegate.
 *
 * Emission contract: `run_dir` once, from the first execution's ctx;
 * `tool_exec_start` with the validated input; one `artifact_published`
 * per new-or-changed published manifest entry, before that execution's
 * `tool_exec_end`; `tool_exec_end` with ok/result or ok:false/error
 * before the error is rethrown to the pipeline.
 */
export function createTuiTracing(deps: TuiTracingDeps): RunTracing {
  const delegate = deps.delegate ?? createRunTracing();
  const emit = deps.onEvent;
  let nextExecId = 1;
  let runDirSeen = false;

  /** filename → sha256 of every published entry already announced. */
  const announced = new Map<string, string>();

  /** Diff the manifest's published entries (roles presence is the
   * published marker — scratch entries carry none) against what has been
   * announced, emitting artifact_published for each new or changed one.
   * The manifest is the metadata channel: reading it catches writes the
   * tool boundary hides (browser_batch's inner registry) and is exactly
   * what graders do. Tracing must never break a run — failures emit
   * nothing. */
  const emitPublishedDiff = (runDir: string, toolExecId: number): void => {
    try {
      const manifest = JSON.parse(
        readFileSync(join(runDir, 'manifest.json'), 'utf8'),
      ) as Manifest;
      for (const entry of manifest.artifacts ?? []) {
        if (entry.roles === undefined) continue;
        if (announced.get(entry.filename) === entry.sha256) continue;
        announced.set(entry.filename, entry.sha256);
        let sizeBytes: number | undefined;
        try {
          sizeBytes = statSync(join(runDir, entry.filename)).size;
        } catch {
          sizeBytes = undefined;
        }
        emit({ type: 'artifact_published', entry, sizeBytes, toolExecId });
      }
    } catch {
      // Best-effort: a missing or malformed manifest publishes nothing.
    }
  };

  const wrapRegistry = (registry: ToolRegistry): ToolRegistry => {
    // Delegate first, so our wrapper is outermost: the UiEvents cover the
    // same execution the delegate's observation records.
    const delegated = delegate.wrapRegistry(registry);
    const wrapped = new Map<string, ToolDef>();
    for (const [name, tool] of delegated) {
      wrapped.set(name, {
        ...tool,
        execute: async (input: unknown, ctx: ToolCtx) => {
          if (!runDirSeen) {
            runDirSeen = true;
            emit({ type: 'run_dir', runDir: ctx.runDir });
          }
          const id = nextExecId;
          nextExecId += 1;
          emit({ type: 'tool_exec_start', id, name: tool.name, input });
          try {
            const result = await tool.execute(input, ctx);
            emitPublishedDiff(ctx.runDir, id);
            emit({ type: 'tool_exec_end', id, ok: true, result });
            return result;
          } catch (error) {
            // A failing tool (e.g. a partially-successful batch) may still
            // have published artifacts — surface them before the error.
            emitPublishedDiff(ctx.runDir, id);
            emit({
              type: 'tool_exec_end',
              id,
              ok: false,
              error: error instanceof Error ? error.message : String(error),
            });
            throw error;
          }
        },
      });
    }
    return wrapped;
  };

  return {
    wrapCallModel: (callModel, model) => delegate.wrapCallModel(callModel, model),
    wrapRegistry,
    traceRun: (taskText, operation) => delegate.traceRun(taskText, operation),
    flush: () => delegate.flush(),
    close: () => delegate.close(),
  };
}
