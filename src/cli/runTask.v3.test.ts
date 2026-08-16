import {
  mkdtempSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { BrowserController } from '../browser/controller.js';
import type { OutputContract } from '../contracts/outputContract.js';
import type {
  Message,
  ModelResponse,
  Usage,
} from '../loop/messages.js';
import type { ProgressEvent } from '../model/callModel.js';
import {
  readManifest,
} from '../run/artifacts.js';
import type { RunTracing } from '../tracing/runTracing.js';
import type { ResumeTaskConfig } from './runTask.js';
import {
  readV3CheckpointConfiguration,
} from '../v3/run/checkpoint.js';
import { BROWSER_EXECUTE_POLICY_DENIED_MESSAGE } from '../v3/tools/browserExecute.js';
import {
  V3_PRODUCTION_DEFAULTS,
  resumeTask,
  runTask,
} from './runTask.js';

const TASK =
  'Publish report.csv with exactly one name column and one data row. Do not take screenshots.';
const REPORT = 'name\nAlice\n';
const FINISH = {
  summary: 'Published the requested one-row report.',
  limitations: [],
};

const CONTRACT: OutputContract = {
  outputs: [
    {
      id: 'report',
      kind: 'table',
      filename: 'report.csv',
      format: 'csv',
      columns: [{ name: 'name', required: true, type: 'string' }],
      rules: [{ type: 'exact_row_count', value: 1 }],
    },
  ],
};

const INITIALIZER_USAGE: Usage = { input_tokens: 5, output_tokens: 2 };
const PUBLISH_USAGE: Usage = { input_tokens: 7, output_tokens: 3 };
const FINISH_USAGE: Usage = {
  input_tokens: 11,
  output_tokens: 4,
  cache_read_input_tokens: 6,
};
const VERIFIER_USAGE: Usage = { input_tokens: 13, output_tokens: 2 };

let tempRoot: string;
let runsBaseDir: string;

beforeEach(() => {
  tempRoot = mkdtempSync(join(tmpdir(), 'sherlock-run-task-v3-'));
  runsBaseDir = join(tempRoot, 'runs');
});

afterEach(() => {
  rmSync(tempRoot, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('public runTask v3 adapter', () => {
  it('uses v3 by default, persists finite defaults, and orders worker progress', async () => {
    const browser = fakeBrowser();
    const progress: ProgressEvent[] = [];
    const tracing = recordingTracing();
    const run = await runVerifiedV3({
      browser,
      tracing: tracing.tracing,
      onProgress: (event) => progress.push(event),
    });

    expect(run.result).toEqual({
      runDir: run.result.runDir,
      status: 'verified',
      finalText: FINISH.summary,
    });
    expect(readFileSync(join(run.result.runDir, 'artifacts/report.csv'), 'utf8')).toBe(
      REPORT,
    );
    const configuration = readV3CheckpointConfiguration(run.result.runDir);
    expect(configuration).toMatchObject({
      maxOutputTokens: V3_PRODUCTION_DEFAULTS.maxOutputTokens,
      maxContextTokens: V3_PRODUCTION_DEFAULTS.maxContextTokens,
      maxCompletionCheckFailures:
        V3_PRODUCTION_DEFAULTS.maxCompletionCheckFailures,
      budgetLimits: {
        maxWorkerTurns: V3_PRODUCTION_DEFAULTS.maxWorkerTurns,
        maxToolCalls: V3_PRODUCTION_DEFAULTS.maxToolCalls,
        maxModelTokens: V3_PRODUCTION_DEFAULTS.maxModelTokens,
        maxToolResultBytes: V3_PRODUCTION_DEFAULTS.maxToolResultBytes,
        maxWallTimeMs: V3_PRODUCTION_DEFAULTS.maxWallTimeMs,
        maxVerifierCorrections:
          V3_PRODUCTION_DEFAULTS.maxVerifierCorrections,
      },
    });
    expect(
      Object.values(V3_PRODUCTION_DEFAULTS).every(
        (value) => Number.isFinite(value) && value > 0,
      ),
    ).toBe(true);

    expect(progress).toEqual([
      { type: 'turn_start', turn: 1 },
      { type: 'turn_end', turn: 1, usage: PUBLISH_USAGE },
      { type: 'turn_start', turn: 2 },
      { type: 'turn_end', turn: 2, usage: FINISH_USAGE },
    ]);
    expect(run.initializer.callModel).toHaveBeenCalledOnce();
    expect(run.worker.callModel).toHaveBeenCalledTimes(2);
    expect(run.verifier.callModel).toHaveBeenCalledOnce();
    expect(browser.prepareTaskPage).toHaveBeenCalledOnce();
    expect(browser.closeTaskPages).toHaveBeenCalledOnce();
    expect(tracing.traceRuns).toBe(1);
    expect(tracing.runDirs).toEqual([run.result.runDir]);
    expect(tracing.modelCalls).toBe(2);
    expect(tracing.toolExecutions).toEqual(['publish_artifact']);
    expect(tracing.closeCalls).toBe(1);

    const transcript = readTranscript(run.result.runDir);
    expect(
      transcript
        .filter((event) => event.type === 'tool_call')
        .map((event) => (event.call as { name: string }).name),
    ).toEqual(['publish_artifact', 'finish']);
    expect(transcript.some((event) => event.type === 'finish_requested')).toBe(
      true,
    );

    const manifest = readManifest(run.result.runDir);
    expect(manifest.finishedAt).toBeDefined();
    expect(manifest.artifacts).toEqual([
      expect.objectContaining({
        filename: 'artifacts/report.csv',
        roles: ['requested_output'],
      }),
    ]);
    expect(readJson(join(run.result.runDir, 'metrics.json'))).toMatchObject({
      status: 'verified',
      turns: 2,
    });
  });

  it('makes javascriptPolicy=deny guidance agree with the real registry refusal', async () => {
    const browser = fakeBrowser();
    const run = await runVerifiedV3({
      browser,
      javascriptPolicy: 'deny',
      workerResponses: [
        toolResponse(
          'try-browser',
          'browser_execute',
          { code: 'return await browser.pageInfo()' },
          PUBLISH_USAGE,
        ),
        publishResponse(),
        finishResponse(),
      ],
    });

    expect(run.result.status).toBe('verified');
    expect(JSON.stringify(run.worker.requests[0])).toContain(
      'browser_execute is disabled in its entirety',
    );
    expect(JSON.stringify(run.worker.requests[1])).toContain(
      BROWSER_EXECUTE_POLICY_DENIED_MESSAGE,
    );
    expect(browser.openCommandSession).not.toHaveBeenCalled();
    expect(readFileSync(join(run.result.runDir, 'artifacts/report.csv'), 'utf8')).toBe(
      REPORT,
    );
  });

  it('returns an initializer outage as a truthful public incomplete outcome', async () => {
    const browser = fakeBrowser();
    const initializer = unexpectedCallModel('initializer transport unavailable');
    const worker = unexpectedCallModel('worker must not run');
    const verifier = unexpectedCallModel('verifier must not run');

    const result = await runTask('A task whose initializer is unavailable.', {
      browser: browser.controller,
      runsBaseDir,
      callModel: worker,
      tracing: noopTracing(),
      harness: {
        initializerCallModel: initializer,
        verifierCallModel: verifier,
      },
    });

    expect(result).toMatchObject({
      status: 'incomplete',
      reason: 'initializer_unavailable',
      detail: expect.stringContaining('initializer transport unavailable'),
      finalText: '',
    });
    expect(readV3CheckpointConfiguration(result.runDir).taskText).toBe(
      'A task whose initializer is unavailable.',
    );
    expect(readManifest(result.runDir).finishedAt).toBeDefined();
    expect(readJson(join(result.runDir, 'metrics.json'))).toMatchObject({
      status: 'incomplete',
      turns: 0,
    });
    expect(initializer).toHaveBeenCalledOnce();
    expect(worker).not.toHaveBeenCalled();
    expect(verifier).not.toHaveBeenCalled();
    expect(browser.prepareTaskPage).not.toHaveBeenCalled();
    expect(browser.closeTaskPages).toHaveBeenCalledOnce();
  });
});

describe('public v3 resumeTask', () => {
  it('returns a terminal v3 checkpoint without model or browser effects', async () => {
    const initial = await runVerifiedV3({ browser: fakeBrowser() });
    const browser = fakeBrowser();
    const initializer = unexpectedCallModel('initializer must not resume');
    const worker = unexpectedCallModel('worker must not resume');
    const verifier = unexpectedCallModel('verifier must not resume');
    const tracing = recordingTracing();

    const resumed = await resumeTask(initial.result.runDir, {
      browser: browser.controller,
      authenticated: false,
      callModel: worker,
      tracing: tracing.tracing,
      harness: {
        initializerCallModel: initializer,
        verifierCallModel: verifier,
      },
    });

    expect(resumed).toEqual(initial.result);
    expect(initializer).not.toHaveBeenCalled();
    expect(worker).not.toHaveBeenCalled();
    expect(verifier).not.toHaveBeenCalled();
    for (const effect of browser.effects) expect(effect).not.toHaveBeenCalled();
    expect(tracing.runDirs).toEqual([initial.result.runDir]);
    expect(tracing.traceRuns).toBe(0);
    expect(tracing.modelCalls).toBe(0);
    expect(tracing.toolExecutions).toEqual([]);
    expect(tracing.closeCalls).toBe(1);
  });

  it('requires an explicit authenticated assertion for v3 resume', async () => {
    const initial = await runVerifiedV3({ browser: fakeBrowser() });
    const unsafeConfig = {
      browser: fakeBrowser().controller,
      tracing: noopTracing(),
    } as unknown as ResumeTaskConfig;

    await expect(resumeTask(initial.result.runDir, unsafeConfig)).rejects.toThrow(
      /explicitly state authenticated=true or false/,
    );
  });
});

interface FakeBrowser {
  controller: BrowserController;
  setBusyRegistry: ReturnType<typeof vi.fn>;
  prepareTaskPage: ReturnType<typeof vi.fn>;
  closeTaskPages: ReturnType<typeof vi.fn>;
  openCommandSession: ReturnType<typeof vi.fn>;
  refreshAfterExternalCommands: ReturnType<typeof vi.fn>;
  pages: ReturnType<typeof vi.fn>;
  listPendingDialogs: ReturnType<typeof vi.fn>;
  effects: Array<ReturnType<typeof vi.fn>>;
}

function fakeBrowser(): FakeBrowser {
  const setBusyRegistry = vi.fn(() => undefined);
  const prepareTaskPage = vi.fn(async () => undefined);
  const closeTaskPages = vi.fn(async () => undefined);
  const openCommandSession = vi.fn(async () => {
    throw new Error('openCommandSession must not be reached by this test');
  });
  const refreshAfterExternalCommands = vi.fn(async () => undefined);
  const pages = vi.fn(async () => []);
  const listPendingDialogs = vi.fn(() => []);
  const effects = [
    setBusyRegistry,
    prepareTaskPage,
    closeTaskPages,
    openCommandSession,
    refreshAfterExternalCommands,
    pages,
    listPendingDialogs,
  ];
  return {
    controller: {
      setBusyRegistry,
      prepareTaskPage,
      closeTaskPages,
      openCommandSession,
      refreshAfterExternalCommands,
      pages,
      listPendingDialogs,
    } as unknown as BrowserController,
    setBusyRegistry,
    prepareTaskPage,
    closeTaskPages,
    openCommandSession,
    refreshAfterExternalCommands,
    pages,
    listPendingDialogs,
    effects,
  };
}

function scriptedCallModel(responses: readonly ModelResponse[]) {
  const remaining = [...responses];
  const requests: Array<readonly Message[]> = [];
  const callModel = vi.fn(
    async (messages: readonly Message[]): Promise<ModelResponse> => {
      requests.push(structuredClone(messages));
      const response = remaining.shift();
      if (response === undefined) throw new Error('scripted model exhausted');
      return structuredClone(response);
    },
  );
  return { callModel, requests };
}

function unexpectedCallModel(message: string) {
  return vi.fn(async (_messages: readonly Message[]): Promise<ModelResponse> => {
    throw new Error(message);
  });
}

function toolResponse(
  id: string,
  name: string,
  input: unknown,
  usage: Usage,
): ModelResponse {
  return {
    content: [{ type: 'tool_use', id, name, input }],
    stop_reason: 'tool_use',
    usage,
  };
}

function initializerResponse(): ModelResponse {
  return toolResponse(
    'contract-report',
    'set_output_contract',
    { contract: CONTRACT },
    INITIALIZER_USAGE,
  );
}

function publishResponse(): ModelResponse {
  return toolResponse(
    'publish-report',
    'publish_artifact',
    {
      kind: 'text',
      artifact_path: 'artifacts/report.csv',
      roles: ['requested_output'],
      content: REPORT,
    },
    PUBLISH_USAGE,
  );
}

function finishResponse(): ModelResponse {
  return toolResponse('finish-report', 'finish', FINISH, FINISH_USAGE);
}

function verifierResponse(): ModelResponse {
  return toolResponse(
    'verify-report',
    'report_verification',
    { status: 'verified', findings: [] },
    VERIFIER_USAGE,
  );
}

async function runVerifiedV3(options: {
  browser: FakeBrowser;
  javascriptPolicy?: 'allow' | 'deny';
  workerResponses?: readonly ModelResponse[];
  onProgress?: (event: ProgressEvent) => void;
  tracing?: RunTracing;
}) {
  const initializer = scriptedCallModel([initializerResponse()]);
  const worker = scriptedCallModel(
    options.workerResponses ?? [publishResponse(), finishResponse()],
  );
  const verifier = scriptedCallModel([verifierResponse()]);
  const result = await runTask(TASK, {
    browser: options.browser.controller,
    runsBaseDir,
    callModel: worker.callModel,
    tracing: options.tracing ?? noopTracing(),
    ...(options.javascriptPolicy === undefined
      ? {}
      : { javascriptPolicy: options.javascriptPolicy }),
    ...(options.onProgress === undefined
      ? {}
      : { onProgress: options.onProgress }),
    harness: {
      initializerCallModel: initializer.callModel,
      verifierCallModel: verifier.callModel,
    },
  });
  return { result, initializer, worker, verifier };
}

function recordingTracing(): {
  tracing: RunTracing;
  readonly traceRuns: number;
  readonly modelCalls: number;
  readonly toolExecutions: readonly string[];
  readonly closeCalls: number;
  readonly runDirs: readonly string[];
} {
  let traceRuns = 0;
  let modelCalls = 0;
  let closeCalls = 0;
  const toolExecutions: string[] = [];
  const runDirs: string[] = [];
  return {
    tracing: {
      announceRunDir: (runDir) => {
        runDirs.push(runDir);
      },
      wrapCallModel: (callModel) => async (messages) => {
        modelCalls += 1;
        return callModel(messages);
      },
      wrapRegistry: (registry) =>
        new Map(
          [...registry].map(([name, tool]) => [
            name,
            {
              ...tool,
              execute: async (input, context) => {
                toolExecutions.push(name);
                return tool.execute(input, context);
              },
            },
          ]),
        ),
      traceRun: async (_taskText, operation) => {
        traceRuns += 1;
        return operation();
      },
      flush: async () => undefined,
      close: async () => {
        closeCalls += 1;
      },
    },
    get traceRuns() {
      return traceRuns;
    },
    get modelCalls() {
      return modelCalls;
    },
    toolExecutions,
    get closeCalls() {
      return closeCalls;
    },
    runDirs,
  };
}

function noopTracing(): RunTracing {
  return {
    wrapCallModel: (callModel) => callModel,
    wrapRegistry: (registry) => registry,
    traceRun: (_taskText, operation) => operation(),
    flush: async () => undefined,
    close: async () => undefined,
  };
}

function readTranscript(runDir: string): Array<Record<string, unknown>> {
  return readFileSync(join(runDir, 'transcript.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
}
