import { fork, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';

import {
  ParentDeathWatchdogError,
  startParentDeathWatchdog,
} from '../../process/parentDeathWatchdog.js';

export const BROWSER_PROGRAM_LIMITS = Object.freeze({
  maxSourceBytes: 256_000,
  maxIpcMessageBytes: 1_048_576,
  maxResultBytes: 524_288,
  maxCaptureOutputBytes: 10_000_000,
  maxProgramTimeoutMs: 120_000,
  maxCdpCalls: 1_000,
  maxPendingCdpCalls: 32,
  maxHostCalls: 32,
  maxPendingHostCalls: 8,
  maxWorkspacePathBytes: 4_096,
  maxUploadFileBytes: 64 * 1024 * 1024,
});

const PROTOCOL_VERSION = 1;
const TERMINATE_GRACE_MS = 750;
const STRAY_KILL_DELAY_MS = 250;
const DRAIN_DEADLINE_MS = 1_000;
const TERMINATION_DEADLINE_MS = 2_500;
const MAX_ERROR_NAME_BYTES = 256;
const MAX_ERROR_MESSAGE_BYTES = 8_192;
const MAX_ERROR_STACK_BYTES = 24_576;
const MAX_CDP_METHOD_BYTES = 512;
const MAX_NAVIGATION_URL_BYTES = 256_000;
const MAX_NAVIGATION_TIMEOUT_MS = 120_000;
const CHILD_MODULE = fileURLToPath(new URL('./child.mjs', import.meta.url));

export type BrowserProgramStatus =
  | 'exited'
  | 'failed'
  | 'protocol_error'
  | 'timed_out'
  | 'cancelled'
  | 'output_limit_exceeded';

export interface BrowserProgramError {
  name: string;
  message: string;
  stack?: string;
}

export interface BrowserProgramPageIdentity {
  /** Stable Sherlock/controller page identifier. */
  pageId: string;
  /** Exact CDP target to which sendCdp is pinned. */
  targetId: string;
}

export interface BrowserProgramNavigationResult {
  pageId: string;
  targetId: string;
  url: string;
  title: string;
}

export interface BrowserProgramOptions {
  /** Async-function body executed with one argument named `browser`. */
  code: string;
  /** Existing working directory for the child. */
  cwd: string;
  /**
   * Explicit environment source. The runner never falls back to process.env;
   * secret/capability and process-startup variables are removed before fork.
   */
  env: NodeJS.ProcessEnv;
  /** Immutable identity of the command session's initially pinned page. */
  page: BrowserProgramPageIdentity;
  timeoutMs: number;
  /** Aggregate raw-byte ceiling shared by stdout and stderr. */
  maxOutputBytes: number;
  abortSignal?: AbortSignal;
  /** Parent-owned, target-pinned CDP sender. It must not expose a CDP URL. */
  sendCdp(method: string, params: Record<string, unknown>): Promise<unknown>;
  /** Parent-owned navigation transaction on the same pinned page. */
  navigate(
    url: string,
    options: { timeoutMs: number; waitUntil: 'domcontentloaded' | 'load' },
  ): Promise<BrowserProgramNavigationResult>;
  /** Parent-owned upload effect. The implementation must confine workspacePath
   * before invoking the exact target-pinned command session. */
  upload(backendDOMNodeId: number, workspacePath: string): Promise<void>;
}

export interface BrowserProgramResult {
  status: BrowserProgramStatus;
  durationMs: number;
  value?: unknown;
  stdout: string;
  stderr: string;
  error?: BrowserProgramError;
}

interface TerminalOutcome {
  status: BrowserProgramStatus;
  value?: unknown;
  error?: BrowserProgramError;
}

const FORBIDDEN_ENV_NAMES = new Set([
  'BASH_ENV',
  'ENV',
  'ZDOTDIR',
  'SHELLOPTS',
  'PS4',
  'PROMPT_COMMAND',
  'NODE_OPTIONS',
  'NODE_PATH',
  'NODE_REPL_EXTERNAL_MODULE',
  'NODE_EXTRA_CA_CERTS',
  'NODE_TLS_REJECT_UNAUTHORIZED',
]);

const FORBIDDEN_ENV_PREFIXES = [
  'ANTHROPIC_',
  'OPENAI_',
  'LANGFUSE_',
  'BROWSERBASE_',
  'SHERLOCK_BROWSER_',
  'BU_CDP',
  'CDP_',
  'CHROME_REMOTE_DEBUG',
  'GITHUB_',
  'AWS_',
  'AZURE_',
  'GOOGLE_',
];

const SECRET_ENV_NAME =
  /(?:^|_)(?:API_?KEY|TOKEN|SECRET|PASSWORD|PASSWD|PRIVATE_?KEY|CREDENTIALS?|AUTH)(?:$|_)/i;
const CDP_CAPABILITY_VALUE =
  /(?:wss?:\/\/[^\s]+|https?:\/\/[^\s]*(?:\/devtools\/(?:browser|page)|browserbase|\/json\/version)[^\s]*)/i;

function truncateUtf8(value: string, maxBytes: number): string {
  const bytes = Buffer.from(value, 'utf8');
  if (bytes.length <= maxBytes) return value;
  let end = maxBytes;
  while (end > 0 && (bytes[end]! & 0b1100_0000) === 0b1000_0000) end -= 1;
  return `${bytes.subarray(0, end).toString('utf8')}…`;
}

function redactCapabilities(value: string): string {
  return value
    .replace(/wss?:\/\/[^\s)'"\]]+/gi, '[REDACTED_WEBSOCKET_URL]')
    .replace(
      /https?:\/\/[^\s)'"\]]*(?:\/devtools\/(?:browser|page)|browserbase)[^\s)'"\]]*/gi,
      '[REDACTED_CDP_URL]',
    );
}

function structuredError(thrown: unknown): BrowserProgramError {
  if (thrown instanceof Error) {
    return {
      name: truncateUtf8(redactCapabilities(thrown.name || 'Error'), MAX_ERROR_NAME_BYTES),
      message: truncateUtf8(
        redactCapabilities(thrown.message || String(thrown)),
        MAX_ERROR_MESSAGE_BYTES,
      ),
      ...(typeof thrown.stack === 'string'
        ? {
            stack: truncateUtf8(
              redactCapabilities(thrown.stack),
              MAX_ERROR_STACK_BYTES,
            ),
          }
        : {}),
    };
  }
  return {
    name: 'Error',
    message: truncateUtf8(redactCapabilities(String(thrown)), MAX_ERROR_MESSAGE_BYTES),
  };
}

function protocolError(message: string): BrowserProgramError {
  return { name: 'ProtocolError', message: truncateUtf8(message, MAX_ERROR_MESSAGE_BYTES) };
}

function watchdogError(error: unknown, fallback: string): BrowserProgramError {
  const message =
    error instanceof ParentDeathWatchdogError ? error.message : fallback;
  return {
    name: 'ParentDeathWatchdogError',
    message: truncateUtf8(redactCapabilities(message), MAX_ERROR_MESSAGE_BYTES),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function serializedSize(value: unknown): number {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new TypeError('value is not JSON-serializable');
  return Buffer.byteLength(serialized, 'utf8');
}

function normalizedJsonValue(value: unknown): unknown {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new TypeError('value is not JSON-serializable');
  return JSON.parse(serialized) as unknown;
}

/**
 * Create the child's entire environment from the explicit caller input.
 * This is exposure reduction, not an OS security boundary.
 */
export function sanitizeBrowserProgramEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const sanitized: NodeJS.ProcessEnv = Object.create(null) as NodeJS.ProcessEnv;
  for (const [name, value] of Object.entries(env)) {
    if (typeof value !== 'string') continue;
    const upperName = name.toUpperCase();
    if (FORBIDDEN_ENV_NAMES.has(upperName)) continue;
    if (FORBIDDEN_ENV_PREFIXES.some((prefix) => upperName.startsWith(prefix))) continue;
    if (SECRET_ENV_NAME.test(upperName)) continue;
    if (upperName.includes('CDP') || upperName.includes('REMOTE_DEBUGGING')) continue;
    if (CDP_CAPABILITY_VALUE.test(value)) continue;
    sanitized[name] = value;
  }
  return sanitized;
}

function decodeRetainedBytes(chunks: Buffer[]): string {
  const bytes = Buffer.concat(chunks);
  if (bytes.length === 0) return '';
  let start = bytes.length - 1;
  while (start >= 0 && (bytes[start]! & 0b1100_0000) === 0b1000_0000) start -= 1;
  if (start < 0) return '';
  const lead = bytes[start]!;
  const expected =
    lead >= 0b1111_0000 ? 4 : lead >= 0b1110_0000 ? 3 : lead >= 0b1100_0000 ? 2 : 1;
  const actual = bytes.length - start;
  return bytes.subarray(0, expected > 1 && actual < expected ? start : bytes.length).toString('utf8');
}

function validateOptions(options: BrowserProgramOptions): void {
  if (!isRecord(options)) throw new TypeError('browser program options must be an object');
  if (typeof options.code !== 'string') throw new TypeError('code must be a string');
  if (typeof options.cwd !== 'string' || options.cwd.length === 0) {
    throw new TypeError('cwd must be a non-empty string');
  }
  if (!isRecord(options.env)) {
    throw new TypeError('env must be an explicit environment object');
  }
  if (
    !isRecord(options.page) ||
    typeof options.page.pageId !== 'string' ||
    options.page.pageId.length === 0 ||
    Buffer.byteLength(options.page.pageId, 'utf8') > 4_096 ||
    typeof options.page.targetId !== 'string' ||
    options.page.targetId.length === 0 ||
    Buffer.byteLength(options.page.targetId, 'utf8') > 4_096
  ) {
    throw new TypeError(
      'page must contain non-empty pageId and targetId strings of at most 4096 bytes',
    );
  }
  if (typeof options.sendCdp !== 'function') throw new TypeError('sendCdp must be a function');
  if (typeof options.navigate !== 'function') throw new TypeError('navigate must be a function');
  if (typeof options.upload !== 'function') throw new TypeError('upload must be a function');
  if (
    !Number.isInteger(options.timeoutMs) ||
    options.timeoutMs <= 0 ||
    options.timeoutMs > BROWSER_PROGRAM_LIMITS.maxProgramTimeoutMs
  ) {
    throw new RangeError(
      `timeoutMs must be an integer from 1 through ${BROWSER_PROGRAM_LIMITS.maxProgramTimeoutMs}`,
    );
  }
  if (
    !Number.isInteger(options.maxOutputBytes) ||
    options.maxOutputBytes <= 0 ||
    options.maxOutputBytes > BROWSER_PROGRAM_LIMITS.maxCaptureOutputBytes
  ) {
    throw new RangeError(
      `maxOutputBytes must be an integer from 1 through ${BROWSER_PROGRAM_LIMITS.maxCaptureOutputBytes}`,
    );
  }
}

function immediateResult(
  startedAt: number,
  outcome: TerminalOutcome,
): BrowserProgramResult {
  return {
    status: outcome.status,
    durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
    ...(Object.prototype.hasOwnProperty.call(outcome, 'value') ? { value: outcome.value } : {}),
    stdout: '',
    stderr: '',
    ...(outcome.error ? { error: outcome.error } : {}),
  };
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

/**
 * Run one model-authored browser program in a fresh, bounded Node child.
 *
 * The child has a private Node IPC channel and receives source only in its
 * `start` message. It receives neither a CDP URL nor a provider object. Raw
 * commands are validated and routed through the caller's target-pinned
 * `sendCdp` function. The process boundary protects Sherlock's liveness and
 * globals; it is intentionally not described or implemented as a sandbox.
 */
export async function runBrowserProgram(
  options: BrowserProgramOptions,
): Promise<BrowserProgramResult> {
  validateOptions(options);
  const startedAt = performance.now();

  if (isAborted(options.abortSignal)) {
    return immediateResult(startedAt, { status: 'cancelled' });
  }

  if (process.platform === 'win32') {
    return immediateResult(startedAt, {
      status: 'failed',
      error: {
        name: 'UnsupportedPlatformError',
        message:
          'browser_execute currently requires POSIX process-group termination; Windows is not supported.',
      },
    });
  }

  const sourceBytes = Buffer.byteLength(options.code, 'utf8');
  if (sourceBytes > BROWSER_PROGRAM_LIMITS.maxSourceBytes) {
    return immediateResult(startedAt, {
      status: 'protocol_error',
      error: protocolError(
        `browser program source exceeds ${BROWSER_PROGRAM_LIMITS.maxSourceBytes} bytes`,
      ),
    });
  }

  let abortedDuringWatchdogStart = false;
  const onWatchdogStartAbort = (): void => {
    abortedDuringWatchdogStart = true;
  };
  options.abortSignal?.addEventListener('abort', onWatchdogStartAbort, {
    once: true,
  });

  let watchdog;
  try {
    watchdog = await startParentDeathWatchdog();
  } catch (error) {
    return immediateResult(startedAt, {
      status: 'failed',
      error: watchdogError(error, 'parent-death watchdog failed to start'),
    });
  } finally {
    options.abortSignal?.removeEventListener('abort', onWatchdogStartAbort);
  }

  if (abortedDuringWatchdogStart || isAborted(options.abortSignal)) {
    await watchdog.disarm();
    return immediateResult(startedAt, { status: 'cancelled' });
  }

  return new Promise<BrowserProgramResult>((resolve) => {
    let child: ChildProcess;
    try {
      child = fork(CHILD_MODULE, [], {
        cwd: options.cwd,
        env: sanitizeBrowserProgramEnvironment(options.env),
        execArgv: [],
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        detached: process.platform !== 'win32',
        serialization: 'json',
      });
    } catch (error) {
      void watchdog.disarm().then(() => {
        resolve(immediateResult(startedAt, { status: 'failed', error: structuredError(error) }));
      });
      return;
    }

    if (!child.stdout || !child.stderr) {
      child.kill('SIGKILL');
      void watchdog.disarm().then(() => {
        resolve(
          immediateResult(startedAt, {
            status: 'failed',
            error: protocolError('browser-program child was created without output pipes'),
          }),
        );
      });
      return;
    }

    let settled = false;
    let ready = false;
    let watchdogArmed = false;
    let startSent = false;
    let outcome: TerminalOutcome | undefined;
    let watchdogFailure: BrowserProgramError | undefined;
    let terminationStarted = false;
    let exitObserved = false;
    let stdoutEnded = false;
    let stderrEnded = false;
    let outputBytes = 0;
    let cdpCallCount = 0;
    let hostCallCount = 0;
    const pendingCdp = new Set<number>();
    const pendingHost = new Set<number>();
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    let timeoutTimer: NodeJS.Timeout | undefined;
    let graceKillTimer: NodeJS.Timeout | undefined;
    let strayKillTimer: NodeJS.Timeout | undefined;
    let drainTimer: NodeJS.Timeout | undefined;
    let terminationDeadlineTimer: NodeJS.Timeout | undefined;

    const clearTimers = (): void => {
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (graceKillTimer) clearTimeout(graceKillTimer);
      if (strayKillTimer) clearTimeout(strayKillTimer);
      if (drainTimer) clearTimeout(drainTimer);
      if (terminationDeadlineTimer) clearTimeout(terminationDeadlineTimer);
      timeoutTimer = undefined;
      graceKillTimer = undefined;
      strayKillTimer = undefined;
      drainTimer = undefined;
      terminationDeadlineTimer = undefined;
    };

    const killGroup = (signal: NodeJS.Signals): void => {
      const pid = child.pid;
      if (pid === undefined) return;
      try {
        if (process.platform === 'win32') child.kill(signal);
        else process.kill(-pid, signal);
      } catch {
        // ESRCH means the group is already gone. Other signal failures are
        // reflected by the hard termination deadline rather than hanging.
      }
    };

    const detachAbort = (): void => {
      options.abortSignal?.removeEventListener('abort', onAbort);
    };
    let detachWatchdogFailure = (): void => undefined;

    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimers();
      detachAbort();
      detachWatchdogFailure();
      killGroup('SIGKILL');
      child.stdout?.removeAllListeners();
      child.stderr?.removeAllListeners();
      child.removeAllListeners();
      const finalOutcome: TerminalOutcome = watchdogFailure
        ? { status: 'failed', error: watchdogFailure }
        : outcome ?? {
            status: 'failed',
            error: protocolError('browser-program child ended without a result'),
          };
      const result: BrowserProgramResult = {
        status: finalOutcome.status,
        durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
        ...(Object.prototype.hasOwnProperty.call(finalOutcome, 'value')
          ? { value: finalOutcome.value }
          : {}),
        stdout: decodeRetainedBytes(stdoutChunks),
        stderr: decodeRetainedBytes(stderrChunks),
        ...(finalOutcome.error ? { error: finalOutcome.error } : {}),
      };
      void watchdog.disarm().then(
        () => resolve(result),
        () => resolve(result),
      );
    };

    const maybeFinishAfterExit = (): void => {
      if (!exitObserved) return;
      if (stdoutEnded && stderrEnded) {
        finish();
        return;
      }
      if (!drainTimer) drainTimer = setTimeout(finish, DRAIN_DEADLINE_MS);
    };

    const beginTermination = (nextOutcome: TerminalOutcome): void => {
      if (settled) return;
      // Output that was already written can arrive after a success message on
      // the separate stdout pipe. It must still be allowed to replace success
      // with the stronger output-limit classification.
      if (
        !outcome ||
        (nextOutcome.status === 'output_limit_exceeded' &&
          (outcome.status === 'exited' || outcome.status === 'failed'))
      ) {
        outcome = nextOutcome;
      }
      if (terminationStarted) return;
      terminationStarted = true;
      if (timeoutTimer) {
        clearTimeout(timeoutTimer);
        timeoutTimer = undefined;
      }
      killGroup('SIGTERM');
      graceKillTimer = setTimeout(() => {
        graceKillTimer = undefined;
        killGroup('SIGKILL');
      }, TERMINATE_GRACE_MS);
      terminationDeadlineTimer = setTimeout(() => {
        terminationDeadlineTimer = undefined;
        killGroup('SIGKILL');
        finish();
      }, TERMINATION_DEADLINE_MS);
    };

    function onAbort(): void {
      beginTermination({ status: 'cancelled' });
    }

    detachWatchdogFailure = watchdog.onFailure((error) => {
      if (settled) return;
      watchdogFailure = watchdogError(
        error,
        'parent-death watchdog stopped while the browser program was active',
      );
      const failure: TerminalOutcome = {
        status: 'failed',
        error: watchdogFailure,
      };

      // Force the infrastructure failure even if cancellation, timeout, or a
      // program result already began ordinary termination. With the watcher
      // gone there can be no grace period during which a harness SIGKILL could
      // abandon this group.
      outcome = failure;
      beginTermination(failure);
      if (graceKillTimer) {
        clearTimeout(graceKillTimer);
        graceKillTimer = undefined;
      }
      killGroup('SIGKILL');
    });

    const maybeStartProgram = (): void => {
      if (!ready || !watchdogArmed || startSent || settled || terminationStarted) return;
      startSent = sendToChild({
        version: PROTOCOL_VERSION,
        kind: 'start',
        code: options.code,
        page: options.page,
        maxIpcMessageBytes: BROWSER_PROGRAM_LIMITS.maxIpcMessageBytes,
        maxResultBytes: BROWSER_PROGRAM_LIMITS.maxResultBytes,
      });
    };

    const appendOutput = (target: Buffer[], chunk: Buffer | string): void => {
      if (settled) return;
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const remaining = options.maxOutputBytes - outputBytes;
      if (remaining <= 0) {
        beginTermination({
          status: 'output_limit_exceeded',
          error: {
            name: 'OutputLimitError',
            message: `browser program output exceeds ${options.maxOutputBytes} bytes`,
          },
        });
        return;
      }
      const kept = bytes.length <= remaining ? bytes : bytes.subarray(0, remaining);
      target.push(kept);
      outputBytes += kept.length;
      if (bytes.length > kept.length) {
        beginTermination({
          status: 'output_limit_exceeded',
          error: {
            name: 'OutputLimitError',
            message: `browser program output exceeds ${options.maxOutputBytes} bytes`,
          },
        });
      }
    };

    child.stdout.on('data', (chunk: Buffer) => appendOutput(stdoutChunks, chunk));
    child.stderr.on('data', (chunk: Buffer) => appendOutput(stderrChunks, chunk));
    child.stdout.once('end', () => {
      stdoutEnded = true;
      maybeFinishAfterExit();
    });
    child.stderr.once('end', () => {
      stderrEnded = true;
      maybeFinishAfterExit();
    });

    const sendToChild = (message: Record<string, unknown>): boolean => {
      let size: number;
      try {
        size = serializedSize(message);
      } catch (error) {
        beginTermination({ status: 'protocol_error', error: structuredError(error) });
        return false;
      }
      if (size > BROWSER_PROGRAM_LIMITS.maxIpcMessageBytes) {
        beginTermination({
          status: 'protocol_error',
          error: protocolError(
            `parent IPC message exceeds ${BROWSER_PROGRAM_LIMITS.maxIpcMessageBytes} bytes`,
          ),
        });
        return false;
      }
      if (!child.connected) {
        beginTermination({
          status: 'protocol_error',
          error: protocolError('browser-program IPC channel closed unexpectedly'),
        });
        return false;
      }
      try {
        child.send(message, (error) => {
          if (error && !settled) {
            beginTermination({ status: 'protocol_error', error: structuredError(error) });
          }
        });
        return true;
      } catch (error) {
        beginTermination({ status: 'protocol_error', error: structuredError(error) });
        return false;
      }
    };

    const replyToCdp = (id: number, ok: boolean, valueOrError: unknown): void => {
      if (settled || outcome) return;
      if (ok) {
        let value: unknown;
        try {
          value = normalizedJsonValue(valueOrError);
          const response = {
            version: PROTOCOL_VERSION,
            kind: 'cdp_response',
            id,
            ok: true,
            value,
          };
          if (serializedSize(response) > BROWSER_PROGRAM_LIMITS.maxIpcMessageBytes) {
            throw new RangeError(
              `CDP reply exceeds ${BROWSER_PROGRAM_LIMITS.maxIpcMessageBytes} bytes`,
            );
          }
          sendToChild(response);
          return;
        } catch (error) {
          valueOrError = error;
        }
      }
      sendToChild({
        version: PROTOCOL_VERSION,
        kind: 'cdp_response',
        id,
        ok: false,
        error: structuredError(valueOrError),
      });
    };

    const replyToHost = (id: number, value: unknown, error?: unknown): void => {
      if (settled || outcome) return;
      if (error !== undefined) {
        sendToChild({
          version: PROTOCOL_VERSION,
          kind: 'host_response',
          id,
          ok: false,
          error: structuredError(error),
        });
        return;
      }
      try {
        const response = {
          version: PROTOCOL_VERSION,
          kind: 'host_response',
          id,
          ok: true,
          value: normalizedJsonValue(value),
        };
        if (serializedSize(response) > BROWSER_PROGRAM_LIMITS.maxIpcMessageBytes) {
          throw new RangeError(
            `host reply exceeds ${BROWSER_PROGRAM_LIMITS.maxIpcMessageBytes} bytes`,
          );
        }
        sendToChild(response);
      } catch (replyError) {
        sendToChild({
          version: PROTOCOL_VERSION,
          kind: 'host_response',
          id,
          ok: false,
          error: structuredError(replyError),
        });
      }
    };

    const handleCdpRequest = (message: Record<string, unknown>): void => {
      const id = message.id;
      const method = message.method;
      const params = message.params;
      if (
        !Number.isSafeInteger(id) ||
        (id as number) <= 0 ||
        typeof method !== 'string' ||
        method.length === 0 ||
        Buffer.byteLength(method, 'utf8') > MAX_CDP_METHOD_BYTES ||
        !isRecord(params)
      ) {
        beginTermination({
          status: 'protocol_error',
          error: protocolError('child sent a malformed CDP request'),
        });
        return;
      }
      const requestId = id as number;
      if (pendingCdp.has(requestId) || pendingHost.has(requestId)) {
        beginTermination({
          status: 'protocol_error',
          error: protocolError(`child reused pending CDP request id ${requestId}`),
        });
        return;
      }
      cdpCallCount += 1;
      if (
        cdpCallCount > BROWSER_PROGRAM_LIMITS.maxCdpCalls ||
        pendingCdp.size >= BROWSER_PROGRAM_LIMITS.maxPendingCdpCalls
      ) {
        beginTermination({
          status: 'protocol_error',
          error: protocolError('browser program exceeded its CDP request budget'),
        });
        return;
      }
      pendingCdp.add(requestId);
      Promise.resolve()
        .then(() => options.sendCdp(method, params))
        .then(
          (value) => replyToCdp(requestId, true, value),
          (error: unknown) => replyToCdp(requestId, false, error),
        )
        .finally(() => pendingCdp.delete(requestId));
    };

    const handleHostRequest = (message: Record<string, unknown>): void => {
      const id = message.id;
      const operation = message.operation;
      const params = message.params;
      const validEnvelope =
        Number.isSafeInteger(id) &&
        (id as number) > 0 &&
        isRecord(params) &&
        !Object.keys(message).some(
          (key) =>
            key !== 'version' &&
            key !== 'kind' &&
            key !== 'id' &&
            key !== 'operation' &&
            key !== 'params',
        );
      const validUpload =
        operation === 'upload' &&
        isRecord(params) &&
        Number.isInteger(params.backendDOMNodeId) &&
        (params.backendDOMNodeId as number) > 0 &&
        (params.backendDOMNodeId as number) <= 2_147_483_647 &&
        typeof params.workspacePath === 'string' &&
        params.workspacePath.length > 0 &&
        Buffer.byteLength(params.workspacePath, 'utf8') <=
          BROWSER_PROGRAM_LIMITS.maxWorkspacePathBytes &&
        !Object.keys(params).some(
          (key) => key !== 'backendDOMNodeId' && key !== 'workspacePath',
        );
      const validNavigation =
        operation === 'navigate' &&
        isRecord(params) &&
        typeof params.url === 'string' &&
        params.url.length > 0 &&
        Buffer.byteLength(params.url, 'utf8') <= MAX_NAVIGATION_URL_BYTES &&
        Number.isInteger(params.timeoutMs) &&
        (params.timeoutMs as number) >= 1 &&
        (params.timeoutMs as number) <= MAX_NAVIGATION_TIMEOUT_MS &&
        (params.waitUntil === 'domcontentloaded' || params.waitUntil === 'load') &&
        !Object.keys(params).some(
          (key) => key !== 'url' && key !== 'timeoutMs' && key !== 'waitUntil',
        );
      if (
        !validEnvelope ||
        (!validUpload && !validNavigation)
      ) {
        beginTermination({
          status: 'protocol_error',
          error: protocolError('child sent a malformed browser host request'),
        });
        return;
      }
      const requestId = id as number;
      if (pendingHost.has(requestId) || pendingCdp.has(requestId)) {
        beginTermination({
          status: 'protocol_error',
          error: protocolError(`child reused pending request id ${requestId}`),
        });
        return;
      }
      hostCallCount += 1;
      if (
        hostCallCount > BROWSER_PROGRAM_LIMITS.maxHostCalls ||
        pendingHost.size >= BROWSER_PROGRAM_LIMITS.maxPendingHostCalls
      ) {
        beginTermination({
          status: 'protocol_error',
          error: protocolError('browser program exceeded its host request budget'),
        });
        return;
      }
      pendingHost.add(requestId);
      const effect = validUpload
        ? () =>
            options
              .upload(
                params.backendDOMNodeId as number,
                params.workspacePath as string,
              )
              .then(() => null)
        : () =>
            options.navigate(params.url as string, {
              timeoutMs: params.timeoutMs as number,
              waitUntil: params.waitUntil as 'domcontentloaded' | 'load',
            });
      Promise.resolve()
        .then(effect)
        .then(
          (value) => replyToHost(requestId, value),
          (error: unknown) => replyToHost(requestId, null, error),
        )
        .finally(() => pendingHost.delete(requestId));
    };

    const handleProgramResult = (message: Record<string, unknown>): void => {
      if (!startSent || typeof message.ok !== 'boolean') {
        beginTermination({
          status: 'protocol_error',
          error: protocolError('child sent a malformed program result'),
        });
        return;
      }
      if (message.ok) {
        if (typeof message.hasValue !== 'boolean') {
          beginTermination({
            status: 'protocol_error',
            error: protocolError('successful child result is missing hasValue'),
          });
          return;
        }
        if (message.hasValue && !Object.prototype.hasOwnProperty.call(message, 'value')) {
          beginTermination({
            status: 'protocol_error',
            error: protocolError('successful child result is missing value'),
          });
          return;
        }
        if (!message.hasValue && Object.prototype.hasOwnProperty.call(message, 'value')) {
          beginTermination({
            status: 'protocol_error',
            error: protocolError('successful child result has an unexpected value'),
          });
          return;
        }
        if (message.hasValue) {
          let valueBytes: number;
          try {
            valueBytes = serializedSize(message.value);
          } catch (error) {
            beginTermination({ status: 'protocol_error', error: structuredError(error) });
            return;
          }
          if (valueBytes > BROWSER_PROGRAM_LIMITS.maxResultBytes) {
            beginTermination({
              status: 'output_limit_exceeded',
              error: {
                name: 'ResultLimitError',
                message: `browser program result exceeds ${BROWSER_PROGRAM_LIMITS.maxResultBytes} bytes`,
              },
            });
            return;
          }
        }
        beginTermination({
          status: 'exited',
          ...(message.hasValue ? { value: message.value } : {}),
        });
        return;
      }

      if (!isRecord(message.error) || typeof message.failure !== 'string') {
        beginTermination({
          status: 'protocol_error',
          error: protocolError('failed child result is missing a structured error'),
        });
        return;
      }
      const error: BrowserProgramError = {
        name:
          typeof message.error.name === 'string'
            ? truncateUtf8(redactCapabilities(message.error.name), MAX_ERROR_NAME_BYTES)
            : 'Error',
        message:
          typeof message.error.message === 'string'
            ? truncateUtf8(
                redactCapabilities(message.error.message),
                MAX_ERROR_MESSAGE_BYTES,
              )
            : 'browser program failed',
        ...(typeof message.error.stack === 'string'
          ? {
              stack: truncateUtf8(
                redactCapabilities(message.error.stack),
                MAX_ERROR_STACK_BYTES,
              ),
            }
          : {}),
      };
      if (message.failure === 'result_limit') {
        beginTermination({ status: 'output_limit_exceeded', error });
      } else if (message.failure === 'program') {
        beginTermination({ status: 'failed', error });
      } else if (message.failure === 'protocol') {
        beginTermination({ status: 'protocol_error', error });
      } else {
        beginTermination({
          status: 'protocol_error',
          error: protocolError(`child returned unknown failure kind ${message.failure}`),
        });
      }
    };

    child.on('message', (rawMessage: unknown) => {
      if (settled || outcome) return;
      let messageBytes: number;
      try {
        messageBytes = serializedSize(rawMessage);
      } catch (error) {
        beginTermination({ status: 'protocol_error', error: structuredError(error) });
        return;
      }
      if (messageBytes > BROWSER_PROGRAM_LIMITS.maxIpcMessageBytes) {
        beginTermination({
          status: 'protocol_error',
          error: protocolError(
            `child IPC message exceeds ${BROWSER_PROGRAM_LIMITS.maxIpcMessageBytes} bytes`,
          ),
        });
        return;
      }
      if (
        !isRecord(rawMessage) ||
        rawMessage.version !== PROTOCOL_VERSION ||
        typeof rawMessage.kind !== 'string'
      ) {
        beginTermination({
          status: 'protocol_error',
          error: protocolError('child sent a malformed browser-program IPC message'),
        });
        return;
      }

      if (rawMessage.kind === 'ready') {
        if (ready || startSent || Object.keys(rawMessage).length !== 2) {
          beginTermination({
            status: 'protocol_error',
            error: protocolError('child sent an invalid ready message'),
          });
          return;
        }
        ready = true;
        maybeStartProgram();
        return;
      }
      if (!ready || !startSent) {
        beginTermination({
          status: 'protocol_error',
          error: protocolError('child sent a message before the start handshake'),
        });
        return;
      }
      if (rawMessage.kind === 'cdp_request') {
        handleCdpRequest(rawMessage);
      } else if (rawMessage.kind === 'host_request') {
        handleHostRequest(rawMessage);
      } else if (rawMessage.kind === 'program_result') {
        handleProgramResult(rawMessage);
      } else {
        beginTermination({
          status: 'protocol_error',
          error: protocolError(`child sent unknown IPC message kind ${rawMessage.kind}`),
        });
      }
    });

    child.once('error', (error) => {
      if (child.pid === undefined) {
        outcome = { status: 'failed', error: structuredError(error) };
        finish();
      } else {
        beginTermination({ status: 'failed', error: structuredError(error) });
      }
    });

    child.once('exit', (code, signal) => {
      exitObserved = true;
      if (graceKillTimer) {
        clearTimeout(graceKillTimer);
        graceKillTimer = undefined;
      }
      killGroup('SIGTERM');
      strayKillTimer = setTimeout(() => {
        strayKillTimer = undefined;
        killGroup('SIGKILL');
      }, STRAY_KILL_DELAY_MS);
      if (!outcome) {
        outcome = {
          status: 'failed',
          error: protocolError(
            `browser-program child exited before returning a result (code ${String(code)}, signal ${String(signal)})`,
          ),
        };
      }
      maybeFinishAfterExit();
    });

    child.once('disconnect', () => {
      if (!outcome && !exitObserved) {
        beginTermination({
          status: 'protocol_error',
          error: protocolError('browser-program IPC channel disconnected before a result'),
        });
      }
    });

    timeoutTimer = setTimeout(() => {
      timeoutTimer = undefined;
      beginTermination({ status: 'timed_out' });
    }, options.timeoutMs);

    if (options.abortSignal) {
      options.abortSignal.addEventListener('abort', onAbort, { once: true });
      if (options.abortSignal.aborted) onAbort();
    }

    void watchdog.arm(child.pid ?? -1).then(
      () => {
        watchdogArmed = true;
        maybeStartProgram();
      },
      (error: unknown) => {
        beginTermination({
          status: 'failed',
          error: watchdogError(
            error,
            'parent-death watchdog failed while arming the browser program',
          ),
        });
      },
    );
  });
}
