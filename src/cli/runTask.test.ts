import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import type { BrowserController } from '../browser/controller.js';
import { LocalChromeBrowserSessionProvider } from '../browser/playwrightBrowserController.js';
import { HARNESS_FILENAME, type HarnessDiagnostics } from '../harness/harness.js';
import {
  CONTRACT_FILENAME,
  INITIALIZER_MODEL,
  INTENT_FILENAME,
} from '../harness/initializer.js';
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
  turn?: number;
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

// --- Harness-mode fakes: a well-formed initializer response, and judge
// DONE/CONTINUE responses, all built on top of textResponse above (the
// initializer's and judge's callModels are never offered tools, so every
// scripted response here is text-only, matching initializer.test.ts and
// judge.test.ts's own fakes).

/** A well-formed initializer response: both sections, non-empty bodies. */
function initializerResponse(intent: string, contract: string): ModelResponse {
  return textResponse(`# INTENT\n${intent}\n\n# CONTRACT\n${contract}`);
}

/** A judge response proposing DONE. */
function judgeDone(): ModelResponse {
  return textResponse('DONE');
}

/** A judge response proposing CONTINUE with the given reason. */
function judgeContinue(reason: string): ModelResponse {
  return textResponse(`CONTINUE: ${reason}`);
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
  let browser: BrowserController;
  let fixtureServer: FixtureServer;
  let tempRoot: string;
  let runsBaseDir: string;

  beforeAll(async () => {
    fixtureServer = await startFixtureServer();
    tempRoot = await mkdtemp(join(tmpdir(), 'run-task-test-'));
    runsBaseDir = join(tempRoot, 'runs');
    const browserSessionProvider = new LocalChromeBrowserSessionProvider({
      profileDir: join(tempRoot, 'chrome-profile'),
      headless: true,
    });
    browser = await browserSessionProvider.createSession();
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
      const csv = `title,url\nBrowser Controller Fixture,${fixtureUrl}\n`;
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
          { file_path: 'artifacts/stories.csv', content: csv },
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
        maxContextTokens: 10_000,
      });

      expect(result.status).toBe('completed');
      if (result.status !== 'completed') {
        throw new Error(`Expected a completed run, got ${result.status}.`);
      }
      expect(result.finalText).toBe('The CSV deliverable is complete.');
      expect(await readFile(join(result.runDir, 'artifacts/stories.csv'), 'utf8')).toBe(csv);

      // The third request can only contain this page data if navigate and
      // inspect_page ran through the real browser controller in the prior turns.
      expect(JSON.stringify(fake.requests[2])).toContain(fixtureUrl);
      expect(JSON.stringify(fake.requests[2])).toContain('Browser Controller Fixture');
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
      expect(manifest.artifacts[0]?.filename).toBe('artifacts/stories.csv');
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
        maxContextTokens: 10_000,
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
        maxContextTokens: 10_000,
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
        maxContextTokens: 10_000,
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

  describe('harness mode (initializer → worker → judge outer loop)', () => {
    it(
      'is unaffected when config.harness is absent: single loop, no INTENT.md/CONTRACT.md/harness.json',
      async () => {
        const fake = scriptModel([textResponse('Completed with no harness configured.')]);

        const result = await runTask('Plain task, harness absent.', {
          browser,
          runsBaseDir,
          callModel: fake.callModel,
          maxTurns: 4,
          maxContextTokens: 10_000,
        });

        expect(result).toMatchObject({
          status: 'completed',
          finalText: 'Completed with no harness configured.',
        });
        expect(existsSync(join(result.runDir, INTENT_FILENAME))).toBe(false);
        expect(existsSync(join(result.runDir, CONTRACT_FILENAME))).toBe(false);
        expect(existsSync(join(result.runDir, HARNESS_FILENAME))).toBe(false);
        await expect(
          readJson<RunMetrics>(join(result.runDir, METRICS_FILENAME)),
        ).resolves.toMatchObject({ status: 'completed', turns: 1 });
      },
      TEST_TIMEOUT_MS,
    );

    it(
      'runs the initializer and one worker cycle, ending on a judge DONE verdict',
      async () => {
        const initializer = scriptModel([
          initializerResponse(
            'Collect and publish the widget roster.',
            'artifacts/report.md must exist and list every widget.',
          ),
        ]);
        const worker = scriptModel([textResponse('Report published.')]);
        const judge = scriptModel([judgeDone()]);

        const result = await runTask('Collect widgets and publish a report.', {
          browser,
          runsBaseDir,
          callModel: worker.callModel,
          maxTurns: 4,
          maxContextTokens: 10_000,
          harness: {
            initializerCallModel: initializer.callModel,
            judgeCallModel: judge.callModel,
          },
        });

        expect(result).toMatchObject({ status: 'completed', finalText: 'Report published.' });

        expect(await readFile(join(result.runDir, INTENT_FILENAME), 'utf8')).toBe(
          'Collect and publish the widget roster.\n',
        );
        expect(await readFile(join(result.runDir, CONTRACT_FILENAME), 'utf8')).toBe(
          'artifacts/report.md must exist and list every widget.\n',
        );

        const diagnostics = await readJson<HarnessDiagnostics>(
          join(result.runDir, HARNESS_FILENAME),
        );
        expect(diagnostics).toEqual({
          initializer: { model: INITIALIZER_MODEL },
          cycles: [{ cycle: 1, workerStatus: 'completed', verdict: 'done' }],
        });

        const rollup = await readJson<RunMetrics>(join(result.runDir, METRICS_FILENAME));
        expect(rollup).toMatchObject({ status: 'completed', turns: 1 });
        const cycle1Metrics = await readJson<RunMetrics>(
          join(result.runDir, 'metrics-cycle-1.json'),
        );
        // A single-cycle run's rollup is exactly that cycle's own metrics.
        expect(cycle1Metrics).toEqual(rollup);

        const events = await readTranscript(result.runDir);
        expect(events.filter((e) => e.type === 'cycle_start').map((e) => e.cycle)).toEqual([1]);
      },
      TEST_TIMEOUT_MS,
    );

    it(
      'runs a second worker cycle carrying the judge reason as feedback, then ends on DONE',
      async () => {
        const initializer = scriptModel([
          initializerResponse('Collect the widget roster.', 'artifacts/report.md must exist.'),
        ]);
        const worker = scriptModel([
          textResponse('First attempt at the report.'),
          textResponse('Second attempt, column fixed.'),
        ]);
        const judge = scriptModel([
          judgeContinue('artifacts/report.md is missing the required id column.'),
          judgeDone(),
        ]);

        const result = await runTask('Collect widgets and publish a report.', {
          browser,
          runsBaseDir,
          callModel: worker.callModel,
          maxTurns: 4,
          maxContextTokens: 10_000,
          harness: {
            initializerCallModel: initializer.callModel,
            judgeCallModel: judge.callModel,
          },
        });

        expect(result).toMatchObject({
          status: 'completed',
          finalText: 'Second attempt, column fixed.',
        });
        expect(worker.requests).toHaveLength(2);

        // Cycle 2's opening message: taskText + judge feedback, plain text,
        // no special framing (judge-design.md's "Judge-reason delivery").
        const secondRequest = worker.requests[1];
        expect(secondRequest).toHaveLength(1);
        const secondOpeningText = (
          secondRequest?.[0]?.content[0] as { text: string }
        ).text;
        expect(secondOpeningText).toContain('Collect widgets and publish a report.');
        expect(secondOpeningText).toContain('Judge feedback:');
        expect(secondOpeningText).toContain(
          'artifacts/report.md is missing the required id column.',
        );

        const diagnostics = await readJson<HarnessDiagnostics>(
          join(result.runDir, HARNESS_FILENAME),
        );
        expect(diagnostics).toEqual({
          initializer: { model: INITIALIZER_MODEL },
          cycles: [
            {
              cycle: 1,
              workerStatus: 'completed',
              verdict: 'continue',
              reason: 'artifacts/report.md is missing the required id column.',
            },
            { cycle: 2, workerStatus: 'completed', verdict: 'done' },
          ],
        });

        const events = await readTranscript(result.runDir);
        expect(events.filter((e) => e.type === 'cycle_start').map((e) => e.cycle)).toEqual([1, 2]);
      },
      TEST_TIMEOUT_MS,
    );

    it(
      'ends at cycle exhaustion (maxWorkerCycles: 2) on a lingering CONTINUE verdict, still completed',
      async () => {
        const initializer = scriptModel([
          initializerResponse('Collect the widget roster.', 'artifacts/report.md must exist.'),
        ]);
        const worker = scriptModel([
          textResponse('First attempt.'),
          textResponse('Second attempt.'),
        ]);
        const judge = scriptModel([
          judgeContinue('First reason.'),
          judgeContinue('Second reason.'),
        ]);

        const result = await runTask('Collect widgets and publish a report.', {
          browser,
          runsBaseDir,
          callModel: worker.callModel,
          maxTurns: 4,
          maxContextTokens: 10_000,
          harness: {
            maxWorkerCycles: 2,
            initializerCallModel: initializer.callModel,
            judgeCallModel: judge.callModel,
          },
        });

        expect(result).toMatchObject({ status: 'completed', finalText: 'Second attempt.' });
        // Exactly two worker cycles ran — a third would have thrown against
        // this fake's exhausted response script.
        expect(worker.requests).toHaveLength(2);
        expect(judge.requests).toHaveLength(2);

        const diagnostics = await readJson<HarnessDiagnostics>(
          join(result.runDir, HARNESS_FILENAME),
        );
        expect(diagnostics.cycles).toHaveLength(2);
        expect(diagnostics.cycles[1]).toEqual({
          cycle: 2,
          workerStatus: 'completed',
          verdict: 'continue',
          reason: 'Second reason.',
        });

        const events = await readTranscript(result.runDir);
        expect(events.filter((e) => e.type === 'cycle_start').map((e) => e.cycle)).toEqual([1, 2]);
      },
      TEST_TIMEOUT_MS,
    );

    it(
      'ends at a worker budget_exceeded without ever calling the judge',
      async () => {
        const initializer = scriptModel([
          initializerResponse('Collect the widget roster.', 'artifacts/report.md must exist.'),
        ]);
        const worker = scriptModel([
          toolResponse('navigate-harness-budget', 'navigate', {
            url: fixtureServer.url('/'),
          }),
        ]);
        // No responses scripted: a judge call here throws immediately,
        // failing the test loudly instead of silently passing.
        const judge = scriptModel([]);

        const result = await runTask('Keep browsing until stopped.', {
          browser,
          runsBaseDir,
          callModel: worker.callModel,
          maxTurns: 1,
          maxContextTokens: 10_000,
          harness: {
            initializerCallModel: initializer.callModel,
            judgeCallModel: judge.callModel,
          },
        });

        expect(result).toMatchObject({ status: 'budget_exceeded', reason: 'max_turns' });
        expect(judge.requests).toHaveLength(0);

        const diagnostics = await readJson<HarnessDiagnostics>(
          join(result.runDir, HARNESS_FILENAME),
        );
        expect(diagnostics).toEqual({
          initializer: { model: INITIALIZER_MODEL },
          cycles: [{ cycle: 1, workerStatus: 'budget_exceeded' }],
        });

        const rollup = await readJson<RunMetrics>(join(result.runDir, METRICS_FILENAME));
        expect(rollup).toMatchObject({ status: 'budget_exceeded', turns: 1 });
      },
      TEST_TIMEOUT_MS,
    );

    it(
      'rejects when the initializer fails on both attempts, and still finalizes the manifest',
      async () => {
        // Same malformed pair as initializer.test.ts's own "still malformed
        // after the corrective retry" case: no headers at all, then INTENT
        // present but no CONTRACT header.
        const malformedOnce = textResponse('No headers at all here.');
        const malformedTwice = textResponse('# INTENT\nGoal stated.\n\nNo contract header this time.');
        const initializer = scriptModel([malformedOnce, malformedTwice]);
        const worker = scriptModel([]);
        const judge = scriptModel([]);

        const before = new Set(await readdir(runsBaseDir));

        await expect(
          runTask('Initializer fails on both attempts.', {
            browser,
            runsBaseDir,
            callModel: worker.callModel,
            maxTurns: 4,
            maxContextTokens: 10_000,
            harness: {
              initializerCallModel: initializer.callModel,
              judgeCallModel: judge.callModel,
            },
          }),
        ).rejects.toThrow(/CONTRACT/);

        const after = await readdir(runsBaseDir);
        const newDirs = after.filter((name) => !before.has(name));
        expect(newDirs).toHaveLength(1);
        const runDir = join(runsBaseDir, newDirs[0]!);

        const manifest = await readJson<Manifest>(join(runDir, MANIFEST_FILENAME));
        expect(manifest.finishedAt).toBeDefined();

        // The run never got past the initializer: no harness bookkeeping,
        // no governing documents, and the browser tab never opened.
        expect(existsSync(join(runDir, HARNESS_FILENAME))).toBe(false);
        expect(existsSync(join(runDir, INTENT_FILENAME))).toBe(false);
        expect(existsSync(join(runDir, CONTRACT_FILENAME))).toBe(false);
        expect(existsSync(join(runDir, METRICS_FILENAME))).toBe(false);
      },
      TEST_TIMEOUT_MS,
    );
  });
});
