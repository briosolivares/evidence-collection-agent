import { normalize, sep } from 'node:path';

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
  /** Cancellation for tools that own a long-running external resource (a
   * spawned process group, a network connection) and can react to the run
   * being cancelled before their own work naturally ends. This is the FIRST
   * tool-level cancellation signal in the codebase — until now the only
   * cancellation was the TUI wrapping `config.callModel`, which only ever
   * lands at model-call boundaries and cannot reach into a tool already
   * executing. Present in interactive environments that support cancelling
   * an in-flight run; tools that do not own such a resource can ignore it. */
  abortSignal?: AbortSignal;
  /** This run's ledger of resources an abandoned (timed-out) call might
   * still be touching — see `BusyResourceRegistry`. Always present for a
   * run built through `buildRunToolchain`; absent only in tests that build
   * a bare `ToolCtx` by hand, in which case the pipeline skips the gate and
   * behaves exactly as it did before the registry existed. */
  busyRegistry?: BusyResourceRegistry;
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

const FILE_KEY_PREFIX = 'file:';

/** Normalize a `file:` key's path portion so `.`, `./foo`, and `foo/` all
 * compare equal to `foo` — and the whole-run-dir key (`.`) reduces to `''`,
 * the sentinel `filePathsOverlap` treats as containing everything. Collapsing
 * this once here is what lets `grep`'s directory-scoped read key
 * (`accessKey.file(input.path ?? '.')`) line up with a sibling tool's
 * single-file write key (`accessKey.file(input.file_path)`) without either
 * side having to agree on a shared string representation. */
function normalizeFileKeyPath(relPath: string): string {
  const normalized = normalize(relPath);
  if (normalized === '.') return '';
  return normalized.endsWith(sep) ? normalized.slice(0, -sep.length) : normalized;
}

/**
 * Whether two `file:`-key paths overlap: equal, or one is an ancestor
 * directory of (or the run-dir root containing) the other.
 *
 * This is the piece plain string equality cannot express. A directory-scoped
 * read key like `file:.` (grep's default, or `file:artifacts`) must conflict
 * with a nested single-file write key like `file:artifacts/report.csv` —
 * the write happens inside the tree the read is scanning — even though the
 * two strings share no exact match. Comparing by path segment (via the
 * `sep`-joined prefix check, not a bare `startsWith`) is what keeps
 * `file:foo` from wrongly overlapping `file:foobar`.
 */
function filePathsOverlap(leftPath: string, rightPath: string): boolean {
  const left = normalizeFileKeyPath(leftPath);
  const right = normalizeFileKeyPath(rightPath);
  if (left === right) return true;
  if (left === '' || right === '') return true; // '' is the whole run dir.
  return left.startsWith(right + sep) || right.startsWith(left + sep);
}

/** Whether two access keys name overlapping resources. Every key but `file:`
 * is an opaque atom compared by exact equality; `file:` keys are paths and
 * compared by containment (see `filePathsOverlap`), since a tool may declare
 * a directory it reads or writes rather than a single file. */
function keysOverlap(left: string, right: string): boolean {
  if (left.startsWith(FILE_KEY_PREFIX) && right.startsWith(FILE_KEY_PREFIX)) {
    return filePathsOverlap(left.slice(FILE_KEY_PREFIX.length), right.slice(FILE_KEY_PREFIX.length));
  }
  return left === right;
}

/** Whether two access declarations conflict — a write against any read or
 * write of the other. Read/read never conflicts, which is what allows
 * unbounded parallel observation.
 *
 * Pairwise rather than Set-based: overlap between two `file:` keys is a path
 * containment check, not a hash lookup, so every key on one side must be
 * compared against every key on the other. Each side's `reads`/`writes` is a
 * handful of concrete keys at most, so this stays cheap. */
export function accessesConflict(left: ToolAccess, right: ToolAccess): boolean {
  // Exclusivity is unconditional: an unclassifiable call conflicts with
  // everything, including a call that touches nothing it names.
  if (left.exclusive === true || right.exclusive === true) return true;
  for (const leftKey of left.writes) {
    for (const rightKey of right.writes) {
      if (keysOverlap(leftKey, rightKey)) return true;
    }
  }
  for (const leftKey of left.reads) {
    for (const rightKey of right.writes) {
      if (keysOverlap(leftKey, rightKey)) return true;
    }
  }
  for (const rightKey of right.reads) {
    for (const leftKey of left.writes) {
      if (keysOverlap(leftKey, rightKey)) return true;
    }
  }
  return false;
}

/** The fail-closed access for a call whose declaration threw: it conflicts
 * with everything, so it runs alone. */
export const EXCLUSIVE_ACCESS: ToolAccess = { reads: [], writes: [], exclusive: true };

/** Derive a tool call's access the same way for both scheduling (grouping
 * concurrent calls) and execution (gating/registering against abandoned
 * work) — one implementation, so the two can never silently disagree about
 * what a call touches. `getAccess` is mandatory on `ToolDef` (T16), so the
 * only failure mode left is a declaration that THROWS; that still degrades
 * to `EXCLUSIVE_ACCESS` rather than to unsafe parallelism — see
 * `ToolDef.getAccess`'s own doc. */
export function deriveAccess(tool: ToolDef, input: unknown): ToolAccess {
  try {
    return tool.getAccess(input);
  } catch {
    return EXCLUSIVE_ACCESS;
  }
}

/**
 * The run's ledger of resources an abandoned (timed-out) call might still be
 * touching.
 *
 * `withToolDeadline` cannot cancel a wedged tool call — nothing in this
 * codebase can reach into Playwright and stop it — so giving up on waiting
 * for it does not mean the real work stopped. Without this registry, the
 * scheduler's mutual-exclusion guarantee (two calls that write the same key
 * never run concurrently) silently breaks the moment a call times out: the
 * abandoned call's slot is released as an ordinary settled call, and
 * whatever runs next on the same resource races work that may still be in
 * flight. This registry is what lets a LATER call notice "the previous
 * occupant of this key never confirmed it was done" and wait for it (or a
 * bounded timeout of its own) instead of racing it blind.
 *
 * Deliberately NOT keyed by an id or ToolCall — only by the abandoned call's
 * `ToolAccess`, checked via the same `accessesConflict` the scheduler
 * already uses. A read that finishes late never blocks a later read (read/
 * read still never conflicts), but it does block a later write to the same
 * key — which is exactly the guarantee that was silently breaking.
 */
export interface BusyResourceRegistry {
  /** Record that a call touching `access` was abandoned — `settles`
   * resolves or rejects whenever the real, still-running work eventually
   * finishes, however long that takes. The entry clears itself the moment
   * `settles` settles; nothing else needs to remove it. */
  markAbandoned(access: ToolAccess, settles: Promise<unknown>): void;
  /** Resolve `true` once nothing currently marked abandoned conflicts with
   * `access` (immediately, in the common case where nothing is marked),
   * or `false` once `timeoutMs` elapses first. A conflicting entry added
   * AFTER this call starts waiting is not included — see the module note
   * on why that snapshot is intentional, not a race. */
  waitUntilFree(
    access: ToolAccess,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<boolean>;
  /** Wait without releasing the caller until every conflicting abandoned
   * effect has actually settled. Unlike `waitUntilFree`, this is a fixed-
   * point drain: entries added while an earlier snapshot is settling are
   * included before it returns. Terminalization uses this only after its
   * finite safety gate expires, so a live effect can never outlive the run
   * lock and race a fresh coordinator. */
  drainUntilFree(access: ToolAccess): Promise<void>;
}

/** Build an empty `BusyResourceRegistry`. One instance per run, shared by
 * every tool call through `ToolCtx.busyRegistry` and by the browser
 * controller's own internal renderer-read timeouts (see
 * `PlaywrightBrowserController.setBusyRegistry`) — the same abandoned work
 * must be visible to both layers, or a call gated at one layer could still
 * race an abandonment the other layer never told it about.
 *
 * Snapshot semantics in `waitUntilFree`: a call that starts waiting sees
 * only the entries that exist at that instant, and waits for exactly those
 * to clear (or its own bound to elapse) — it does not keep growing its wait
 * for entries added afterward. This is safe rather than merely convenient:
 * every call that could ever conflict with a given key must itself pass
 * through this same gate before it is allowed to start touching that key,
 * so the only way a NEW conflicting entry can appear while an existing
 * waiter is waiting is for its own call to have already found the key
 * clear at the moment ITS gate ran — at which point the resource genuinely
 * was momentarily free, and both waiters proceeding is correct.
 */
export function createBusyResourceRegistry(): BusyResourceRegistry {
  const abandoned = new Set<{ access: ToolAccess; cleared: Promise<void> }>();

  const conflictingEntries = (access: ToolAccess) =>
    [...abandoned].filter((entry) => accessesConflict(entry.access, access));

  return {
    markAbandoned(access, settles) {
      const entry = {
        access,
        cleared: settles.then(
          () => undefined,
          () => undefined,
        ),
      };
      abandoned.add(entry);
      void entry.cleared.then(() => {
        abandoned.delete(entry);
      });
    },
    async waitUntilFree(access, timeoutMs, signal) {
      const conflicting = conflictingEntries(access);
      if (conflicting.length === 0) return true;
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
          Promise.all(conflicting.map((entry) => entry.cleared)).then(() => true),
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
    async drainUntilFree(access) {
      for (;;) {
        const conflicting = conflictingEntries(access);
        if (conflicting.length === 0) return;
        await Promise.all(conflicting.map((entry) => entry.cleared));
      }
    },
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
  /**
   * What this call touches, derived from its validated input (see ToolAccess).
   *
   * Mandatory (T16): every production tool must be able to say what it
   * touches, so there is no fallback left to reach for when a declaration is
   * merely forgotten. A THROWING declaration is still tolerated — it
   * degrades to `EXCLUSIVE_ACCESS` (see `deriveAccess`) rather than to unsafe
   * parallelism — but an absent one is now a type error, not a silent
   * "unknown".
   */
  getAccess(input: Input): ToolAccess;
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
    input_schema: z.toJSONSchema(tool.inputSchema, { io: 'input' }) as Record<
      string,
      unknown
    >,
  }));
}
