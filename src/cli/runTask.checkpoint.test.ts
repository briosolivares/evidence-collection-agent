import { existsSync } from 'node:fs';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import type { BrowserController } from '../browser/controller.js';
import { LocalChromeBrowserSessionProvider } from '../browser/playwrightBrowserController.js';
import { CONTRACT_FILENAME, INTENT_FILENAME } from '../harness/initializer.js';
import type { CallModel, Message, ModelResponse, Usage } from '../loop/messages.js';
import { createRunBudgetTracker } from '../run/runBudget.js';
import { openRunCheckpointStore } from '../run/runCheckpointStore.js';
import { createRunDir } from '../run/runDir.js';
import { generateRunId } from '../run/runId.js';
import { initManifest, MANIFEST_FILENAME, type Manifest } from '../run/artifacts.js';
import type { RunMetrics } from '../loop/agentLoop.js';
import { createRunCheckpointWriter } from './runCheckpoint.js';
import { resumeTask, runTask, type RunTaskResult } from './runTask.js';

// Durable checkpointing + resume, driven entirely by scripted models (no
// real API call, no network) — matching runTask.test.ts's own conventions
// for a real browser + fake models. "Crashing" a run mid-harness is
// simulated the same way runTask.test.ts's fake models already fail loudly
// when asked for a response nobody scripted: scriptModel's own "only N
// responses were scripted" throw IS the simulated crash, propagating out of
// runTask exactly like a real transport failure would.

const TEST_TIMEOUT_MS = 30_000;
const DEFAULT_USAGE: Usage = { input_tokens: 10, output_tokens: 2 };

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

function textResponse(text: string, usage: Usage = DEFAULT_USAGE): ModelResponse {
  return { content: [{ type: 'text', text }], stop_reason: 'end_turn', usage };
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

function initializerResponse(intent: string, contract: string): ModelResponse {
  return textResponse(`# INTENT\n${intent}\n\n# CONTRACT\n${contract}`);
}

function verifierVerified(): ModelResponse {
  return toolResponse('report-verified', 'report_verification', { status: 'verified', findings: [] });
}

function verifierNeedsCorrection(message: string): ModelResponse {
  return toolResponse('report-correction', 'report_verification', {
    status: 'needs_correction',
    findings: [{ area: 'output', code: 'unsatisfied_criterion', message }],
  });
}

/** A never-callable model: any invocation is a test failure, since the
 * whole point of resuming a 'terminal' checkpoint is zero model calls. */
function throwingCallModel(label: string): CallModel {
  return async () => {
    throw new Error(`${label} must never be called`);
  };
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, 'utf8')) as T;
}

/** Find the one run directory a `runsBaseDir` snapshot gained between two
 * points in time — the technique runTask.test.ts's own initializer-failure
 * test uses to locate a run directory when `runTask` rejects instead of
 * returning it. */
async function newRunDir(runsBaseDir: string, before: Set<string>): Promise<string> {
  const after = await readdir(runsBaseDir);
  const added = after.filter((name) => !before.has(name));
  if (added.length !== 1) {
    throw new Error(`expected exactly one new run directory, found ${added.length}: ${added.join(', ')}`);
  }
  return join(runsBaseDir, added[0]!);
}

/** A minimal, valid CONTRACT_INPUT for the typed-protocol test: one
 * `download` output checked purely by manifest presence and filename
 * pattern (see completionCheck.ts's checkCaptureOutput) — satisfiable with
 * a plain `write_file` call, no evidence and no `write_document` (a V2 tool
 * this codebase's registry construction does not yet wire up; out of scope
 * to add here — see the module note on why a `table`/`download`/
 * `screenshots` output is used instead of `document` in this suite). */
const CONTRACT_INPUT = {
  contract: {
    outputs: [{ id: 'report', kind: 'download', count: { exact: 1 }, filenamePattern: '*.md' }],
  },
};

describe('runTask checkpointing and resumeTask', () => {
  let browser: BrowserController;
  let tempRoot: string;
  let runsBaseDir: string;

  beforeAll(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), 'run-checkpoint-e2e-'));
    runsBaseDir = join(tempRoot, 'runs');
    browser = await new LocalChromeBrowserSessionProvider({
      profileDir: join(tempRoot, 'chrome-profile'),
      headless: true,
    }).createSession();
  }, TEST_TIMEOUT_MS);

  afterEach(async () => {
    // Belt-and-suspenders: a test that already closed its own tab makes this
    // a no-op (closeTab is documented as such); one that crashed mid-test
    // leaves the session ready for the next test regardless.
    await browser.closeTab().catch(() => undefined);
  });

  afterAll(async () => {
    await browser?.close();
    if (tempRoot !== undefined) await rm(tempRoot, { recursive: true, force: true });
  });

  /** A complete, one-cycle, prose-path harness run that writes one
   * manifest-tracked artifact and ends 'verified' — the shared fixture for
   * every test that just needs SOME finished checkpointed run to inspect or
   * resume, without caring about the specific task content. */
  async function runSimpleVerifiedHarnessRun(
    taskText: string,
  ): Promise<{ result: RunTaskResult; runDir: string }> {
    const initializer = scriptModel([initializerResponse('Goal.', 'Criteria.')]);
    const worker = scriptModel([
      toolResponse('w1', 'write_file', { file_path: 'artifacts/note.txt', content: 'hello\n' }),
      textResponse('All done.'),
    ]);
    const verifier = scriptModel([verifierVerified()]);
    const result = await runTask(taskText, {
      browser,
      runsBaseDir,
      callModel: worker.callModel,
      maxTurns: 8,
      maxContextTokens: 100_000,
      harness: {
        initializerCallModel: initializer.callModel,
        verifierCallModel: verifier.callModel,
      },
    });
    return { result, runDir: result.runDir };
  }

  it(
    'a harness run writes checkpoints and the terminal one records the real outcome',
    async () => {
      const { result, runDir } = await runSimpleVerifiedHarnessRun(
        'Write a checkpointed note and verify it.',
      );
      expect(result).toMatchObject({ status: 'verified', finalText: 'All done.' });

      // runTask's own finally already closed the store; opening a fresh
      // instance to inspect it proves the lock was actually released, not
      // just that the file bytes look right.
      const store = await openRunCheckpointStore(runDir);
      try {
        const checkpoint = store.load();
        expect(checkpoint).toBeDefined();
        expect(checkpoint?.runStatus).toBe('terminal');
        expect(checkpoint?.finalOutcome).toEqual({ status: 'verified', finalText: 'All done.' });
        expect(checkpoint?.workerSession).toBeDefined();
        expect(checkpoint?.checkpointRevision).toBeGreaterThan(1);
      } finally {
        await store.close();
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'a judge-less run writes NO checkpoint',
    async () => {
      const worker = scriptModel([textResponse('Completed with no harness configured.')]);
      const result = await runTask('Plain task, harness absent.', {
        browser,
        runsBaseDir,
        callModel: worker.callModel,
        maxTurns: 4,
        maxContextTokens: 10_000,
      });
      expect(result.status).toBe('completed');
      expect(existsSync(join(result.runDir, 'harness'))).toBe(false);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'resume from a terminal checkpoint makes zero model and zero tool calls',
    async () => {
      const { result, runDir } = await runSimpleVerifiedHarnessRun(
        'Write a checkpointed note and verify it, then resume from terminal.',
      );
      expect(result.status).toBe('verified');

      const resumed = await resumeTask(runDir, {
        browser,
        callModel: throwingCallModel('the worker model'),
        harness: { verifierCallModel: throwingCallModel('the verifier model') },
      });

      expect(resumed).toEqual(result);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'resume fails loudly on a scalar-config mismatch, before touching the run',
    async () => {
      const { runDir } = await runSimpleVerifiedHarnessRun('Scalar mismatch check.');

      await expect(
        resumeTask(runDir, {
          browser,
          model: 'definitely-not-the-original-model',
          callModel: throwingCallModel('the worker model'),
        }),
      ).rejects.toThrow(/does not match this run's checkpoint/);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "resume fails loudly when a manifest-tracked file's bytes changed",
    async () => {
      const { runDir } = await runSimpleVerifiedHarnessRun('Tamper-detection check.');
      await writeFile(join(runDir, 'artifacts/note.txt'), 'tampered content\n', 'utf8');

      await expect(
        resumeTask(runDir, {
          browser,
          callModel: throwingCallModel('the worker model'),
          harness: { verifierCallModel: throwingCallModel('the verifier model') },
        }),
      ).rejects.toThrow(/changed after it was recorded/);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'resume from ready_for_model restores conversation, turn count, and budget without refilling headroom, and appends exactly one recovery notice',
    async () => {
      const taskText = 'Collect a widget note, get corrected once, then finish after a crash.';
      const before = new Set(await readdir(runsBaseDir));

      const initializer = scriptModel([initializerResponse('Collect a note.', 'artifacts/note.txt must exist.')]);
      // Cycle 1: a tool call, then a completion. Cycle 2 never gets a
      // scripted response — the attempt to call the model for it is the
      // simulated crash.
      const worker = scriptModel([
        toolResponse('w1', 'write_file', { file_path: 'artifacts/note.txt', content: 'hello\n' }),
        textResponse('First attempt.'),
      ]);
      const verifier = scriptModel([verifierNeedsCorrection('Needs a second pass.')]);

      await expect(
        runTask(taskText, {
          browser,
          runsBaseDir,
          callModel: worker.callModel,
          maxTurns: 8,
          maxContextTokens: 100_000,
          harness: {
            maxWorkerCycles: 2,
            initializerCallModel: initializer.callModel,
            verifierCallModel: verifier.callModel,
          },
        }),
      ).rejects.toThrow(/only 2 responses were scripted/);

      const runDir = await newRunDir(runsBaseDir, before);

      // The crash happened mid-run: no metrics.json (a cancelled/crashed run
      // never gets the success-shaped one), but the checkpoint is durable.
      const store = await openRunCheckpointStore(runDir);
      const crashedCheckpoint = store.load();
      await store.close();
      expect(crashedCheckpoint?.runStatus).toBe('ready_for_model');
      expect(crashedCheckpoint?.runProgress.currentCycle).toBe(2);
      expect(crashedCheckpoint?.workerSession?.turnCount).toBe(2);

      const continuation = scriptModel([textResponse('Second attempt, corrected.')]);
      const continuationVerifier = scriptModel([verifierVerified()]);

      const result = await resumeTask(runDir, {
        browser,
        confirmPreviousCommandStopped: true,
        callModel: continuation.callModel,
        harness: { verifierCallModel: continuationVerifier.callModel },
      });

      expect(result).toMatchObject({
        runDir,
        status: 'verified',
        finalText: 'Second attempt, corrected.',
      });

      // The restored request replays the ENTIRE prior conversation exactly,
      // then the recovery notice, exactly once — no more, no less.
      expect(continuation.requests).toHaveLength(1);
      const restored = continuation.requests[0]!;
      expect(restored).toHaveLength(6);
      expect(restored[0]).toEqual({
        role: 'user',
        content: [{ type: 'text', text: taskText }],
      });
      expect(restored[1]?.role).toBe('assistant');
      expect((restored[1]?.content[0] as { name: string }).name).toBe('write_file');
      expect(restored[2]?.role).toBe('user'); // the write_file tool_result
      expect(restored[3]).toEqual({
        role: 'assistant',
        content: [{ type: 'text', text: 'First attempt.' }],
      });
      const feedbackText = (restored[4]?.content[0] as { text: string }).text;
      expect(feedbackText).toContain('Verification findings:');
      expect(feedbackText).toContain('Needs a second pass.');
      const noticeText = (restored[5]?.content[0] as { text: string }).text;
      expect(noticeText).toContain('recovered after an interruption');
      expect(noticeText).toContain('browser session was recreated');
      // Exactly once: nowhere else in the restored (or newly produced)
      // conversation does this text appear a second time.
      const fullConversationText = JSON.stringify(restored);
      expect(fullConversationText.split('recovered after an interruption')).toHaveLength(2);

      // Turn count and budget are additive across the crash boundary, not
      // reset: 2 worker turns before the crash + 1 after == 3, never 1 (lost
      // history) and never 4 (the crashed attempt double-billed).
      const metrics = await readJson<RunMetrics>(join(runDir, 'metrics.json'));
      expect(metrics.status).toBe('verified');
      expect(metrics.turns).toBe(3);
      expect(metrics.roles?.worker?.turns).toBe(3);
      expect(metrics.roles?.verifier?.turns).toBe(2);
      expect(metrics.roles?.initializer?.turns).toBe(1);

      const finalStore = await openRunCheckpointStore(runDir);
      const finalCheckpoint = finalStore.load();
      await finalStore.close();
      expect(finalCheckpoint?.runStatus).toBe('terminal');
      expect(finalCheckpoint?.finalOutcome).toMatchObject({ status: 'verified' });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "resume of an interrupted prose initializer finishes INTENT.md/CONTRACT.md without a second initializer call",
    async () => {
      const taskText = 'Interrupted prose initializer.';
      const runDir = createRunDir(runsBaseDir, generateRunId(taskText));
      initManifest(runDir, taskText);

      // Hand-build exactly the checkpoint runTask would have left behind had
      // it crashed between recording the accepted {intent, contract} and
      // calling writeInitializerFiles — a window with no awaited call in it
      // to interrupt from the outside, so this is constructed directly
      // rather than through a real crash (see the module note on
      // resumeTask's 'initializing' handling for why this is the one
      // deterministic recovery step that needs no model call to finish).
      const budget = createRunBudgetTracker({
        maxWorkerTurns: Infinity,
        maxToolCalls: Infinity,
        maxModelTokens: Infinity,
        maxToolResultBytes: Infinity,
        maxWallTimeMs: Infinity,
        maxVerifierCorrections: 2,
      });
      const store = await openRunCheckpointStore(runDir);
      const writer = createRunCheckpointWriter(store, {
        runConfiguration: {
          model: 'claude-sonnet-5',
          toolProfile: 'atomic',
          maxOutputTokens: 8192,
          maxTurns: 'unbounded',
          maxContextTokens: 100_000,
          harness: {
            maxWorkerCycles: 3,
            maxCompletionCheckFailures: 5,
            outputContract: false,
            contractAuthor: 'initializer',
          },
        },
        budget,
      });
      await writer.saveInitializing();
      await writer.saveInitializerAccepted({
        mode: 'prose',
        proseAccepted: { intent: 'Collect one note.', contract: 'artifacts/note.txt must exist.' },
      });
      await writer.close();

      expect(existsSync(join(runDir, INTENT_FILENAME))).toBe(false);
      expect(existsSync(join(runDir, CONTRACT_FILENAME))).toBe(false);

      const worker = scriptModel([
        toolResponse('w1', 'write_file', { file_path: 'artifacts/note.txt', content: 'hello\n' }),
        textResponse('Done.'),
      ]);
      const verifier = scriptModel([verifierVerified()]);

      const result = await resumeTask(runDir, {
        browser,
        callModel: worker.callModel,
        harness: { verifierCallModel: verifier.callModel },
      });

      expect(result).toMatchObject({ runDir, status: 'verified', finalText: 'Done.' });
      expect(await readFile(join(runDir, INTENT_FILENAME), 'utf8')).toBe('Collect one note.\n');
      expect(await readFile(join(runDir, CONTRACT_FILENAME), 'utf8')).toBe(
        'artifacts/note.txt must exist.\n',
      );
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'resume on the typed path rehydrates the contract store to the same current revision',
    async () => {
      const taskText = 'Typed contract, crash after acceptance, resume and finish.';
      const before = new Set(await readdir(runsBaseDir));

      // Cycle 1, turn 1: the worker states the contract itself (no
      // initializer call needed). Turn 2 has no scripted response — the
      // model call for it is the simulated crash, AFTER the contract is
      // already durable on disk.
      const worker = scriptModel([toolResponse('c1', 'set_output_contract', CONTRACT_INPUT)]);
      const verifier = scriptModel([]);

      await expect(
        runTask(taskText, {
          browser,
          runsBaseDir,
          callModel: worker.callModel,
          maxTurns: 8,
          maxContextTokens: 100_000,
          harness: {
            outputContract: true,
            contractAuthor: 'worker',
            maxWorkerCycles: 2,
            verifierCallModel: verifier.callModel,
          },
        }),
      ).rejects.toThrow(/only 1 responses were scripted/);

      const runDir = await newRunDir(runsBaseDir, before);
      expect(existsSync(join(runDir, 'scratch/output-contract/revision-1.json'))).toBe(true);

      // If the resumed run's contract store were NOT rehydrated,
      // `submit_for_verification` would reach runVerifier with no contract
      // and no INTENT.md/CONTRACT.md to fall back on, which throws — so a
      // clean 'verified' result here is itself the proof that rehydration
      // put the SAME contract back in the run-scoped store.
      const continuation = scriptModel([
        toolResponse('w1', 'write_file', { file_path: 'artifacts/report.md', content: '# Report\n' }),
        toolResponse('s1', 'submit_for_verification', { summary: 'done' }),
      ]);
      const continuationVerifier = scriptModel([verifierVerified()]);

      const result = await resumeTask(runDir, {
        browser,
        confirmPreviousCommandStopped: true,
        callModel: continuation.callModel,
        harness: { verifierCallModel: continuationVerifier.callModel },
      });

      expect(result).toMatchObject({ runDir, status: 'verified' });
      expect(await readFile(join(runDir, 'artifacts/report.md'), 'utf8')).toBe('# Report\n');

      // The verifier saw the SAME contract (revision 1's single 'report'
      // output), not the prose compatibility path.
      const verifierRequestText = JSON.stringify(continuationVerifier.requests[0]);
      expect(verifierRequestText).toContain('report');
      expect(verifierRequestText).not.toContain('INTENT.md');

      const manifest = await readJson<Manifest>(join(runDir, MANIFEST_FILENAME));
      expect(manifest.artifacts.some((a) => a.filename === 'artifacts/report.md')).toBe(true);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "resume from a 'verifying' checkpoint never re-runs the finished worker cycle, and still delivers the recovery notice",
    async () => {
      const taskText = 'Typed submission, crash inside the verifier call, resume to verified.';
      const before = new Set(await readdir(runsBaseDir));

      // Cycle 1 completes in full — contract, deliverable, submission — and
      // the completion checks pass, so the harness reaches saveVerifying and
      // calls the verifier. The verifier throws an AbortError: runVerifier
      // treats every OTHER model failure as its own 'verifier_unavailable'
      // outcome (a normal, non-crashing ending — see verifier.ts), so an
      // AbortError is the one failure that actually propagates out of
      // runTask as a genuine crash, exactly like the caller's own
      // cancellation would (see runTask.test.ts's own
      // "an AbortError from the judge propagates" case).
      const worker = scriptModel([
        toolResponse('c1', 'set_output_contract', CONTRACT_INPUT),
        toolResponse('w1', 'write_file', { file_path: 'artifacts/report.md', content: '# Report\n' }),
        toolResponse('s1', 'submit_for_verification', { summary: 'done' }),
      ]);
      const abortingVerifier: CallModel = async () => {
        const error = new Error('simulated crash mid-verifier-call');
        error.name = 'AbortError';
        throw error;
      };

      await expect(
        runTask(taskText, {
          browser,
          runsBaseDir,
          callModel: worker.callModel,
          maxTurns: 8,
          maxContextTokens: 100_000,
          harness: {
            outputContract: true,
            contractAuthor: 'worker',
            maxWorkerCycles: 2,
            verifierCallModel: abortingVerifier,
          },
        }),
      ).rejects.toThrow('simulated crash mid-verifier-call');

      const runDir = await newRunDir(runsBaseDir, before);

      const crashedStore = await openRunCheckpointStore(runDir);
      const crashedCheckpoint = crashedStore.load();
      await crashedStore.close();
      expect(crashedCheckpoint?.runStatus).toBe('verifying');
      expect(crashedCheckpoint?.runProgress.currentCycle).toBe(1);
      const lastMessage = crashedCheckpoint?.workerSession?.messages.at(-1) as
        | { role: string; content: Array<{ type: string; name?: string }> }
        | undefined;
      expect(lastMessage?.role).toBe('assistant');
      expect(lastMessage?.content.some((block) => block.name === 'submit_for_verification')).toBe(
        true,
      );

      // No worker callModel is supplied at all — any call would fail the
      // test immediately, proving the finished cycle is never re-run.
      const continuationVerifier = scriptModel([verifierVerified()]);
      const result = await resumeTask(runDir, {
        browser,
        callModel: throwingCallModel('the worker model'),
        harness: { verifierCallModel: continuationVerifier.callModel },
      });

      expect(result).toMatchObject({ runDir, status: 'verified' });
      expect(continuationVerifier.requests).toHaveLength(1);

      // The recovery notice is delivered exactly once, folded into the
      // submission's own tool_result — the earliest point after the
      // dangling submit_for_verification tool_use where a plain message can
      // safely be appended (see resumeTask's `deferNotice`).
      const finalStore = await openRunCheckpointStore(runDir);
      const finalCheckpoint = finalStore.load();
      await finalStore.close();
      expect(finalCheckpoint?.runStatus).toBe('terminal');
      const finalMessages = finalCheckpoint?.workerSession?.messages ?? [];
      const conversationText = JSON.stringify(finalMessages);
      expect(conversationText.split('recovered after an interruption')).toHaveLength(2);
      const submissionAnswer = finalMessages.at(-1) as { content: Array<{ content: string }> };
      expect(submissionAnswer.content[0]?.content).toContain('recovered after an interruption');
      expect(submissionAnswer.content[0]?.content).toContain('"status":"verified"');
    },
    TEST_TIMEOUT_MS,
  );
});
