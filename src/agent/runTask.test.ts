import { createHash } from 'node:crypto';
import { access, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import type { BrowserController } from '../browser/controller.js';
import { LocalChromeBrowserSessionProvider } from '../browser/playwrightBrowserController.js';
import type {
  CallModel,
  Message,
  ModelResponse,
  Usage,
} from '../model/messages.js';
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
const USAGE: Usage = { input_tokens: 10, output_tokens: 2 };

interface TranscriptEvent {
  type: string;
  call?: unknown;
}

function toolResponse(
  id: string,
  name: string,
  input: unknown,
): ModelResponse {
  return {
    content: [{ type: 'tool_use', id, name, input }],
    stop_reason: 'tool_use',
    usage: USAGE,
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
    return structuredClone(response);
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

async function filesContaining(
  root: string,
  needle: string,
  relativeDir = '',
): Promise<string[]> {
  const hits: string[] = [];
  for (const entry of await readdir(join(root, relativeDir), {
    withFileTypes: true,
  })) {
    const relativePath = join(relativeDir, entry.name);
    if (entry.isDirectory()) {
      hits.push(...(await filesContaining(root, needle, relativePath)));
    } else if (entry.isFile()) {
      const bytes = await readFile(join(root, relativePath));
      if (bytes.includes(needle)) hits.push(relativePath);
    }
  }
  return hits;
}

describe('runTask browser acceptance', () => {
  let browser: BrowserController;
  let fixtureServer: FixtureServer;
  let tempRoot: string;
  let runsBaseDir: string;

  beforeAll(async () => {
    fixtureServer = await startFixtureServer();
    tempRoot = await mkdtemp(join(tmpdir(), 'run-task-test-'));
    runsBaseDir = join(tempRoot, 'runs');
    browser = await new LocalChromeBrowserSessionProvider({
      profileDir: join(tempRoot, 'chrome-profile'),
      headless: true,
    }).createSession();
  }, TEST_TIMEOUT_MS);

  afterEach(async () => {
    await browser.closeTaskPages();
  }, TEST_TIMEOUT_MS);

  afterAll(async () => {
    await browser?.close();
    await fixtureServer?.close();
    if (tempRoot !== undefined) {
      await rm(tempRoot, { recursive: true, force: true });
    }
  }, TEST_TIMEOUT_MS);

  it(
    'browses, publishes, verifies, hashes, and closes the owned task page',
    async () => {
      const taskText =
        'Inspect the local evidence fixture and publish its title and URL as stories.csv. Do not take screenshots.';
      const fixtureUrl = fixtureServer.url('/');
      const csv = `title,url\nBrowser Controller Fixture,${fixtureUrl}\n`;
      const secretSentinel = 'sherlock-run-secret-sentinel-8f06d05f';
      const initializer = scriptModel([
        toolResponse('contract-1', 'set_output_contract', {
          contract: {
            outputs: [
              {
                id: 'stories',
                kind: 'table',
                filename: 'stories.csv',
                format: 'csv',
                columns: [
                  { name: 'title', required: true, type: 'string' },
                  { name: 'url', required: true, type: 'string' },
                ],
                rules: [{ type: 'exact_row_count', value: 1 }],
              },
            ],
          },
        }),
      ]);
      const worker = scriptModel([
        toolResponse('browse-1', 'browser_execute', {
          code:
            `await browser.goto(${JSON.stringify(fixtureUrl)}); ` +
            'await browser.waitForLoad(); ' +
            "const page = await browser.js('({title: document.title, url: location.href})'); " +
            'return { page, leakedSecret: process.env.BROWSERBASE_API_KEY ?? null };',
        }),
        toolResponse('publish-1', 'publish_artifact', {
          kind: 'text',
          artifact_path: 'artifacts/stories.csv',
          roles: ['requested_output'],
          content: csv,
        }),
        toolResponse('finish-1', 'finish', {
          summary: 'Published the requested fixture report.',
          unresolved: [],
        }),
      ]);
      const verifier = scriptModel([
        toolResponse('verify-1', 'report_verification', {
          status: 'verified',
          findings: [],
        }),
      ]);

      const previousBrowserbaseKey = process.env.BROWSERBASE_API_KEY;
      process.env.BROWSERBASE_API_KEY = secretSentinel;
      let result: Awaited<ReturnType<typeof runTask>>;
      try {
        result = await runTask(taskText, {
          browser,
          runsBaseDir,
          authenticated: false,
          javascriptPolicy: 'allow',
          callModel: worker.callModel,
          maxTurns: 4,
          maxContextTokens: 10_000,
          harness: {
            initializerCallModel: initializer.callModel,
            verifierCallModel: verifier.callModel,
          },
        });
      } finally {
        if (previousBrowserbaseKey === undefined) {
          delete process.env.BROWSERBASE_API_KEY;
        } else {
          process.env.BROWSERBASE_API_KEY = previousBrowserbaseKey;
        }
      }

      expect(result).toEqual({
        runDir: result.runDir,
        status: 'verified',
        finalText: 'Published the requested fixture report.',
      });
      expect(await readFile(join(result.runDir, 'artifacts/stories.csv'), 'utf8')).toBe(csv);
      expect(JSON.stringify(worker.requests[1])).toContain('Browser Controller Fixture');
      expect(JSON.stringify(worker.requests[1])).toContain(fixtureUrl);
      expect(JSON.stringify(worker.requests[1])).toContain(
        '\\"leakedSecret\\":null',
      );

      const manifest = await readJson<Manifest>(
        join(result.runDir, MANIFEST_FILENAME),
      );
      expect(manifest.finishedAt).toBeDefined();
      expect(manifest.artifacts).toEqual([
        expect.objectContaining({
          filename: 'artifacts/stories.csv',
          roles: ['requested_output'],
        }),
      ]);
      const bytes = await readFile(join(result.runDir, 'artifacts/stories.csv'));
      expect(manifest.artifacts[0]?.sha256).toBe(
        createHash('sha256').update(bytes).digest('hex'),
      );
      await expect(
        readJson<{ status: string; turns: number }>(
          join(result.runDir, 'metrics.json'),
        ),
      ).resolves.toMatchObject({ status: 'verified', turns: 3 });
      await expect(
        readJson(join(result.runDir, 'harness/checkpoint.json')),
      ).resolves.toMatchObject({
        version: 3,
        phase: 'terminal',
        outcome: { status: 'verified' },
      });
      await expect(
        readJson(join(result.runDir, 'harness/output-contract.json')),
      ).resolves.toMatchObject({
        outputs: [{ id: 'stories', filename: 'stories.csv' }],
      });
      await expect(
        readdir(join(result.runDir, 'harness/artifact-write-journal')),
      ).resolves.toEqual([]);
      await expect(
        access(join(result.runDir, 'harness/run.lock')),
      ).rejects.toMatchObject({ code: 'ENOENT' });

      const events = await readTranscript(result.runDir);
      expect(
        events
          .filter((event) => event.type === 'tool_call')
          .map((event) => (event.call as { name: string }).name),
      ).toEqual(['browser_execute', 'publish_artifact', 'finish']);
      expect(await filesContaining(result.runDir, secretSentinel)).toEqual([]);
      expect(() => browser.currentUrl()).toThrow(/No browser task page/);
    },
    TEST_TIMEOUT_MS,
  );
});
