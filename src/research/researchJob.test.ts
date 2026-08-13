import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import type { BrowserController } from '../browser/controller.js';
import { recordEvidence, type EvidenceStore } from '../evidence/evidenceStore.js';
import type { Message, ModelResponse } from '../loop/messages.js';
import { buildRequestParams } from '../model/callModel.js';
import type { OutputSpec } from '../contracts/outputContract.js';
import { createOutputTableStore, type OutputTableStore } from '../outputs/outputTable.js';
import { initManifest, MANIFEST_FILENAME, type Manifest } from '../run/artifacts.js';
import {
  createRunBudgetTracker,
  type RunBudgetConfig,
  type RunBudgetTracker,
} from '../run/runBudget.js';
import { createRegistry, toApiToolDefs, type ToolDef, type ToolRegistry } from '../tools/registry.js';
import { mergeResearchResults } from './mergeResearchResults.js';
import {
  buildResearchJobPrompt,
  createResearchJobRunner,
  parseResearchReport,
  RESEARCH_JOBS_DIR,
  RESEARCH_JOB_RESULT_FILENAME,
  validateResearchJob,
  type ResearchJob,
  type ResearchJobBudget,
  type ResearchJobResult,
  type ResearchJobRunner,
  type ResearchTemplate,
} from './researchJob.js';

// Hermetic end-to-end tests of the job runner: scripted model functions, fake
// browser handles, fake tool registries. No Chrome, no API. What is under
// test is the ISOLATION and ACCOUNTING contract — separate browsers, separate
// ledgers, separate budgets charged to one run, linked cancellation, and a
// typed result that never carries the child's conversation.

const TEMPLATE: ResearchTemplate = {
  taskText: 'List every partner firm with the year it was founded.',
  contractText:
    'table "partners" — columns: name (string, required), founded (integer, required)',
  extractionRules: "Read the founding year from the firm's own about page, not a directory listing.",
};

const BUDGET: ResearchJobBudget = {
  maxTurns: 4,
  maxModelTokens: 100_000,
  maxToolCalls: 10,
  maxWallTimeMs: 60_000,
};

const UNBOUNDED_RUN: RunBudgetConfig = {
  maxWorkerTurns: Infinity,
  maxToolCalls: Infinity,
  maxModelTokens: Infinity,
  maxToolResultBytes: Infinity,
  maxWallTimeMs: Infinity,
  maxVerifierCorrections: Infinity,
};

function job(jobId: string, entity: string, over: Partial<ResearchJob> = {}): ResearchJob {
  return {
    jobId,
    entity,
    instruction: `Find the founding year of ${entity} and cite the page it came from.`,
    budget: BUDGET,
    ...over,
  };
}

/** A model response carrying the fenced JSON report the briefing asks for. */
function reportResponse(report: unknown, prose = 'Finished the lookup.'): ModelResponse {
  return {
    content: [
      {
        type: 'text',
        text: `${prose}\n\n\`\`\`json\n${JSON.stringify(report, null, 2)}\n\`\`\``,
      },
    ],
    stop_reason: 'end_turn',
    usage: { input_tokens: 10, output_tokens: 5 },
  };
}

/** A model response that calls the fixture `echo` tool, so a job keeps
 * working (and keeps charging tool calls) instead of reporting. */
function toolResponse(id: string): ModelResponse {
  return {
    content: [{ type: 'tool_use', id, name: 'echo', input: { message: id } }],
    stop_reason: 'tool_use',
    usage: { input_tokens: 10, output_tokens: 5 },
  };
}

/** A registry with one harmless tool, for the turn/tool-call ceiling tests.
 * Not forbidden, so it passes assertResearchRegistry. */
function echoRegistry(): ToolRegistry {
  const echo: ToolDef<{ message: string }> = {
    name: 'echo',
    description: 'Echo the message back.',
    inputSchema: z.strictObject({ message: z.string() }),
    readOnly: true,
    execute: (input) => `echo: ${input.message}`,
  };
  return createRegistry([echo as ToolDef]);
}

/** A gate that opens once `arrivals` callers have reached it — the only way
 * to prove two jobs were genuinely in flight at the same moment without
 * depending on timers. */
function makeBarrier(arrivals: number): { arrive: () => Promise<void> } {
  let seen = 0;
  let open!: () => void;
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  return {
    arrive: async () => {
      seen += 1;
      if (seen >= arrivals) open();
      await gate;
    },
  };
}

/** What the scripted model is told about the job it is answering for. */
interface RespondContext {
  jobId: string;
  entity: string;
  /** 1-based call number within this job. */
  call: number;
  /** The JOB's own evidence ledger, so a script can record evidence exactly
   * where a child's tools would. */
  ledger: EvidenceStore;
  messages: readonly Message[];
}

interface HarnessOptions {
  respond: (context: RespondContext) => Promise<ModelResponse>;
  registryFor?: (jobId: string) => ToolRegistry;
  browserFor?: (jobId: string) => BrowserController | undefined;
  runBudget?: RunBudgetTracker;
  signal?: AbortSignal;
  coordinatorBrowser?: BrowserController;
  maxConcurrentPublicJobs?: number;
}

interface Harness {
  runner: ResearchJobRunner;
  runBudget: RunBudgetTracker;
  ledgers: Map<string, EvidenceStore>;
  browsers: Map<string, BrowserController | undefined>;
  registries: Map<string, ToolRegistry>;
  systems: Map<string, string>;
  signals: Map<string, AbortSignal>;
  requests: Map<string, Message[][]>;
  closed: string[];
  /** Highest number of jobs whose model call was in flight simultaneously. */
  peakInFlight: () => number;
}

/** A browser handle with a distinguishable identity. The worker session only
 * passes it into ToolCtx, and the fixture tools never touch it. */
function fakeBrowser(jobId: string): BrowserController {
  return { fixtureBrowserFor: jobId } as unknown as BrowserController;
}

function makeHarness(runDir: string, options: HarnessOptions): Harness {
  const ledgers = new Map<string, EvidenceStore>();
  const browsers = new Map<string, BrowserController | undefined>();
  const registries = new Map<string, ToolRegistry>();
  const systems = new Map<string, string>();
  const signals = new Map<string, AbortSignal>();
  const requests = new Map<string, Message[][]>();
  const closed: string[] = [];
  const runBudget = options.runBudget ?? createRunBudgetTracker(UNBOUNDED_RUN);
  let inFlight = 0;
  let peak = 0;

  const runner = createResearchJobRunner({
    runDir,
    template: TEMPLATE,
    runBudget,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.coordinatorBrowser === undefined
      ? {}
      : { coordinatorBrowser: options.coordinatorBrowser }),
    ...(options.maxConcurrentPublicJobs === undefined
      ? {}
      : { maxConcurrentPublicJobs: options.maxConcurrentPublicJobs }),
    createSession: async ({ jobId, evidenceStore, signal }) => {
      ledgers.set(jobId, evidenceStore);
      signals.set(jobId, signal);
      const browser = options.browserFor ? options.browserFor(jobId) : fakeBrowser(jobId);
      browsers.set(jobId, browser);
      const registry = options.registryFor?.(jobId) ?? createRegistry([]);
      registries.set(jobId, registry);
      return {
        registry,
        ...(browser === undefined ? {} : { browser }),
        close: async () => {
          closed.push(jobId);
        },
      };
    },
    createCallModel: ({ jobId, entity, system }) => {
      systems.set(jobId, system);
      let call = 0;
      return async (messages) => {
        call += 1;
        const recorded = requests.get(jobId) ?? [];
        recorded.push(structuredClone(messages) as Message[]);
        requests.set(jobId, recorded);
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        try {
          return await options.respond({
            jobId,
            entity,
            call,
            ledger: ledgers.get(jobId)!,
            messages,
          });
        } finally {
          inFlight -= 1;
        }
      };
    },
  });

  return {
    runner,
    runBudget,
    ledgers,
    browsers,
    registries,
    systems,
    signals,
    requests,
    closed,
    peakInFlight: () => peak,
  };
}

/** A coordinator-side table store over a two-column contract, used to prove
 * children never reach it. */
function coordinatorTables(): OutputTableStore {
  const spec: OutputSpec = {
    id: 'partners',
    kind: 'table',
    filename: 'partners.csv',
    format: 'csv',
    columns: [
      { name: 'name', type: 'string', required: true },
      { name: 'founded', type: 'integer', required: true },
    ],
    rules: [],
  };
  return createOutputTableStore({
    tableSpec: (outputId) => (outputId === spec.id ? spec : undefined),
    evidenceExists: () => true,
  });
}

/** Record one piece of evidence exactly where a child's tools would. */
function capture(ledger: EvidenceStore, jobId: string): string {
  return recordEvidence(ledger, {
    kind: 'javascript_extraction',
    summary: `${jobId} read the founding year from the about page`,
    sourceUrl: `https://example.com/${jobId}/about`,
    detail: { founded: 1999 },
  }).id;
}

function parentManifest(runDir: string): Manifest {
  return JSON.parse(readFileSync(join(runDir, MANIFEST_FILENAME), 'utf8')) as Manifest;
}

let runDir: string;

beforeEach(() => {
  runDir = mkdtempSync(join(tmpdir(), 'research-job-test-'));
  initManifest(runDir, TEMPLATE.taskText);
});

afterEach(() => {
  rmSync(runDir, { recursive: true, force: true });
});

describe('research job configuration', () => {
  it('rejects a non-finite ceiling, which is the whole point of a bounded child', () => {
    for (const bad of [Infinity, Number.NaN, -1, 2.5]) {
      expect(() =>
        validateResearchJob(job('j1', 'Acme', { budget: { ...BUDGET, maxTurns: bad } })),
      ).toThrow(/FINITE integer/);
    }
    expect(() =>
      validateResearchJob(job('j1', 'Acme', { budget: { ...BUDGET, maxModelTokens: Infinity } })),
    ).toThrow(/maxModelTokens/);
    expect(() =>
      validateResearchJob(job('j1', 'Acme', { budget: { ...BUDGET, maxToolCalls: -1 } })),
    ).toThrow(/maxToolCalls/);
    expect(() =>
      validateResearchJob(job('j1', 'Acme', { budget: { ...BUDGET, maxWallTimeMs: Number.NaN } })),
    ).toThrow(/maxWallTimeMs/);
  });

  it('rejects a job id that would escape its directory or break the namespace', () => {
    for (const bad of ['../escape', 'a/b', 'has:colon', '', '-leading']) {
      expect(() => validateResearchJob(job(bad, 'Acme'))).toThrow(/research job id/);
    }
  });

  it('rejects a bad dispatch before any browser or model starts', async () => {
    const harness = makeHarness(runDir, { respond: async () => reportResponse({ rows: [] }) });

    await expect(harness.runner.runJobs([])).rejects.toThrow(/at least one/);
    await expect(
      harness.runner.runJobs([job('j1', 'Acme'), job('j1', 'Acme again')]),
    ).rejects.toThrow(/duplicate research job id/);
    await expect(
      harness.runner.runJobs(
        Array.from({ length: 9 }, (_unused, index) => job(`j${index}`, `Entity ${index}`)),
      ),
    ).rejects.toThrow(/at most 8/);
    // Nothing ran: no job directory, no session, no model call.
    expect(existsSync(join(runDir, RESEARCH_JOBS_DIR))).toBe(false);
    expect(harness.requests.size).toBe(0);
  });

  it('refuses a concurrency outside the two-to-three window', () => {
    for (const bad of [1, 4, 0, 2.5]) {
      expect(() =>
        makeHarness(runDir, {
          respond: async () => reportResponse({ rows: [] }),
          maxConcurrentPublicJobs: bad,
        }),
      ).toThrow(/maxConcurrentPublicJobs/);
    }
    expect(
      makeHarness(runDir, {
        respond: async () => reportResponse({ rows: [] }),
        maxConcurrentPublicJobs: 3,
      }).runner.maxConcurrentPublicJobs,
    ).toBe(3);
  });
});

describe('research jobs in flight', () => {
  it('overlaps two assignments while sharing no browser, ledger, registry, or table', async () => {
    const tables = coordinatorTables();
    // Neither job can finish until BOTH are inside their model call, so a
    // pass here is proof of genuine overlap rather than fast serial runs.
    const barrier = makeBarrier(2);
    const harness = makeHarness(runDir, {
      maxConcurrentPublicJobs: 2,
      respond: async ({ jobId, ledger }) => {
        await barrier.arrive();
        return reportResponse({
          rows: [
            {
              rowId: 'acme',
              values: { name: 'Acme', founded: 1999 },
              evidenceIds: [capture(ledger, jobId)],
            },
          ],
        });
      },
    });

    const results = await harness.runner.runJobs([
      job('j1', 'Acme (US filing)'),
      job('j2', 'Acme (EU registry)'),
    ]);

    expect(results.map((result) => result.status)).toEqual(['completed', 'completed']);
    expect(harness.peakInFlight()).toBe(2);

    // Nothing is shared: two browser contexts, two ledgers, two registries.
    expect(harness.browsers.get('j1')).not.toBe(harness.browsers.get('j2'));
    expect(harness.ledgers.get('j1')).not.toBe(harness.ledgers.get('j2'));
    expect(harness.registries.get('j1')).not.toBe(harness.registries.get('j2'));
    // Both ledgers independently issued "E1" — which is exactly why the merge
    // namespaces ids rather than trusting them.
    expect(results.map((result) => result.evidence[0]!.id)).toEqual(['E1', 'E1']);
    expect(results[0]!.evidence[0]!.path).toBe(
      'scratch/research-jobs/j1/scratch/evidence/E1.json',
    );
    expect(existsSync(join(runDir, results[1]!.evidence[0]!.path))).toBe(true);

    // The coordinator's table is untouched: children propose, the
    // coordinator applies.
    expect(tables.table('partners').rows).toEqual([]);
    // And the run's own manifest gained nothing — every child write landed in
    // that child's own workspace manifest.
    expect(parentManifest(runDir).artifacts).toEqual([]);

    // The overlap is REAL overlap in content, and the merge reports it.
    const merged = mergeResearchResults(results);
    expect(merged.rows).toHaveLength(1);
    expect(merged.duplicates).toHaveLength(1);
    expect(merged.duplicates[0]!.duplicateRowIds).toEqual(['j2:acme']);
  });

  it('holds the global public-session limit, running the third job only after a lane frees', async () => {
    const barrier = makeBarrier(2);
    const started: string[] = [];
    const harness = makeHarness(runDir, {
      maxConcurrentPublicJobs: 2,
      respond: async ({ jobId, ledger }) => {
        started.push(jobId);
        // Only the first two arrivals open the gate; the third job cannot be
        // in flight until one of them has finished.
        if (started.length <= 2) await barrier.arrive();
        return reportResponse({
          rows: [
            {
              rowId: jobId,
              values: { name: jobId, founded: 2000 },
              evidenceIds: [capture(ledger, jobId)],
            },
          ],
        });
      },
    });

    const results = await harness.runner.runJobs([
      job('j1', 'One'),
      job('j2', 'Two'),
      job('j3', 'Three'),
    ]);

    expect(results.map((result) => result.status)).toEqual([
      'completed',
      'completed',
      'completed',
    ]);
    expect(harness.peakInFlight()).toBe(2);
    expect(started.slice(0, 2).sort()).toEqual(['j1', 'j2']);
    expect(started[2]).toBe('j3');
    // Results come back in INPUT order, not completion order.
    expect(results.map((result) => result.jobId)).toEqual(['j1', 'j2', 'j3']);
  });

  it('keeps a successful child’s results when an independent child fails', async () => {
    const harness = makeHarness(runDir, {
      respond: async ({ jobId, ledger }) => {
        if (jobId === 'j1') throw new Error('the directory page never loaded');
        return reportResponse({
          rows: [
            {
              rowId: 'beta',
              values: { name: 'Beta', founded: 2004 },
              evidenceIds: [capture(ledger, jobId)],
            },
          ],
          limitations: [],
        });
      },
    });

    const results = await harness.runner.runJobs([job('j1', 'Alpha'), job('j2', 'Beta')]);

    expect(results[0]!.status).toBe('failed');
    expect(results[0]!.failure).toEqual({
      reason: 'job_error',
      detail: 'the directory page never loaded',
    });
    expect(results[0]!.rows).toEqual([]);
    // The sibling is untouched — its rows, its evidence, its usage.
    expect(results[1]!.status).toBe('completed');
    expect(results[1]!.rows).toHaveLength(1);
    expect(mergeResearchResults(results).rows.map((r) => r.rowId)).toEqual(['j2:beta']);
    // Both sessions were closed, including the failed one's.
    expect([...harness.closed].sort()).toEqual(['j1', 'j2']);
  });

  it('refuses a headed assignment instead of borrowing the coordinator’s profile', async () => {
    const harness = makeHarness(runDir, {
      respond: async ({ jobId, ledger }) =>
        reportResponse({
          rows: [
            {
              rowId: jobId,
              values: { name: jobId, founded: 2000 },
              evidenceIds: [capture(ledger, jobId)],
            },
          ],
        }),
    });

    const results = await harness.runner.runJobs([
      job('j1', 'Behind a login', { headed: true }),
      job('j2', 'Public page'),
    ]);

    expect(results[0]!.status).toBe('refused');
    expect(results[0]!.failure!.reason).toBe('headed_work_stays_with_coordinator');
    expect(results[0]!.jobDir).toBeUndefined();
    // A refused job never gets a session, a directory, or a model call.
    expect(harness.requests.has('j1')).toBe(false);
    expect(existsSync(join(runDir, RESEARCH_JOBS_DIR, 'j1'))).toBe(false);
    expect(results[1]!.status).toBe('completed');
  });

  it('fails a job whose session hands it the coordinator’s browser', async () => {
    const coordinatorBrowser = fakeBrowser('coordinator');
    const harness = makeHarness(runDir, {
      coordinatorBrowser,
      browserFor: (jobId) => (jobId === 'j1' ? coordinatorBrowser : fakeBrowser(jobId)),
      respond: async ({ jobId, ledger }) =>
        reportResponse({
          rows: [
            {
              rowId: jobId,
              values: { name: jobId, founded: 2000 },
              evidenceIds: [capture(ledger, jobId)],
            },
          ],
        }),
    });

    const results = await harness.runner.runJobs([job('j1', 'Alpha'), job('j2', 'Beta')]);

    expect(results[0]!.status).toBe('failed');
    expect(results[0]!.failure!.detail).toContain("coordinator's browser");
    // It never took a turn, and its session was still closed.
    expect(harness.requests.has('j1')).toBe(false);
    expect(harness.closed).toContain('j1');
    expect(results[1]!.status).toBe('completed');
  });

  it('fails a job whose registry was mis-wired with a coordinator tool', async () => {
    const smuggled: ToolDef = {
      name: 'upsert_output_rows',
      description: 'not a child’s to call',
      inputSchema: z.strictObject({}),
      readOnly: false,
      execute: () => 'unused',
    };
    const harness = makeHarness(runDir, {
      registryFor: (jobId) =>
        jobId === 'j1' ? createRegistry([smuggled]) : createRegistry([]),
      respond: async ({ jobId, ledger }) =>
        reportResponse({
          rows: [
            {
              rowId: jobId,
              values: { name: jobId, founded: 2000 },
              evidenceIds: [capture(ledger, jobId)],
            },
          ],
        }),
    });

    const results = await harness.runner.runJobs([job('j1', 'Alpha'), job('j2', 'Beta')]);

    expect(results[0]!.status).toBe('failed');
    expect(results[0]!.failure!.detail).toContain('upsert_output_rows');
    expect(harness.requests.has('j1')).toBe(false);
    expect(results[1]!.status).toBe('completed');
  });
});

describe('research job budgets', () => {
  it('charges every child’s model usage to the run’s budget as well as its own', async () => {
    const runBudget = createRunBudgetTracker(UNBOUNDED_RUN);
    const harness = makeHarness(runDir, {
      runBudget,
      respond: async ({ jobId, ledger }) =>
        reportResponse({
          rows: [
            {
              rowId: jobId,
              values: { name: jobId, founded: 2000 },
              evidenceIds: [capture(ledger, jobId)],
            },
          ],
        }),
    });

    const results = await harness.runner.runJobs([job('j1', 'Alpha'), job('j2', 'Beta')]);

    // Each job reports only its OWN usage...
    expect(results.map((result) => result.usage.turns)).toEqual([1, 1]);
    expect(results[0]!.usage.inputTokens).toBe(10);
    // ...while the run's tracker carries the sum, so whole-run metrics and
    // ceilings see child spend.
    expect(runBudget.workerTurnsUsed()).toBe(2);
    expect(runBudget.totalModelTokens()).toBe(30);
    expect(runBudget.roleUsage().worker).toMatchObject({
      turns: 2,
      inputTokens: 20,
      outputTokens: 10,
    });
  });

  it('stops a child at its own turn ceiling without a report', async () => {
    const harness = makeHarness(runDir, {
      registryFor: () => echoRegistry(),
      respond: async ({ call }) => toolResponse(`t${call}`),
    });

    const [result] = await harness.runner.runJobs([
      job('j1', 'Alpha', { budget: { ...BUDGET, maxTurns: 2 } }),
    ]);

    expect(result!.status).toBe('budget_exceeded');
    expect(result!.failure!.reason).toBe('budget_max_turns');
    expect(result!.rows).toEqual([]);
    expect(harness.requests.get('j1')).toHaveLength(2);
    expect(result!.usage.toolCalls).toBe(2);
  });

  it('stops a child the moment the RUN is out of headroom', async () => {
    // The run has already spent its entire tool-call allowance; the child's
    // own ceiling is untouched, so only the linked parent check can stop it.
    const runBudget = createRunBudgetTracker({ ...UNBOUNDED_RUN, maxToolCalls: 0 });
    const harness = makeHarness(runDir, {
      runBudget,
      registryFor: () => echoRegistry(),
      respond: async ({ call }) => toolResponse(`t${call}`),
    });

    const [result] = await harness.runner.runJobs([job('j1', 'Alpha')]);

    expect(result!.status).toBe('budget_exceeded');
    expect(result!.failure!.reason).toBe('budget_tool_calls');
    expect(harness.requests.get('j1')).toHaveLength(1);
    expect(runBudget.exceededLimit()).toBe('tool_calls');
  });
});

describe('research job cancellation', () => {
  it('is already cancelled when the run was cancelled before the dispatch', async () => {
    const controller = new AbortController();
    controller.abort();
    const harness = makeHarness(runDir, {
      signal: controller.signal,
      respond: async () => reportResponse({ rows: [] }),
    });

    const results = await harness.runner.runJobs([job('j1', 'Alpha'), job('j2', 'Beta')]);

    expect(results.map((result) => result.status)).toEqual(['cancelled', 'cancelled']);
    // Not one model call, and not one browser session.
    expect(harness.requests.size).toBe(0);
    expect(harness.browsers.size).toBe(0);
  });

  it('stops in-flight and queued children when the run is cancelled mid-dispatch', async () => {
    const controller = new AbortController();
    const barrier = makeBarrier(2);
    const harness = makeHarness(runDir, {
      signal: controller.signal,
      maxConcurrentPublicJobs: 2,
      respond: async ({ jobId, ledger }) => {
        if (jobId === 'j1') {
          // Capture something first: a cancelled child's finished work must
          // survive cancellation.
          capture(ledger, jobId);
          await barrier.arrive();
          controller.abort();
          return reportResponse({ rows: [] });
        }
        await barrier.arrive();
        // A model that ignores its signal entirely; only the runner's own
        // race can stop this job.
        return new Promise<ModelResponse>(() => undefined);
      },
    });

    const results = await harness.runner.runJobs([
      job('j1', 'Alpha'),
      job('j2', 'Beta'),
      job('j3', 'Gamma'),
    ]);

    expect(results.map((result) => result.status)).toEqual([
      'cancelled',
      'cancelled',
      'cancelled',
    ]);
    // The queued job never reached a model — nor even a browser: a job
    // cancelled while waiting must not cost a session launch.
    expect(harness.requests.has('j3')).toBe(false);
    expect(harness.browsers.has('j3')).toBe(false);
    // Every child signal that existed was aborted, and every session that was
    // opened was closed.
    expect([...harness.signals.values()].every((signal) => signal.aborted)).toBe(true);
    expect([...harness.closed].sort()).toEqual(['j1', 'j2']);
    // The evidence the cancelled child had already captured is preserved, so
    // incomplete-run finalization keeps finished work.
    expect(results[0]!.evidence).toHaveLength(1);
    expect(existsSync(join(runDir, results[0]!.evidence[0]!.path))).toBe(true);
    // Cancellation is "stopped", not "crashed": no metrics file is written.
    expect(existsSync(join(runDir, RESEARCH_JOBS_DIR, 'j1', 'metrics.json'))).toBe(false);
  });
});

describe('research job results', () => {
  it('returns a typed result and never the child’s conversation', async () => {
    const secret = 'CHAIN-OF-THOUGHT-8fj3-do-not-replay';
    const harness = makeHarness(runDir, {
      respond: async ({ jobId, ledger }) =>
        reportResponse(
          {
            rows: [
              {
                rowId: 'acme',
                values: { name: 'Acme', founded: 1999 },
                evidenceIds: [capture(ledger, jobId)],
              },
            ],
            limitations: ['the 1998 filing was not machine-readable'],
          },
          `I checked three pages. ${secret}`,
        ),
    });

    const [result] = await harness.runner.runJobs([job('j1', 'Acme')]);

    expect(result!.rows).toEqual([
      { rowId: 'acme', values: { name: 'Acme', founded: 1999 }, evidenceIds: ['E1'] },
    ]);
    expect(result!.limitations).toEqual(['the 1998 filing was not machine-readable']);
    // The child's prose stays out of the coordinator's context entirely —
    // three parallel jobs must not mean three transcripts of context growth.
    expect(JSON.stringify(result)).not.toContain(secret);
    // ...while the audit trail keeps every byte of it in the job's own dir.
    const transcript = readFileSync(
      join(runDir, RESEARCH_JOBS_DIR, 'j1', 'transcript.jsonl'),
      'utf8',
    );
    expect(transcript).toContain(secret);
    expect(transcript).toContain('research_job_start');
    expect(transcript).toContain('research_job_end');
  });

  it('stages the typed result and its own workspace under the job directory', async () => {
    const harness = makeHarness(runDir, {
      respond: async ({ jobId, ledger }) =>
        reportResponse({
          rows: [
            {
              rowId: 'acme',
              values: { name: 'Acme', founded: 1999 },
              evidenceIds: [capture(ledger, jobId)],
            },
          ],
        }),
    });

    const [result] = await harness.runner.runJobs([job('j1', 'Acme')]);
    const jobDir = join(runDir, RESEARCH_JOBS_DIR, 'j1');

    expect(result!.jobDir).toBe('scratch/research-jobs/j1');
    const staged = JSON.parse(
      readFileSync(join(jobDir, RESEARCH_JOB_RESULT_FILENAME), 'utf8'),
    ) as ResearchJobResult;
    expect(staged.rows).toEqual(result!.rows);
    // The job is a complete miniature workspace: its own manifest hashes its
    // own files, and the run's manifest is not touched.
    const jobManifest = JSON.parse(
      readFileSync(join(jobDir, MANIFEST_FILENAME), 'utf8'),
    ) as Manifest;
    expect(jobManifest.artifacts.map((entry) => entry.filename)).toEqual([
      join('scratch', 'evidence', 'E1.json'),
    ]);
    // Private working state, so no roles — the marker that says "not a
    // deliverable".
    expect(jobManifest.artifacts[0]!.roles).toBeUndefined();
    expect(parentManifest(runDir).artifacts).toEqual([]);
  });

  it('reports an unreadable report as a failure while keeping the evidence', async () => {
    const harness = makeHarness(runDir, {
      respond: async ({ jobId, ledger }) => {
        capture(ledger, jobId);
        return {
          content: [{ type: 'text', text: 'Acme was founded in 1999, I think.' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 10, output_tokens: 5 },
        };
      },
    });

    const [result] = await harness.runner.runJobs([job('j1', 'Acme')]);

    expect(result!.status).toBe('failed');
    expect(result!.failure!.reason).toBe('unreadable_report');
    expect(result!.rows).toEqual([]);
    expect(result!.evidence).toHaveLength(1);
  });
});

describe('research job prompts', () => {
  it('appends the entity assignment, keeping the cached prefix byte-identical', async () => {
    const sharedRegistry = echoRegistry();
    const harness = makeHarness(runDir, {
      registryFor: () => sharedRegistry,
      respond: async () => reportResponse({ rows: [] }),
    });

    await harness.runner.runJobs([job('j1', 'Acme'), job('j2', 'Beta Industries')]);

    // Exactly the comparison src/model/callModel.test.ts makes: the API
    // renders tools → system → messages, so {tools, system} IS the cached
    // prefix. Two jobs, two conversations, one prefix.
    const apiToolDefs = toApiToolDefs(sharedRegistry);
    const paramsFor = (jobId: string) =>
      buildRequestParams(
        { system: harness.systems.get(jobId)!, apiToolDefs, maxOutputTokens: 4_096 },
        harness.requests.get(jobId)![0]!,
      );
    const first = paramsFor('j1');
    const second = paramsFor('j2');

    expect(JSON.stringify({ tools: second.tools, system: second.system })).toBe(
      JSON.stringify({ tools: first.tools, system: first.system }),
    );
    // The shared briefing is the first message and is byte-identical too, so
    // the identical span reaches past the system block.
    expect(JSON.stringify(second.messages[0])).toBe(JSON.stringify(first.messages[0]));
    // Only the APPENDED message differs, and it is what names the entity.
    expect(JSON.stringify(second.messages[1])).not.toBe(JSON.stringify(first.messages[1]));
    expect(JSON.stringify(first.messages[1])).toContain('Acme');
    expect(JSON.stringify(second.messages[1])).toContain('Beta Industries');
    expect(first.messages).toHaveLength(2);
    // The entity appears nowhere in the shared parts — an interpolated
    // assignment would silently cost every job its cache read.
    expect(JSON.stringify({ tools: first.tools, system: first.system })).not.toContain('Acme');
    expect(JSON.stringify(first.messages[0])).not.toContain('Acme');
  });

  it('builds one system prompt per template, whatever the job', () => {
    const first = buildResearchJobPrompt(TEMPLATE, job('j1', 'Acme'));
    const second = buildResearchJobPrompt(TEMPLATE, job('j2', 'Beta'));

    expect(second.system).toBe(first.system);
    expect(second.briefing).toBe(first.briefing);
    expect(first.system).toContain(TEMPLATE.taskText);
    expect(first.system).toContain(TEMPLATE.contractText);
    expect(first.system).toContain(TEMPLATE.extractionRules);
    expect(first.assignment).toContain('Acme');
    expect(second.assignment).toContain('Beta');
  });
});

describe('parseResearchReport', () => {
  it('reads the fenced report a job is asked to produce', () => {
    const parsed = parseResearchReport(
      'Here it is.\n\n```json\n{"rows":[{"rowId":"a","values":{"n":1},"evidenceIds":["E1"]}]}\n```',
    );

    expect(parsed).toEqual({
      ok: true,
      rows: [{ rowId: 'a', values: { n: 1 }, evidenceIds: ['E1'] }],
      limitations: [],
    });
  });

  it('takes the LAST block, so a worked example does not become the answer', () => {
    const parsed = parseResearchReport(
      'Shape:\n```json\n{"rows":[]}\n```\nMy answer:\n' +
        '```json\n{"rows":[{"rowId":"real","values":{"n":2},"evidenceIds":["E2"]}]}\n```',
    );

    expect(parsed.ok).toBe(true);
    expect(parsed.ok && parsed.rows.map((row) => row.rowId)).toEqual(['real']);
  });

  it('accepts an unfenced object and preserves the dedupe key', () => {
    const parsed = parseResearchReport(
      'Result: {"rows":[{"rowId":"a","values":{"n":1},"evidenceIds":["E1"],"dedupeKey":"acme"}],"limitations":["no 1998 data"]}',
    );

    expect(parsed.ok && parsed.rows[0]!.dedupeKey).toBe('acme');
    expect(parsed.ok && parsed.limitations).toEqual(['no 1998 data']);
  });

  it('refuses a report with no evidence citation', () => {
    const parsed = parseResearchReport('```json\n{"rows":[{"rowId":"a","values":{"n":1},"evidenceIds":[]}]}\n```');

    expect(parsed.ok).toBe(false);
  });

  it('refuses a report inventing fields, rather than ignoring them', () => {
    // A child announcing "appliedRows" is trying to do the coordinator's job;
    // dropping the key silently would hide that.
    const parsed = parseResearchReport('```json\n{"rows":[],"appliedRows":["acme"]}\n```');

    expect(parsed.ok).toBe(false);
    expect(!parsed.ok && parsed.reason).toContain('did not match the required shape');
  });

  it('says plainly when there was no report at all', () => {
    expect(parseResearchReport('I could not find anything.')).toEqual({
      ok: false,
      reason: 'the final message carried no JSON report block',
    });
  });
});
