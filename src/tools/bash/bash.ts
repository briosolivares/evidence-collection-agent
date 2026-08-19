import { mkdirSync } from 'node:fs';

import { z } from 'zod';

import { SCRATCH_DIR } from '../../run/artifacts.js';
import { resolveRunPath } from '../../run/runDir.js';
import {
  syncScratchWorkspace,
  type ScratchWorkspaceChangedFile,
} from '../../run/syncScratchWorkspace.js';
import {
  runForegroundCommand,
  type ForegroundCommandOptions,
  type ForegroundCommandResult,
} from './runForegroundCommand.js';
import type { ToolCtx, ToolDef } from '../registry.js';

export const DEFAULT_BASH_TIMEOUT_MS = 30_000;
export const MAX_BASH_TIMEOUT_MS = 120_000;
export const BASH_MAX_OUTPUT_BYTES = 10 * 1024 * 1024;

/**
 * The outer pipeline deadline must leave enough room for the command's own
 * maximum deadline, its SIGTERM/SIGKILL and stream-drain cleanup, and a final
 * workspace reconciliation. The command runner owns cancellation; allowing
 * the pipeline to abandon it first could leave a process group alive.
 */
export const BASH_TOOL_TIMEOUT_MS = 150_000;

const SHELL_PATH = '/bin/bash';
const SHELL_STARTUP_HOOK_ENV_KEYS = new Set(['BASH_ENV', 'ENV']);

/** Legacy browser-script capabilities must never cross into the v3 shell. */
const BROWSER_CAPABILITY_ENV_KEYS = new Set([
  'SHERLOCK_CDP_URL',
  'SHERLOCK_PLAYWRIGHT_HELPER_URL',
  'SHERLOCK_SELECTED_PAGE_TARGET_ID',
]);

const BROWSER_CAPABILITY_ENV_PREFIXES = [
  'SHERLOCK_CDP_',
  'SHERLOCK_PLAYWRIGHT_',
  'BU_CDP',
  'CDP_',
  'CHROME_REMOTE_DEBUG',
];

const CDP_CAPABILITY_VALUE =
  /(?:wss?:\/\/[^\s]+|https?:\/\/[^\s]*(?:\/devtools\/(?:browser|page)|browserbase|\/json\/version)[^\s]*|browserScriptHelper\.mjs)/i;

export const bashInputSchema = z.strictObject({
  command: z
    .string()
    .refine((value) => value.trim().length > 0, {
      message: 'command must contain at least one non-whitespace character',
    })
    .describe(
      "Command run as `/bin/bash -c <command>` in this run's scratch/workspace directory.",
    ),
  timeout_ms: z
    .number()
    .int()
    .min(1)
    .max(MAX_BASH_TIMEOUT_MS)
    .optional()
    .describe(
      `Wall-clock deadline in milliseconds (default ${DEFAULT_BASH_TIMEOUT_MS}, ` +
        `maximum ${MAX_BASH_TIMEOUT_MS}). Values above the maximum are rejected.`,
    ),
});

export type BashInput = z.infer<typeof bashInputSchema>;

export interface BashResult {
  status: ForegroundCommandResult['status'];
  exit_code: number | null;
  termination_signal: string | null;
  duration_ms: number;
  stdout: string;
  stderr: string;
  changed_files: ScratchWorkspaceChangedFile[];
}

type RunCommand = (
  options: ForegroundCommandOptions,
) => Promise<ForegroundCommandResult>;

export interface BashToolDeps {
  /** Exact names or prefixes removed from the child environment. */
  secretEnvDenylist: readonly string[];
  /** Configuration/test seam. A fresh copy is sanitized for each call. */
  environment?: () => NodeJS.ProcessEnv;
  /** Test seam; production uses the process-group-owning runner. */
  runCommand?: RunCommand;
}

export function createBashTool(deps: BashToolDeps): ToolDef<BashInput> {
  const environment = deps.environment ?? (() => process.env);
  const executeCommand = deps.runCommand ?? runForegroundCommand;

  return {
    name: 'bash',
    description:
      "Run one finite foreground command with /bin/bash -c in this run's private " +
      'scratch/workspace directory. The command receives no browser helper or CDP ' +
      'capability. A nonzero exit code is a normal result. Package installation and ' +
      'background work are unsupported; every descendant is terminated when the call ' +
      'ends. Keep intermediate files in scratch/workspace, inspect changed_files, and ' +
      'use browser_execute for all browser work.',
    inputSchema: bashInputSchema,
    getAccess: () => ({ reads: [], writes: [], exclusive: true }),
    timeoutMs: BASH_TOOL_TIMEOUT_MS,
    execute: (input, ctx) =>
      executeBash(input, ctx, {
        environment,
        executeCommand,
        secretEnvDenylist: deps.secretEnvDenylist,
      }),
  };
}

interface ExecutionDeps {
  environment(): NodeJS.ProcessEnv;
  executeCommand(options: ForegroundCommandOptions): Promise<ForegroundCommandResult>;
  secretEnvDenylist: readonly string[];
}

async function executeBash(
  input: BashInput,
  ctx: ToolCtx,
  deps: ExecutionDeps,
): Promise<BashResult> {
  if (ctx.abortSignal?.aborted === true) return cancelledResult();

  if (process.platform === 'win32') {
    throw new Error(
      'bash is unavailable on Windows until Sherlock owns a tested process-tree cleanup mechanism.',
    );
  }

  const workspaceDir = resolveRunPath(
    ctx.runDir,
    `${SCRATCH_DIR}/workspace`,
  );
  mkdirSync(workspaceDir, { recursive: true, mode: 0o700 });

  let commandResult: ForegroundCommandResult | undefined;
  let executionError: unknown;
  try {
    commandResult = await deps.executeCommand({
      shellPath: SHELL_PATH,
      command: input.command,
      cwd: workspaceDir,
      env: buildChildEnvironment(
        deps.environment(),
        deps.secretEnvDenylist,
      ),
      timeoutMs: input.timeout_ms ?? DEFAULT_BASH_TIMEOUT_MS,
      maxOutputBytes: BASH_MAX_OUTPUT_BYTES,
      abortSignal: ctx.abortSignal,
    });
  } catch (error) {
    executionError = error;
  }

  let changedFiles: ScratchWorkspaceChangedFile[] = [];
  let syncError: unknown;
  try {
    changedFiles = syncScratchWorkspace(ctx.runDir);
  } catch (error) {
    syncError = error;
  }

  if (executionError !== undefined) {
    const cleanup =
      syncError === undefined
        ? ''
        : ` (workspace sync also failed: ${safeMessage(syncError)})`;
    throw new Error(`bash failed to start or run: ${safeMessage(executionError)}${cleanup}`);
  }

  if (syncError !== undefined) {
    throw new Error(
      `bash finished with status ${JSON.stringify(commandResult!.status)}, ` +
        `but workspace sync failed: ${safeMessage(syncError)}`,
    );
  }

  return {
    status: commandResult!.status,
    exit_code: commandResult!.exitCode,
    termination_signal: commandResult!.terminationSignal,
    duration_ms: commandResult!.durationMs,
    stdout: commandResult!.stdout,
    stderr: commandResult!.stderr,
    changed_files: changedFiles,
  };
}

function cancelledResult(): BashResult {
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

function buildChildEnvironment(
  source: NodeJS.ProcessEnv,
  secretEnvDenylist: readonly string[],
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...source };

  for (const key of Object.keys(env)) {
    const value = env[key];
    const deniedSecret = secretEnvDenylist.some(
      (denied) => key === denied || key.startsWith(denied),
    );
    const browserCapability =
      BROWSER_CAPABILITY_ENV_KEYS.has(key) ||
      BROWSER_CAPABILITY_ENV_PREFIXES.some((prefix) => key.startsWith(prefix)) ||
      (value !== undefined && CDP_CAPABILITY_VALUE.test(value));

    if (
      deniedSecret ||
      browserCapability ||
      SHELL_STARTUP_HOOK_ENV_KEYS.has(key)
    ) {
      delete env[key];
    }
  }

  env.GIT_EDITOR = 'true';
  env.GIT_PAGER = 'cat';
  env.PAGER = 'cat';
  env.GIT_TERMINAL_PROMPT = '0';

  return env;
}

function safeMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw
    .replace(/\bwss?:\/\/[^\s)'"\]]+/giu, '[REDACTED_WEBSOCKET_URL]')
    .replace(
      /\bhttps?:\/\/[^\s)'"\]]*(?:\/devtools\/(?:browser|page)|browserbase|\/json\/version)[^\s)'"\]]*/giu,
      '[REDACTED_CDP_URL]',
    );
}
