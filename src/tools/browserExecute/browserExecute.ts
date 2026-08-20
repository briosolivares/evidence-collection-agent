import { lstatSync, mkdirSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';

import { z } from 'zod';

import { safeBrowserErrorMessage } from '../../browser/capabilityRedaction.js';
import type {
  BrowserDialog,
  BrowserCommandSession,
  BrowserController,
  BrowserPage,
} from '../../browser/controller.js';
import type { BrowserJavaScriptPolicy } from '../../browser/browserJavaScript.js';
import { SCRATCH_DIR } from '../../run/artifacts.js';
import { inspectPathNoFollow, NoFollowFileError } from '../../run/noFollowFile.js';
import { resolveRunPath } from '../../run/runDir.js';
import {
  syncScratchWorkspace,
  type ScratchWorkspaceChangedFile,
} from '../../run/syncScratchWorkspace.js';
import type { ToolCtx, ToolDef } from '../registry.js';
import {
  BROWSER_PROGRAM_LIMITS,
  runBrowserProgram,
  sanitizeBrowserProgramEnvironment,
  type BrowserProgramError,
  type BrowserProgramOptions,
  type BrowserProgramResult,
  type BrowserProgramStatus,
} from './runner.js';

export const DEFAULT_BROWSER_EXECUTE_TIMEOUT_MS = 30_000;
export const MAX_BROWSER_EXECUTE_TIMEOUT_MS = BROWSER_PROGRAM_LIMITS.maxProgramTimeoutMs;
export const BROWSER_EXECUTE_MAX_OUTPUT_BYTES = BROWSER_PROGRAM_LIMITS.maxCaptureOutputBytes;
export const BROWSER_UPLOAD_MAX_FILE_BYTES = BROWSER_PROGRAM_LIMITS.maxUploadFileBytes;

export const BROWSER_EXECUTE_POLICY_DENIED_MESSAGE =
  'browser_execute is disabled for this run (javascriptPolicy=deny). ' +
  'Do not retry browser_execute; complete only work that does not require browser execution ' +
  'and report the access limitation honestly.';

/**
 * The tool deadline must outlive the runner's own maximum program deadline,
 * process-group termination grace, workspace reconciliation, and browser
 * refresh. If this outer deadline wins, the pipeline can only abandon the
 * work; it cannot improve on the runner's owned cancellation path.
 */
export const BROWSER_EXECUTE_TOOL_TIMEOUT_MS = 150_000;

export const browserExecuteInputSchema = z.strictObject({
  code: z
    .string()
    .refine((value) => value.trim().length > 0, {
      message: 'code must contain at least one non-whitespace character',
    })
    .refine((value) => Buffer.byteLength(value, 'utf8') <= BROWSER_PROGRAM_LIMITS.maxSourceBytes, {
      message: `code must not exceed ${BROWSER_PROGRAM_LIMITS.maxSourceBytes} UTF-8 bytes`,
    })
    .describe(
      'Body of an async JavaScript function run in a bounded Node child process (not in the ' +
        'page) receiving the protected `browser` helper object. ' +
        'Example batch shape: `const items = [/* known { id, url } items */]; const results = []; ' +
        'for (const item of items.slice(0, 20)) { try { const page = await browser.goto(item.url); ' +
        "results.push({ id: item.id, url: page.url, title: await browser.js('document.title') }); " +
        '} catch (error) { results.push({ id: item.id, error: String(error) }); } } return results;`',
    ),
  page_id: z
    .string()
    .min(1)
    .optional()
    .describe('Sherlock page id to pin for this program; omit for the active task page.'),
  timeout_ms: z
    .number()
    .int()
    .min(1)
    .max(MAX_BROWSER_EXECUTE_TIMEOUT_MS)
    .optional()
    .describe(
      `Whole-program deadline in milliseconds (default ${DEFAULT_BROWSER_EXECUTE_TIMEOUT_MS}, ` +
        `maximum ${MAX_BROWSER_EXECUTE_TIMEOUT_MS}). Values above the maximum are rejected.`,
    ),
});

export type BrowserExecuteInput = z.infer<typeof browserExecuteInputSchema>;

export interface BrowserExecuteResult {
  status: BrowserProgramStatus;
  duration_ms: number;
  value?: unknown;
  stdout: string;
  stderr: string;
  error?: BrowserProgramError;
  changed_files: ScratchWorkspaceChangedFile[];
  pages: BrowserPage[];
  pending_dialogs: readonly BrowserDialog[];
}

export interface BrowserExecuteToolDeps {
  /** Durable run policy for all model-authored browser execution, including
   * protected helpers and raw CDP methods. There is deliberately no default. */
  javascriptPolicy: BrowserJavaScriptPolicy;
  /** Run-configured names or prefixes stripped in addition to the runner's
   * generic secret/capability policy. */
  secretEnvDenylist: readonly string[];
  /** Test/configuration seam. A fresh copy is sanitized for every call. */
  environment?: () => NodeJS.ProcessEnv;
  /** Test seam; production always uses the bounded child-process runner. */
  runProgram?: (options: BrowserProgramOptions) => Promise<BrowserProgramResult>;
}

export function createBrowserExecuteTool(
  deps: BrowserExecuteToolDeps,
): ToolDef<BrowserExecuteInput> {
  const javascriptPolicy = requireJavaScriptPolicy(deps.javascriptPolicy);
  const executeProgram = deps.runProgram ?? runBrowserProgram;
  const environment = deps.environment ?? (() => process.env);

  return {
    name: 'browser_execute',
    description:
      'Run one bounded async JavaScript program against an exact browser page. The program ' +
      'receives `browser`, which provides raw CDP plus protected inspection, interaction, ' +
      'navigation, wait, tab, dialog, confined importModule, and upload helpers. ' +
      'Treat this as a small multi-line browser program, not a single browser action. When ' +
      'three or more known items require the same mechanical workflow, normally process a ' +
      'bounded batch of up to 20 in one call. Split when the next step requires judgment, ' +
      'visual inspection, human authority, or resolving an ambiguous target. ' +
      'The program itself runs in a bounded Node child process whose working directory is ' +
      'scratch/workspace — read and write workspace files there with ' +
      "`await import('node:fs/promises')`, e.g. to move bulk data into a page expression. " +
      'Only browser.js(expression) evaluates in the page; top-level const/let declared in ' +
      'those expressions persist as page globals across calls, so wrap page expressions in ' +
      'an IIFE. browser.click takes viewport x,y coordinates, browser.waitFor takes a JS ' +
      'expression string, and there is no clipboard helper — use navigator.clipboard ' +
      'through browser.js. ' +
      'Ordered-list numbering is generated by rendering, never DOM text: derive an ' +
      "item's displayed number from its position within its own parent list (plus the " +
      "list's start offset), or from a rendered marker that names it (like an inline " +
      'citation superscript) — an index into your own query results is not a displayed ' +
      'number. ' +
      'browser.upload targets a backend DOM node and a path relative to scratch/workspace. ' +
      'Use page_id to target a page returned by a prior result; omit it for the active task ' +
      'page. Intermediate files belong in the current scratch/workspace directory and are ' +
      'reconciled into changed_files. The child ' +
      'receives no CDP URL or provider/model/tracing secret. This is powerful local code, not ' +
      'a security sandbox, and the call always runs alone.',
    inputSchema: browserExecuteInputSchema,
    timeoutMs: BROWSER_EXECUTE_TOOL_TIMEOUT_MS,
    execute: (input, ctx) => {
      // This is the complete browser-program authority boundary. Refuse
      // before even checking cancellation so deny has one deterministic
      // result and cannot reach a controller, workspace, child, helper, or
      // raw CDP method through any input shape.
      if (javascriptPolicy === 'deny') {
        throw new Error(BROWSER_EXECUTE_POLICY_DENIED_MESSAGE);
      }
      return executeBrowserProgram(input, ctx, {
        executeProgram,
        environment,
        secretEnvDenylist: deps.secretEnvDenylist,
      });
    },
  };
}

function requireJavaScriptPolicy(policy: BrowserJavaScriptPolicy): BrowserJavaScriptPolicy {
  if (policy !== 'allow' && policy !== 'deny') {
    throw new Error('browser_execute requires an explicit javascriptPolicy of "allow" or "deny".');
  }
  return policy;
}

interface ExecutionDeps {
  executeProgram(options: BrowserProgramOptions): Promise<BrowserProgramResult>;
  environment(): NodeJS.ProcessEnv;
  secretEnvDenylist: readonly string[];
}

async function executeBrowserProgram(
  input: BrowserExecuteInput,
  ctx: ToolCtx,
  deps: ExecutionDeps,
): Promise<BrowserExecuteResult> {
  if (ctx.abortSignal?.aborted === true) {
    return emptyResult('cancelled');
  }

  const browser = requireBrowser(ctx.browser);
  const workspaceDir = resolveRunPath(ctx.runDir, `${SCRATCH_DIR}/workspace`);
  mkdirSync(workspaceDir, { recursive: true, mode: 0o700 });

  let commandSession: BrowserCommandSession | undefined;
  let programResult: BrowserProgramResult | undefined;
  let executionError: unknown;
  try {
    commandSession = await browser.openCommandSession(input.page_id);
    programResult = await deps.executeProgram({
      code: input.code,
      cwd: workspaceDir,
      env: buildBrowserProgramEnvironment(deps.environment(), deps.secretEnvDenylist),
      timeoutMs: input.timeout_ms ?? DEFAULT_BROWSER_EXECUTE_TIMEOUT_MS,
      maxOutputBytes: BROWSER_EXECUTE_MAX_OUTPUT_BYTES,
      abortSignal: ctx.abortSignal,
      page: {
        pageId: commandSession.pageId,
        targetId: commandSession.targetId,
      },
      sendCdp: (method, params) => commandSession!.send(method, params),
      navigate: (url, options) => commandSession!.navigate(url, options),
      upload: async (backendDOMNodeId, workspacePath) => {
        const absolutePath = resolveWorkspaceUploadPath(workspaceDir, workspacePath);
        await commandSession!.upload(backendDOMNodeId, absolutePath);
      },
    });
  } catch (error) {
    executionError = error;
  }

  const cleanup = await cleanupAfterBrowserProgram(ctx.runDir, browser, commandSession);

  if (executionError !== undefined) {
    throw combinedFailure('browser program failed to run', executionError, cleanup.errors);
  }
  if (cleanup.errors.length > 0) {
    throw new Error(
      `browser program finished with status ${JSON.stringify(programResult!.status)}, ` +
        `but cleanup failed: ${cleanup.errors.join('; ')}`,
    );
  }

  return {
    status: programResult!.status,
    duration_ms: programResult!.durationMs,
    ...(Object.prototype.hasOwnProperty.call(programResult, 'value')
      ? { value: programResult!.value }
      : {}),
    stdout: programResult!.stdout,
    stderr: programResult!.stderr,
    ...(programResult!.error ? { error: programResult!.error } : {}),
    changed_files: cleanup.changedFiles,
    pages: cleanup.pages,
    pending_dialogs: cleanup.pendingDialogs,
  };
}

function requireBrowser(browser: BrowserController | undefined): BrowserController {
  if (browser === undefined) {
    throw new Error('browser_execute requires an active browser session.');
  }
  return browser;
}

function resolveWorkspaceUploadPath(workspaceDir: string, workspacePath: string): string {
  const workspaceStats = lstatSync(workspaceDir);
  if (workspaceStats.isSymbolicLink()) {
    throw new Error('browser.upload scratch/workspace root must not be a symbolic link');
  }
  if (!workspaceStats.isDirectory()) {
    throw new Error('browser.upload scratch/workspace root must be a directory');
  }
  if (
    typeof workspacePath !== 'string' ||
    workspacePath.length === 0 ||
    Buffer.byteLength(workspacePath, 'utf8') > BROWSER_PROGRAM_LIMITS.maxWorkspacePathBytes
  ) {
    throw new Error(
      `browser.upload workspace path must contain 1 through ` +
        `${BROWSER_PROGRAM_LIMITS.maxWorkspacePathBytes} UTF-8 bytes`,
    );
  }
  if (workspacePath.includes('\0')) {
    throw new Error('browser.upload workspace path must not contain a NUL byte');
  }
  if (isAbsolute(workspacePath)) {
    throw new Error('browser.upload workspace path must be relative');
  }
  if (workspacePath.split(/[\\/]+/u).includes('..')) {
    throw new Error('browser.upload path must stay within scratch/workspace');
  }

  const absolutePath = resolve(workspaceDir, workspacePath);
  const confined = relative(workspaceDir, absolutePath);
  if (
    confined === '' ||
    confined === '..' ||
    confined.startsWith(`..${sep}`) ||
    isAbsolute(confined)
  ) {
    throw new Error('browser.upload path must name a file within scratch/workspace');
  }

  const components = confined.split(sep);
  let current = workspaceDir;
  for (const [index, component] of components.entries()) {
    current = resolve(current, component);
    let stats;
    try {
      stats = lstatSync(current);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      throw new Error(
        `browser.upload file ${JSON.stringify(workspacePath)} is unavailable` +
          (code === undefined ? '' : ` (${code})`),
      );
    }
    if (stats.isSymbolicLink()) {
      throw new Error('browser.upload path must not contain symbolic links');
    }
    const isEntry = index === components.length - 1;
    if (!isEntry && !stats.isDirectory()) {
      throw new Error('browser.upload parent must be a directory');
    }
    if (isEntry && !stats.isFile()) {
      throw new Error('browser.upload path must name a regular file');
    }
  }

  try {
    inspectPathNoFollow(absolutePath, { maxBytes: BROWSER_UPLOAD_MAX_FILE_BYTES });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ELOOP') {
      throw new Error('browser.upload path must not contain symbolic links');
    }
    if (error instanceof NoFollowFileError && error.kind === 'not_regular') {
      throw new Error('browser.upload path must name a regular file');
    }
    if (error instanceof NoFollowFileError && error.kind === 'max_bytes') {
      throw new Error(`browser.upload file exceeds ${BROWSER_UPLOAD_MAX_FILE_BYTES} bytes`);
    }
    throw error;
  }
  return absolutePath;
}

function emptyResult(status: BrowserProgramStatus): BrowserExecuteResult {
  return {
    status,
    duration_ms: 0,
    stdout: '',
    stderr: '',
    changed_files: [],
    pages: [],
    pending_dialogs: [],
  };
}

function buildBrowserProgramEnvironment(
  source: NodeJS.ProcessEnv,
  secretEnvDenylist: readonly string[],
): NodeJS.ProcessEnv {
  const withoutConfiguredSecrets: NodeJS.ProcessEnv = { ...source };
  for (const key of Object.keys(withoutConfiguredSecrets)) {
    if (secretEnvDenylist.some((denied) => key === denied || key.startsWith(denied))) {
      delete withoutConfiguredSecrets[key];
    }
  }
  return sanitizeBrowserProgramEnvironment(withoutConfiguredSecrets);
}

interface CleanupOutcome {
  changedFiles: ScratchWorkspaceChangedFile[];
  pages: BrowserPage[];
  pendingDialogs: readonly BrowserDialog[];
  errors: string[];
}

async function cleanupAfterBrowserProgram(
  runDir: string,
  browser: BrowserController,
  commandSession: BrowserCommandSession | undefined,
): Promise<CleanupOutcome> {
  const errors: string[] = [];
  let changedFiles: ScratchWorkspaceChangedFile[] = [];
  let pages: BrowserPage[] = [];
  let pendingDialogs: readonly BrowserDialog[] = [];

  if (commandSession !== undefined) {
    try {
      await commandSession.close();
    } catch (error) {
      errors.push(`command-session close failed: ${safeBrowserErrorMessage(error)}`);
    }
  }

  try {
    changedFiles = syncScratchWorkspace(runDir);
  } catch (error) {
    errors.push(`workspace sync failed: ${safeBrowserErrorMessage(error)}`);
  }

  try {
    await browser.refreshAfterExternalCommands();
  } catch (error) {
    errors.push(`browser refresh failed: ${safeBrowserErrorMessage(error)}`);
  }

  try {
    pages = await browser.pages();
  } catch (error) {
    errors.push(`browser page listing failed: ${safeBrowserErrorMessage(error)}`);
  }

  try {
    pendingDialogs = browser.listPendingDialogs();
  } catch (error) {
    errors.push(`browser dialog listing failed: ${safeBrowserErrorMessage(error)}`);
  }

  return { changedFiles, pages, pendingDialogs, errors };
}

function combinedFailure(
  prefix: string,
  primary: unknown,
  cleanupErrors: readonly string[],
): Error {
  const cleanup =
    cleanupErrors.length > 0 ? ` (cleanup also failed: ${cleanupErrors.join('; ')})` : '';
  return new Error(`${prefix}: ${safeBrowserErrorMessage(primary)}${cleanup}`);
}
