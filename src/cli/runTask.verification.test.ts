import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { LocalChromeBrowserSessionProvider } from '../browser/playwrightBrowserController.js';
import type { BrowserController } from '../browser/controller.js';
import { contractRevisionPath } from '../contracts/outputContractStore.js';
import { HARNESS_FILENAME, type HarnessDiagnostics } from '../harness/harness.js';
import type { CallModel, Message, ModelResponse, Usage } from '../loop/messages.js';
import { MANIFEST_FILENAME, type Manifest } from '../run/artifacts.js';
import { runTask } from './runTask.js';

// The vertical T5 test: contract → file write → submit → code check →
// verified, driven entirely by scripted models. No real API call, no
// network. This is the test that proves the whole V2 completion protocol
// holds together, not just its parts.

const TEST_TIMEOUT_MS = 30_000;
const USAGE: Usage = { input_tokens: 10, output_tokens: 3 };

const CSV = 'name,url\nAlpha,https://example.com/alpha\n';

const CONTRACT_INPUT = {
  contract: {
    outputs: [
      {
        id: 'roster',
        kind: 'table',
        filename: 'roster.csv',
        format: 'csv',
        columns: [
          { name: 'name', required: true, type: 'string' },
          { name: 'url', required: false, type: 'url' },
        ],
        rules: [{ type: 'exact_row_count', value: 1 }],
      },
    ],
  },
};

function toolResponse(
  calls: Array<{ id: string; name: string; input: unknown }>,
): ModelResponse {
  return {
    content: calls.map((call) => ({ type: 'tool_use' as const, ...call })),
    stop_reason: 'tool_use',
    usage: { ...USAGE },
  };
}

function textResponse(text: string): ModelResponse {
  return { content: [{ type: 'text', text }], stop_reason: 'end_turn', usage: { ...USAGE } };
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
      throw new Error(`model called ${requests.length}x, only ${responses.length} scripted`);
    }
    return response;
  };
  return { callModel, requests };
}

const setContract = (input: unknown = CONTRACT_INPUT) =>
  toolResponse([{ id: 'c1', name: 'set_output_contract', input }]);

const writeCsv = (content = CSV) =>
  toolResponse([
    { id: 'w1', name: 'write_file', input: { file_path: 'artifacts/roster.csv', content } },
  ]);

const submit = (id = 's1') =>
  toolResponse([{ id, name: 'submit_for_verification', input: { summary: 'Roster published.' } }]);

// The typed-row path: mint one evidence record, cite it from a row and from
// the completeness claim, and never touch write_file. Evidence ids start at
// E1, so a scripted worker can cite the id its own first call will create.
const captureEvidence = () =>
  toolResponse([
    {
      id: 'j1',
      name: 'execute_javascript',
      input: { target: 'selected_top_document', code: '"Alpha"', captureEvidence: true },
    },
  ]);

const upsertRow = () =>
  toolResponse([
    {
      id: 'r1',
      name: 'upsert_output_rows',
      input: {
        outputId: 'roster',
        rows: [
          {
            rowId: '1',
            values: { name: 'Alpha', url: 'https://example.com/alpha' },
            evidenceIds: ['E1'],
          },
        ],
      },
    },
  ]);

const setCompleteness = () =>
  toolResponse([
    {
      id: 't1',
      name: 'set_table_completeness',
      input: {
        outputId: 'roster',
        method: 'The page lists exactly one widget.',
        evidenceIds: ['E1'],
        statedTotal: 1,
      },
    },
  ]);

const reportVerified = () =>
  toolResponse([
    { id: 'v1', name: 'report_verification', input: { status: 'verified', findings: [] } },
  ]);

const reportNeedsCorrection = (message: string) =>
  toolResponse([
    {
      id: 'v1',
      name: 'report_verification',
      input: {
        status: 'needs_correction',
        findings: [{ area: 'output', code: 'unsatisfied', message }],
      },
    },
  ]);

describe('runTask V2 verification protocol', () => {
  let browser: BrowserController;
  let tempRoot: string;
  let runsBaseDir: string;

  beforeAll(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), 'verification-test-'));
    runsBaseDir = join(tempRoot, 'runs');
    browser = await new LocalChromeBrowserSessionProvider({
      profileDir: join(tempRoot, 'chrome-profile'),
      headless: true,
    }).createSession();
  }, TEST_TIMEOUT_MS);

  afterAll(async () => {
    await browser?.close();
    if (tempRoot !== undefined) await rm(tempRoot, { recursive: true, force: true });
  });

  it(
    'completes contract → write → submit → code check → verified without a real API call',
    async () => {
      const worker = scriptModel([setContract(), writeCsv(), submit()]);
      const verifier = scriptModel([reportVerified()]);

      const result = await runTask('Publish the widget roster.', {
        browser,
        runsBaseDir,
        callModel: worker.callModel,
        maxTurns: 8,
        maxContextTokens: 100_000,
        harness: {
          outputContract: true,
          contractAuthor: 'worker',
          verifierCallModel: verifier.callModel,
        },
      });

      expect(result.status).toBe('verified');
      // The contract was stored, the deliverable published, the manifest
      // records both, and the verifier was reached exactly once.
      expect(await readFile(join(result.runDir, 'artifacts/roster.csv'), 'utf8')).toBe(CSV);
      expect(
        JSON.parse(await readFile(join(result.runDir, contractRevisionPath(1)), 'utf8')),
      ).toMatchObject({ revision: 1 });
      expect(verifier.requests).toHaveLength(1);

      const diagnostics = JSON.parse(
        await readFile(join(result.runDir, HARNESS_FILENAME), 'utf8'),
      ) as HarnessDiagnostics;
      expect(diagnostics.outcome).toEqual({ status: 'verified' });
      expect(diagnostics.cycles[0]).toMatchObject({ verdict: 'verified' });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'a failing code check never spends a verifier attempt and returns to the same worker',
    async () => {
      // The CSV has two rows but the contract requires exactly one, so the
      // code checks reject the first submission. The worker fixes it and
      // resubmits; only then does the verifier run.
      const worker = scriptModel([
        setContract(),
        writeCsv(`${CSV}Beta,https://example.com/beta\n`),
        submit('s1'),
        writeCsv(),
        submit('s2'),
      ]);
      const verifier = scriptModel([reportVerified()]);

      const result = await runTask('Publish the widget roster.', {
        browser,
        runsBaseDir,
        callModel: worker.callModel,
        maxTurns: 12,
        maxContextTokens: 100_000,
        harness: {
          outputContract: true,
          contractAuthor: 'worker',
          verifierCallModel: verifier.callModel,
        },
      });

      expect(result.status).toBe('verified');
      // One verifier call total: the rejected submission cost none.
      expect(verifier.requests).toHaveLength(1);
      // The rejection came back as the submission call's own result, in the
      // same conversation — the worker's 4th request contains it.
      const afterRejection = JSON.stringify(worker.requests[3]);
      expect(afterRejection).toMatch(/Automated checks rejected/);
      expect(afterRejection).toMatch(/row_count_mismatch/);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'a no-tool response cannot finish the run — submission is the only way',
    async () => {
      // The worker claims completion in prose, is corrected, then submits.
      const worker = scriptModel([
        setContract(),
        writeCsv(),
        textResponse('All done — the roster is complete.'),
        submit(),
      ]);
      const verifier = scriptModel([reportVerified()]);

      const result = await runTask('Publish the widget roster.', {
        browser,
        runsBaseDir,
        callModel: worker.callModel,
        maxTurns: 12,
        maxContextTokens: 100_000,
        harness: {
          outputContract: true,
          contractAuthor: 'worker',
          verifierCallModel: verifier.callModel,
        },
      });

      expect(result.status).toBe('verified');
      // The prose claim produced protocol feedback, not completion.
      expect(JSON.stringify(worker.requests[3])).toMatch(/claimed the work was finished/);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'a verifier correction reaches the same worker conversation and can then verify',
    async () => {
      const worker = scriptModel([setContract(), writeCsv(), submit('s1'), writeCsv(), submit('s2')]);
      const verifier = scriptModel([
        reportNeedsCorrection('The url column must use https.'),
        reportVerified(),
      ]);

      const result = await runTask('Publish the widget roster.', {
        browser,
        runsBaseDir,
        callModel: worker.callModel,
        maxTurns: 12,
        maxContextTokens: 100_000,
        harness: {
          outputContract: true,
          contractAuthor: 'worker',
          verifierCallModel: verifier.callModel,
        },
      });

      expect(result.status).toBe('verified');
      // The findings arrived as the submission's result, and the worker's
      // whole prior conversation was still present.
      const afterFindings = JSON.stringify(worker.requests[3]);
      expect(afterFindings).toMatch(/Verification found problems/);
      expect(afterFindings).toMatch(/must use https/);
      expect(afterFindings).toMatch(/set_output_contract/); // history retained
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'the contract-first gate stops a browser action before any contract exists',
    async () => {
      const worker = scriptModel([
        // Navigating first, with no contract: refused, nothing runs.
        toolResponse([{ id: 'n1', name: 'navigate', input: { url: 'https://example.com' } }]),
        setContract(),
        writeCsv(),
        submit(),
      ]);
      const verifier = scriptModel([reportVerified()]);

      const result = await runTask('Publish the widget roster.', {
        browser,
        runsBaseDir,
        callModel: worker.callModel,
        maxTurns: 12,
        maxContextTokens: 100_000,
        harness: {
          outputContract: true,
          contractAuthor: 'worker',
          verifierCallModel: verifier.callModel,
        },
      });

      expect(result.status).toBe('verified');
      expect(JSON.stringify(worker.requests[1])).toContain('output_contract_required');
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'exhausted verifier corrections end incomplete and mark the output partial',
    async () => {
      const worker = scriptModel([setContract(), writeCsv(), submit('s1'), submit('s2')]);
      const verifier = scriptModel([
        reportNeedsCorrection('Still wrong.'),
        reportNeedsCorrection('Still wrong again.'),
      ]);

      const result = await runTask('Publish the widget roster.', {
        browser,
        runsBaseDir,
        callModel: worker.callModel,
        maxTurns: 12,
        maxContextTokens: 100_000,
        harness: {
          outputContract: true,
          contractAuthor: 'worker',
          maxWorkerCycles: 2,
          verifierCallModel: verifier.callModel,
        },
      });

      expect(result.status).toBe('incomplete');
      if (result.status !== 'incomplete') throw new Error('unreachable');
      expect(result.reason).toBe('verification_attempts');

      // The run is preserved: the file still exists with its hash intact.
      expect(await readFile(join(result.runDir, 'artifacts/roster.csv'), 'utf8')).toBe(CSV);
      const manifest = JSON.parse(
        await readFile(join(result.runDir, MANIFEST_FILENAME), 'utf8'),
      ) as Manifest;
      const entry = manifest.artifacts.find((a) => a.filename === 'artifacts/roster.csv');
      // The code checks pass for this file, so it stays complete rather than
      // being blanket-marked partial — the distinction a grader needs.
      expect(entry?.completionStatus).toBe('complete');
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'the initializer can author the contract instead of the worker',
    async () => {
      const initializer = scriptModel([setContract()]);
      const worker = scriptModel([writeCsv(), submit()]);
      const verifier = scriptModel([reportVerified()]);

      const result = await runTask('Publish the widget roster.', {
        browser,
        runsBaseDir,
        callModel: worker.callModel,
        maxTurns: 8,
        maxContextTokens: 100_000,
        harness: {
          outputContract: true,
          contractAuthor: 'initializer',
          initializerCallModel: initializer.callModel,
          verifierCallModel: verifier.callModel,
        },
      });

      expect(result.status).toBe('verified');
      // The worker never called set_output_contract, yet the gate let it
      // work immediately because a contract already existed.
      expect(JSON.stringify(worker.requests[0])).not.toContain('output_contract_required');
      expect(
        JSON.parse(await readFile(join(result.runDir, contractRevisionPath(1)), 'utf8')),
      ).toMatchObject({ revision: 1 });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'renders the table deliverable from typed rows, with no write_file at all',
    async () => {
      // Every other test here hand-writes the CSV with write_file, which is
      // why nothing noticed that renderTableOutputs had NO production caller:
      // a run built valid rows, was told `missing_file`, and hand-wrote the
      // deliverable to get past its own check. The rendered file IS the
      // product of the typed-row pipeline; if code does not write it, the
      // pipeline's whole reason for existing is absent.
      const initializer = scriptModel([setContract()]);
      const worker = scriptModel([captureEvidence(), upsertRow(), setCompleteness(), submit()]);
      const verifier = scriptModel([reportVerified()]);

      const result = await runTask('Publish the widget roster.', {
        browser,
        runsBaseDir,
        callModel: worker.callModel,
        maxTurns: 10,
        maxContextTokens: 100_000,
        harness: {
          outputContract: true,
          contractAuthor: 'initializer',
          initializerCallModel: initializer.callModel,
          verifierCallModel: verifier.callModel,
        },
      });

      expect(result.status).toBe('verified');

      const csv = await readFile(join(result.runDir, 'artifacts/roster.csv'), 'utf8');
      expect(csv).toContain('name,url');
      expect(csv).toContain('Alpha');

      // Published as the deliverable graders select, and produced by code:
      // the worker's script contains no write_file at all.
      const manifest = JSON.parse(
        await readFile(join(result.runDir, MANIFEST_FILENAME), 'utf8'),
      ) as Manifest;
      expect(
        manifest.artifacts?.find((entry) => entry.filename === 'artifacts/roster.csv')?.roles,
      ).toEqual(['requested_output']);
      expect(JSON.stringify(worker.requests)).not.toContain('write_file');
    },
    TEST_TIMEOUT_MS,
  );
});
