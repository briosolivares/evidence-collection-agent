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
  BrowserAdapter,
  BrowserFetchResult,
  BrowserScreenshotOptions,
} from '../browser/adapter.js';
import { runTask } from '../cli/runTask.js';
import {
  METRICS_FILENAME,
  type RunMetrics,
} from '../loop/agentLoop.js';
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

class FakeBrowser implements BrowserAdapter {
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

  async click(_ref: string): Promise<void> {
    throw new Error('Unexpected browser click.');
  }

  async type(_ref: string, _text: string): Promise<void> {
    throw new Error('Unexpected browser typing.');
  }

  async scroll(): Promise<void> {
    throw new Error('Unexpected browser scroll.');
  }

  async screenshot(
    _options?: BrowserScreenshotOptions,
  ): Promise<Uint8Array> {
    throw new Error('Unexpected browser screenshot.');
  }

  async resolveHref(_ref: string): Promise<string | null> {
    throw new Error('Unexpected href resolution.');
  }

  async fetch(_url: string): Promise<BrowserFetchResult> {
    throw new Error('Unexpected browser fetch.');
  }

  currentUrl(): string {
    if (!this.activeTab) {
      throw new Error('No browser task tab.');
    }
    return 'about:blank';
  }

  async title(): Promise<string> {
    if (!this.activeTab) {
      throw new Error('No browser task tab.');
    }
    return '';
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

function toolResponse(usage: Usage): ModelResponse {
  return {
    content: [
      {
        type: 'tool_use',
        id: 'write-1',
        name: 'write_file',
        input: { file_path: 'trace.txt', content: 'traced output\n' },
      },
    ],
    stop_reason: 'tool_use',
    usage,
  };
}

function textResponse(text: string, usage: Usage): ModelResponse {
  return {
    content: [{ type: 'text', text }],
    stop_reason: 'end_turn',
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
    const taskText = 'Complete without tracing configuration.';
    const result = await runTask(taskText, {
      browser,
      runsBaseDir,
      callModel: scriptModel([
        textResponse('Completed normally.', {
          input_tokens: 7,
          output_tokens: 2,
          cache_read_input_tokens: 1,
        }),
      ]),
    });

    expect(result).toMatchObject({
      status: 'completed',
      finalText: 'Completed normally.',
    });
    expect(browser.activeTab).toBe(false);
    expect(browser.sessionClosed).toBe(false);

    const transcript = await readTranscript(result.runDir);
    expect(transcript.map(({ type, turn }) => [type, turn])).toEqual([
      ['model_request', 1],
      ['model_response', 1],
    ]);

    const metrics = await readJson<RunMetrics>(
      join(result.runDir, METRICS_FILENAME),
    );
    expect(metrics).toMatchObject({
      status: 'completed',
      turns: 1,
      inputTokens: 7,
      outputTokens: 2,
      cacheReadInputTokens: 1,
    });
    expect(metrics.wallClockMs).toBeGreaterThanOrEqual(0);

    const manifest = await readJson<Manifest>(
      join(result.runDir, MANIFEST_FILENAME),
    );
    expect(manifest).toMatchObject({ task: taskText, artifacts: [] });
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
      callModel: scriptModel([
        toolResponse(FIRST_USAGE),
        textResponse('The traced deliverable is complete.', SECOND_USAGE),
      ]),
      tracing,
    });

    expect(result.status).toBe('completed');
    expect(await readFile(join(result.runDir, 'trace.txt'), 'utf8')).toBe(
      'traced output\n',
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
      { input: 11, output: 3, cache_read_input_tokens: 2 },
      { input: 13, output: 5, cache_read_input_tokens: 4 },
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
    expect(toolOutput).toBe('File created successfully at: trace.txt');
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
