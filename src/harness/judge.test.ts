import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { CallModel, Message, ModelResponse, Usage } from '../loop/messages.js';
import { JUDGE_MAX_TURNS, JUDGE_MODEL, runJudge } from './judge.js';

// Every test drives the judge with a scripted fake callModel — zero real API
// calls anywhere in this file (hermetic-suite convention, matching
// agentLoop.test.ts and initializer.test.ts).

const TASK = 'Collect the widgets and report on them.';
const INTENT = 'Goal: collect every widget from the source and report its status.\nNo non-goals stated.';
const CONTRACT =
  'Criterion 1: artifacts/report.md exists and lists one row per widget.\n' +
  'Proof: read artifacts/report.md and count rows against the roster.';
const MANIFEST_JSON = JSON.stringify(
  { task: TASK, startedAt: '2026-08-13T00:00:00.000Z', artifacts: [] },
  null,
  2,
);

/** Default per-response usage: 15 tokens per turn (10 in + 5 out). */
const DEFAULT_USAGE: Usage = { input_tokens: 10, output_tokens: 5 };

/** A terminal response: text only, no tool_use. */
function textResponse(text: string): ModelResponse {
  return { content: [{ type: 'text', text }], stop_reason: 'end_turn', usage: { ...DEFAULT_USAGE } };
}

/** A continuing response: one tool_use block per requested call. */
function toolResponse(calls: Array<{ id: string; name: string; input: unknown }>): ModelResponse {
  return {
    content: calls.map((call) => ({ type: 'tool_use' as const, ...call })),
    stop_reason: 'tool_use',
    usage: { ...DEFAULT_USAGE },
  };
}

/**
 * A scripted CallModel: serves the given responses in order, snapshotting
 * the messages of each request into `requests`. Calling it more times than
 * scripted throws — a mini-loop that fails to stop fails its test loudly.
 */
function scriptModel(responses: ModelResponse[]): { callModel: CallModel; requests: Message[][] } {
  const requests: Message[][] = [];
  const callModel: CallModel = async (messages) => {
    requests.push(structuredClone(messages) as Message[]);
    const next = responses[requests.length - 1];
    if (next === undefined) {
      throw new Error(
        `fake model called ${requests.length} times but only ${responses.length} responses scripted`,
      );
    }
    return next;
  };
  return { callModel, requests };
}

/** A CallModel that fails the test if invoked at all — for asserting a
 * throw happens before any model call (e.g. a missing governing document). */
function unusedCallModel(): CallModel {
  return async () => {
    throw new Error('callModel should not have been invoked');
  };
}

let runDir: string;

/** Write the standard fixture (INTENT.md, CONTRACT.md, manifest.json, and
 * two artifacts/ files) into a fresh run directory. */
function writeFixture(dir: string): void {
  writeFileSync(join(dir, 'INTENT.md'), `${INTENT}\n`, 'utf8');
  writeFileSync(join(dir, 'CONTRACT.md'), `${CONTRACT}\n`, 'utf8');
  writeFileSync(join(dir, 'manifest.json'), `${MANIFEST_JSON}\n`, 'utf8');
  mkdirSync(join(dir, 'artifacts'), { recursive: true });
  writeFileSync(join(dir, 'artifacts', 'report.md'), 'widget-1: ok\nwidget-2: ok\n', 'utf8');
  writeFileSync(join(dir, 'artifacts', 'notes.txt'), 'scratchy notes', 'utf8');
}

beforeEach(() => {
  runDir = mkdtempSync(join(tmpdir(), 'judge-test-'));
  writeFixture(runDir);
});

afterEach(() => {
  rmSync(runDir, { recursive: true, force: true });
});

describe('constants', () => {
  it('pins the judge model id and turn cap', () => {
    expect(JUDGE_MODEL).toBe('claude-haiku-4-5-20251001');
    expect(JUDGE_MAX_TURNS).toBe(8);
  });
});

describe('runJudge', () => {
  it('an immediate DONE final response yields a done verdict', async () => {
    const { callModel, requests } = scriptModel([textResponse('DONE')]);
    const result = await runJudge({ taskText: TASK, runDir, callModel });

    expect(result).toEqual({ verdict: 'done', reason: '' });
    expect(requests).toHaveLength(1);
    // The opening message carries the task, both documents, the manifest,
    // and the artifact listing — everything the judge needs without asking.
    const opening = requests[0]![0]!;
    expect(opening.role).toBe('user');
    const openingText = (opening.content[0] as { text: string }).text;
    expect(openingText).toContain(TASK);
    expect(openingText).toContain(INTENT);
    expect(openingText).toContain(CONTRACT);
    expect(openingText).toContain(MANIFEST_JSON);
    expect(openingText).toContain('artifacts/report.md');
    expect(openingText).toContain('artifacts/notes.txt');
  });

  it('reads an artifact via read_file, then returns CONTINUE with the given reason', async () => {
    const { callModel, requests } = scriptModel([
      toolResponse([{ id: 't1', name: 'read_file', input: { file_path: 'artifacts/report.md' } }]),
      textResponse('CONTINUE: widget-3 is missing from the report.'),
    ]);
    const result = await runJudge({ taskText: TASK, runDir, callModel });

    expect(result).toEqual({ verdict: 'continue', reason: 'widget-3 is missing from the report.' });
    // The second request replays the tool_use and carries back the real
    // file's content — proof the judge reused the actual read_file executor,
    // not a mock.
    const secondRequestMessages = requests[1]!;
    const toolResultMessage = secondRequestMessages[secondRequestMessages.length - 1]!;
    expect(toolResultMessage.role).toBe('user');
    const toolResultBlock = toolResultMessage.content[0] as {
      type: string;
      tool_use_id: string;
      content: string;
      is_error?: boolean;
    };
    expect(toolResultBlock.type).toBe('tool_result');
    expect(toolResultBlock.tool_use_id).toBe('t1');
    expect(toolResultBlock.is_error).toBeUndefined();
    expect(toolResultBlock.content).toContain('widget-1: ok');
  });

  it('a multi-line CONTINUE reason joins the remainder of the first line with following lines', async () => {
    const { callModel } = scriptModel([textResponse('CONTINUE: missing rows\nalso check formatting')]);
    const result = await runJudge({ taskText: TASK, runDir, callModel });

    expect(result).toEqual({ verdict: 'continue', reason: 'missing rows\nalso check formatting' });
  });

  it('an unparseable final response yields the generic continue reason', async () => {
    const { callModel } = scriptModel([
      textResponse('I looked around and things seem mostly fine, hard to say.'),
    ]);
    const result = await runJudge({ taskText: TASK, runDir, callModel });

    expect(result).toEqual({ verdict: 'continue', reason: 'judge did not reach a parseable verdict' });
  });

  it('hitting the turn cap while the model keeps requesting tools yields the generic continue reason', async () => {
    const responses = Array.from({ length: JUDGE_MAX_TURNS }, (_, i) =>
      toolResponse([{ id: `t${i}`, name: 'grep', input: { pattern: 'widget' } }]),
    );
    const { callModel, requests } = scriptModel(responses);
    const result = await runJudge({ taskText: TASK, runDir, callModel });

    expect(result).toEqual({ verdict: 'continue', reason: 'judge did not reach a parseable verdict' });
    // Exactly JUDGE_MAX_TURNS calls — no call beyond the cap.
    expect(requests).toHaveLength(JUDGE_MAX_TURNS);
  });

  it('throws when CONTRACT.md is missing — a harness bug, not a worker-fixable condition', async () => {
    const bareDir = mkdtempSync(join(tmpdir(), 'judge-test-bare-'));
    try {
      writeFileSync(join(bareDir, 'INTENT.md'), `${INTENT}\n`, 'utf8');
      // CONTRACT.md deliberately absent.
      await expect(
        runJudge({ taskText: TASK, runDir: bareDir, callModel: unusedCallModel() }),
      ).rejects.toThrow(/CONTRACT\.md is missing/);
    } finally {
      rmSync(bareDir, { recursive: true, force: true });
    }
  });

  it('a disallowed tool (e.g. navigate) gets an is_error tool_result and the loop continues', async () => {
    const { callModel, requests } = scriptModel([
      toolResponse([{ id: 't1', name: 'navigate', input: { url: 'https://example.com' } }]),
      textResponse('DONE'),
    ]);
    const result = await runJudge({ taskText: TASK, runDir, callModel });

    expect(result).toEqual({ verdict: 'done', reason: '' });
    const secondRequestMessages = requests[1]!;
    const toolResultMessage = secondRequestMessages[secondRequestMessages.length - 1]!;
    const toolResultBlock = toolResultMessage.content[0] as {
      tool_use_id: string;
      content: string;
      is_error?: boolean;
    };
    expect(toolResultBlock.tool_use_id).toBe('t1');
    expect(toolResultBlock.is_error).toBe(true);
    expect(toolResultBlock.content).toContain('Unknown tool "navigate"');
    expect(toolResultBlock.content).toContain('read_file');
    expect(toolResultBlock.content).toContain('grep');
  });

  it('a bare CONTINUE with no reason text still parses as continue, with a placeholder reason', async () => {
    const { callModel } = scriptModel([textResponse('CONTINUE')]);
    const result = await runJudge({ taskText: TASK, runDir, callModel });

    expect(result.verdict).toBe('continue');
    expect(result.reason.length).toBeGreaterThan(0);
  });
});
