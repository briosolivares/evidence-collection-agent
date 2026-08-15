import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import type { BrowserController } from '../browser/controller.js';
import { LocalChromeBrowserSessionProvider } from '../browser/playwrightBrowserController.js';
import { HARNESS_FILENAME, type HarnessDiagnostics } from '../harness/harness.js';
import { INITIALIZER_MODEL } from '../harness/initializer.js';
import { METRICS_FILENAME, type RunMetrics } from '../loop/workerSession.js';
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

// --- Harness-mode fakes: a forced set_output_contract call for the
// initializer (the only shape it can produce — see
// makeContractInitializerModelDriver), plus verifier responses that
// conclude the only way the verifier now can: one schema-valid
// report_verification tool call.

const submit = (id = 's1', summary = 'done') =>
  toolResponse(id, 'submit_for_verification', { summary });

/** A verifier response reporting `verified` (no findings). */
function verifierVerified(): ModelResponse {
  return toolResponse('report-verified', 'report_verification', {
    status: 'verified',
    findings: [],
  });
}

/** A verifier response reporting `needs_correction`, its single finding
 * carrying the given message. */
function verifierNeedsCorrection(message: string): ModelResponse {
  return toolResponse('report-correction', 'report_verification', {
    status: 'needs_correction',
    findings: [{ area: 'output', code: 'unsatisfied_criterion', message }],
  });
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
    await browser.closeTaskPages();
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
      const contract = {
        contract: {
          outputs: [
            { id: 'stories', kind: 'download', count: { exact: 1 }, filenamePattern: 'stories.csv' },
          ],
        },
      };
      const fake = scriptModel([
        toolResponse('c1', 'set_output_contract', contract, {
          input_tokens: 9,
          output_tokens: 2,
        }),
        toolResponse(
          'navigate-1',
          'browser_action',
          { actions: [{ op: 'navigate', url: fixtureUrl }] },
          {
            input_tokens: 11,
            output_tokens: 3,
          },
        ),
        toolResponse('inspect-1', 'observe', {}, {
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
        submit('s1', 'The CSV deliverable is complete.'),
      ]);
      const verifier = scriptModel([verifierVerified()]);

      const result = await runTask(taskText, {
        browser,
        runsBaseDir,
        callModel: fake.callModel,
        maxTurns: 8,
        maxContextTokens: 10_000,
        harness: { contractAuthor: 'worker', verifierCallModel: verifier.callModel },
      });

      expect(result.status).toBe('verified');
      expect(await readFile(join(result.runDir, 'artifacts/stories.csv'), 'utf8')).toBe(csv);

      // The third request can only contain this page data if browser_action
      // and observe ran through the real browser controller in the prior turns.
      expect(JSON.stringify(fake.requests[2])).toContain(fixtureUrl);
      expect(JSON.stringify(fake.requests[2])).toContain('Browser Controller Fixture');
      expect(fake.requests).toHaveLength(5);

      const events = await readTranscript(result.runDir);
      expect(
        events
          .filter((event) => event.type === 'tool_call')
          .map((event) => (event.call as { name: string }).name),
      ).toEqual(['set_output_contract', 'browser_action', 'observe', 'write_file']);
      expect(
        events
          .filter((event) => event.type === 'tool_result')
          .map((event) => (event.result as { toolCallId: string; isError: boolean }).toolCallId),
      ).toEqual(['c1', 'navigate-1', 'inspect-1', 'write-1', 's1']);
      expect(events.some((event) => event.type === 'submission')).toBe(true);

      const manifest = await readJson<Manifest>(
        join(result.runDir, MANIFEST_FILENAME),
      );
      expect(manifest.task).toBe(taskText);
      expect(manifest.finishedAt).toBeDefined();
      expect(Date.parse(manifest.finishedAt ?? '')).toBeGreaterThanOrEqual(
        Date.parse(manifest.startedAt),
      );
      const recordedArtifact = manifest.artifacts.find(
        (artifact) => artifact.filename === 'artifacts/stories.csv',
      );
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
      expect(metrics).toMatchObject({ status: 'verified', turns: 5 });
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
      const fake = scriptModel([...responses, submit('s1', 'Completed on the default final turn.')]);
      const verifier = scriptModel([verifierVerified()]);

      const result = await runTask('Use the complete default turn budget.', {
        browser,
        runsBaseDir,
        callModel: fake.callModel,
        maxContextTokens: 10_000,
        harness: { contractAuthor: 'worker', verifierCallModel: verifier.callModel },
      });

      // No contract is ever established (every inspect_page call is refused
      // by the contract-first gate — that refusal is the point: it proves
      // the run kept going for the full 23 refused turns before submitting,
      // which is all this test asserts about the default turn budget).
      expect(result.status).toBe('verified');
      expect(fake.requests).toHaveLength(24);
      await expect(
        readJson<RunMetrics>(join(result.runDir, METRICS_FILENAME)),
      ).resolves.toMatchObject({ status: 'verified', turns: 24 });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'closes an owned popup when a run fails before submission',
    async () => {
      const contract = {
        contract: {
          outputs: [
            {
              id: 'note',
              kind: 'download',
              count: { exact: 1 },
              filenamePattern: 'note.txt',
            },
          ],
        },
      };
      const popupUrl = fixtureServer.url('/second.html');
      // The missing third response deliberately crashes the model call after
      // the popup exists. runTask's finally block must still close the whole
      // owned page graph, not only the selected task tab.
      const worker = scriptModel([
        toolResponse('c-popup', 'set_output_contract', contract),
        toolResponse('open-popup', 'execute_javascript', {
          code: `window.open(${JSON.stringify(popupUrl)}, '_blank'); return true;`,
        }),
      ]);

      await expect(
        runTask('Open a popup, then fail before publishing.', {
          browser,
          runsBaseDir,
          callModel: worker.callModel,
          maxTurns: 5,
          maxContextTokens: 10_000,
          harness: { contractAuthor: 'worker' },
        }),
      ).rejects.toThrow(/only 2 responses were scripted/);

      expect(await browser.pages()).toEqual([]);
      await browser.newTab();
      await browser.goto(fixtureServer.url('/second.html'));
      expect(await browser.title()).toBe('Second Fixture Page');
      await browser.closeTaskPages();
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
        harness: { contractAuthor: 'worker' },
      });

      expect(budgetResult).toMatchObject({
        status: 'incomplete',
        reason: 'budget_exceeded',
      });
      expect(() => browser.currentUrl()).toThrow(/No browser task tab/);
      const budgetManifest = await readJson<Manifest>(
        join(budgetResult.runDir, MANIFEST_FILENAME),
      );
      expect(budgetManifest.finishedAt).toBeDefined();

      // runTask itself must be able to acquire the next fresh tab on the
      // same persistent browser session after the guarded ending.
      const nextFake = scriptModel([submit('s1', 'Next run completed.')]);
      const nextVerifier = scriptModel([verifierVerified()]);
      const nextResult = await runTask('Complete immediately.', {
        browser,
        runsBaseDir,
        callModel: nextFake.callModel,
        maxTurns: 2,
        maxContextTokens: 10_000,
        harness: { contractAuthor: 'worker', verifierCallModel: nextVerifier.callModel },
      });
      expect(nextResult.status).toBe('verified');
      expect(nextResult.runDir).not.toBe(budgetResult.runDir);
      expect(() => browser.currentUrl()).toThrow(/No browser task tab/);
    },
    TEST_TIMEOUT_MS,
  );

  describe('harness cycles (initializer → worker → judge outer loop)', () => {
    it(
      'runs the initializer and one worker cycle, ending on a judge DONE verdict',
      async () => {
        const contract = {
          contract: {
            outputs: [
              { id: 'report', kind: 'download', count: { exact: 1 }, filenamePattern: '*.md' },
            ],
          },
        };
        const initializer = scriptModel([toolResponse('c1', 'set_output_contract', contract)]);
        const worker = scriptModel([
          toolResponse('w1', 'write_file', { file_path: 'artifacts/report.md', content: '# Report\n' }),
          submit('s1', 'Report published.'),
        ]);
        const verifier = scriptModel([verifierVerified()]);

        const result = await runTask('Collect widgets and publish a report.', {
          browser,
          runsBaseDir,
          callModel: worker.callModel,
          maxTurns: 4,
          maxContextTokens: 10_000,
          harness: {
            contractAuthor: 'initializer',
            initializerCallModel: initializer.callModel,
            verifierCallModel: verifier.callModel,
          },
        });

        // A judge DONE verdict is the only success — and it reports as such.
        // The submission call carries no text of its own, so finalText is empty.
        expect(result).toMatchObject({ status: 'verified', finalText: '' });

        const diagnostics = await readJson<HarnessDiagnostics>(
          join(result.runDir, HARNESS_FILENAME),
        );
        expect(diagnostics).toEqual({
          initializer: { model: INITIALIZER_MODEL },
          cycles: [{ cycle: 1, workerStatus: 'completed', verdict: 'verified' }],
          outcome: { status: 'verified' },
        });

        // One metrics.json for the whole run: aggregates plus every model
        // role's own usage (initializer and verifier are no longer
        // invisible in the accounting).
        const metrics = await readJson<RunMetrics>(join(result.runDir, METRICS_FILENAME));
        expect(metrics).toMatchObject({ status: 'verified', turns: 2 });
        expect(metrics.roles?.worker?.turns).toBe(2);
        expect(metrics.roles?.initializer?.turns).toBe(1);
        expect(metrics.roles?.verifier?.turns).toBe(1);
        expect(existsSync(join(result.runDir, 'metrics-cycle-1.json'))).toBe(false);

        const events = await readTranscript(result.runDir);
        expect(events.filter((e) => e.type === 'cycle_start').map((e) => e.cycle)).toEqual([1]);
      },
      TEST_TIMEOUT_MS,
    );

    it(
      'runs a second worker cycle carrying the judge reason as feedback, then ends on DONE',
      async () => {
        // Deliberately worker-authored with no contract ever set: every
        // submission is unconditional, so this test stays about the
        // persistent-session/correction mechanic and not about contract
        // validity — that is runTask.verification.test.ts's job.
        const worker = scriptModel([
          submit('s1', 'First attempt at the report.'),
          submit('s2', 'Second attempt, column fixed.'),
        ]);
        const verifier = scriptModel([
          verifierNeedsCorrection('artifacts/report.md is missing the required id column.'),
          verifierVerified(),
        ]);

        const result = await runTask('Collect widgets and publish a report.', {
          browser,
          runsBaseDir,
          callModel: worker.callModel,
          maxTurns: 4,
          maxContextTokens: 10_000,
          harness: { contractAuthor: 'worker', verifierCallModel: verifier.callModel },
        });

        expect(result).toMatchObject({ status: 'verified', finalText: '' });
        expect(worker.requests).toHaveLength(2);

        // One persistent session: cycle 2's request replays the whole
        // prior exchange — task, the worker's first submission, the
        // verifier's correction answering it — before the worker acts
        // again. The worker keeps its context instead of starting over.
        const secondRequest = worker.requests[1];
        expect(secondRequest).toHaveLength(3);
        expect(secondRequest?.[0]?.role).toBe('user');
        expect(secondRequest?.[0]?.content[0]).toEqual({
          type: 'text',
          text: 'Collect widgets and publish a report.',
        });
        expect(secondRequest?.[1]?.role).toBe('assistant');
        expect((secondRequest?.[1]?.content[0] as { name: string }).name).toBe(
          'submit_for_verification',
        );
        const feedbackText = (secondRequest?.[2]?.content[0] as { content: string }).content;
        expect(secondRequest?.[2]?.role).toBe('user');
        expect(feedbackText).toContain('Verification found problems');
        expect(feedbackText).toContain(
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
              verdict: 'needs_correction',
              reason: '- output/unsatisfied_criterion: artifacts/report.md is missing the required id column.',
            },
            { cycle: 2, workerStatus: 'completed', verdict: 'verified' },
          ],
          outcome: { status: 'verified' },
        });

        const events = await readTranscript(result.runDir);
        expect(events.filter((e) => e.type === 'cycle_start').map((e) => e.cycle)).toEqual([1, 2]);
      },
      TEST_TIMEOUT_MS,
    );

    it(
      'ends at cycle exhaustion (maxWorkerCycles: 2) on a lingering CONTINUE as incomplete',
      async () => {
        const worker = scriptModel([submit('s1', 'First attempt.'), submit('s2', 'Second attempt.')]);
        const verifier = scriptModel([
          verifierNeedsCorrection('First reason.'),
          verifierNeedsCorrection('Second reason.'),
        ]);

        const result = await runTask('Collect widgets and publish a report.', {
          browser,
          runsBaseDir,
          callModel: worker.callModel,
          maxTurns: 4,
          maxContextTokens: 10_000,
          harness: {
            maxWorkerCycles: 2,
            contractAuthor: 'worker',
            verifierCallModel: verifier.callModel,
          },
        });

        // Exhausted corrections are not success: the last cycle's work
        // stands, explicitly unverified.
        expect(result).toMatchObject({
          status: 'incomplete',
          reason: 'verification_attempts',
          finalText: '',
        });
        // Exactly two worker cycles ran — a third would have thrown against
        // this fake's exhausted response script.
        expect(worker.requests).toHaveLength(2);
        expect(verifier.requests).toHaveLength(2);

        const diagnostics = await readJson<HarnessDiagnostics>(
          join(result.runDir, HARNESS_FILENAME),
        );
        expect(diagnostics.cycles).toHaveLength(2);
        expect(diagnostics.cycles[1]).toEqual({
          cycle: 2,
          workerStatus: 'completed',
          verdict: 'needs_correction',
          reason: '- output/unsatisfied_criterion: Second reason.',
        });
        expect(diagnostics.outcome).toMatchObject({
          status: 'incomplete',
          reason: 'verification_attempts',
        });
        await expect(
          readJson<RunMetrics>(join(result.runDir, METRICS_FILENAME)),
        ).resolves.toMatchObject({ status: 'incomplete' });

        const events = await readTranscript(result.runDir);
        expect(events.filter((e) => e.type === 'cycle_start').map((e) => e.cycle)).toEqual([1, 2]);
      },
      TEST_TIMEOUT_MS,
    );

    it(
      'the default cycle cap permits a third worker cycle (maxWorkerCycles omitted)',
      async () => {
        const worker = scriptModel([
          submit('s1', 'First attempt.'),
          submit('s2', 'Second attempt.'),
          submit('s3', 'Third attempt.'),
        ]);
        const verifier = scriptModel([
          verifierNeedsCorrection('First reason.'),
          verifierNeedsCorrection('Second reason.'),
          verifierVerified(),
        ]);

        const result = await runTask('Collect widgets and publish a report.', {
          browser,
          runsBaseDir,
          callModel: worker.callModel,
          maxTurns: 4,
          maxContextTokens: 10_000,
          harness: { contractAuthor: 'worker', verifierCallModel: verifier.callModel },
        });

        // Under the old default of 2, cycle 2's CONTINUE would have ended
        // the run; the default of 3 lets the third cycle run to DONE.
        expect(result).toMatchObject({ status: 'verified', finalText: '' });
        expect(worker.requests).toHaveLength(3);
        expect(verifier.requests).toHaveLength(3);
        // The persistent session accretes: attempt 1, correction, attempt 2,
        // correction, then the third request sees the full history.
        expect(worker.requests[2]).toHaveLength(5);

        const events = await readTranscript(result.runDir);
        expect(events.filter((e) => e.type === 'cycle_start').map((e) => e.cycle)).toEqual([
          1, 2, 3,
        ]);
      },
      TEST_TIMEOUT_MS,
    );

    it(
      'ends at a worker budget_exceeded without ever calling the judge',
      async () => {
        // A single navigate call, refused by the contract-first gate (no
        // contract has been set) — the refusal still charges a worker turn,
        // so this trips the max_turns guard immediately without needing any
        // initializer call or real network access.
        const worker = scriptModel([
          toolResponse('navigate-harness-budget', 'navigate', {
            url: fixtureServer.url('/'),
          }),
        ]);
        // No responses scripted: a judge call here throws immediately,
        // failing the test loudly instead of silently passing.
        const verifier = scriptModel([]);

        const result = await runTask('Keep browsing until stopped.', {
          browser,
          runsBaseDir,
          callModel: worker.callModel,
          maxTurns: 1,
          maxContextTokens: 10_000,
          harness: { contractAuthor: 'worker', verifierCallModel: verifier.callModel },
        });

        // Budget exhaustion inside the harness is an incomplete outcome —
        // budgets end runs, and an unverified end is not success.
        expect(result).toMatchObject({ status: 'incomplete', reason: 'budget_exceeded' });
        expect(verifier.requests).toHaveLength(0);

        const diagnostics = await readJson<HarnessDiagnostics>(
          join(result.runDir, HARNESS_FILENAME),
        );
        expect(diagnostics).toEqual({
          initializer: { model: INITIALIZER_MODEL },
          cycles: [{ cycle: 1, workerStatus: 'budget_exceeded' }],
          outcome: {
            status: 'incomplete',
            reason: 'budget_exceeded',
            detail: "worker budget guard 'max_turns' tripped in cycle 1",
          },
        });

        const metrics = await readJson<RunMetrics>(join(result.runDir, METRICS_FILENAME));
        expect(metrics).toMatchObject({ status: 'incomplete', turns: 1 });
      },
      TEST_TIMEOUT_MS,
    );

    it(
      'a judge crash preserves the finished run but reports incomplete: verifier_unavailable',
      async () => {
        const worker = scriptModel([submit('s1', 'Report published.')]);
        const crashingVerifier: CallModel = async () => {
          throw new Error('400 image dimensions exceed max allowed size');
        };

        const result = await runTask('Collect widgets and publish a report.', {
          browser,
          runsBaseDir,
          callModel: worker.callModel,
          maxTurns: 4,
          maxContextTokens: 10_000,
          harness: { contractAuthor: 'worker', verifierCallModel: crashingVerifier },
        });

        // The worker's artifacts survive its verifier's crash — but nobody
        // trustworthy reviewed them, so the run is incomplete, not success.
        expect(result).toMatchObject({
          status: 'incomplete',
          reason: 'verifier_unavailable',
          finalText: '',
        });
        const diagnostics = await readJson<HarnessDiagnostics>(
          join(result.runDir, HARNESS_FILENAME),
        );
        expect(diagnostics.cycles).toEqual([
          {
            cycle: 1,
            workerStatus: 'completed',
            verifierError: expect.stringContaining('400 image dimensions'),
          },
        ]);
        expect(diagnostics.outcome).toMatchObject({
          status: 'incomplete',
          reason: 'verifier_unavailable',
        });
        const metrics = await readJson<RunMetrics>(join(result.runDir, METRICS_FILENAME));
        expect(metrics).toMatchObject({ status: 'incomplete', turns: 1 });
      },
      TEST_TIMEOUT_MS,
    );

    it(
      "an AbortError from the judge propagates — cancellation is the caller's, not the judge's",
      async () => {
        const worker = scriptModel([submit('s1', 'Report published.')]);
        const abortingVerifier: CallModel = async () => {
          const error = new Error('aborted');
          error.name = 'AbortError';
          throw error;
        };

        await expect(
          runTask('Collect widgets and publish a report.', {
            browser,
            runsBaseDir,
            callModel: worker.callModel,
            maxTurns: 4,
            maxContextTokens: 10_000,
            harness: { contractAuthor: 'worker', verifierCallModel: abortingVerifier },
          }),
        ).rejects.toThrow('aborted');
      },
      TEST_TIMEOUT_MS,
    );

    it(
      'rejects when the initializer fails on both attempts, and still finalizes the manifest',
      async () => {
        // Same malformed pair as initializer.test.ts's own "fails after a
        // second bad response" case: a response with no set_output_contract
        // call at all, twice.
        const malformed = textResponse('I will not call any tool.');
        const initializer = scriptModel([malformed, malformed]);
        const worker = scriptModel([]);
        const verifier = scriptModel([]);

        const before = new Set(await readdir(runsBaseDir));

        await expect(
          runTask('Initializer fails on both attempts.', {
            browser,
            runsBaseDir,
            callModel: worker.callModel,
            maxTurns: 4,
            maxContextTokens: 10_000,
            harness: {
              contractAuthor: 'initializer',
              initializerCallModel: initializer.callModel,
              verifierCallModel: verifier.callModel,
            },
          }),
        ).rejects.toThrow(/set_output_contract/);

        const after = await readdir(runsBaseDir);
        const newDirs = after.filter((name) => !before.has(name));
        expect(newDirs).toHaveLength(1);
        const runDir = join(runsBaseDir, newDirs[0]!);

        const manifest = await readJson<Manifest>(join(runDir, MANIFEST_FILENAME));
        expect(manifest.finishedAt).toBeDefined();

        // The run never got past the initializer: no harness bookkeeping,
        // and the browser tab never opened.
        expect(existsSync(join(runDir, HARNESS_FILENAME))).toBe(false);
        expect(existsSync(join(runDir, METRICS_FILENAME))).toBe(false);
      },
      TEST_TIMEOUT_MS,
    );
  });
});
