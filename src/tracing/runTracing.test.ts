import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { LangfuseOtelSpanAttributes } from '@langfuse/tracing';
import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  BrowserActionOutput,
  BrowserActionRequest,
} from '../browser/browserActions.js';
import type {
  BrowserObservation,
  BrowserPage,
} from '../browser/browserState.js';
import type {
  BrowserController,
  BrowserDownloadResult,
  BrowserDownloadTarget,
  BrowserFetchResult,
  BrowserScreenshotOptions,
  HandleDialogRequest,
  HandleDialogResult,
} from '../browser/controller.js';
import { runTask } from '../cli/runTask.js';
import {
  METRICS_FILENAME,
  type RunMetrics,
} from '../loop/workerSession.js';
import type {
  CallModel,
  ModelResponse,
  Usage,
} from '../loop/messages.js';
import {
  MANIFEST_FILENAME,
  type Manifest,
} from '../run/artifacts.js';
import { TRANSCRIPT_FILENAME } from '../run/transcript.js';
import { createRunTracing } from './runTracing.js';

const FIRST_USAGE: Usage = {
  input_tokens: 11,
  output_tokens: 3,
  cache_read_input_tokens: 2,
};
const SECOND_USAGE: Usage = {
  input_tokens: 13,
  output_tokens: 5,
  cache_read_input_tokens: 4,
};

class FakeBrowser implements BrowserController {
  activeTab = false;
  sessionClosed = false;

  async newTab(): Promise<void> {
    if (this.sessionClosed || this.activeTab) {
      throw new Error('Cannot open a task tab.');
    }
    this.activeTab = true;
  }

  async closeTab(): Promise<void> {
    this.activeTab = false;
  }

  async goto(_url: string): Promise<void> {
    throw new Error('Unexpected browser navigation.');
  }

  async outline(): Promise<string> {
    throw new Error('Unexpected page inspection.');
  }

  async screenshot(
    _options?: BrowserScreenshotOptions,
  ): Promise<Uint8Array> {
    throw new Error('Unexpected browser screenshot.');
  }

  async fetch(_url: string): Promise<BrowserFetchResult> {
    throw new Error('Unexpected browser fetch.');
  }

  async download(_target: BrowserDownloadTarget): Promise<BrowserDownloadResult> {
    throw new Error('Unexpected browser download.');
  }

  currentUrl(_pageId?: string): string {
    if (!this.activeTab) {
      throw new Error('No browser task tab.');
    }
    return 'about:blank';
  }

  async title(_pageId?: string): Promise<string> {
    if (!this.activeTab) {
      throw new Error('No browser task tab.');
    }
    return '';
  }

  async pages(): Promise<BrowserPage[]> {
    throw new Error('Unexpected page listing.');
  }

  async observe(): Promise<BrowserObservation> {
    throw new Error('Unexpected page observation.');
  }

  async browserAction(_request: BrowserActionRequest): Promise<BrowserActionOutput> {
    throw new Error('Unexpected browser action sequence.');
  }

  async handleDialog(_request: HandleDialogRequest): Promise<HandleDialogResult> {
    throw new Error('Unexpected browser dialog decision.');
  }

  async close(): Promise<void> {
    this.activeTab = false;
    this.sessionClosed = true;
  }
}

function scriptModel(responses: readonly ModelResponse[]): CallModel {
  let callCount = 0;
  return async () => {
    const response = responses[callCount];
    callCount += 1;
    if (response === undefined) {
      throw new Error(`Unexpected model call ${callCount}.`);
    }
    return response;
  };
}

// A one-column, no-rules table body: valid CSV against contractResponse's
// contract below (a rules-ruled table would additionally need a completeness
// claim — see completionCheck.ts's validateTableCompleteness — which these
// tracing tests have no reason to exercise), so `write_file`-ing it directly
// clears the automated completion checks without extra worker turns.
const TRACED_CSV = 'body\ntraced output\n';

function toolResponse(usage: Usage): ModelResponse {
  return {
    content: [
      {
        type: 'tool_use',
        id: 'write-1',
        name: 'write_file',
        input: { file_path: 'artifacts/trace.txt', content: TRACED_CSV },
      },
    ],
    stop_reason: 'tool_use',
    usage,
  };
}

function submitResponse(usage: Usage): ModelResponse {
  return {
    content: [
      {
        type: 'tool_use',
        id: 'submit-1',
        name: 'submit_for_verification',
        input: { summary: 'Done.' },
      },
    ],
    stop_reason: 'tool_use',
    usage,
  };
}

const VERIFIED_USAGE: Usage = { input_tokens: 4, output_tokens: 1 };

function verifiedResponse(): ModelResponse {
  return {
    content: [
      {
        type: 'tool_use',
        id: 'verify-1',
        name: 'report_verification',
        input: { status: 'verified', findings: [] },
      },
    ],
    stop_reason: 'tool_use',
    usage: { ...VERIFIED_USAGE },
  };
}

function contractResponse(outputFilename: string, usage: Usage): ModelResponse {
  return {
    content: [
      {
        type: 'tool_use',
        id: 'contract-1',
        name: 'set_output_contract',
        input: {
          contract: {
            outputs: [
              {
                id: 'note',
                kind: 'table',
                filename: outputFilename,
                format: 'csv',
                columns: [{ name: 'body', required: true, type: 'string' }],
                rules: [],
              },
            ],
          },
        },
      },
    ],
    stop_reason: 'tool_use',
    usage,
  };
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, 'utf8')) as T;
}

async function readTranscript(runDir: string): Promise<Record<string, unknown>[]> {
  const raw = await readFile(join(runDir, TRANSCRIPT_FILENAME), 'utf8');
  return raw
    .trimEnd()
    .split('\n')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe('createRunTracing with runTask', () => {
  let tempRoot: string;
  let runsBaseDir: string;

  beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), 'run-tracing-test-'));
    runsBaseDir = join(tempRoot, 'runs');
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(tempRoot, { recursive: true, force: true });
  });

  it('is a clean no-op without Langfuse credentials', async () => {
    // Every run goes through initializer -> worker -> verifier, and
    // `submit_for_verification` is the only way a worker cycle ends (see
    // runTask.ts's HarnessConfig module comment) — the single-turn
    // no-tool-response 'completed' path this test used to exercise no longer
    // exists. The no-op-tracing claim itself is unchanged: only its shape
    // (contract, one write, one submission, one verified verdict) had to
    // catch up.
    vi.stubEnv('LANGFUSE_PUBLIC_KEY', '');
    vi.stubEnv('LANGFUSE_SECRET_KEY', '');
    vi.stubEnv('LANGFUSE_BASE_URL', '');
    const browser = new FakeBrowser();
    const taskText = 'Complete without tracing configuration.';
    const writeUsage: Usage = { input_tokens: 7, output_tokens: 2, cache_read_input_tokens: 1 };
    // Non-zero cache_read_input_tokens from turn 2 on: otherwise the worker's
    // own cache-miss tripwire (workerSession.ts, "from turn 2 the stable
    // prompt prefix alone guarantees cache reads") fires a
    // `cache_miss_warning` transcript event this fixture has no reason to
    // produce.
    const submitUsage: Usage = { input_tokens: 5, output_tokens: 1, cache_read_input_tokens: 1 };
    const initializerUsage: Usage = { input_tokens: 3, output_tokens: 1 };
    const result = await runTask(taskText, {
      browser,
      runsBaseDir,
      callModel: scriptModel([toolResponse(writeUsage), submitResponse(submitUsage)]),
      harness: {
        contractAuthor: 'initializer',
        initializerCallModel: scriptModel([contractResponse('trace.txt', initializerUsage)]),
        verifierCallModel: scriptModel([verifiedResponse()]),
      },
    });

    expect(result).toMatchObject({ status: 'verified' });
    expect(browser.activeTab).toBe(false);
    expect(browser.sessionClosed).toBe(false);

    const transcript = await readTranscript(result.runDir);
    // Every stage the harness goes through for one write + one
    // submission: the cycle marker, the write turn (request/response/tool
    // call/tool result), the submission turn (request/response), and the
    // submission call's own answer once the verifier reports `verified`.
    expect(transcript.map(({ type, turn }) => [type, turn])).toEqual([
      ['cycle_start', undefined],
      ['model_request', 1],
      ['model_response', 1],
      ['tool_call', 1],
      ['tool_result', 1],
      ['model_request', 2],
      ['model_response', 2],
      ['submission', 2],
      ['tool_result', 2],
    ]);

    const metrics = await readJson<RunMetrics>(
      join(result.runDir, METRICS_FILENAME),
    );
    // Aggregated over every role sharing the run's budget (worker, verifier,
    // initializer) — see writeWorkerSessionMetrics's own doc comment.
    expect(metrics).toMatchObject({
      status: 'verified',
      turns: 2,
      inputTokens: writeUsage.input_tokens + submitUsage.input_tokens + initializerUsage.input_tokens + VERIFIED_USAGE.input_tokens,
      outputTokens: writeUsage.output_tokens + submitUsage.output_tokens + initializerUsage.output_tokens + VERIFIED_USAGE.output_tokens,
      cacheReadInputTokens:
        (writeUsage.cache_read_input_tokens ?? 0) + (submitUsage.cache_read_input_tokens ?? 0),
    });
    expect(metrics.wallClockMs).toBeGreaterThanOrEqual(0);

    const manifest = await readJson<Manifest>(
      join(result.runDir, MANIFEST_FILENAME),
    );
    expect(manifest.task).toBe(taskText);
    // Two tracked files, not one: the accepted output-contract revision the
    // initializer wrote (scratch/output-contract/revision-1.json) plus the
    // requested deliverable itself — the manifest now tracks every
    // durable file the run produced, not only artifacts/.
    expect(manifest.artifacts.map((a) => a.filename).sort()).toEqual([
      'artifacts/trace.txt',
      'scratch/output-contract/revision-1.json',
    ]);
    expect(manifest.finishedAt).toBeDefined();
  });

  it('emits one agent trace with generation and tool observations', async () => {
    const exporter = new InMemorySpanExporter();
    const tracing = createRunTracing({
      env: {},
      spanProcessor: new SimpleSpanProcessor(exporter),
    });
    const browser = new FakeBrowser();
    const result = await runTask('Write a traced deliverable.', {
      browser,
      runsBaseDir,
      model: 'test-model',
      callModel: scriptModel([toolResponse(FIRST_USAGE), submitResponse(SECOND_USAGE)]),
      tracing,
      harness: {
        contractAuthor: 'initializer',
        initializerCallModel: scriptModel([
          contractResponse('trace.txt', { input_tokens: 3, output_tokens: 1 }),
        ]),
        verifierCallModel: scriptModel([verifiedResponse()]),
      },
    });

    expect(result.status).toBe('verified');
    expect(await readFile(join(result.runDir, 'artifacts/trace.txt'), 'utf8')).toBe(
      TRACED_CSV,
    );

    const manifest = await readJson<Manifest>(
      join(result.runDir, MANIFEST_FILENAME),
    );
    const artifact = manifest.artifacts[0];
    expect(artifact).toBeDefined();
    if (artifact === undefined) {
      throw new Error('Expected trace.txt in the finalized manifest.');
    }
    const artifactBytes = await readFile(join(result.runDir, artifact.filename));
    expect(artifact.sha256).toBe(
      createHash('sha256').update(artifactBytes).digest('hex'),
    );

    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(4);
    const spansOfType = (type: string) =>
      spans.filter(
        (span) =>
          span.attributes[LangfuseOtelSpanAttributes.OBSERVATION_TYPE] === type,
      );
    const agentSpans = spansOfType('agent');
    const generationSpans = spansOfType('generation');
    const toolSpans = spansOfType('tool');
    expect(agentSpans).toHaveLength(1);
    expect(generationSpans).toHaveLength(2);
    expect(toolSpans).toHaveLength(1);

    const root = agentSpans[0];
    if (root === undefined) {
      throw new Error('Expected one root agent span.');
    }
    expect(root.parentSpanContext).toBeUndefined();
    for (const child of [...generationSpans, ...toolSpans]) {
      expect(child.spanContext().traceId).toBe(root.spanContext().traceId);
      expect(child.parentSpanContext?.spanId).toBe(root.spanContext().spanId);
    }

    const usageDetails = generationSpans
      .map((span) =>
        JSON.parse(
          String(
            span.attributes[
              LangfuseOtelSpanAttributes.OBSERVATION_USAGE_DETAILS
            ],
          ),
        ) as Record<string, number>,
      )
      .sort((left, right) => left.input - right.input);
    expect(usageDetails).toEqual([
      { input: 11, output: 3, cache_read_input_tokens: 2, cache_creation_input_tokens: 0 },
      { input: 13, output: 5, cache_read_input_tokens: 4, cache_creation_input_tokens: 0 },
    ]);
    for (const generation of generationSpans) {
      expect(
        generation.attributes[LangfuseOtelSpanAttributes.OBSERVATION_INPUT],
      ).toBeDefined();
      expect(
        generation.attributes[LangfuseOtelSpanAttributes.OBSERVATION_OUTPUT],
      ).toBeDefined();
    }

    const toolSpan = toolSpans[0];
    if (toolSpan === undefined) {
      throw new Error('Expected one tool span.');
    }
    const toolOutput =
      toolSpan.attributes[LangfuseOtelSpanAttributes.OBSERVATION_OUTPUT];
    expect(toolOutput).toBe('File created successfully at: artifacts/trace.txt');
    expect(
      toolSpan.attributes[
        `${LangfuseOtelSpanAttributes.OBSERVATION_METADATA}.resultBytes`
      ],
    ).toBe(String(Buffer.byteLength(String(toolOutput), 'utf8')));

    expect(
      root.attributes[
        `${LangfuseOtelSpanAttributes.OBSERVATION_METADATA}.turnCount`
      ],
    ).toBe('2');
    expect(
      JSON.parse(
        String(
          root.attributes[
            `${LangfuseOtelSpanAttributes.OBSERVATION_METADATA}.toolsUsed`
          ],
        ),
      ),
    ).toEqual(['write_file']);
    const latencyMs = Number(
      root.attributes[
        `${LangfuseOtelSpanAttributes.OBSERVATION_METADATA}.latencyMs`
      ],
    );
    expect(latencyMs).toBeGreaterThanOrEqual(0);
  });
});
