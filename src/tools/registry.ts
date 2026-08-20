import { z } from 'zod';

import type { BrowserController } from '../browser/controller.js';

/** A tool call awaiting the user's decision. */
export interface PermissionRequest {
  toolName: string;
  /** The validated tool input (safe: validated before the gate). */
  input: unknown;
}

/**
 * The user's answer to a permission request. `updatedInput` is trusted and
 * NOT re-validated: it comes from our own UI code, never the model, and the
 * allow path deliberately merges answer fields the model-facing schema must
 * not declare (the Claude Code pattern this seam follows).
 */
export type PermissionDecision =
  | { behavior: 'allow'; updatedInput: unknown }
  | { behavior: 'deny'; feedback: string };

/**
 * Context handed to every tool executor: the per-run resources a tool may
 * need. Later tasks grow this interface in place (e.g. a browser controller
 * field), so tools gain capabilities without any signature churn.
 */
export interface ToolCtx {
  /** Absolute path to the current run's directory. All of a tool's file
   * I/O must stay inside it. */
  runDir: string;
  /** Browser session for tools that observe or act on a page. File-only
   * tool registries may omit it. */
  browser?: BrowserController;
  /** Interactive environments resolve tool permission requests here (the
   * TUI dialog). Headless environments omit it; tools that require user
   * interaction then fail closed. */
  requestPermission?: (request: PermissionRequest) => Promise<PermissionDecision>;
  /** Cancellation for tools that own long-running external resources and can
   * stop before their work naturally ends. */
  abortSignal?: AbortSignal;
  /** This run's ledger of abandoned timed-out effects — see
   * `BusyResourceRegistry`. Always present for a
   * run built by the lifecycle; absent only in tests that build a bare
   * `ToolCtx` by hand, in which case the pipeline skips the gate. */
  busyRegistry?: BusyResourceRegistry;
}

/**
 * The run's ledger of abandoned timed-out effects that might still be
 * mutating state. Sequential worker execution makes per-resource access
 * declarations unnecessary: while any abandoned effect remains live, every
 * later tool call waits or fails closed.
 *
 * `withToolDeadline` cannot cancel a wedged tool call, so giving up on
 * waiting does not mean the real work stopped. Without this registry, the
 * sequential worker could start its next call while abandoned work is still
 * in flight. The global gate waits for confirmation or fails closed.
 */
export interface BusyResourceRegistry {
  markAbandoned(settles: Promise<unknown>): void;
  waitUntilFree(timeoutMs: number, signal?: AbortSignal): Promise<boolean>;
  /** Drain to a fixed point, including effects registered while an earlier
   * snapshot is settling. */
  drainUntilFree(): Promise<void>;
}

/** Build an empty `BusyResourceRegistry`. One instance per run, shared by
 * every tool call through `ToolCtx.busyRegistry` and by the browser
 * controller's own internal renderer-read timeouts (see
 * `PlaywrightBrowserController.setBusyRegistry`) — the same abandoned work
 * must be visible to both layers, or a call gated at one layer could still
 * race an abandonment the other layer never told it about.
 *
 * Both waiting methods use fixed-point semantics so a browser abandonment
 * registered while an earlier effect is clearing is included before the run
 * proceeds.
 */
export function createBusyResourceRegistry(): BusyResourceRegistry {
  const abandoned = new Set<Promise<void>>();

  const drainUntilFree = async (): Promise<void> => {
    while (abandoned.size > 0) await Promise.all([...abandoned]);
  };

  return {
    markAbandoned(settles) {
      const cleared = settles.then(
        () => undefined,
        () => undefined,
      );
      abandoned.add(cleared);
      void cleared.then(() => {
        abandoned.delete(cleared);
      });
    },
    async waitUntilFree(timeoutMs, signal) {
      if (abandoned.size === 0) return true;
      signal?.throwIfAborted();
      let timer: NodeJS.Timeout | undefined;
      let abort: (() => void) | undefined;
      const aborted = new Promise<never>((_resolve, reject) => {
        if (signal === undefined) return;
        abort = () => reject(signal.reason);
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) abort();
      });
      try {
        return await Promise.race([
          drainUntilFree().then(() => true),
          new Promise<false>((resolve) => {
            timer = setTimeout(() => resolve(false), timeoutMs);
          }),
          aborted,
        ]);
      } finally {
        if (timer !== undefined) clearTimeout(timer);
        if (abort !== undefined) signal?.removeEventListener('abort', abort);
      }
    },
    drainUntilFree,
  };
}

/**
 * One tool, defined once: the model-facing contract (name, description,
 * input schema) together with the executor that does the work.
 *
 * The zod `inputSchema` does double duty: it validates the model's raw
 * input at runtime, and it is converted to the JSON Schema the Claude API
 * requires (see `toApiToolDefs`). One definition, two jobs.
 */
export interface ToolDef<Input = unknown> {
  /** Unique name the model invokes the tool by (e.g. "read_file"). */
  name: string;
  /** Model-facing description of what the tool does and when to use it. */
  description: string;
  /** zod schema every input is validated against before `execute` runs. */
  inputSchema: z.ZodType<Input>;
  /** Maximum size in bytes of this tool's normalized result before the
   * pipeline offloads it to a file and hands the model a preview + path
   * (T5). Omitted means DEFAULT_MAX_RESULT_BYTES. */
  maxBytes?: number;
  /** True iff this tool must not run without an interactive user decision.
   * The pipeline gates such calls through `ToolCtx.requestPermission`; when
   * the environment provides none, calls fail closed with a
   * permission_denied error. */
  requiresUserInteraction?: boolean;
  /**
   * Wall-clock ceiling for one execution of this tool, in milliseconds.
   * Omitted means DEFAULT_TOOL_TIMEOUT_MS. Declare a larger value for work
   * that is legitimately slow (a large download, OCR, parallel research), or
   * `Infinity` to opt out — which only a tool whose waiting is genuinely
   * unbounded should do, since this deadline is what keeps one wedged call
   * from hanging the entire run.
   */
  timeoutMs?: number;
  /**
   * Do the tool's work.
   *
   * @param input - the call's input, already validated against `inputSchema`
   * @param ctx   - the per-run context (run directory, etc.)
   * @returns the tool's raw output — a string, or any JSON-serializable
   *   value; the pipeline normalizes it for the model. May throw; the
   *   pipeline converts a throw into a structured error result.
   */
  execute(input: Input, ctx: ToolCtx): Promise<unknown> | unknown;
}

/** The set of tools available to a run, keyed by tool name. Built with
 * `createRegistry`; iteration order is registration order. */
export type ToolRegistry = ReadonlyMap<string, ToolDef>;

/**
 * Build a tool registry from a list of tool definitions.
 *
 * @param tools - tool definitions with pairwise-distinct names
 * @returns a registry containing exactly the given tools, iterating in the
 *   given order
 * @throws if two definitions share a name (a duplicate would silently
 *   shadow a tool — fail fast instead)
 */
export function createRegistry(tools: readonly ToolDef[]): ToolRegistry {
  const registry = new Map<string, ToolDef>();
  for (const tool of tools) {
    if (registry.has(tool.name)) {
      throw new Error(`Duplicate tool name "${tool.name}" in registry`);
    }
    registry.set(tool.name, tool);
  }
  return registry;
}

/** One entry of the Claude API `tools` array: the tool's contract with the
 * input schema in JSON Schema form. */
export interface ApiToolDef {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

/**
 * Convert a registry to the Claude API `tools` array.
 *
 * @param registry - the registry to serialize
 * @returns one entry per tool, in registration order, with each zod input
 *   schema converted to JSON Schema. Deterministic: for the same registry,
 *   repeated calls produce byte-identical `JSON.stringify` output — this
 *   array is part of the stable prompt prefix (T9), and any instability
 *   would silently break prompt caching.
 */
export function toApiToolDefs(registry: ToolRegistry): ApiToolDef[] {
  return [...registry.values()].map((tool) => ({
    name: tool.name,
    description: tool.description,
    // io: 'input' — the model *sends* inputs, so describe the input side of
    // the schema (matters once schemas use defaults/transforms).
    input_schema: z.toJSONSchema(tool.inputSchema, { io: 'input' }) as Record<string, unknown>,
  }));
}
