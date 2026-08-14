import { mkdirSync } from 'node:fs';
import { z } from 'zod';

import type { BrowserController, BrowserScriptSetup } from '../../browser/controller.js';
import { SCRATCH_DIR } from '../../run/artifacts.js';
import { resolveRunPath } from '../../run/runDir.js';
import {
  syncScratchWorkspace,
  type ScratchWorkspaceChangedFile,
} from '../../run/syncScratchWorkspace.js';
import type { ToolCtx, ToolDef } from '../registry.js';
import {
  runForegroundCommand,
  type ForegroundCommandResult,
} from './runForegroundCommand.js';

/** Default `timeout_ms` when the model omits it: generous for a quick shell
 * command, short enough that a hung command does not eat the whole run. */
export const DEFAULT_BASH_TIMEOUT_MS = 30_000;

/** Ceiling on the model-supplied `timeout_ms`. Values above this are
 * REJECTED by the schema, never silently clamped — a model that thinks it
 * asked for five minutes must not silently get two. */
export const MAX_BASH_TIMEOUT_MS = 120_000;

/** Fixed combined stdout+stderr ceiling for one command. Not model
 * configurable: a command that wants more output should write to a file
 * under scratch/workspace and read it back in pieces. */
const MAX_OUTPUT_BYTES = 10 * 1024 * 1024;

/**
 * Wall-clock ceiling this tool declares to the pipeline via `timeoutMs`,
 * well above its own worst case so `withToolDeadline`'s
 * DEFAULT_TOOL_TIMEOUT_MS (120_000ms, see pipeline.ts) can never fire first
 * and ABANDON a still-live process group — `withToolDeadline` does not
 * cancel the abandoned work, it just stops waiting for it, so racing it
 * against this tool's own 120_000ms ceiling would orphan a real child
 * process outside anything that can still kill it.
 *
 * Worst-case arithmetic: the model's own `timeout_ms` tops out at
 * MAX_BASH_TIMEOUT_MS (120_000ms). Once that fires inside
 * `runForegroundCommand`, it still needs its fixed 2s SIGTERM-then-SIGKILL
 * grace period, plus its post-exit stray-descendant kill and up to a 1s
 * stream-drain deadline (~3.5s more) before it resolves at all. After it
 * resolves, this tool still has to run `syncScratchWorkspace` (bounded
 * generously at 10s — it hashes every changed file in a workspace that may
 * hold files up to 256 MiB each) and, for `uses_browser` calls,
 * `refreshAfterBrowserScript` (a CDP round trip, bounded generously at 5s).
 * Summing the worst case — 120_000 + 2_000 + ~3_500 + 10_000 + 5_000 ≈
 * 140_500ms — and rounding up for a clean margin gives 150_000ms (2.5
 * minutes): comfortably clear of every legitimate completion path, so
 * tripping the pipeline deadline at that point means something is genuinely
 * wedged, not that bash was merely slow.
 */
export const BASH_TOOL_TIMEOUT_MS = 150_000;

/** Shell startup hooks that must never reach the child: a non-interactive
 * `-c` invocation already refuses to be a login shell, and honoring these
 * would let an ambient file silently run on every single command. */
const SHELL_STARTUP_HOOK_ENV_KEYS = ['BASH_ENV', 'ENV'] as const;

const bashInputSchema = z.strictObject({
  command: z
    .string()
    .refine((value) => value.trim().length > 0, {
      message: 'command must contain at least one non-whitespace character',
    })
    .describe(
      "Shell command, run as `/bin/bash -c <command>` (never a login shell — profiles are " +
        "not sourced), starting in this run's private scratch/workspace directory.",
    ),
  timeout_ms: z
    .number()
    .int()
    .min(1)
    .max(MAX_BASH_TIMEOUT_MS)
    .optional()
    .describe(
      `Wall-clock budget in milliseconds (default ${DEFAULT_BASH_TIMEOUT_MS}). Maximum ` +
        `${MAX_BASH_TIMEOUT_MS} — values above it are rejected, not clamped.`,
    ),
  uses_browser: z
    .boolean()
    .optional()
    .describe(
      'Set true only when this command (typically a generated Node/Playwright script) must ' +
        'connect to the currently selected browser page over CDP. Leave false (the default) ' +
        'for plain shell commands — true prepares and refreshes browser state around the ' +
        'call even when unused, and fails up front if this session cannot support it.',
    ),
});

/** Model-facing input for the `bash` tool. */
export type BashInput = z.infer<typeof bashInputSchema>;

/** Model-facing result of one `bash` call. A nonzero `exit_code` with
 * `status: 'exited'` is a completed, successful TOOL result — the command
 * itself failing is information for the model, not a transport error. */
export interface BashResult {
  status: ForegroundCommandResult['status'];
  exit_code: number | null;
  termination_signal: string | null;
  duration_ms: number;
  stdout: string;
  stderr: string;
  changed_files: ScratchWorkspaceChangedFile[];
}

/** Dependencies a run supplies when building its `bash` tool. A factory
 * rather than a module-level tool because both fields are run-scoped
 * decisions: the secret denylist is assembled once from that run's
 * configured providers/credentials, and the helper URL is fixed for the
 * whole process. */
export interface BashToolDeps {
  /** Environment variable names stripped from the child's environment —
   * model-provider API keys, tracing tokens, and any other secret the run
   * is configured with. Owned by the run (see runTask.ts), not this tool:
   * one shared list, one obvious place to add a newly introduced secret. */
  secretEnvDenylist: readonly string[];
  /** Absolute `file://` URL of the bundled browser-script helper
   * (src/browser/browserScriptHelper.mjs), injected as
   * `SHERLOCK_PLAYWRIGHT_HELPER_URL` for `uses_browser: true` calls whose
   * browser preparation succeeds. Defaults to resolving the helper relative
   * to this module's own location, so callers never need to know the
   * package layout. */
  helperUrl?: string;
}

/** Default helper URL, resolved from this module's own location
 * (src/tools/bash/ → src/browser/browserScriptHelper.mjs) so the tool needs
 * no knowledge of where the package is installed. Computed once at module
 * load; constructing a URL does not require the target file to exist. */
const DEFAULT_HELPER_URL = new URL(
  '../../browser/browserScriptHelper.mjs',
  import.meta.url,
).href;

/**
 * Build the `bash` tool for one run.
 *
 * @param deps - the run's secret denylist and (optionally) the bundled
 *   helper's file URL
 * @returns the registry definition, ready to append to a worker registry.
 *   NOT wired into any registry by this module — that is a later,
 *   dedicated integration step.
 */
export function createBashTool(deps: BashToolDeps): ToolDef<BashInput> {
  const helperUrl = deps.helperUrl ?? DEFAULT_HELPER_URL;

  return {
    name: 'bash',
    description:
      "Run a shell command with /bin/bash -c in this run's private scratch/workspace " +
      'directory. The command runs alone — no other tool call overlaps it. A nonzero exit ' +
      'code is a normal result, not a tool failure: read status and exit_code alongside ' +
      'stdout/stderr to see what happened. Keep intermediate files under scratch/workspace ' +
      '(they are reconciled into changed_files automatically) and publish final outputs with ' +
      'write_file under artifacts/. Set uses_browser: true only for a command (typically a ' +
      'generated Node/Playwright script) that must drive the currently selected browser page ' +
      'over CDP; call inspect_page again afterward before trusting page state, since this ' +
      'tool never reports it.',
    inputSchema: bashInputSchema,
    readOnly: false,
    // A shell command can touch anything on the host, so — unlike every
    // access-scoped browser/file tool — it declares no keys at all and
    // instead runs completely alone.
    getAccess: () => ({ reads: [], writes: [], exclusive: true }),
    timeoutMs: BASH_TOOL_TIMEOUT_MS,
    execute: (input, ctx) => executeBash(input, ctx, deps.secretEnvDenylist, helperUrl),
  };
}

/**
 * Do the actual work of one `bash` call: guard against an already-cancelled
 * run, prepare the workspace and (optionally) the browser, spawn the
 * command, and always attempt cleanup before returning or throwing.
 */
async function executeBash(
  input: BashInput,
  ctx: ToolCtx,
  secretEnvDenylist: readonly string[],
  helperUrl: string,
): Promise<BashResult> {
  // An already-aborted run must not spawn anything at all — not the
  // workspace directory's creation, not browser preparation, nothing. There
  // is genuinely no work to clean up here, so this returns immediately
  // rather than funneling through the cleanup path below.
  if (ctx.abortSignal?.aborted === true) {
    return {
      status: 'cancelled',
      exit_code: null,
      termination_signal: null,
      duration_ms: 0,
      stdout: '',
      stderr: '',
      changed_files: [],
    };
  }

  // Owned by this call, not `ctx.abortSignal` directly: `runForegroundCommand`
  // only accepts one signal, and composing through a call-scoped controller
  // keeps this call's listener lifecycle (attach/detach) fully local instead
  // of depending on how many other listeners the run-wide signal accumulates.
  const commandController = new AbortController();
  const forwardAbort = (): void => commandController.abort();
  ctx.abortSignal?.addEventListener('abort', forwardAbort, { once: true });

  try {
    const workspaceDir = resolveRunPath(ctx.runDir, `${SCRATCH_DIR}/workspace`);
    // Idempotent: a no-op when the directory already exists (mode is only
    // applied on creation), which is exactly "create it if absent".
    mkdirSync(workspaceDir, { recursive: true, mode: 0o700 });

    // Resolved BEFORE spawning: an unsupported controller must fail loudly
    // up front rather than silently running the command without the browser
    // access the caller asked for.
    let browserSetup: BrowserScriptSetup | undefined;
    if (input.uses_browser === true) {
      const browser = ctx.browser;
      if (
        typeof browser?.prepareForBrowserScript !== 'function' ||
        typeof browser?.refreshAfterBrowserScript !== 'function'
      ) {
        throw new Error(
          'bash uses_browser=true requires a browser session that supports generated ' +
            'scripts (prepareForBrowserScript and refreshAfterBrowserScript), which this ' +
            'run does not provide. Retry with uses_browser: false for a plain shell command.',
        );
      }
      browserSetup = await browser.prepareForBrowserScript();
    }

    const env = buildChildEnv(secretEnvDenylist, browserSetup, helperUrl);

    let commandResult: ForegroundCommandResult | undefined;
    let spawnError: unknown;
    try {
      commandResult = await runForegroundCommand({
        shellPath: '/bin/bash',
        command: input.command,
        cwd: workspaceDir,
        env,
        timeoutMs: input.timeout_ms ?? DEFAULT_BASH_TIMEOUT_MS,
        maxOutputBytes: MAX_OUTPUT_BYTES,
        abortSignal: commandController.signal,
      });
    } catch (thrown) {
      spawnError = thrown;
    }

    // Always attempted from here on — normal exit, timeout, cancellation,
    // output overflow, or a spawn failure that never produced a result at
    // all — because a partially-run command can still have touched the
    // workspace or left the browser mid-script.
    const cleanup = await runCleanup(ctx.runDir, ctx.browser, browserSetup);

    if (spawnError !== undefined) {
      // The spawn failure is the PRIMARY problem here; a cleanup failure on
      // top of it is additional information, appended rather than allowed
      // to replace or hide the original message.
      throw cleanup.errors.length > 0
        ? new Error(
            `${messageOf(spawnError)} (cleanup also failed: ${cleanup.errors.join('; ')})`,
          )
        : new Error(messageOf(spawnError));
    }

    const result = commandResult!;
    if (cleanup.errors.length > 0) {
      // The command itself completed (however that turned out), so the
      // exit status is not lost when reporting the cleanup failure that
      // supersedes this call's result — it is folded into the message
      // instead of silently discarded.
      throw new Error(
        `bash command finished with status "${result.status}"` +
          (result.exitCode !== null ? ` (exit code ${result.exitCode})` : '') +
          `, but tool cleanup failed: ${cleanup.errors.join('; ')}`,
      );
    }

    return {
      status: result.status,
      exit_code: result.exitCode,
      termination_signal: result.terminationSignal,
      duration_ms: result.durationMs,
      stdout: result.stdout,
      stderr: result.stderr,
      changed_files: cleanup.changedFiles,
    };
  } finally {
    ctx.abortSignal?.removeEventListener('abort', forwardAbort);
  }
}

/** What cleanup accomplished and what, if anything, went wrong attempting
 * it. Errors are collected rather than thrown so a failure in one step
 * never prevents the other from being attempted. */
interface CleanupOutcome {
  changedFiles: ScratchWorkspaceChangedFile[];
  errors: string[];
}

/**
 * Post-command cleanup, always run to completion: reconcile the scratch
 * workspace into the manifest, then — only when browser preparation
 * succeeded for this call — refresh the browser controller's view of live
 * pages. Both steps are attempted unconditionally and independently: a
 * broken sync must never suppress an attempted refresh, or vice versa.
 */
async function runCleanup(
  runDir: string,
  browser: BrowserController | undefined,
  browserSetup: BrowserScriptSetup | undefined,
): Promise<CleanupOutcome> {
  const errors: string[] = [];
  let changedFiles: ScratchWorkspaceChangedFile[] = [];
  try {
    changedFiles = syncScratchWorkspace(runDir);
  } catch (thrown) {
    errors.push(`workspace sync failed: ${messageOf(thrown)}`);
  }

  if (browserSetup !== undefined) {
    try {
      // Only reachable once `prepareForBrowserScript` succeeded, which only
      // happens after confirming both lifecycle methods exist on `browser`.
      await browser!.refreshAfterBrowserScript!();
    } catch (thrown) {
      errors.push(`browser refresh failed: ${messageOf(thrown)}`);
    }
  }

  return { changedFiles, errors };
}

/**
 * Build a fresh, non-interactive child environment for one bash invocation.
 *
 * Starts from a COPY of `process.env` — never the live object, and this
 * function never mutates it — strips the run's secret denylist and the
 * shell startup hooks, fixes four Git/pager variables so the command can
 * never block on an interactive prompt, and, only when browser preparation
 * succeeded, adds the three SHERLOCK_* values a generated script needs to
 * reach the selected page.
 *
 * This shapes reproducibility, it is NOT a security boundary: local bash
 * still runs as the same OS user as the rest of the application and can
 * reach anything that user can reach — including a "removed" variable, by
 * reading it from another process, a config file, or any other channel this
 * function has no control over. Stripping it here only keeps it out of this
 * one process's environment block.
 */
function buildChildEnv(
  secretEnvDenylist: readonly string[],
  browserSetup: BrowserScriptSetup | undefined,
  helperUrl: string,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const name of secretEnvDenylist) delete env[name];
  for (const name of SHELL_STARTUP_HOOK_ENV_KEYS) delete env[name];

  env.GIT_EDITOR = 'true';
  env.GIT_PAGER = 'cat';
  env.PAGER = 'cat';
  env.GIT_TERMINAL_PROMPT = '0';

  if (browserSetup !== undefined) {
    env.SHERLOCK_PLAYWRIGHT_HELPER_URL = helperUrl;
    env.SHERLOCK_CDP_URL = browserSetup.cdpUrl;
    env.SHERLOCK_SELECTED_PAGE_TARGET_ID = browserSetup.selectedPageTargetId;
  }

  return env;
}

/** Extract a thrown value's message, whatever was actually thrown. */
function messageOf(thrown: unknown): string {
  return thrown instanceof Error ? thrown.message : String(thrown);
}
