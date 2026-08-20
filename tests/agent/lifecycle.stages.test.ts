import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import type { BrowserController } from '../../src/browser/controller.js';
import type { OutputContract } from '../../src/agent/initializer/outputContract.schema.js';
import type { AcceptedModelResponse, ModelDriver } from '../../src/model/modelDriver.js';
import { initManifest, readManifest, writeArtifact } from '../../src/run/artifacts.js';
import {
  createBusyResourceRegistry,
  createRegistry,
  type BusyResourceRegistry,
  type ToolDef,
  type ToolRegistry,
} from '../../src/tools/registry.js';
import { publishArtifactTool } from '../../src/tools/publishArtifact/publishArtifact.js';
import { finishTool, type FinishInput } from '../../src/tools/finish/finish.js';
import { HARNESS_DIR } from '../../src/agent/checkpoint.js';
import type { Checkpoint, DurableRunConfiguration } from '../../src/agent/checkpoint.schema.js';
import { runAgent } from '../../src/agent/lifecycle.js';
import { readCheckpoint, scriptedDriver, unexpectedDriver } from './modelDrivers.js';
import { FINDINGS_REPORT_FILENAME } from '../../src/agent/findingsReport.js';
import { raceWithRunSignal } from '../../src/run/runDeadline.js';

const TASK =
  'Publish report.csv with exactly one name column and one row. Do not take screenshots.';
const START_URL = 'https://example.test/start';

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

const FINISH = {
  summary: 'Published the requested one-row report.',
  unresolved: [],
};

const CONFIGURATION: DurableRunConfiguration = {
  taskText: TASK,
  model: 'scripted-worker',
  maxOutputTokens: 4_096,
  maxContextTokens: 100_000,
  browserProvider: 'local',
  authenticated: false,
  javascriptPolicy: 'allow',
  startUrl: START_URL,
  maxInitializerAttempts: 2,
  maxCompletionCheckFailures: 2,
  budgetLimits: {
    maxWorkerTurns: 12,
    maxToolCalls: 20,
    maxModelTokens: 100_000,
    maxWallTimeMs: 1_000_000,
  },
};

const DEFAULT_USAGE = {
  input_tokens: 5,
  output_tokens: 1,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
};

let runDir: string;

beforeEach(() => {
  runDir = mkdtempSync(join(tmpdir(), 'sherlock-coordinator-lifecycle-'));
  initManifest(runDir, TASK, 'local');
});

afterEach(() => {
  rmSync(runDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('coordinator correction lifecycle', () => {
  it('returns a research finding with the harness instruction, accepts new evidence, and owns one browser page', async () => {
    const unresolvedFinish: FinishInput = {
      summary: 'Published the available report; Bob is still unresolved.',
      unresolved: [
        {
          requirement: 'Include Bob in the requested report.',
          reason: 'The only source checked so far showed Alice.',
          attempts: ['Checked the primary listing page.'],
        },
      ],
    };
    const worker = scriptedDriver([
      publishReport('Alice', 'publish-initial'),
      finishResponse('finish-initial', unresolvedFinish),
      publishReport('Bob', 'publish-corrected'),
      finishResponse('finish-corrected'),
    ]);
    const verifier = scriptedDriver([
      verifierResponse('needs_correction'),
      verifierResponse('verified'),
    ]);
    const browser = fakeBrowser();

    const outcome = await runCoordinator({
      initializer: scriptedDriver([initializerAccepted()]),
      worker,
      verifier,
      browser: browser.controller,
    });

    expect(outcome).toEqual({
      status: 'verified',
      finalText: FINISH.summary,
    });
    expect(readFileSync(join(runDir, 'artifacts/report.csv'), 'utf8')).toBe('name\nBob\n');
    expect(worker.generate).toHaveBeenCalledTimes(4);
    expect(verifier.generate).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(worker.requests[2])).toContain('needs_correction');
    expect(JSON.stringify(worker.requests[2])).toContain('Include Bob in the requested report.');
    // The harness attaches its own fixed instruction to a research finding;
    // the verifier never dictates artifact contents and no free-form
    // model-authored nextAction is forwarded.
    expect(JSON.stringify(worker.requests[2])).toContain(
      'Continue evidence collection for this requirement',
    );
    expect(JSON.stringify(worker.requests[2])).not.toContain('nextAction');
    expect(readCheckpoint(runDir)).toMatchObject({
      phase: 'terminal',
      progress: { verifierCycles: 2, completionCheckFailures: 0 },
      outcome: { status: 'verified' },
    });
    expect(readManifest(runDir).finishedAt).toBeDefined();
    expectBrowserLifecycle(browser);
  });

  it('writes a needs_correction cycle and the verified terminus into harness/findings.md', async () => {
    const unresolvedFinish: FinishInput = {
      summary: 'Published the available report; Bob is still unresolved.',
      unresolved: [
        {
          requirement: 'Include Bob in the requested report.',
          reason: 'The only source checked so far showed Alice.',
          attempts: ['Checked the primary listing page.'],
        },
      ],
    };
    const outcome = await runCoordinator({
      initializer: scriptedDriver([initializerAccepted()]),
      worker: scriptedDriver([
        publishReport('Alice', 'publish-initial'),
        finishResponse('finish-initial', unresolvedFinish),
        publishReport('Bob', 'publish-corrected'),
        finishResponse('finish-corrected'),
      ]),
      verifier: scriptedDriver([
        verifierResponse('needs_correction'),
        verifierResponse('verified'),
      ]),
      browser: fakeBrowser().controller,
    });

    expect(outcome.status).toBe('verified');
    const findingsPath = join(runDir, HARNESS_DIR, FINDINGS_REPORT_FILENAME);
    const findings = readFileSync(findingsPath, 'utf8');
    expect(findings).toContain('Audit projection only');
    expect(findings).toContain('Include Bob in the requested report.');
    expect(findings).toContain('- Outcome: verified');
  });

  it('records a diagnostic and leaves the verification outcome unchanged when the findings-report write fails', async () => {
    // Pre-create the harness directory with the exact convention the
    // checkpoint store expects, then pre-occupy the findings-report path
    // with a directory so the atomic rename onto it fails deterministically.
    mkdirSync(join(runDir, HARNESS_DIR), { mode: 0o700 });
    mkdirSync(join(runDir, HARNESS_DIR, FINDINGS_REPORT_FILENAME));

    const outcome = await runCoordinator({
      initializer: scriptedDriver([initializerAccepted()]),
      worker: scriptedDriver([
        publishReport('Alice', 'publish-write-failure'),
        finishResponse('finish-write-failure'),
      ]),
      verifier: scriptedDriver([verifierResponse('verified')]),
      browser: fakeBrowser().controller,
    });

    expect(outcome).toEqual({ status: 'verified', finalText: FINISH.summary });
    expect(readCheckpoint(runDir)).toMatchObject({
      phase: 'terminal',
      outcome: { status: 'verified' },
    });
    const events = readFileSync(join(runDir, 'transcript.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { type?: string; message?: string });
    const failure = events.find((event) => event.type === 'v3_findings_report_failed');
    expect(failure).toBeDefined();
    expect(failure?.message).toBeTruthy();
  });

  it('bounces a failed deterministic check to the worker even when unresolved is nonempty, never reaching the verifier', async () => {
    const claimedBlockerFinish: FinishInput = {
      summary: 'Published the report; one entity could not be confirmed.',
      unresolved: [
        {
          requirement: 'Confirm the second entity.',
          reason: 'The source was inconsistent.',
          attempts: ['Checked the primary source.'],
        },
      ],
    };
    const worker = scriptedDriver([
      publishReport(['Alice', 'Bob'], 'publish-invalid-with-blocker'),
      finishResponse('finish-invalid-with-blocker', claimedBlockerFinish),
      publishReport('Carol', 'publish-repaired-with-blocker'),
      finishResponse('finish-repaired-with-blocker'),
    ]);
    const verifier = scriptedDriver([verifierResponse('verified')]);
    const browser = fakeBrowser();

    const outcome = await runCoordinator({
      initializer: scriptedDriver([initializerAccepted()]),
      worker,
      verifier,
      browser: browser.controller,
    });

    expect(outcome.status).toBe('verified');
    expect(verifier.generate).toHaveBeenCalledOnce();
    expect(JSON.stringify(worker.requests[2])).toContain('deterministic_finish_checks');
    expect(JSON.stringify(worker.requests[2])).toContain('exact_row_count');
    expect(readCheckpoint(runDir)).toMatchObject({
      phase: 'terminal',
      progress: { verifierCycles: 1, completionCheckFailures: 1 },
      outcome: { status: 'verified' },
    });
    expectBrowserLifecycle(browser);
  });

  it('ends credible unresolved work incomplete with the worker-written response', async () => {
    const incompleteFinish: FinishInput = {
      summary: 'Published the available report; the requested source was inaccessible.',
      unresolved: [
        {
          requirement: 'Support the report with the requested source.',
          reason: 'The source consistently returned an access-denied response.',
          attempts: ['Opened the source directly.', 'Retried from the task page.'],
        },
      ],
    };
    const outcome = await runCoordinator({
      initializer: scriptedDriver([initializerAccepted()]),
      worker: scriptedDriver([
        publishReport('Alice', 'publish-partial'),
        finishResponse('finish-partial', incompleteFinish),
      ]),
      verifier: scriptedDriver([verifierIncompleteResponse()]),
      browser: fakeBrowser().controller,
    });

    expect(outcome).toMatchObject({
      status: 'incomplete',
      reason: 'verification_incomplete',
      finalText: incompleteFinish.summary,
      unresolved: incompleteFinish.unresolved,
    });
  });

  it('continues on a genuinely new attempt but converges once the same attempt repeats', async () => {
    const firstAttemptFinish: FinishInput = {
      summary: 'Published the available report, but Bob could not be confirmed.',
      unresolved: [
        {
          requirement: 'Include Bob in the requested report.',
          reason: 'The only available source continued to show Alice.',
          attempts: ['Rechecked the primary source listing.'],
        },
      ],
    };
    const repeatedAttemptFinish: FinishInput = {
      ...firstAttemptFinish,
      summary: 'Published the available report; Bob remains unconfirmed after another check.',
    };
    const verifier = scriptedDriver([
      verifierResponse('needs_correction'),
      verifierResponse('needs_correction'),
      verifierResponse('needs_correction'),
    ]);
    const outcome = await runCoordinator({
      initializer: scriptedDriver([initializerAccepted()]),
      worker: scriptedDriver([
        publishReport('Alice', 'publish-no-progress'),
        finishResponse('finish-claimed-complete'),
        finishResponse('finish-first-attempt', firstAttemptFinish),
        finishResponse('finish-repeated-attempt', repeatedAttemptFinish),
      ]),
      verifier,
      browser: fakeBrowser().controller,
    });

    // Unchanged surfaced evidence and the same unsupported requirement, but a
    // genuinely new distinct attempt string on the second cycle, must not
    // converge yet; only the third cycle's exact repeat of that attempt
    // converges to incomplete.
    expect(outcome).toMatchObject({
      status: 'incomplete',
      reason: 'verification_incomplete',
      finalText: repeatedAttemptFinish.summary,
      unresolved: repeatedAttemptFinish.unresolved,
    });
    expect(verifier.generate).toHaveBeenCalledTimes(3);
  });

  it('preserves the latest worker completion report if a later worker turn stops involuntarily', async () => {
    const latestFinish: FinishInput = {
      summary: 'Published the available report; one requested row remains unsupported.',
      unresolved: [
        {
          requirement: 'Include Bob in the requested report.',
          reason: 'The surfaced source did not contain Bob.',
          attempts: ['Checked the available source.'],
        },
      ],
    };
    const outcome = await runCoordinator({
      initializer: scriptedDriver([initializerAccepted()]),
      worker: scriptedDriver([
        publishReport('Alice', 'publish-before-worker-stop'),
        finishResponse('finish-before-worker-stop', latestFinish),
      ]),
      verifier: scriptedDriver([verifierResponse('needs_correction')]),
      browser: fakeBrowser().controller,
    });

    expect(outcome).toMatchObject({
      status: 'incomplete',
      reason: 'worker_incomplete',
      finalText: latestFinish.summary,
      unresolved: latestFinish.unresolved,
    });
  });

  it('waits for an abandoned tool effect before running finish checks or the verifier', async () => {
    const effectOrder: string[] = [];
    const delayedPublisher = delayedPublishTool(40, () => {
      effectOrder.push('artifact-written');
    });
    const worker = scriptedDriver([
      accepted([
        {
          type: 'tool_use',
          id: 'delayed-publish',
          name: delayedPublisher.name,
          input: {},
        },
      ]),
      finishResponse('finish-after-timeout'),
    ]);
    const verifier = scriptedDriver([
      () => {
        effectOrder.push('verifier-called');
        return verifierResponse('verified');
      },
    ]);
    const browser = fakeBrowser();

    const outcome = await runCoordinator({
      initializer: scriptedDriver([initializerAccepted()]),
      worker,
      verifier,
      browser: browser.controller,
      registry: createRegistry([delayedPublisher, finishTool]),
    });

    expect(outcome.status).toBe('verified');
    expect(effectOrder).toEqual(['artifact-written', 'verifier-called']);
    expect(JSON.stringify(worker.requests[1])).toContain('was abandoned');
    expect(readFileSync(join(runDir, 'artifacts/report.csv'), 'utf8')).toBe('name\nSettled\n');
    expectBrowserLifecycle(browser);
  });

  it('interrupts the finish busy-resource gate and drains safely before cancellation', async () => {
    const abort = new AbortController();
    let effectSettled = false;
    let releaseEffect!: () => void;
    const effectGate = new Promise<void>((resolve) => {
      releaseEffect = resolve;
    });
    const delayedPublisher = delayedPublishTool(effectGate, () => {
      effectSettled = true;
    });
    const worker = scriptedDriver([
      accepted([
        {
          type: 'tool_use',
          id: 'delayed-before-cancel',
          name: delayedPublisher.name,
          input: {},
        },
      ]),
      () => {
        setTimeout(() => {
          abort.abort(new DOMException('operator cancelled during finish gate', 'AbortError'));
          setTimeout(releaseEffect, 10);
        }, 5);
        return finishResponse('finish-before-cancel');
      },
    ]);
    const verifier = unexpectedDriver('verifier');
    const browser = fakeBrowser();

    const outcome = await runCoordinator({
      initializer: scriptedDriver([initializerAccepted()]),
      worker,
      verifier,
      browser: browser.controller,
      registry: createRegistry([delayedPublisher, finishTool]),
      signal: abort.signal,
    });

    expect(outcome).toMatchObject({
      status: 'cancelled',
      reason: expect.stringContaining('operator cancelled during finish gate'),
    });
    expect(effectSettled).toBe(true);
    expect(verifier.generate).not.toHaveBeenCalled();
    const results = toolResultsFor(readCheckpoint(runDir), 'finish-before-cancel');
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ is_error: true });
    expect(results[0]?.content).toContain('"source":"run_terminal"');
    expect(results[0]?.content).toContain('"outcome":"cancelled"');
    expectBrowserLifecycle(browser);
  });
});

describe('coordinator terminal lifecycle', () => {
  it.each([
    {
      label: 'initializer',
      initializer: neverSettlingDriver(),
      worker: unexpectedDriver('worker'),
      verifier: unexpectedDriver('verifier'),
      workerResponses: 0,
      verifierResponses: 0,
      deadlineMs: 100,
    },
    {
      label: 'worker',
      initializer: scriptedDriver([initializerAccepted()]),
      worker: neverSettlingDriver(),
      verifier: unexpectedDriver('verifier'),
      workerResponses: 1,
      verifierResponses: 0,
      deadlineMs: 500,
    },
    {
      label: 'verifier',
      initializer: scriptedDriver([initializerAccepted()]),
      worker: scriptedDriver([
        publishReport('Alice', 'publish-before-deadline'),
        finishResponse('finish-before-deadline'),
      ]),
      verifier: neverSettlingDriver(),
      workerResponses: 2,
      verifierResponses: 1,
      // Reaching the verifier first performs real artifact publication,
      // deterministic inspection, and durable checkpoint writes. Give that
      // setup enough headroom under a concurrently loaded full suite; the
      // assertion still proves the never-settling verifier itself is cut off
      // by the finite run deadline.
      deadlineMs: 5_000,
    },
  ])(
    'interrupts a non-cooperative $label model at the whole-run wall deadline',
    async ({ initializer, worker, verifier, workerResponses, verifierResponses, deadlineMs }) => {
      const browser = fakeBrowser();
      const outcome = await runCoordinator({
        initializer,
        worker,
        verifier,
        browser: browser.controller,
        configuration: wallDeadlineConfiguration(deadlineMs),
      });

      expect(outcome).toMatchObject({
        status: 'incomplete',
        reason: 'budget_exceeded',
        detail: expect.stringContaining('wall_time'),
      });
      expect(worker.generate).toHaveBeenCalledTimes(workerResponses);
      expect(verifier.generate).toHaveBeenCalledTimes(verifierResponses);
      expect(readCheckpoint(runDir)).toMatchObject({
        phase: 'terminal',
        outcome: { status: 'incomplete', reason: 'budget_exceeded' },
      });
      expect(readManifest(runDir).finishedAt).toBeDefined();
      expect(browser.closeTaskPages).toHaveBeenCalledOnce();
      if (verifierResponses === 1) {
        const results = toolResultsFor(readCheckpoint(runDir), 'finish-before-deadline');
        expect(results).toHaveLength(1);
        expect(results[0]).toMatchObject({ is_error: true });
        expect(results[0]?.content).toContain('"source":"run_budget"');
        expect(results[0]?.content).toContain('"budget_limit":"wall_time"');
      }
    },
    10_000,
  );

  it.each([
    { label: 'newTab', browserOptions: { newTabNeverSettles: true } },
    { label: 'goto', browserOptions: { gotoNeverSettles: true } },
  ])(
    'interrupts a non-cooperative browser $label and finalizes only after containment cleanup',
    async ({ browserOptions }) => {
      const browser = fakeBrowser(browserOptions);
      const outcome = await runCoordinator({
        initializer: scriptedDriver([initializerAccepted()]),
        worker: unexpectedDriver('worker'),
        verifier: unexpectedDriver('verifier'),
        browser: browser.controller,
        configuration: wallDeadlineConfiguration(100),
      });

      expect(outcome).toMatchObject({
        status: 'incomplete',
        reason: 'budget_exceeded',
        detail: expect.stringContaining('wall_time'),
      });
      expect(browser.closeTaskPages).toHaveBeenCalledOnce();
      expect(browser.events.at(-1)).toBe('closeTaskPages');
      expect(readManifest(runDir).finishedAt).toBeDefined();
    },
  );

  it('answers the pending finish exactly once when the verifier is unavailable', async () => {
    const browser = fakeBrowser();
    const outcome = await runCoordinator({
      initializer: scriptedDriver([initializerAccepted()]),
      worker: scriptedDriver([
        publishReport('Alice', 'publish-before-verifier-outage'),
        finishResponse('finish-verifier-outage'),
      ]),
      verifier: scriptedDriver([new Error('verifier transport unavailable')]),
      browser: browser.controller,
    });

    expect(outcome).toMatchObject({
      status: 'incomplete',
      reason: 'verifier_unavailable',
    });
    const results = toolResultsFor(readCheckpoint(runDir), 'finish-verifier-outage');
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ is_error: true });
    expect(results[0]?.content).toContain('"source":"verifier"');
    expectBrowserLifecycle(browser);
  });

  it('terminalizes verification_incomplete, not verifier_unavailable, when the verifier repeats an invalid artifact_repair', async () => {
    const browser = fakeBrowser();
    const citesUnsurfacedEvidence = accepted([
      {
        type: 'tool_use',
        id: 'verdict-invalid-artifact-repair',
        name: 'report_verification',
        input: {
          status: 'needs_correction',
          findings: [
            {
              kind: 'artifact_repair',
              requirement: 'Include Bob in the requested report.',
              problem: 'Bob is already proven by evidence that was never surfaced.',
              evidencePaths: ['artifacts/not-surfaced.png'],
            },
          ],
        },
      },
    ]);
    const outcome = await runCoordinator({
      initializer: scriptedDriver([initializerAccepted()]),
      worker: scriptedDriver([
        publishReport('Alice', 'publish-before-invalid-verdict'),
        finishResponse('finish-before-invalid-verdict'),
      ]),
      verifier: scriptedDriver([citesUnsurfacedEvidence, citesUnsurfacedEvidence]),
      browser: browser.controller,
    });

    expect(outcome).toMatchObject({
      status: 'incomplete',
      reason: 'verification_incomplete',
    });
    expect(outcome).not.toMatchObject({ reason: 'verifier_unavailable' });
    const results = toolResultsFor(readCheckpoint(runDir), 'finish-before-invalid-verdict');
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ is_error: true });
    expect(results[0]?.content).toContain('"source":"verifier"');
    expectBrowserLifecycle(browser);
  });

  it('terminalizes verification_incomplete when the verifier repeats an invalid verified verdict', async () => {
    const browser = fakeBrowser();
    const creditableBlocker: FinishInput = {
      summary: 'Published the available report; one entity could not be confirmed.',
      unresolved: [
        {
          requirement: 'Confirm the second entity.',
          reason: 'The only available source was inconsistent.',
          attempts: ['Checked the primary source.', 'Checked the archived mirror.'],
        },
      ],
    };
    const invalidVerified = accepted([
      {
        type: 'tool_use',
        id: 'verdict-invalid-verified',
        name: 'report_verification',
        input: { status: 'verified', findings: [] },
      },
    ]);
    const outcome = await runCoordinator({
      initializer: scriptedDriver([initializerAccepted()]),
      worker: scriptedDriver([
        publishReport('Alice', 'publish-before-invalid-verified'),
        finishResponse('finish-before-invalid-verified', creditableBlocker),
      ]),
      verifier: scriptedDriver([invalidVerified, invalidVerified]),
      browser: browser.controller,
    });

    expect(outcome).toMatchObject({
      status: 'incomplete',
      reason: 'verification_incomplete',
      finalText: creditableBlocker.summary,
      unresolved: creditableBlocker.unresolved,
    });
    expect(outcome).not.toMatchObject({ reason: 'verifier_unavailable' });
    expectBrowserLifecycle(browser);
  });

  it.each([
    {
      label: 'worker-turn ceiling',
      limits: { maxWorkerTurns: 1 },
      response: publishReport('Alice', 'publish-at-turn-limit'),
      detail: 'worker_turns',
    },
    {
      label: 'aggregate model-token ceiling',
      limits: { maxModelTokens: 10 },
      response: accepted([{ type: 'text', text: 'I am still working.' }], {
        input_tokens: 5,
        output_tokens: 1,
      }),
      detail: 'model_tokens',
    },
  ])(
    'ends incomplete at the $label and closes its run-owned browser page',
    async ({ limits, response, detail }) => {
      const browser = fakeBrowser();
      const worker = scriptedDriver([response]);
      const verifier = unexpectedDriver('verifier');

      const outcome = await runCoordinator({
        initializer: scriptedDriver([initializerAccepted()]),
        worker,
        verifier,
        browser: browser.controller,
        configuration: {
          ...CONFIGURATION,
          budgetLimits: { ...CONFIGURATION.budgetLimits, ...limits },
        },
      });

      expect(outcome).toMatchObject({
        status: 'incomplete',
        reason: 'budget_exceeded',
        detail: expect.stringContaining(detail),
      });
      expect(worker.generate).toHaveBeenCalledOnce();
      expect(verifier.generate).not.toHaveBeenCalled();
      expect(readCheckpoint(runDir)).toMatchObject({
        phase: 'terminal',
        outcome: { status: 'incomplete', reason: 'budget_exceeded' },
      });
      expectBrowserLifecycle(browser);
    },
  );

  it('propagates cancellation as a cancelled outcome and still cleans up the browser page', async () => {
    const abort = new AbortController();
    const browser = fakeBrowser();
    const worker = scriptedDriver([
      (options) => {
        abort.abort(new DOMException('operator cancelled the run', 'AbortError'));
        expect(options.signal?.aborted).toBe(true);
        throw new Error('unrelated provider failure after cancellation');
      },
    ]);

    const outcome = await runCoordinator({
      initializer: scriptedDriver([initializerAccepted()]),
      worker,
      verifier: unexpectedDriver('verifier'),
      browser: browser.controller,
      signal: abort.signal,
    });

    expect(outcome).toMatchObject({
      status: 'cancelled',
      during: 'ready_for_model',
      reason: expect.stringContaining('operator cancelled the run'),
    });
    expect(outcome).not.toMatchObject({
      reason: expect.stringContaining('unrelated provider failure'),
    });
    expect(readCheckpoint(runDir)).toMatchObject({
      phase: 'terminal',
      outcome: { status: 'cancelled' },
    });
    expectBrowserLifecycle(browser);
  });

  it('classifies a provider AbortError as worker unavailability, not cancellation', async () => {
    const browser = fakeBrowser();
    const outcome = await runCoordinator({
      initializer: scriptedDriver([initializerAccepted()]),
      worker: scriptedDriver([
        new DOMException('provider request aborted internally', 'AbortError'),
      ]),
      verifier: unexpectedDriver('verifier'),
      browser: browser.controller,
    });

    expect(outcome).toMatchObject({
      status: 'incomplete',
      reason: 'worker_incomplete',
      detail: expect.stringContaining('provider request aborted internally'),
    });
    expect(readCheckpoint(runDir)).toMatchObject({
      phase: 'terminal',
      outcome: { status: 'incomplete', reason: 'worker_incomplete' },
    });
    expectBrowserLifecycle(browser);
  });

  it('closes run-owned pages when start-url navigation fails', async () => {
    const browser = fakeBrowser({
      gotoError: new Error('start URL navigation failed'),
    });
    const worker = unexpectedDriver('worker');
    const verifier = unexpectedDriver('verifier');

    const outcome = await runCoordinator({
      initializer: scriptedDriver([initializerAccepted()]),
      worker,
      verifier,
      browser: browser.controller,
    });

    expect(outcome).toMatchObject({
      status: 'failed',
      during: 'ready_for_model',
      message: expect.stringContaining('start URL navigation failed'),
    });
    expect(worker.generate).not.toHaveBeenCalled();
    expect(verifier.generate).not.toHaveBeenCalled();
    expect(readCheckpoint(runDir)).toMatchObject({
      phase: 'terminal',
      outcome: { status: 'failed' },
    });
    expectBrowserLifecycle(browser);
  });

  it('drains an abandoned effect before finalizing an incomplete run', async () => {
    let effectSettled = false;
    const delayedPublisher = delayedPublishTool(40, () => {
      effectSettled = true;
    });
    const browser = fakeBrowser();

    const outcome = await runCoordinator({
      initializer: scriptedDriver([initializerAccepted()]),
      worker: scriptedDriver([
        accepted([
          {
            type: 'tool_use',
            id: 'delayed-before-limit',
            name: delayedPublisher.name,
            input: {},
          },
        ]),
      ]),
      verifier: unexpectedDriver('verifier'),
      browser: browser.controller,
      registry: createRegistry([delayedPublisher, finishTool]),
      configuration: {
        ...CONFIGURATION,
        budgetLimits: {
          ...CONFIGURATION.budgetLimits,
          maxWorkerTurns: 1,
        },
      },
    });

    expect(outcome).toMatchObject({
      status: 'incomplete',
      reason: 'budget_exceeded',
    });
    expect(effectSettled).toBe(true);
    expect(readManifest(runDir)).toMatchObject({
      finishedAt: expect.any(String),
      artifacts: expect.arrayContaining([
        expect.objectContaining({ filename: 'artifacts/report.csv' }),
      ]),
    });
    expectBrowserLifecycle(browser);
  });

  it('bounds a wedged browser cleanup and still finalizes every run projection', async () => {
    const browser = fakeBrowser({ closeNeverSettles: true });

    const outcome = await runCoordinator({
      initializer: scriptedDriver([initializerAccepted()]),
      worker: scriptedDriver([
        publishReport('Alice', 'publish-before-wedged-cleanup'),
        finishResponse('finish-before-wedged-cleanup'),
      ]),
      verifier: scriptedDriver([verifierResponse('verified')]),
      browser: browser.controller,
      terminalBrowserCleanupTimeoutMs: 10,
    });

    expect(outcome).toMatchObject({
      status: 'failed',
      message: expect.stringContaining('did not settle within 10ms'),
    });
    expect(readCheckpoint(runDir)).toMatchObject({
      phase: 'terminal',
      outcome: { status: 'failed' },
    });
    expect(readManifest(runDir).finishedAt).toBeDefined();
    expect(readFileSync(join(runDir, 'metrics.json'), 'utf8')).toContain('"status": "failed"');
    const results = toolResultsFor(readCheckpoint(runDir), 'finish-before-wedged-cleanup');
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ is_error: true });
    expect(results[0]?.content).toContain('"source":"run_terminal"');
    expect(results[0]?.content).toContain('"outcome":"failed"');
    expectBrowserLifecycle(browser);
  });

  it('lets operator cancellation win while verified cleanup is still settling', async () => {
    const abort = new AbortController();
    let releaseClose!: () => void;
    const closeGate = new Promise<void>((resolve) => {
      releaseClose = resolve;
    });
    const browser = fakeBrowser({ closeGate });
    const running = runCoordinator({
      initializer: scriptedDriver([initializerAccepted()]),
      worker: scriptedDriver([
        publishReport('Alice', 'publish-before-cleanup-cancel'),
        finishResponse('finish-before-cleanup-cancel'),
      ]),
      verifier: scriptedDriver([verifierResponse('verified')]),
      browser: browser.controller,
      signal: abort.signal,
    });

    await vi.waitFor(() => expect(browser.closeTaskPages).toHaveBeenCalledOnce());
    abort.abort(new DOMException('operator cancelled during cleanup', 'AbortError'));
    releaseClose();

    await expect(running).resolves.toMatchObject({
      status: 'cancelled',
      reason: expect.stringContaining('operator cancelled during cleanup'),
    });
    const results = toolResultsFor(readCheckpoint(runDir), 'finish-before-cleanup-cancel');
    expect(results).toHaveLength(1);
    expect(results[0]?.content).toContain('"outcome":"cancelled"');
  });

  it('lets the hard wall limit win while verified cleanup is still settling', async () => {
    let now = 0;
    let releaseClose!: () => void;
    const closeGate = new Promise<void>((resolve) => {
      releaseClose = resolve;
    });
    const browser = fakeBrowser({ closeGate });
    const running = runCoordinator({
      initializer: scriptedDriver([initializerAccepted()]),
      worker: scriptedDriver([
        publishReport('Alice', 'publish-before-cleanup-deadline'),
        finishResponse('finish-before-cleanup-deadline'),
      ]),
      verifier: scriptedDriver([verifierResponse('verified')]),
      browser: browser.controller,
      configuration: wallDeadlineConfiguration(100),
      now: () => now,
    });

    await vi.waitFor(() => expect(browser.closeTaskPages).toHaveBeenCalledOnce());
    now = 100;
    releaseClose();

    await expect(running).resolves.toMatchObject({
      status: 'incomplete',
      reason: 'budget_exceeded',
      detail: expect.stringContaining('wall_time'),
    });
    const results = toolResultsFor(readCheckpoint(runDir), 'finish-before-cleanup-deadline');
    expect(results).toHaveLength(1);
    expect(results[0]?.content).toContain('"outcome":"incomplete"');
  });

  it('retains the run lock past the finite busy gate until the live effect settles', async () => {
    const busyRegistry = createBusyResourceRegistry();
    let releaseEffect!: () => void;
    const effect = new Promise<void>((resolve) => {
      releaseEffect = resolve;
    });
    const verifier = scriptedDriver([
      () => {
        busyRegistry.markAbandoned(effect);
        return verifierResponse('verified');
      },
    ]);
    const browser = fakeBrowser();
    const running = runCoordinator({
      initializer: scriptedDriver([initializerAccepted()]),
      worker: scriptedDriver([
        publishReport('Alice', 'publish-before-terminal-drain'),
        finishResponse('finish-before-terminal-drain'),
      ]),
      verifier,
      browser: browser.controller,
      busyRegistry,
      terminalBusyResourceTimeoutMs: 5,
    });

    await vi.waitFor(() => expect(verifier.generate).toHaveBeenCalledOnce());
    await new Promise((resolve) => setTimeout(resolve, 15));
    let firstSettled = false;
    void running.then(
      () => {
        firstSettled = true;
      },
      () => {
        firstSettled = true;
      },
    );
    expect(firstSettled).toBe(false);
    await expect(
      runCoordinator({
        initializer: unexpectedDriver('second initializer'),
        worker: unexpectedDriver('second worker'),
        verifier: unexpectedDriver('second verifier'),
        browser: fakeBrowser().controller,
      }),
    ).rejects.toThrow(/lock/i);

    releaseEffect();
    await expect(running).resolves.toMatchObject({ status: 'verified' });
  });
});

interface RunInputs {
  initializer: ModelDriver;
  worker: ModelDriver;
  verifier: ModelDriver;
  browser: BrowserController;
  registry?: ToolRegistry;
  busyRegistry?: BusyResourceRegistry;
  configuration?: DurableRunConfiguration;
  signal?: AbortSignal;
  terminalBrowserCleanupTimeoutMs?: number;
  terminalBusyResourceTimeoutMs?: number;
  now?: () => number;
}

function runCoordinator(inputs: RunInputs) {
  return runAgent({
    runDir,
    configuration: inputs.configuration ?? CONFIGURATION,
    initializerModel: inputs.initializer,
    workerModel: inputs.worker,
    verifierModel: inputs.verifier,
    registry: inputs.registry ?? createRegistry([publishArtifactTool, finishTool]),
    browser: inputs.browser,
    ...(inputs.busyRegistry === undefined ? {} : { busyRegistry: inputs.busyRegistry }),
    ...(inputs.signal === undefined ? {} : { signal: inputs.signal }),
    ...(inputs.terminalBrowserCleanupTimeoutMs === undefined
      ? {}
      : {
          terminalBrowserCleanupTimeoutMs: inputs.terminalBrowserCleanupTimeoutMs,
        }),
    ...(inputs.terminalBusyResourceTimeoutMs === undefined
      ? {}
      : {
          terminalBusyResourceTimeoutMs: inputs.terminalBusyResourceTimeoutMs,
        }),
    ...(inputs.now === undefined ? {} : { now: inputs.now }),
  });
}

function initializerAccepted(): AcceptedModelResponse {
  return accepted([
    {
      type: 'tool_use',
      id: 'contract-report',
      name: 'set_output_contract',
      input: { contract: CONTRACT },
    },
  ]);
}

function publishReport(names: string | readonly string[], id: string): AcceptedModelResponse {
  const rows = typeof names === 'string' ? [names] : names;
  return accepted([
    {
      type: 'tool_use',
      id,
      name: 'publish_artifact',
      input: {
        kind: 'text',
        artifact_path: 'artifacts/report.csv',
        roles: ['requested_output'],
        source_url: 'https://example.test/source',
        content: `name\n${rows.join('\n')}\n`,
      },
    },
  ]);
}

function finishResponse(id: string, input: FinishInput = FINISH): AcceptedModelResponse {
  return accepted([
    {
      type: 'tool_use',
      id,
      name: 'finish',
      input,
    },
  ]);
}

function verifierIncompleteResponse(): AcceptedModelResponse {
  return accepted([
    {
      type: 'tool_use',
      id: 'verdict-incomplete',
      name: 'report_verification',
      input: {
        status: 'incomplete',
        findings: [
          {
            requirement: 'Support the report with the requested source.',
            assessment:
              'The reported access denial is credible and equivalent retries are unlikely to help.',
          },
        ],
      },
    },
  ]);
}

function verifierResponse(status: 'verified' | 'needs_correction'): AcceptedModelResponse {
  return accepted([
    {
      type: 'tool_use',
      id: `verdict-${status}`,
      name: 'report_verification',
      input:
        status === 'verified'
          ? { status, findings: [] }
          : {
              status,
              findings: [
                {
                  kind: 'research',
                  requirement: 'Include Bob in the requested report.',
                  problem: 'The report contains Alice instead of Bob.',
                },
              ],
            },
    },
  ]);
}

function accepted(
  content: AcceptedModelResponse['response']['content'],
  usage: AcceptedModelResponse['usage'] = DEFAULT_USAGE,
): AcceptedModelResponse {
  const stopReason = content.some((block) => block.type === 'tool_use') ? 'tool_use' : 'end_turn';
  return {
    response: { content, stop_reason: stopReason, usage },
    stopReason,
    attempts: 1,
    usage,
  };
}

function neverSettlingDriver(): ModelDriver & {
  generate: ReturnType<typeof vi.fn>;
} {
  return {
    generate: vi.fn(async () => new Promise<never>(() => undefined)),
  };
}

interface FakeBrowser {
  controller: BrowserController;
  events: string[];
  initializeRunPageOwnership: ReturnType<typeof vi.fn>;
  newTab: ReturnType<typeof vi.fn>;
  goto: ReturnType<typeof vi.fn>;
  prepareTaskPage: ReturnType<typeof vi.fn>;
  closeTaskPages: ReturnType<typeof vi.fn>;
  setBusyRegistry: ReturnType<typeof vi.fn>;
}

function fakeBrowser(
  options: {
    gotoError?: Error;
    closeNeverSettles?: boolean;
    newTabNeverSettles?: boolean;
    gotoNeverSettles?: boolean;
    closeGate?: Promise<void>;
  } = {},
): FakeBrowser {
  const events: string[] = [];
  const initializeRunPageOwnership = vi.fn(async (ownershipId: string) => {
    expect(ownershipId).toBe(runDir);
    events.push('initializeRunPageOwnership');
  });
  const newTab = vi.fn(async () => {
    events.push('newTab');
    if (options.newTabNeverSettles === true) {
      await new Promise<never>(() => undefined);
    }
  });
  const goto = vi.fn(async (url: string) => {
    events.push(`goto:${url}`);
    if (options.gotoError !== undefined) throw options.gotoError;
    if (options.gotoNeverSettles === true) {
      await new Promise<never>(() => undefined);
    }
  });
  const prepareTaskPage = vi.fn(
    async (request: { ownershipId: string; startUrl?: string; signal?: AbortSignal }) => {
      await initializeRunPageOwnership(request.ownershipId);
      await raceWithRunSignal(() => newTab(), request.signal);
      if (request.startUrl !== undefined) {
        await raceWithRunSignal(() => goto(request.startUrl!), request.signal);
      }
    },
  );
  const closeTaskPages = vi.fn(async () => {
    events.push('closeTaskPages');
    if (options.closeGate !== undefined) await options.closeGate;
    if (options.closeNeverSettles === true) {
      await new Promise<never>(() => undefined);
    }
  });
  const setBusyRegistry = vi.fn(() => {
    events.push('setBusyRegistry');
  });
  return {
    controller: {
      setBusyRegistry,
      initializeRunPageOwnership,
      prepareTaskPage,
      newTab,
      goto,
      closeTaskPages,
    } as unknown as BrowserController,
    events,
    initializeRunPageOwnership,
    newTab,
    goto,
    prepareTaskPage,
    closeTaskPages,
    setBusyRegistry,
  };
}

function wallDeadlineConfiguration(maxWallTimeMs: number): DurableRunConfiguration {
  return {
    ...CONFIGURATION,
    budgetLimits: {
      ...CONFIGURATION.budgetLimits,
      maxWallTimeMs,
    },
  };
}

function expectBrowserLifecycle(browser: FakeBrowser): void {
  expect(browser.events).toEqual([
    'setBusyRegistry',
    'initializeRunPageOwnership',
    'newTab',
    `goto:${START_URL}`,
    'closeTaskPages',
  ]);
  expect(browser.prepareTaskPage).toHaveBeenCalledOnce();
  expect(browser.newTab).toHaveBeenCalledOnce();
  expect(browser.initializeRunPageOwnership).toHaveBeenCalledOnce();
  expect(browser.goto).toHaveBeenCalledOnce();
  expect(browser.goto).toHaveBeenCalledWith(START_URL);
  expect(browser.closeTaskPages).toHaveBeenCalledOnce();
  expect(browser.setBusyRegistry).toHaveBeenCalledOnce();
}

function delayedPublishTool(
  delay: number | Promise<void>,
  afterWrite: () => void,
): ToolDef<Record<string, never>> {
  return {
    name: 'delayed_publish_for_test',
    description: 'Test-only publisher that outlives its pipeline deadline.',
    inputSchema: z.strictObject({}),
    timeoutMs: 5,
    async execute(_input, ctx) {
      if (typeof delay === 'number') {
        await new Promise((resolve) => setTimeout(resolve, delay));
      } else {
        await delay;
      }
      writeArtifact(ctx.runDir, 'artifacts/report.csv', Buffer.from('name\nSettled\n', 'utf8'), {
        roles: ['requested_output'],
        sourceUrl: 'https://example.test/source',
      });
      afterWrite();
      return { status: 'settled' };
    },
  };
}

function toolResultsFor(
  checkpoint: Checkpoint,
  toolUseId: string,
): Array<{ tool_use_id: string; is_error?: boolean; content: unknown }> {
  if (checkpoint.phase === 'initializing' || checkpoint.worker === undefined) return [];
  return checkpoint.worker.messages.flatMap((message) =>
    message.role === 'user'
      ? message.content.filter(
          (block): block is Extract<(typeof message.content)[number], { type: 'tool_result' }> =>
            block.type === 'tool_result' && block.tool_use_id === toolUseId,
        )
      : [],
  );
}
