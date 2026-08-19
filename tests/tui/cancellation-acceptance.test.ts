import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import type { BrowserController } from '../../src/browser/controller.js';
import { LocalChromeBrowserSessionProvider } from '../../src/browser/playwrightBrowserController.js';
import type { CallModel, ModelResponse } from '../../src/loop/messages.js';
import { readManifest } from '../../src/run/artifacts.js';
import type { RunTracing } from '../../src/tracing/runTracing.js';
import { createTuiRuntime } from '../../src/tui/bridge/runtime.js';
import {
  startRun,
  type RunHandle,
  type RunSessionDeps,
} from '../../src/tui/bridge/runSession.js';
import type { UiEvent } from '../../src/tui/store/state.js';
import {
  V3_HARNESS_DIR,
  V3_RUN_CHECKPOINT_FILENAME,
  V3_RUN_LOCK_FILENAME,
} from '../../src/v3/run/checkpoint.js';
import {
  scriptedResponse,
  scriptedStreamFactory,
} from './streamFixtures.js';

const BROWSER_CANCELLATION_TASK =
  'Exercise browser cancellation without publishing the requested output.';
const BASH_CANCELLATION_TASK =
  'Exercise Bash cancellation without publishing the requested output.';
const RECOVERY_TASK =
  'Prove the same TUI browser session still works and publish success.md. Do not take screenshots.';

const PARTIAL_BROWSER_BYTES = 'browser prefix written before cancellation\n';
const PARTIAL_BASH_BYTES = 'bash prefix written before cancellation\n';
const SUCCESS_DOCUMENT =
  '# Recovered\n\nThe reused TUI browser session returned 42.\n';
const RUN_TIMEOUT_MS = 20_000;
const MARKER_TIMEOUT_MS = 15_000;

type StreamFactory = NonNullable<RunSessionDeps['createStream']>;

const initializerCallModel: CallModel = async () => ({
  content: [
    {
      type: 'tool_use',
      id: 'contract-cancellation-acceptance',
      name: 'set_output_contract',
      input: {
        contract: {
          outputs: [
            {
              id: 'success',
              kind: 'document',
              filename: 'success.md',
              format: 'markdown',
              evidenceRequirement: 'none',
              evidencePresentation: 'hidden',
            },
          ],
        },
      },
    },
  ],
  stop_reason: 'tool_use',
  usage: { input_tokens: 40, output_tokens: 10 },
});

const verifierCallModel: CallModel = async () => verifiedResponse();

function verifiedResponse(): ModelResponse {
  return {
    content: [
      {
        type: 'tool_use',
        id: 'verify-cancellation-recovery',
        name: 'report_verification',
        input: { status: 'verified', findings: [] },
      },
    ],
    stop_reason: 'tool_use',
    usage: { input_tokens: 10, output_tokens: 2 },
  };
}

function stubbornDescendantSource(): string {
  return [
    "process.on('SIGTERM', () => {});",
    '// Finite even if the process-group cleanup regresses.',
    'setTimeout(() => process.exit(0), 15000);',
  ].join('\n');
}

function browserCancellationResponse() {
  const descendantSource = stubbornDescendantSource();
  return scriptedResponse(
    [
      {
        type: 'tool_use',
        id: 'cancel-real-browser-child',
        name: 'browser_execute',
        input: {
          timeout_ms: RUN_TIMEOUT_MS,
          code: `
            const fs = await import('node:fs');
            const { spawn } = await import('node:child_process');
            const ownedPage = await browser.open('about:blank#cancel-owned');
            const descendant = spawn(
              process.execPath,
              ['-e', ${JSON.stringify(descendantSource)}],
              { stdio: 'ignore' }
            );
            if (descendant.pid === undefined) {
              throw new Error('browser descendant did not receive a pid');
            }
            const partial = fs.openSync('browser-partial.txt', 'w');
            fs.writeSync(partial, ${JSON.stringify(PARTIAL_BROWSER_BYTES)});
            fs.writeFileSync('browser-child.pid', String(process.pid));
            fs.writeFileSync('browser-descendant.pid', String(descendant.pid));
            fs.writeFileSync('browser-owned-page.json', JSON.stringify(ownedPage));
            await new Promise(() => {});
          `,
        },
      },
    ],
    { input: 100, output: 20 },
    'tool_use',
  );
}

function bashCancellationResponse() {
  const descendantSource = stubbornDescendantSource();
  const commandSource = `
    const fs = require('node:fs');
    const { spawn } = require('node:child_process');
    const descendant = spawn(
      process.execPath,
      ['-e', ${JSON.stringify(descendantSource)}],
      { stdio: 'ignore' }
    );
    if (descendant.pid === undefined) {
      throw new Error('bash descendant did not receive a pid');
    }
    const partial = fs.openSync('bash-partial.txt', 'w');
    fs.writeSync(partial, ${JSON.stringify(PARTIAL_BASH_BYTES)});
    fs.writeFileSync('bash-child.pid', String(process.pid));
    fs.writeFileSync('bash-descendant.pid', String(descendant.pid));
    setTimeout(() => process.exit(0), 15000);
  `;
  return scriptedResponse(
    [
      {
        type: 'tool_use',
        id: 'cancel-real-bash-child',
        name: 'bash',
        input: {
          command: `${shellQuote(process.execPath)} -e ${shellQuote(commandSource)}`,
          timeout_ms: RUN_TIMEOUT_MS,
        },
      },
    ],
    { input: 100, output: 20 },
    'tool_use',
  );
}

function recoveryResponses() {
  return [
    scriptedResponse(
      [
        {
          type: 'tool_use',
          id: 'browser-after-cancellation',
          name: 'browser_execute',
          input: {
            code: `
              return {
                answer: await browser.js('6 * 7'),
                page: await browser.pageInfo()
              };
            `,
          },
        },
        {
          type: 'tool_use',
          id: 'publish-after-cancellation',
          name: 'publish_artifact',
          input: {
            kind: 'text',
            artifact_path: 'artifacts/success.md',
            roles: ['requested_output'],
            content: SUCCESS_DOCUMENT,
          },
        },
      ],
      { input: 120, output: 30 },
      'tool_use',
    ),
    scriptedResponse(
      [
        {
          type: 'tool_use',
          id: 'finish-after-cancellation',
          name: 'finish',
          input: {
            summary: 'The same TUI browser session completed a later task.',
            unresolved: [],
          },
        },
      ],
      { input: 80, output: 15 },
      'tool_use',
    ),
  ];
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function noopTracing(): RunTracing {
  return {
    wrapCallModel: (callModel) => callModel,
    wrapRegistry: (registry) => registry,
    traceRun: (_task, operation) => operation(),
    flush: async () => {},
    close: async () => {},
  };
}

function runDirFrom(events: readonly UiEvent[]): string | undefined {
  return events.find(
    (event): event is Extract<UiEvent, { type: 'run_dir' }> =>
      event.type === 'run_dir',
  )?.runDir;
}

async function waitForValue<T>(
  read: () => T | undefined,
  description: string,
  timeoutMs = MARKER_TIMEOUT_MS,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (value !== undefined) return value;
    if (Date.now() >= deadline) {
      throw new Error(`timed out waiting for ${description}`);
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}

function readPid(path: string): number | undefined {
  if (!existsSync(path)) return undefined;
  const pid = Number(readFileSync(path, 'utf8'));
  return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined;
}

function processIsLive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

async function expectProcessesGone(
  pids: readonly number[],
  description: string,
): Promise<void> {
  await waitForValue(
    () => (pids.every((pid) => !processIsLive(pid)) ? true : undefined),
    `${description} process tree to exit`,
    5_000,
  );
  for (const pid of pids) expect(processIsLive(pid), `pid ${pid}`).toBe(false);
}

function workspaceFiles(runDir: string): string[] {
  const workspace = join(runDir, 'scratch/workspace');
  const files: string[] = [];

  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(absolute);
      } else if (entry.isFile()) {
        files.push(`scratch/workspace/${relative(workspace, absolute)}`);
      } else {
        throw new Error(`unexpected non-file workspace entry: ${absolute}`);
      }
    }
  };

  visit(workspace);
  return files.sort();
}

function expectWorkspaceFullyManifested(runDir: string): void {
  const manifest = readManifest(runDir);
  const files = workspaceFiles(runDir);
  const entries = manifest.artifacts
    .filter((entry) => entry.filename.startsWith('scratch/workspace/'))
    .sort((left, right) => left.filename.localeCompare(right.filename));

  expect(entries.map((entry) => entry.filename)).toEqual(files);
  for (const entry of entries) {
    const bytes = readFileSync(join(runDir, entry.filename));
    expect(entry.sha256).toBe(
      createHash('sha256').update(bytes).digest('hex'),
    );
    expect(entry.roles).toBeUndefined();
  }
  expect(manifest.finishedAt).toEqual(expect.any(String));
}

function expectCancelledRunFinalized(runDir: string): void {
  expect(
    existsSync(join(runDir, V3_HARNESS_DIR, V3_RUN_LOCK_FILENAME)),
  ).toBe(false);
  expect(
    JSON.parse(
      readFileSync(
        join(runDir, V3_HARNESS_DIR, V3_RUN_CHECKPOINT_FILENAME),
        'utf8',
      ),
    ),
  ).toMatchObject({
    phase: 'terminal',
    outcome: { status: 'cancelled' },
  });
  expect(
    JSON.parse(readFileSync(join(runDir, 'metrics.json'), 'utf8')),
  ).toMatchObject({ status: 'cancelled' });
  expectWorkspaceFullyManifested(runDir);
}

describe('Sherlock v3 cancellation acceptance', () => {
  it.skipIf(process.platform === 'win32')(
    'contains real browser and Bash process trees, finalizes their runs, and reuses the TUI session',
    async () => {
      const runsBaseDir = mkdtempSync(
        join(tmpdir(), 'sherlock-v3-cancellation-runs-'),
      );
      const profileDir = mkdtempSync(
        join(tmpdir(), 'sherlock-v3-cancellation-chrome-'),
      );
      const managedProvider = new LocalChromeBrowserSessionProvider({
        profileDir,
        headless: true,
      });
      let browser: BrowserController | undefined;
      const createSession = vi.fn(async () => {
        browser = await managedProvider.createSession();
        return browser;
      });

      const streams = new Map<string, StreamFactory>([
        [
          BROWSER_CANCELLATION_TASK,
          scriptedStreamFactory([browserCancellationResponse()]).createStream,
        ],
        [
          BASH_CANCELLATION_TASK,
          scriptedStreamFactory([bashCancellationResponse()]).createStream,
        ],
        [
          RECOVERY_TASK,
          scriptedStreamFactory(recoveryResponses()).createStream,
        ],
      ]);
      const runtime = createTuiRuntime({
        browserSessionProvider: { createSession },
        runsBaseDir,
        runConfig: {
          javascriptPolicy: 'allow',
          maxTurns: 6,
          harness: {
            initializerCallModel,
            verifierCallModel,
          },
          tracingDelegate: noopTracing(),
        },
        startRunFn: (task, deps) => {
          const createStream = streams.get(task);
          if (createStream === undefined) {
            throw new Error(`missing scripted worker for ${JSON.stringify(task)}`);
          }
          return startRun(task, { ...deps, createStream });
        },
      });
      const handles: RunHandle[] = [];

      await runtime.start();
      try {
        const browserEvents: UiEvent[] = [];
        const browserHandle = runtime.startRun(
          BROWSER_CANCELLATION_TASK,
          (event) => browserEvents.push(event),
        );
        handles.push(browserHandle);
        const browserRunDir = await waitForValue(
          () => runDirFrom(browserEvents),
          'the browser-cancellation run directory',
        );
        const browserPids = await waitForValue(() => {
          const child = readPid(
            join(browserRunDir, 'scratch/workspace/browser-child.pid'),
          );
          const descendant = readPid(
            join(browserRunDir, 'scratch/workspace/browser-descendant.pid'),
          );
          const pageMarker = join(
            browserRunDir,
            'scratch/workspace/browser-owned-page.json',
          );
          const partial = join(
            browserRunDir,
            'scratch/workspace/browser-partial.txt',
          );
          if (
            child === undefined ||
            descendant === undefined ||
            !existsSync(pageMarker) ||
            !existsSync(partial)
          ) {
            return undefined;
          }
          return { child, descendant, pageMarker };
        }, 'the real browser child, descendant, owned page, and partial file');

        expect(browserPids.child).not.toBe(process.pid);
        expect(browserPids.descendant).not.toBe(browserPids.child);
        expect(
          JSON.parse(readFileSync(browserPids.pageMarker, 'utf8')),
        ).toMatchObject({
          targetId: expect.any(String),
          url: 'about:blank#cancel-owned',
        });
        expect(
          browserEvents.some(
            (event) =>
              event.type === 'tool_exec_start' &&
              event.name === 'browser_execute',
          ),
        ).toBe(true);
        const sessionBrowser = browser;
        if (sessionBrowser === undefined) {
          throw new Error('managed browser did not start');
        }
        expect(
          (await sessionBrowser.pages()).map((page) => page.url).sort(),
        ).toEqual(['about:blank', 'about:blank#cancel-owned'].sort());

        browserHandle.cancel();
        await expect(browserHandle.done).resolves.toEqual({
          status: 'cancelled',
        });
        await expectProcessesGone(
          [browserPids.child, browserPids.descendant],
          'browser_execute',
        );
        expectCancelledRunFinalized(browserRunDir);
        expect(
          readFileSync(
            join(browserRunDir, 'scratch/workspace/browser-partial.txt'),
            'utf8',
          ),
        ).toBe(PARTIAL_BROWSER_BYTES);
        expect(browserEvents.at(-1)).toMatchObject({
          type: 'run_cancelled',
        });
        expect(await sessionBrowser.pages()).toEqual([]);

        const bashEvents: UiEvent[] = [];
        const bashHandle = runtime.startRun(
          BASH_CANCELLATION_TASK,
          (event) => bashEvents.push(event),
        );
        handles.push(bashHandle);
        const bashRunDir = await waitForValue(
          () => runDirFrom(bashEvents),
          'the Bash-cancellation run directory',
        );
        const bashPids = await waitForValue(() => {
          const child = readPid(
            join(bashRunDir, 'scratch/workspace/bash-child.pid'),
          );
          const descendant = readPid(
            join(bashRunDir, 'scratch/workspace/bash-descendant.pid'),
          );
          const partial = join(
            bashRunDir,
            'scratch/workspace/bash-partial.txt',
          );
          if (
            child === undefined ||
            descendant === undefined ||
            !existsSync(partial)
          ) {
            return undefined;
          }
          return { child, descendant };
        }, 'the real Bash child, descendant, and partial file');

        expect(bashPids.child).not.toBe(process.pid);
        expect(bashPids.descendant).not.toBe(bashPids.child);
        expect(
          bashEvents.some(
            (event) =>
              event.type === 'tool_exec_start' && event.name === 'bash',
          ),
        ).toBe(true);

        bashHandle.cancel();
        await expect(bashHandle.done).resolves.toEqual({
          status: 'cancelled',
        });
        await expectProcessesGone(
          [bashPids.child, bashPids.descendant],
          'Bash',
        );
        expectCancelledRunFinalized(bashRunDir);
        expect(
          readFileSync(
            join(bashRunDir, 'scratch/workspace/bash-partial.txt'),
            'utf8',
          ),
        ).toBe(PARTIAL_BASH_BYTES);
        expect(bashEvents.at(-1)).toMatchObject({ type: 'run_cancelled' });
        expect(await sessionBrowser.pages()).toEqual([]);

        const recoveryEvents: UiEvent[] = [];
        const recoveryHandle = runtime.startRun(
          RECOVERY_TASK,
          (event) => recoveryEvents.push(event),
        );
        handles.push(recoveryHandle);
        const recoveryOutcome = await recoveryHandle.done;
        expect(
          recoveryOutcome.status,
          JSON.stringify(recoveryOutcome),
        ).toBe('verified');
        if (recoveryOutcome.status !== 'verified') {
          throw new Error('recovery task did not verify');
        }
        expect(recoveryOutcome.finalText).toBe(
          'The same TUI browser session completed a later task.',
        );
        expect(
          readFileSync(
            join(recoveryOutcome.runDir, 'artifacts/success.md'),
            'utf8',
          ),
        ).toBe(SUCCESS_DOCUMENT);
        const recoveredBrowserResult = recoveryEvents.find(
          (event) =>
            event.type === 'tool_exec_end' &&
            event.ok &&
            typeof event.result === 'object' &&
            event.result !== null &&
            'status' in event.result,
        );
        expect(recoveredBrowserResult).toMatchObject({
          type: 'tool_exec_end',
          ok: true,
          result: {
            status: 'exited',
            value: { answer: 42 },
          },
        });
        expect(
          existsSync(
            join(
              recoveryOutcome.runDir,
              V3_HARNESS_DIR,
              V3_RUN_LOCK_FILENAME,
            ),
          ),
        ).toBe(false);
        expect(await sessionBrowser.pages()).toEqual([]);
        expect(browser).toBe(sessionBrowser);
        expect(createSession).toHaveBeenCalledTimes(1);
      } finally {
        for (const handle of handles) handle.cancel();
        await Promise.allSettled(handles.map((handle) => handle.done));
        await runtime.shutdown();
        rmSync(runsBaseDir, { recursive: true, force: true });
        rmSync(profileDir, { recursive: true, force: true });
      }
    },
    60_000,
  );
});
