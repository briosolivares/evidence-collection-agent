import { z } from 'zod';

import type { CredentialStore } from '../auth/credentialStore.js';
import type { BrowserController } from '../browser/controller.js';
import type { OutputContractStore } from '../contracts/outputContractStore.js';

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
  /** Stored login credentials for fill_credentials. Environments without
   * any omit it; fills then degrade to the no-credentials error and the
   * model falls back to human handoff. */
  credentials?: CredentialStore;
  /** Interactive environments resolve tool permission requests here (the
   * TUI dialog). Headless environments omit it; tools that require user
   * interaction then fail closed. */
  requestPermission?: (request: PermissionRequest) => Promise<PermissionDecision>;
  /** The run's append-only output-contract history, owned by the runtime.
   * Present whenever the registry includes `set_output_contract`; registries
   * built for contract-less runs (the judge-less path, fixture tests) omit
   * it, and the tool then fails closed rather than accepting a contract
   * nothing will read. */
  outputContracts?: OutputContractStore;
}

/**
 * What a tool touches, derived from its VALIDATED input.
 *
 * Concrete keys, not categories: `page:p1`, `observation:p1`, `table:roster`,
 * `file:artifacts/x.csv`, `origin:example.com`, `manifest`. Two calls may
 * overlap only when neither writes a key the other reads or writes — which is
 * strictly more permissive than the old read-only/state-changing split (two
 * writes to DIFFERENT pages can now run together) and strictly safer (a
 * "read-only" call that reads the page a concurrent write mutates no longer
 * slips through).
 *
 * Deriving this from input is the whole point: `browser_action` on page p1 and
 * `browser_action` on page p2 are the same TOOL with different access.
 */
export interface ToolAccess {
  /** Keys this call reads and must see unchanged while it runs. */
  reads: readonly string[];
  /** Keys this call may modify. */
  writes: readonly string[];
  /**
   * True when this call must run completely alone.
   *
   * An explicit flag rather than a sentinel key, because a sentinel only
   * conflicts with calls that happen to name it — a call declaring
   * `writes: ['*exclusive*']` does NOT conflict with one that merely reads
   * something else, so a sentinel silently fails to be exclusive. That bug
   * broke the write/read barrier when this was first written; the flag makes
   * exclusivity unconditional.
   */
  exclusive?: boolean;
}

/** Access keys, built through helpers so a typo cannot silently create a key
 * nothing else collides with — the failure mode would be invisible
 * parallelism, not an error. */
export const accessKey = {
  page: (pageId: string): string => `page:${pageId}`,
  observation: (pageId: string): string => `observation:${pageId}`,
  table: (outputId: string): string => `table:${outputId}`,
  file: (relPath: string): string => `file:${relPath}`,
  origin: (host: string): string => `origin:${host}`,
  /** The selected page, when a tool does not name one. Deliberately a single
   * shared key: every unqualified browser action contends for it. */
  selectedPage: (): string => 'page:selected',
  contract: (): string => 'contract',
  evidence: (): string => 'evidence',
  manifest: (): string => 'manifest',
} as const;

/** Whether two access declarations conflict — a write against any read or
 * write of the other. Read/read never conflicts, which is what allows
 * unbounded parallel observation. */
export function accessesConflict(left: ToolAccess, right: ToolAccess): boolean {
  // Exclusivity is unconditional: an unclassifiable call conflicts with
  // everything, including a call that touches nothing it names.
  if (left.exclusive === true || right.exclusive === true) return true;
  const leftWrites = new Set(left.writes);
  const rightWrites = new Set(right.writes);
  for (const key of rightWrites) {
    if (leftWrites.has(key)) return true;
  }
  for (const key of left.reads) {
    if (rightWrites.has(key)) return true;
  }
  for (const key of right.reads) {
    if (leftWrites.has(key)) return true;
  }
  return false;
}

/** The fail-closed access for a call whose tool declares none, or whose
 * declaration threw: it conflicts with everything, so it runs alone. */
export const EXCLUSIVE_ACCESS: ToolAccess = { reads: [], writes: [], exclusive: true };

/** The access a legacy read-only tool (one with no `getAccess`) gets during
 * the migration: it touches nothing it can name, so two of them overlap —
 * preserving today's parallel reads — while any exclusive call still forms a
 * barrier around them. */
export const LEGACY_READ_ACCESS: ToolAccess = { reads: [], writes: [] };

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
  /**
   * True iff the tool never changes state.
   *
   * Retained as a COMPATIBILITY field only: the scheduler now prefers
   * `getAccess()`, and this flag is the fallback for tools that do not yet
   * declare access. T16 removes it once every production tool has migrated.
   */
  readOnly: boolean;
  /**
   * What this call touches, derived from its validated input (see ToolAccess).
   *
   * Omitted means "unknown", which the scheduler treats as exclusive — a tool
   * that cannot say what it touches must not run beside anything. A throw is
   * treated identically, so a buggy declaration degrades to serial execution
   * rather than to unsafe parallelism.
   */
  getAccess?(input: Input): ToolAccess;
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
