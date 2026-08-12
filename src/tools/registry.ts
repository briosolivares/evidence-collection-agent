import { z } from 'zod';

import type { BrowserController } from '../browser/controller.js';

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
  /** True iff the tool never changes state — the scheduler (T8) runs
   * read-only tools in parallel and serializes state-changing ones. */
  readOnly: boolean;
  /** Maximum size in bytes of this tool's normalized result before the
   * pipeline offloads it to a file and hands the model a preview + path
   * (T5). Omitted means DEFAULT_MAX_RESULT_BYTES. */
  maxBytes?: number;
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
    input_schema: z.toJSONSchema(tool.inputSchema, { io: 'input' }) as Record<
      string,
      unknown
    >,
  }));
}
