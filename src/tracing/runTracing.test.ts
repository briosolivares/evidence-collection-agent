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
  BrowserController,
  BrowserDownloadResult,
  BrowserDownloadTarget,
  BrowserPage,
  BrowserScreenshotOptions,
  BrowserTaskPagePreparation,
} from '../browser/controller.js';
import { runTask } from '../cli/runTask.js';
import {
  CallModel,
  ModelResponse,
  Usage,
} from '../loop/messages.js';
import {
  MANIFEST_FILENAME,
  type Manifest,
} from '../run/artifacts.js';
import { TRANSCRIPT_FILENAME } from '../run/transcript.js';
import {
  V3_METRICS_FILENAME,
  type V3WorkerMetrics,
} from '../v3/loop/workerSession.js';
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

  async prepareTaskPage(
    _request: BrowserTaskPagePreparation,
  ): Promise<void> {
    if (this.sessionClosed || this.activeTab) {
      throw new Error('Cannot open a task tab.');
    }
    this.activeTab = true;
  }

  async screenshot(
    _options?: BrowserScreenshotOptions,
  ): Promise<Uint8Array> {
    throw new Error('Unexpected browser screenshot.');
  }

  async download(_target: BrowserDownloadTarget): Promise<BrowserDownloadResult> {
    throw new Error('Unexpected browser download.');
  }

  currentUrl(_pageId?: string): string {
    if (!this.activeTab) {
      throw new Error('No browser task page.');
    }
    return 'about:blank';
  }

  async pages(): Promise<BrowserPage[]> {
    throw new Error('Unexpected page listing.');
  }

  async openCommandSession(): Promise<never> {
    throw new Error('Unexpected browser command session.');
  }

  async refreshAfterExternalCommands(): Promise<void> {
    throw new Error('Unexpected external browser command refresh.');
  }

  listPendingDialogs(): readonly [] {
    return [];
  }

  async closeTaskPages(): Promise<void> {
    this.activeTab = false;
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

// A one-column, no-rules table body that clears v3's deterministic finish
// checks without adding unrelated worker turns to the tracing fixtures.
const TRACED_CSV = 'body\ntraced output\n';

function publishResponse(usage: Usage): ModelResponse {
  return {
    content: [
      {
        type: 'tool_use',
        id: 'publish-1',
        name: 'publish_artifact',
        input: {
          kind: 'text',
          artifact_path: 'artifacts/trace.txt',
          roles: ['requested_output'],
          content: TRACED_CSV,
        },
      },
    ],
    stop_reason: 'tool_use',
    usage,
  };
}

function finishResponse(usage: Usage): ModelResponse {
  return {
    content: [
      {
        type: 'tool_use',
        id: 'finish-1',
        name: 'finish',
        input: {
          summary: 'Published the requested traced output.',
          artifacts: ['artifacts/trace.txt'],
          limitations: [],
        },
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
    vi.stubEnv('LANGFUSE_PUBLIC_KEY', '');
    vi.stubEnv('LANGFUSE_SECRET_KEY', '');
    vi.stubEnv('LANGFUSE_BASE_URL', '');
    const browser = new FakeBrowser();
    const taskText =
      'Complete without tracing configuration. Do not take screenshots.';
    const publishUsage: Usage = {
      input_tokens: 7,
      output_tokens: 2,
      cache_read_input_tokens: 1,
    };
    const finishUsage: Usage = {
      input_tokens: 5,
      output_tokens: 1,
      cache_read_input_tokens: 1,
    };
    const initializerUsage: Usage = { input_tokens: 3, output_tokens: 1 };
    const result = await runTask(taskText, {
      browser,
      runsBaseDir,
      callModel: scriptModel([
        publishResponse(publishUsage),
        finishResponse(finishUsage),
      ]),
      harness: {
        initializerCallModel: scriptModel([contractResponse('trace.txt', initializerUsage)]),
        verifierCallModel: scriptModel([verifiedResponse()]),
      },
    });

    expect(result).toMatchObject({ status: 'verified' });
    expect(browser.activeTab).toBe(false);
    expect(browser.sessionClosed).toBe(false);

    const transcript = await readTranscript(result.runDir);
    expect(transcript.map(({ type, turn }) => [type, turn])).toEqual([
      ['model_request', 1],
      ['model_response', 1],
      ['tool_call', 1],
      ['tool_result', 1],
      ['model_request', 2],
      ['model_response', 2],
      ['tool_call', 2],
      ['finish_requested', 2],
      ['v3_run_terminal', undefined],
    ]);

    const metrics = await readJson<V3WorkerMetrics>(
      join(result.runDir, V3_METRICS_FILENAME),
    );
    expect(metrics).toMatchObject({
      status: 'verified',
      turns: 2,
      protocolCorrections: 0,
      inputTokens:
        publishUsage.input_tokens
        + finishUsage.input_tokens
        + initializerUsage.input_tokens
        + VERIFIED_USAGE.input_tokens,
      outputTokens:
        publishUsage.output_tokens
        + finishUsage.output_tokens
        + initializerUsage.output_tokens
        + VERIFIED_USAGE.output_tokens,
      cacheReadInputTokens:
        (publishUsage.cache_read_input_tokens ?? 0)
        + (finishUsage.cache_read_input_tokens ?? 0),
    });
    expect(metrics.wallClockMs).toBeGreaterThanOrEqual(0);

    const manifest = await readJson<Manifest>(
      join(result.runDir, MANIFEST_FILENAME),
    );
    expect(manifest.task).toBe(taskText);
    expect(manifest.artifacts).toEqual([
      expect.objectContaining({
        filename: 'artifacts/trace.txt',
        roles: ['requested_output'],
      }),
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
    const result = await runTask(
      'Write a traced deliverable. Do not take screenshots.',
      {
        browser,
        runsBaseDir,
        model: 'test-model',
        callModel: scriptModel([
          publishResponse(FIRST_USAGE),
          finishResponse(SECOND_USAGE),
        ]),
        tracing,
        harness: {
          initializerCallModel: scriptModel([
            contractResponse('trace.txt', { input_tokens: 3, output_tokens: 1 }),
          ]),
          verifierCallModel: scriptModel([verifiedResponse()]),
        },
      },
    );

    expect(result.status).toBe('verified');
    expect(await readFile(join(result.runDir, 'artifacts/trace.txt'), 'utf8')).toBe(
      TRACED_CSV,
    );

    const manifest = await readJson<Manifest>(
      join(result.runDir, MANIFEST_FILENAME),
    );
    const artifact = manifest.artifacts.find(
      (entry) => entry.filename === 'artifacts/trace.txt',
    );
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
    expect(JSON.parse(String(toolOutput))).toMatchObject({
      filename: 'artifacts/trace.txt',
      sha256: artifact.sha256,
      roles: ['requested_output'],
    });
    expect(
      toolSpan.attributes[
        `${LangfuseOtelSpanAttributes.OBSERVATION_METADATA}.resultBytes`
      ],
    ).toBe(String(Buffer.byteLength(JSON.stringify(artifact), 'utf8')));

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
    ).toEqual(['publish_artifact']);
    const latencyMs = Number(
      root.attributes[
        `${LangfuseOtelSpanAttributes.OBSERVATION_METADATA}.latencyMs`
      ],
    );
    expect(latencyMs).toBeGreaterThanOrEqual(0);
  });
});
