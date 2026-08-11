import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import type { BrowserAdapter } from '../browser/adapter.js';
import { launchPersistentChrome } from '../browser/playwrightAdapter.js';
import {
  METRICS_FILENAME,
  type RunMetrics,
} from '../loop/agentLoop.js';
import type {
  CallModel,
  Message,
  ModelResponse,
  Usage,
} from '../loop/messages.js';
import {
  MANIFEST_FILENAME,
  type Manifest,
} from '../run/artifacts.js';
import { TRANSCRIPT_FILENAME } from '../run/transcript.js';
import {
  startFixtureServer,
  type FixtureServer,
} from '../../tests/fixtures/server.js';
import { runTask } from './runTask.js';

const TEST_TIMEOUT_MS = 30_000;
const DEFAULT_USAGE: Usage = { input_tokens: 10, output_tokens: 2 };

interface TranscriptEvent {
  type: string;
  turn: number;
  [key: string]: unknown;
}

function toolResponse(
  id: string,
  name: string,
  input: unknown,
  usage: Usage = DEFAULT_USAGE,
): ModelResponse {
  return {
    content: [{ type: 'tool_use', id, name, input }],
    stop_reason: 'tool_use',
    usage,
  };
}

function textResponse(
  text: string,
  usage: Usage = DEFAULT_USAGE,
): ModelResponse {
  return {
    content: [{ type: 'text', text }],
    stop_reason: 'end_turn',
    usage,
  };
}

function scriptModel(responses: readonly ModelResponse[]): {
  callModel: CallModel;
  requests: Message[][];
} {
  const requests: Message[][] = [];
  const callModel: CallModel = async (messages) => {
    requests.push(structuredClone(messages) as Message[]);
    const response = responses[requests.length - 1];
    if (response === undefined) {
      throw new Error(
        `Fake model received call ${requests.length}, but only ${responses.length} responses were scripted.`,
      );
    }
    return response;
  };
  return { callModel, requests };
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, 'utf8')) as T;
}

async function readTranscript(runDir: string): Promise<TranscriptEvent[]> {
  const transcript = await readFile(join(runDir, TRANSCRIPT_FILENAME), 'utf8');
  return transcript
    .trimEnd()
    .split('\n')
    .map((line) => JSON.parse(line) as TranscriptEvent);
}

describe('runTask', () => {
  let browser: BrowserAdapter;
  let fixtureServer: FixtureServer;
  let tempRoot: string;
  let runsBaseDir: string;

  beforeAll(async () => {
    fixtureServer = await startFixtureServer();
    tempRoot = await mkdtemp(join(tmpdir(), 'run-task-test-'));
    runsBaseDir = join(tempRoot, 'runs');
    browser = await launchPersistentChrome({
      profileDir: join(tempRoot, 'chrome-profile'),
      headless: true,
    });
  }, TEST_TIMEOUT_MS);

  afterEach(async () => {
    await browser.closeTab();
  });

  afterAll(async () => {
    await browser?.close();
    await fixtureServer?.close();
    if (tempRoot !== undefined) {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it(
    'runs the real browser and tool pipeline to a verified CSV artifact',
    async () => {
      const taskText =
        'Inspect the local evidence fixture and write its title and URL to stories.csv.';
      const fixtureUrl = fixtureServer.url('/');
      const csv = `title,url\nBrowser Adapter Fixture,${fixtureUrl}\n`;
      const fake = scriptModel([
        toolResponse('navigate-1', 'navigate', { url: fixtureUrl }, {
          input_tokens: 11,
          output_tokens: 3,
        }),
        toolResponse('inspect-1', 'inspect_page', {}, {
          input_tokens: 13,
          output_tokens: 4,
          cache_read_input_tokens: 2,
        }),
        toolResponse(
          'write-1',
          'write_file',
          { file_path: 'stories.csv', content: csv },
          {
            input_tokens: 17,
            output_tokens: 5,
            cache_read_input_tokens: 3,
          },
        ),
        textResponse('The CSV deliverable is complete.', {
          input_tokens: 19,
          output_tokens: 6,
          cache_read_input_tokens: 4,
        }),
      ]);

      const result = await runTask(taskText, {
        browser,
        runsBaseDir,
        callModel: fake.callModel,
        maxTurns: 8,
        maxTokens: 10_000,
      });

      expect(result.status).toBe('completed');
      if (result.status !== 'completed') {
        throw new Error(`Expected a completed run, got ${result.status}.`);
      }
      expect(result.finalText).toBe('The CSV deliverable is complete.');
      expect(await readFile(join(result.runDir, 'stories.csv'), 'utf8')).toBe(csv);

      // The third request can only contain this page data if navigate and
      // inspect_page ran through the real browser adapter in the prior turns.
      expect(JSON.stringify(fake.requests[2])).toContain(fixtureUrl);
      expect(JSON.stringify(fake.requests[2])).toContain('Browser Adapter Fixture');
      expect(fake.requests).toHaveLength(4);

      const events = await readTranscript(result.runDir);
      expect(events.map((event) => [event.type, event.turn])).toEqual([
        ['model_request', 1],
        ['model_response', 1],
        ['tool_call', 1],
        ['tool_result', 1],
        ['model_request', 2],
        ['model_response', 2],
        ['tool_call', 2],
        ['tool_result', 2],
        ['model_request', 3],
        ['model_response', 3],
        ['tool_call', 3],
        ['tool_result', 3],
        ['model_request', 4],
        ['model_response', 4],
      ]);
      expect(
        events
          .filter((event) => event.type === 'tool_call')
          .map((event) => (event.call as { name: string }).name),
      ).toEqual(['navigate', 'inspect_page', 'write_file']);
      expect(
        events
          .filter((event) => event.type === 'tool_result')
          .map((event) => event.result),
      ).toEqual([
        expect.objectContaining({ toolCallId: 'navigate-1', isError: false }),
        expect.objectContaining({ toolCallId: 'inspect-1', isError: false }),
        expect.objectContaining({ toolCallId: 'write-1', isError: false }),
      ]);

      const manifest = await readJson<Manifest>(
        join(result.runDir, MANIFEST_FILENAME),
      );
      expect(manifest.task).toBe(taskText);
      expect(manifest.finishedAt).toBeDefined();
      expect(Date.parse(manifest.finishedAt ?? '')).toBeGreaterThanOrEqual(
        Date.parse(manifest.startedAt),
      );
      expect(manifest.artifacts).toHaveLength(1);
      expect(manifest.artifacts[0]?.filename).toBe('stories.csv');
      const recordedArtifact = manifest.artifacts[0];
      if (recordedArtifact === undefined) {
        throw new Error('Expected stories.csv in the finalized manifest.');
      }
      const artifactBytes = await readFile(
        join(result.runDir, recordedArtifact.filename),
      );
      expect(recordedArtifact.sha256).toBe(
        createHash('sha256').update(artifactBytes).digest('hex'),
      );

      const metrics = await readJson<RunMetrics>(
        join(result.runDir, METRICS_FILENAME),
      );
      expect(metrics).toMatchObject({
        status: 'completed',
        turns: 4,
        inputTokens: 60,
        outputTokens: 18,
        cacheReadInputTokens: 9,
      });
      expect(metrics.wallClockMs).toBeGreaterThanOrEqual(0);

      // A successful run owns and closes only its task tab, not the session.
      expect(() => browser.currentUrl()).toThrow(/No browser task tab/);
      await browser.newTab();
      await browser.goto(fixtureServer.url('/second.html'));
      expect(await browser.title()).toBe('Second Fixture Page');
      await browser.closeTab();
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'allows completion on turn 24 when maxTurns is omitted',
    async () => {
      const responses = Array.from({ length: 23 }, (_, index) =>
        toolResponse(`inspect-default-${index + 1}`, 'inspect_page', {}),
      );
      const fake = scriptModel([
        ...responses,
        textResponse('Completed on the default final turn.'),
      ]);

      const result = await runTask('Use the complete default turn budget.', {
        browser,
        runsBaseDir,
        callModel: fake.callModel,
        maxTokens: 10_000,
      });

      expect(result).toMatchObject({
        status: 'completed',
        finalText: 'Completed on the default final turn.',
      });
      expect(fake.requests).toHaveLength(24);
      await expect(
        readJson<RunMetrics>(join(result.runDir, METRICS_FILENAME)),
      ).resolves.toMatchObject({ status: 'completed', turns: 24 });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'closes a budget-exceeded tab and leaves the browser ready for the next run',
    async () => {
      const budgetFake = scriptModel([
        toolResponse('navigate-budget', 'navigate', {
          url: fixtureServer.url('/'),
        }),
      ]);
      const budgetResult = await runTask('Keep browsing until stopped.', {
        browser,
        runsBaseDir,
        callModel: budgetFake.callModel,
        maxTurns: 1,
        maxTokens: 10_000,
      });

      expect(budgetResult).toMatchObject({
        status: 'budget_exceeded',
        reason: 'max_turns',
      });
      expect(() => browser.currentUrl()).toThrow(/No browser task tab/);
      const budgetManifest = await readJson<Manifest>(
        join(budgetResult.runDir, MANIFEST_FILENAME),
      );
      expect(budgetManifest.finishedAt).toBeDefined();
      await expect(
        readJson(join(budgetResult.runDir, METRICS_FILENAME)),
      ).resolves.toMatchObject({ status: 'budget_exceeded', turns: 1 });

      // runTask itself must be able to acquire the next fresh tab on the
      // same persistent browser session after the guarded ending.
      const nextFake = scriptModel([textResponse('Next run completed.')]);
      const nextResult = await runTask('Complete immediately.', {
        browser,
        runsBaseDir,
        callModel: nextFake.callModel,
        maxTurns: 2,
        maxTokens: 10_000,
      });
      expect(nextResult).toMatchObject({
        status: 'completed',
        finalText: 'Next run completed.',
      });
      expect(nextResult.runDir).not.toBe(budgetResult.runDir);
      expect(() => browser.currentUrl()).toThrow(/No browser task tab/);
    },
    TEST_TIMEOUT_MS,
  );
});
