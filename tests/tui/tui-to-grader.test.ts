import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { grade } from '../../evals/datasets/stub/grader/grader.js';
import { fetchOracle } from '../../evals/datasets/stub/oracle/oracle.js';
import { sha256Hex } from '../../evals/grading/hash.js';
import {
  readManifest,
  requestedOutputs,
  verifyManifestHashes,
} from '../../evals/grading/manifestVerification.js';
import type { CallModel, ModelResponse } from '../../src/model/messages.js';
import { TRANSCRIPT_FILENAME } from '../../src/run/transcript.js';
import { startRun } from '../../src/tui/bridge/runSession.js';
import {
  createInitialState,
  reduce,
  type StoreAction,
} from '../../src/tui/store/reducer.js';
import type { UiEvent } from '../../src/tui/store/state.js';
import { scriptedResponse, scriptedStreamFactory } from './streamFixtures.js';
import { stubBrowser } from './stubBrowser.js';

const TASK =
  'Publish answer.md and export.bin as requested outputs, and capture one source screenshot as evidence.';
const ANSWER = Buffer.from(
  '# Audit answer\n\nThe source export and screenshot were captured.\n',
  'utf8',
);
const SCREENSHOT = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);
const DOWNLOAD = Buffer.from([0, 255, 3, 4, 5, 0]);
const SOURCE_URL = 'https://source.example.test/report';
const REQUESTED_DOWNLOAD_URL = 'https://files.example.test/request.bin';
const FINAL_DOWNLOAD_URL = 'https://files.example.test/export.bin';

let runsBaseDir: string;

beforeEach(() => {
  runsBaseDir = mkdtempSync(join(tmpdir(), 'sherlock-tui-grader-'));
});

afterEach(() => {
  rmSync(runsBaseDir, { recursive: true, force: true });
});

const initializerCallModel: CallModel = async () => ({
  content: [
    {
      type: 'tool_use',
      id: 'contract-vertical',
      name: 'set_output_contract',
      input: {
        contract: {
          outputs: [
            {
              id: 'answer',
              kind: 'document',
              filename: 'answer.md',
              format: 'markdown',
              evidenceRequirement: 'at_least_one',
              evidencePresentation: 'hidden',
            },
            {
              id: 'export',
              kind: 'download',
              count: { exact: 1 },
              filenamePattern: 'export.bin',
              allowedMediaTypes: ['application/octet-stream'],
              sourceUrlPattern: 'https://files.example.test/*',
            },
          ],
        },
      },
    },
  ],
  stop_reason: 'tool_use',
  usage: { input_tokens: 100, output_tokens: 20 },
});

const verifierCallModel: CallModel = async () => verifiedResponse();

function verifiedResponse(): ModelResponse {
  return {
    content: [
      {
        type: 'tool_use',
        id: 'verification-vertical',
        name: 'report_verification',
        input: { status: 'verified', findings: [] },
      },
    ],
    stop_reason: 'tool_use',
    usage: { input_tokens: 10, output_tokens: 2 },
  };
}

function publicationResponse() {
  return scriptedResponse(
    [
      { type: 'text', text: 'Publishing the durable evidence package.' },
      {
        type: 'tool_use',
        id: 'publish-answer',
        name: 'publish_artifact',
        input: {
          kind: 'text',
          artifact_path: 'artifacts/answer.md',
          roles: ['requested_output'],
          content: ANSWER.toString('utf8'),
        },
      },
      {
        type: 'tool_use',
        id: 'publish-screenshot',
        name: 'publish_artifact',
        input: {
          kind: 'screenshot',
          artifact_path: 'artifacts/source.png',
          roles: ['evidence'],
        },
      },
      {
        type: 'tool_use',
        id: 'publish-download',
        name: 'publish_artifact',
        input: {
          kind: 'download',
          artifact_path: 'artifacts/export.bin',
          roles: ['requested_output', 'evidence'],
          url: REQUESTED_DOWNLOAD_URL,
        },
      },
    ],
    { input: 1_000, output: 200, cacheRead: 400 },
    'tool_use',
  );
}

function finishResponse() {
  return scriptedResponse(
    [
      {
        type: 'tool_use',
        id: 'finish-vertical',
        name: 'finish',
        input: {
          summary: 'Published the answer, source screenshot, and exact export.',
          unresolved: [],
        },
      },
    ],
    { input: 1_200, output: 100 },
    'tool_use',
  );
}

function eventIndex(
  events: readonly UiEvent[],
  predicate: (event: UiEvent) => boolean,
  after = -1,
): number {
  const index = events.findIndex(
    (event, candidate) => candidate > after && predicate(event),
  );
  expect(index).toBeGreaterThan(after);
  return index;
}

describe('Sherlock TUI-to-grader acceptance', () => {
  it('carries ordered UI publications through manifest selection into a transcript-free grader', async () => {
    const browser = stubBrowser();
    vi.mocked(browser.currentUrl).mockReturnValue(SOURCE_URL);
    vi.mocked(browser.screenshot).mockResolvedValue(SCREENSHOT);
    vi.mocked(browser.download).mockResolvedValue({
      finalUrl: FINAL_DOWNLOAD_URL,
      status: 200,
      headers: { 'content-type': 'application/octet-stream' },
      bytes: DOWNLOAD,
      suggestedFilename: 'export.bin',
    });
    const streams = scriptedStreamFactory([
      publicationResponse(),
      finishResponse(),
    ]);
    const events: UiEvent[] = [];

    const outcome = await startRun(TASK, {
      browser,
      runsBaseDir,
      harness: { initializerCallModel, verifierCallModel },
      createStream: streams.createStream,
      onEvent: (event) => events.push(event),
      now: () => 42,
    }).done;

    expect(outcome).toMatchObject({ status: 'verified' });
    if (outcome.status !== 'verified') throw new Error('unreachable');
    expect(browser.screenshot).toHaveBeenCalledWith({ fullPage: false });
    expect(browser.download).toHaveBeenCalledWith({
      url: REQUESTED_DOWNLOAD_URL,
    });

    let cursor = eventIndex(events, (event) => event.type === 'run_started');
    cursor = eventIndex(events, (event) => event.type === 'run_dir', cursor);
    cursor = eventIndex(
      events,
      (event) => event.type === 'turn_start' && event.turn === 1,
      cursor,
    );
    for (const name of [
      'publish_artifact',
      'publish_artifact',
      'publish_artifact',
    ]) {
      cursor = eventIndex(
        events,
        (event) => event.type === 'tool_pending' && event.name === name,
        cursor,
      );
    }
    cursor = eventIndex(events, (event) => event.type === 'turn_end', cursor);

    const publishedEvents: Extract<UiEvent, { type: 'artifact_published' }>[] = [];
    for (const filename of [
      'artifacts/answer.md',
      'artifacts/source.png',
      'artifacts/export.bin',
    ]) {
      const started = eventIndex(
        events,
        (event) =>
          event.type === 'tool_exec_start' &&
          event.name === 'publish_artifact',
        cursor,
      );
      const published = eventIndex(
        events,
        (event) =>
          event.type === 'artifact_published' &&
          event.entry.filename === filename,
        started,
      );
      const publishedEvent = events[published];
      if (publishedEvent?.type !== 'artifact_published') {
        throw new Error(`missing publication event for ${filename}`);
      }
      publishedEvents.push(publishedEvent);
      cursor = eventIndex(
        events,
        (event) =>
          event.type === 'tool_exec_end' && event.id === publishedEvent.toolExecId,
        published,
      );
    }
    cursor = eventIndex(
      events,
      (event) => event.type === 'turn_start' && event.turn === 2,
      cursor,
    );
    cursor = eventIndex(
      events,
      (event) => event.type === 'tool_pending' && event.name === 'finish',
      cursor,
    );
    cursor = eventIndex(events, (event) => event.type === 'turn_end', cursor);
    eventIndex(
      events,
      (event) =>
        event.type === 'run_finished' && event.outcome === 'verified',
      cursor,
    );

    const manifest = readManifest(outcome.runDir);
    expect(verifyManifestHashes(outcome.runDir, manifest)).toMatchObject({
      passed: true,
    });
    expect(requestedOutputs(manifest).map((entry) => entry.filename)).toEqual([
      'artifacts/answer.md',
      'artifacts/export.bin',
    ]);
    expect(
      events
        .filter((event) => event.type === 'artifact_published')
        .map((event) => event.entry.filename),
    ).toEqual([
      'artifacts/answer.md',
      'artifacts/source.png',
      'artifacts/export.bin',
    ]);

    const expected = new Map<
      string,
      {
        bytes: Buffer;
        roles: readonly string[];
        sourceUrl: string | undefined;
      }
    >([
      [
        'artifacts/answer.md',
        { bytes: ANSWER, roles: ['requested_output'], sourceUrl: undefined },
      ],
      [
        'artifacts/source.png',
        { bytes: SCREENSHOT, roles: ['evidence'], sourceUrl: SOURCE_URL },
      ],
      [
        'artifacts/export.bin',
        {
          bytes: DOWNLOAD,
          roles: ['requested_output', 'evidence'],
          sourceUrl: FINAL_DOWNLOAD_URL,
        },
      ],
    ]);
    for (const event of publishedEvents) {
      const wanted = expected.get(event.entry.filename);
      expect(wanted, event.entry.filename).toBeDefined();
      const bytes = readFileSync(join(outcome.runDir, event.entry.filename));
      expect(bytes).toEqual(wanted!.bytes);
      expect(event.sizeBytes).toBe(wanted!.bytes.length);
      expect(event.entry.sha256).toBe(sha256Hex(wanted!.bytes));
      expect(event.entry.roles).toEqual(wanted!.roles);
      expect(event.entry.sourceUrl).toBe(wanted!.sourceUrl);
      expect(manifest.artifacts).toContainEqual(event.entry);
    }

    const state = events.reduce(
      (current, event) => reduce(current, event as StoreAction),
      createInitialState(),
    );
    expect(state.transcript.at(-2)).toMatchObject({
      kind: 'activity',
      line: 'Submitting for verification',
      status: 'ok',
    });
    expect(state.transcript.at(-1)).toMatchObject({ kind: 'completion' });
    expect(events.at(-1)).toMatchObject({
      type: 'run_finished',
      outcome: 'verified',
    });

    // The grader contract receives only (runDir, oracleData). Removing the
    // transcript makes accidental transcript dependence fail this journey.
    rmSync(join(outcome.runDir, TRANSCRIPT_FILENAME), { force: true });
    const oracleData = await fetchOracle();
    expect(requestedOutputs(manifest).map((entry) => entry.filename)).toContain(
      oracleData.expectedFile,
    );
    const assertions = await grade(outcome.runDir, oracleData);
    expect(assertions).toHaveLength(2);
    expect(assertions.every((assertion) => assertion.passed)).toBe(true);
  });
});
