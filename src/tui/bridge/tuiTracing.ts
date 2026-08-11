// The tracing seam adapter: a RunTracing whose wrapRegistry emits
// tool_exec_start/end UiEvents (validated input, success/error result)
// and captures ctx.runDir mid-run, while DELEGATING every surface to the
// core's real tracing (default createRunTracing()) so Langfuse
// observability is preserved (design: the wrapper composes, never
// replaces).

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { createRunTracing, type RunTracing } from '../../tracing/runTracing.js';
import type { ToolCtx, ToolDef, ToolRegistry } from '../../tools/registry.js';
import type { UiEvent } from '../store/state.js';

/** Dependencies for the TUI tracing adapter. */
export interface TuiTracingDeps {
  /** Receives tool_exec_start/end and the one-shot run_dir event. */
  onEvent: (event: UiEvent) => void;
  /** The composed tracing implementation; defaults to createRunTracing()
   * (Langfuse from the environment, or a clean no-op). */
  delegate?: RunTracing;
}

const EVIDENCE_TOOLS = new Set(['write_file', 'screenshot', 'download']);

/** Best-effort sourceUrl lookup from the run manifest for an artifact the
 * tool just wrote. Tracing must never break a run — failures return
 * undefined. */
function lookupSourceUrl(
  runDir: string,
  input: unknown,
  result: unknown,
): string | undefined {
  try {
    const candidates = new Set<string>();
    for (const [source, key] of [
      [result, 'path'],
      [input, 'file_path'],
      [input, 'filename'],
    ] as const) {
      if (typeof source === 'object' && source !== null) {
        const value = (source as Record<string, unknown>)[key];
        if (typeof value === 'string' && value !== '') candidates.add(value);
      }
    }
    if (candidates.size === 0) return undefined;
    const manifest = JSON.parse(
      readFileSync(join(runDir, 'manifest.json'), 'utf8'),
    ) as { artifacts?: { filename: string; sourceUrl?: string }[] };
    for (const artifact of manifest.artifacts ?? []) {
      if (candidates.has(artifact.filename)) return artifact.sourceUrl;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * Create the TUI's RunTracing: emits UiEvents from every tool execution
 * and forwards all tracing responsibilities to the delegate.
 *
 * Emission contract: `run_dir` once, from the first execution's ctx;
 * `tool_exec_start` with the validated input; `tool_exec_end` with
 * ok/result (plus a manifest-recorded sourceUrl for evidence tools) or
 * ok:false/error before the error is rethrown to the pipeline.
 */
export function createTuiTracing(deps: TuiTracingDeps): RunTracing {
  const delegate = deps.delegate ?? createRunTracing();
  const emit = deps.onEvent;
  let nextExecId = 1;
  let runDirSeen = false;

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
            const sourceUrl = EVIDENCE_TOOLS.has(tool.name)
              ? lookupSourceUrl(ctx.runDir, input, result)
              : undefined;
            emit({
              type: 'tool_exec_end',
              id,
              ok: true,
              result,
              ...(sourceUrl === undefined ? {} : { sourceUrl }),
            });
            return result;
          } catch (error) {
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
