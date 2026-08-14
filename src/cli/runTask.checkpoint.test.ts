import { existsSync } from 'node:fs';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import type { BrowserController } from '../browser/controller.js';
import { LocalChromeBrowserSessionProvider } from '../browser/playwrightBrowserController.js';
import { CONTRACT_FILENAME, INTENT_FILENAME, writeInitializerFiles } from '../harness/initializer.js';
import type { CallModel, Message, ModelResponse, Usage } from '../loop/messages.js';
import { createWorkerSession, type WorkerSessionDeps } from '../loop/workerSession.js';
import { createRunBudgetTracker } from '../run/runBudget.js';
import { openRunCheckpointStore, type RunCheckpointV1 } from '../run/runCheckpointStore.js';
import { createRunDir } from '../run/runDir.js';
import { generateRunId } from '../run/runId.js';
import { initManifest, MANIFEST_FILENAME, type Manifest } from '../run/artifacts.js';
import type { RunMetrics } from '../loop/agentLoop.js';
import type { ToolProfile } from '../tools/index.js';
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

  /**
   * Hand-build a run directory whose only checkpoint is `'executing_tools'`,
   * carrying exactly the given pendingTurn tool calls — the shape a real
   * `runTask` would have left behind had the process died mid-batch (see
   * runCheckpoint.ts's `saveExecutingTools`). Built directly rather than via
   * a genuine crash, the same technique
   * "resume of an interrupted prose initializer" above uses: there is no
   * awaited call between a state-changing tool call starting and its result
   * landing that this suite could interrupt from the outside.
   *
   * Uses the prose (non-typed) harness path so no contract or initializer
   * call is needed to reach a valid checkpoint — this run never actually
   * executes past `'initializing'`, so nothing here depends on
   * INTENT.md/CONTRACT.md having been written.
   *
   * `toolProfile` defaults to `'atomic'` (every caller but the
   * toolProfile-resume regression test wants the default surface); pass
   * `'batch-enabled'` when the checkpoint being built needs to record that
   * choice for `resumeTask` to read back.
   */
  async function buildExecutingToolsRunDir(
    taskText: string,
    toolCalls: NonNullable<RunCheckpointV1['pendingTurn']>['toolCalls'],
    toolProfile: ToolProfile = 'atomic',
  ): Promise<string> {
    const runDir = createRunDir(runsBaseDir, generateRunId(taskText));
    initManifest(runDir, taskText);

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
        toolProfile,
        maxOutputTokens: 8192,
        maxTurns: 'unbounded',
        maxContextTokens: 100_000,
        harness: {
          maxWorkerCycles: 2,
          maxCompletionCheckFailures: 5,
          outputContract: false,
          contractAuthor: 'initializer',
        },
      },
      budget,
    });
    // The prose path's verifier reads INTENT.md/CONTRACT.md straight off
    // disk (see harness/verifierTools.ts's buildVerificationInput) — a real
    // run would have written these before ever reaching 'ready_for_model',
    // so a hand-built checkpoint must too, or the resumed verifier call
    // fails on a missing-file error unrelated to what this test checks.
    writeInitializerFiles(runDir, { intent: 'Goal.', contract: 'Criteria.' });
    await writer.saveInitializerAccepted({
      mode: 'prose',
      proseAccepted: { intent: 'Goal.', contract: 'Criteria.' },
      filesWritten: true,
    });

    // Never actually called: this session exists only to be snapshotted into
    // the checkpoint below, not to run.
    const fakeDeps: WorkerSessionDeps = {
      callModel: async () => {
        throw new Error('not used: this session is checkpointed, never run');
      },
      registry: new Map(),
      runDir,
    };
    const session = createWorkerSession(taskText, fakeDeps, { budget, maxContextTokens: 100_000 });
    session.state.turnCount = 1;
    // The unanswered assistant turn that started this (never-finished)
    // batch — exactly what session.state.messages.at(-1) is by the time
    // scheduleToolCalls's hooks fire (runWorkerTurn pushes the assistant
    // message before tool execution begins, so it is already the last
    // message when a call is still 'running' or freshly 'finished').
    session.state.messages.push({
      role: 'assistant',
      content: toolCalls.map((call) => ({
        type: 'tool_use' as const,
        id: call.request.id,
        name: call.request.name,
        input: call.request.input,
      })),
    });

    await writer.saveExecutingTools({
      session,
      progress: { currentCycle: 1, completionCheckFailures: 0, cycleRecords: [] },
      pendingTurn: {
        turnNumber: 1,
        assistantMessage: session.state.messages.at(-1),
        toolCalls,
      },
    });
    await writer.close();
    return runDir;
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
    "resume from a 'ready_for_model' checkpoint appends only the plain recovery notice — no interrupted-batch sentence",
    async () => {
      const taskText = 'Ready-for-model crash produces the plain notice only, never the executing_tools one.';
      const before = new Set(await readdir(runsBaseDir));

      const initializer = scriptModel([initializerResponse('Goal.', 'Criteria.')]);
      // Cycle 1 finishes with a plain no-tool completion: the checkpoint this
      // crash leaves is 'ready_for_model', never 'executing_tools', so the
      // resumed notice must never mention any tool call at all — that
      // sentence is specific to describeInterruptedBatch, which only fires
      // for 'executing_tools'.
      const worker = scriptModel([textResponse('First attempt.')]);
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
      ).rejects.toThrow(/only 1 responses were scripted/);

      const runDir = await newRunDir(runsBaseDir, before);
      const crashedStore = await openRunCheckpointStore(runDir);
      const crashedCheckpoint = crashedStore.load();
      await crashedStore.close();
      expect(crashedCheckpoint?.runStatus).toBe('ready_for_model');

      const continuation = scriptModel([textResponse('Second attempt, corrected.')]);
      const continuationVerifier = scriptModel([verifierVerified()]);

      const result = await resumeTask(runDir, {
        browser,
        confirmPreviousCommandStopped: true,
        callModel: continuation.callModel,
        harness: { verifierCallModel: continuationVerifier.callModel },
      });

      expect(result).toMatchObject({ runDir, status: 'verified' });

      expect(continuation.requests).toHaveLength(1);
      const restored = continuation.requests[0]!;
      expect(restored).toHaveLength(4);
      const noticeText = (restored[3]?.content[0] as { text: string }).text;
      expect(noticeText).toContain('recovered after an interruption');
      expect(noticeText).toContain('browser session was recreated');
      // The regression this guards: describeInterruptedBatch's text must
      // never leak onto a checkpoint it was not built for.
      expect(noticeText).not.toContain('The interrupted turn included');
      expect(noticeText).not.toContain('had started but never reported a result');
      expect(noticeText).not.toContain('whose results were lost with the interrupted turn');
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "resume of an 'executing_tools' checkpoint requires confirmPreviousCommandStopped, and the error names the status",
    async () => {
      const runDir = await buildExecutingToolsRunDir(
        "Executing-tools crash requires confirmation before resume.",
        [{ request: { id: 'call-1', name: 'bash', input: { command: 'echo hi' } }, executionStatus: 'running' }],
      );

      await expect(
        resumeTask(runDir, {
          browser,
          callModel: throwingCallModel('the worker model'),
          harness: { verifierCallModel: throwingCallModel('the verifier model') },
        }),
      ).rejects.toThrow(/status 'executing_tools'/);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "resume of an 'executing_tools' checkpoint names a still-running call in the recovery notice the resumed model actually receives",
    async () => {
      const taskText = 'Executing-tools crash: a running bash call is named in the notice.';
      const runDir = await buildExecutingToolsRunDir(taskText, [
        { request: { id: 'call-1', name: 'bash', input: { command: 'echo hi' } }, executionStatus: 'running' },
      ]);

      const continuation = scriptModel([textResponse('Finishing up.')]);
      const continuationVerifier = scriptModel([verifierVerified()]);

      const result = await resumeTask(runDir, {
        browser,
        confirmPreviousCommandStopped: true,
        callModel: continuation.callModel,
        harness: { verifierCallModel: continuationVerifier.callModel },
      });

      expect(result).toMatchObject({ runDir, status: 'verified' });

      // Assert against the exact restored conversation the resumed model
      // was actually asked with — not merely that "some notice" exists.
      expect(continuation.requests).toHaveLength(1);
      const restored = continuation.requests[0]!;

      // The interrupted assistant turn is GONE, not carried forward. It held
      // `tool_use` blocks that nothing ever answered, and the Anthropic API
      // rejects a request whose tool_use blocks are unanswered — so leaving it
      // in would make this resume fail with a 400 against the real API instead
      // of recovering, which the scripted model here cannot tell you.
      expect(
        restored.flatMap((message) =>
          message.content.filter((block) => block.type === 'tool_use'),
        ),
      ).toEqual([]);

      expect(restored).toHaveLength(2);
      expect(restored[0]).toEqual({ role: 'user', content: [{ type: 'text', text: taskText }] });
      const noticeText = (restored[1]!.content[0] as { text: string }).text;
      expect(noticeText).toContain('recovered after an interruption');
      // The dropped turn is still DESCRIBED — that is the whole point of the
      // per-call checkpoint, and it survives the message being removed.
      expect(noticeText).toContain(
        'a call to bash that had started but never reported a result',
      );
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "resume of an 'executing_tools' checkpoint whose pendingTurn recorded a finished call notes its result was lost",
    async () => {
      const taskText = 'Executing-tools crash: a finished write_file call is named as lost.';
      const runDir = await buildExecutingToolsRunDir(taskText, [
        {
          request: {
            id: 'call-1',
            name: 'write_file',
            input: { file_path: 'artifacts/note.txt', content: 'hi\n' },
          },
          executionStatus: 'finished',
          result: { isError: false, content: 'wrote artifacts/note.txt' },
        },
      ]);

      const continuation = scriptModel([textResponse('Finishing up.')]);
      const continuationVerifier = scriptModel([verifierVerified()]);

      const result = await resumeTask(runDir, {
        browser,
        confirmPreviousCommandStopped: true,
        callModel: continuation.callModel,
        harness: { verifierCallModel: continuationVerifier.callModel },
      });

      expect(result).toMatchObject({ runDir, status: 'verified' });

      const restored = continuation.requests[0]!;
      expect(
        restored.flatMap((message) =>
          message.content.filter((block) => block.type === 'tool_use'),
        ),
      ).toEqual([]);
      const noticeText = (restored[1]!.content[0] as { text: string }).text;
      expect(noticeText).toContain('recovered after an interruption');
      expect(noticeText).toContain(
        'a completed call to write_file whose results were lost with the interrupted turn',
      );
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

  it(
    "resume rebuilds the toolchain from the checkpoint's own toolProfile, not a hardcoded default — browser_batch survives a resume of a 'batch-enabled' run",
    async () => {
      const taskText =
        "Batch-enabled run crashes mid-tool-batch and must resume with browser_batch still offered.";
      const runDir = await buildExecutingToolsRunDir(
        taskText,
        [
          {
            request: { id: 'call-1', name: 'bash', input: { command: 'echo hi' } },
            executionStatus: 'running',
          },
        ],
        'batch-enabled',
      );

      // The regression this guards: resumeTask used to call buildRunToolchain
      // with `toolProfile: undefined`, which silently falls back to the
      // 'atomic' default (see buildRunToolchain / DEFAULT_TOOL_PROFILE) and
      // drops browser_batch from the resumed registry even though this
      // checkpoint recorded 'batch-enabled'. Calling browser_batch below
      // would then come back as the pipeline's own "unknown tool" error
      // instead of actually running.
      const continuation = scriptModel([
        toolResponse('batch-1', 'browser_batch', {
          actions: [{ tool: 'inspect_page', input: {} }],
        }),
        textResponse('Finishing up.'),
      ]);
      const continuationVerifier = scriptModel([verifierVerified()]);

      const result = await resumeTask(runDir, {
        browser,
        confirmPreviousCommandStopped: true,
        callModel: continuation.callModel,
        harness: { verifierCallModel: continuationVerifier.callModel },
      });

      expect(result).toMatchObject({ runDir, status: 'verified' });

      // The second worker call's messages carry the tool_result answering
      // the browser_batch call above — assert it actually ran rather than
      // being rejected as an unknown tool.
      expect(continuation.requests).toHaveLength(2);
      let toolResultBlock: { content: string | unknown[]; is_error?: boolean } | undefined;
      for (const message of continuation.requests[1]!) {
        for (const block of message.content) {
          if (block.type === 'tool_result' && block.tool_use_id === 'batch-1') {
            toolResultBlock = block;
          }
        }
      }
      expect(toolResultBlock).toBeDefined();
      expect(toolResultBlock?.is_error).not.toBe(true);
      expect(typeof toolResultBlock?.content).toBe('string');
      const toolResultText = toolResultBlock?.content as string;
      expect(toolResultText).not.toContain('Unknown tool');
      expect(toolResultText).toContain('"status":"completed"');
    },
    TEST_TIMEOUT_MS,
  );
});
