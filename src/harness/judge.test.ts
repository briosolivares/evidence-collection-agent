import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { CallModel, ImageBlock, Message, ModelResponse, TextBlock, Usage } from '../loop/messages.js';
import {
  JUDGE_MAX_CONTEXT_TOKENS,
  JUDGE_MAX_IMAGE_BYTES,
  JUDGE_MAX_IMAGE_DIMENSION_PX,
  JUDGE_MODEL,
  runJudge,
} from './judge.js';

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
  it('pins the judge model id and context guard', () => {
    expect(JUDGE_MODEL).toBe('claude-haiku-4-5-20251001');
    expect(JUDGE_MAX_CONTEXT_TOKENS).toBe(150_000);
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

  it('an unparseable final response gets one corrective re-ask, then parses the retry', async () => {
    const { callModel, requests } = scriptModel([
      textResponse('I looked around and things seem mostly fine, hard to say.'),
      textResponse('CONTINUE: the report is missing widget-3.'),
    ]);
    const result = await runJudge({ taskText: TASK, runDir, callModel });

    expect(result).toEqual({ verdict: 'continue', reason: 'the report is missing widget-3.' });
    expect(requests).toHaveLength(2);
    // The corrective message names the problem and re-demands the format.
    const secondRequest = requests[1]!;
    const corrective = secondRequest[secondRequest.length - 1]!;
    expect(corrective.role).toBe('user');
    expect((corrective.content[0] as { text: string }).text).toContain('not a valid verdict');
  });

  it('a second unparseable response yields the generic continue reason', async () => {
    const { callModel, requests } = scriptModel([
      textResponse('I looked around and things seem mostly fine, hard to say.'),
      textResponse('Well, on reflection, the artifacts are broadly reasonable.'),
    ]);
    const result = await runJudge({ taskText: TASK, runDir, callModel });

    expect(result).toEqual({ verdict: 'continue', reason: 'judge did not reach a parseable verdict' });
    expect(requests).toHaveLength(2);
  });

  it('turns are uncapped below the guard: a long investigation still reaches its own verdict', async () => {
    // 30 tool turns — nearly double the old fixed cap — under the context
    // guard, then a real verdict from the model itself (no forced call).
    const responses = Array.from({ length: 30 }, (_, i) =>
      toolResponse([{ id: `t${i}`, name: 'grep', input: { pattern: 'widget' } }]),
    );
    responses.push(textResponse('DONE'));
    const { callModel, requests } = scriptModel(responses);
    const result = await runJudge({ taskText: TASK, runDir, callModel });

    expect(result).toEqual({ verdict: 'done', reason: '' });
    expect(requests).toHaveLength(31);
  });

  it('tripping the context guard triggers one forced-verdict call that closes dangling tool calls', async () => {
    const overBudget = {
      input_tokens: JUDGE_MAX_CONTEXT_TOKENS,
      output_tokens: 1,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    };
    const responses = [
      toolResponse([{ id: 't0', name: 'grep', input: { pattern: 'widget' } }]),
      // Second investigative response overruns the guard while still
      // requesting tools — its calls must not execute.
      {
        ...toolResponse([{ id: 't1', name: 'grep', input: { pattern: 'widget' } }]),
        usage: overBudget,
      },
      // The forced-verdict call answers with a real verdict.
      textResponse('CONTINUE: could not finish verifying widget counts.'),
    ];
    const { callModel, requests } = scriptModel(responses);
    const result = await runJudge({ taskText: TASK, runDir, callModel });

    expect(result).toEqual({
      verdict: 'continue',
      reason: 'could not finish verifying widget counts.',
    });
    // Two investigative calls plus exactly one forced-verdict call.
    expect(requests).toHaveLength(3);
    // The forced message closes the guard-tripping turn's dangling tool_use
    // with an is_error result (the API requires every tool_use answered)
    // and then demands the verdict as a text block.
    const forcedRequest = requests[2]!;
    const forcedMessage = forcedRequest[forcedRequest.length - 1]!;
    expect(forcedMessage.role).toBe('user');
    const [closing, demand] = forcedMessage.content as unknown as Array<Record<string, unknown>>;
    expect(closing).toMatchObject({
      type: 'tool_result',
      tool_use_id: 't1',
      is_error: true,
    });
    expect(demand).toMatchObject({ type: 'text' });
    expect(String((demand as { text: string }).text)).toContain('final verdict');
  });

  it('a verdict whose own turn overruns the guard is still returned — answer in hand', async () => {
    const { callModel } = scriptModel([
      {
        ...textResponse('DONE'),
        usage: {
          input_tokens: JUDGE_MAX_CONTEXT_TOKENS + 1,
          output_tokens: 1,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
      },
    ]);
    const result = await runJudge({ taskText: TASK, runDir, callModel });

    expect(result).toEqual({ verdict: 'done', reason: '' });
  });

  it('a forced-verdict response that still requests tools yields the generic continue reason', async () => {
    const responses = [
      {
        ...toolResponse([{ id: 't0', name: 'grep', input: { pattern: 'widget' } }]),
        usage: {
          input_tokens: JUDGE_MAX_CONTEXT_TOKENS,
          output_tokens: 1,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
      },
      toolResponse([{ id: 'tx', name: 'grep', input: { pattern: 'more' } }]),
    ];
    const { callModel, requests } = scriptModel(responses);
    const result = await runJudge({ taskText: TASK, runDir, callModel });

    expect(result).toEqual({ verdict: 'continue', reason: 'judge did not reach a parseable verdict' });
    expect(requests).toHaveLength(2);
  });

  it('accepts a verdict on the last line when the model narrates a summary first', async () => {
    const { callModel } = scriptModel([
      textResponse(
        'Based on my investigation, I found an inconsistency:\n' +
          '1. The notes contradict the audit trail.\n\n' +
          'CONTINUE: the two scratch notes disagree about reference 275; re-verify and republish.',
      ),
    ]);
    const result = await runJudge({ taskText: TASK, runDir, callModel });

    expect(result).toEqual({
      verdict: 'continue',
      reason: 'the two scratch notes disagree about reference 275; re-verify and republish.',
    });
  });

  it('parses cosmetically wrapped verdicts: markdown emphasis and a Verdict: prefix', async () => {
    for (const [text, expected] of [
      ['**DONE**', { verdict: 'done', reason: '' }],
      ['Verdict: DONE.', { verdict: 'done', reason: '' }],
      ['# CONTINUE: fix the header row', { verdict: 'continue', reason: 'fix the header row' }],
    ] as const) {
      const { callModel } = scriptModel([textResponse(text)]);
      const result = await runJudge({ taskText: TASK, runDir, callModel });
      expect(result, `for final text ${JSON.stringify(text)}`).toEqual(expected);
    }
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

describe('evidence scope (v2 diet)', () => {
  /** Run one scripted tool call through the judge and return its
   * tool_result block from the follow-up request. */
  async function resultOfCall(call: {
    id: string;
    name: string;
    input: unknown;
  }): Promise<{ tool_use_id: string; content: string; is_error?: boolean }> {
    const { callModel, requests } = scriptModel([toolResponse([call]), textResponse('DONE')]);
    await runJudge({ taskText: TASK, runDir, callModel });
    const followUp = requests[1]!;
    const toolResultMessage = followUp[followUp.length - 1]!;
    return toolResultMessage.content[0] as {
      tool_use_id: string;
      content: string;
      is_error?: boolean;
    };
  }

  it('a read_file into scratch/ returns a steering error naming the boundary, without executing', async () => {
    mkdirSync(join(runDir, 'scratch'), { recursive: true });
    writeFileSync(join(runDir, 'scratch', 'notes.md'), 'worker claims widget-3 is fine', 'utf8');

    const block = await resultOfCall({
      id: 't1',
      name: 'read_file',
      input: { file_path: 'scratch/notes.md' },
    });
    expect(block.is_error).toBe(true);
    expect(block.content).toContain('evidence scope');
    expect(block.content).toContain('artifacts/');
    // The steering error must not leak the file's content.
    expect(block.content).not.toContain('widget-3 is fine');
  });

  it('root bookkeeping files (transcript, metrics) are off-diet even though they are in the run dir', async () => {
    writeFileSync(join(runDir, 'transcript.jsonl'), '{"type":"turn_start"}\n', 'utf8');

    const block = await resultOfCall({
      id: 't1',
      name: 'read_file',
      input: { file_path: 'transcript.jsonl' },
    });
    expect(block.is_error).toBe(true);
    expect(block.content).toContain('evidence scope');
  });

  it('a traversal that resolves outside artifacts/ is caught on the resolved path', async () => {
    mkdirSync(join(runDir, 'scratch'), { recursive: true });
    writeFileSync(join(runDir, 'scratch', 'leak.txt'), 'secret', 'utf8');

    const block = await resultOfCall({
      id: 't1',
      name: 'read_file',
      input: { file_path: 'artifacts/../scratch/leak.txt' },
    });
    expect(block.is_error).toBe(true);
    expect(block.content).toContain('evidence scope');
  });

  it('the governing root files and artifacts/ remain readable', async () => {
    for (const filePath of ['INTENT.md', 'CONTRACT.md', 'manifest.json', 'artifacts/report.md']) {
      const block = await resultOfCall({ id: 't1', name: 'read_file', input: { file_path: filePath } });
      expect(block.is_error, `for ${filePath}`).toBeUndefined();
      expect(block.content.length, `for ${filePath}`).toBeGreaterThan(0);
    }
  });

  it('grep with an explicit scratch/ path returns the steering error', async () => {
    mkdirSync(join(runDir, 'scratch'), { recursive: true });
    writeFileSync(join(runDir, 'scratch', 'leak.txt'), 'widget-9: ok', 'utf8');

    const block = await resultOfCall({
      id: 't1',
      name: 'grep',
      input: { pattern: 'widget', path: 'scratch' },
    });
    expect(block.is_error).toBe(true);
    expect(block.content).toContain('evidence scope');
  });

  it('grep with no path searches artifacts/ only — off-diet files never match', async () => {
    mkdirSync(join(runDir, 'scratch'), { recursive: true });
    writeFileSync(join(runDir, 'scratch', 'leak.txt'), 'widget-9: unpublished claim', 'utf8');

    const block = await resultOfCall({ id: 't1', name: 'grep', input: { pattern: 'widget' } });
    expect(block.is_error).toBeUndefined();
    expect(block.content).toContain('artifacts/report.md');
    expect(block.content).not.toContain('scratch/');
    expect(block.content).not.toContain('unpublished claim');
  });

  it('grep with an explicit root governing file path still works', async () => {
    const block = await resultOfCall({
      id: 't1',
      name: 'grep',
      input: { pattern: 'widget', path: 'CONTRACT.md' },
    });
    expect(block.is_error).toBeUndefined();
    expect(block.content).toContain('CONTRACT.md');
  });
});

describe('screenshot vision (v2)', () => {
  /** Minimal PNG: real signature + IHDR header carrying the given
   * dimensions (only the header is parsed — pixel data is never decoded). */
  function pngBytes(width: number, height: number): Buffer {
    const header = Buffer.alloc(24);
    Buffer.from('89504e470d0a1a0a', 'hex').copy(header, 0);
    header.writeUInt32BE(13, 8); // IHDR data length
    header.write('IHDR', 12, 'latin1');
    header.writeUInt32BE(width, 16);
    header.writeUInt32BE(height, 20);
    return Buffer.concat([header, Buffer.from('fakepixels')]);
  }

  /** Minimal JPEG: SOI + one SOF0 segment carrying the given dimensions. */
  function jpegBytes(width: number, height: number): Buffer {
    const bytes = Buffer.alloc(20);
    bytes.writeUInt16BE(0xffd8, 0); // SOI
    bytes.writeUInt16BE(0xffc0, 2); // SOF0
    bytes.writeUInt16BE(11, 4); // segment length
    bytes[6] = 8; // precision
    bytes.writeUInt16BE(height, 7);
    bytes.writeUInt16BE(width, 9);
    return bytes;
  }

  const PNG_BYTES = pngBytes(1280, 720);

  /** Run one scripted read_file through the judge and return its
   * tool_result block from the follow-up request. */
  async function resultOfRead(filePath: string): Promise<{
    tool_use_id: string;
    content: string | Array<TextBlock | ImageBlock>;
    is_error?: boolean;
  }> {
    const { callModel, requests } = scriptModel([
      toolResponse([{ id: 't1', name: 'read_file', input: { file_path: filePath } }]),
      textResponse('DONE'),
    ]);
    await runJudge({ taskText: TASK, runDir, callModel });
    const followUp = requests[1]!;
    const toolResultMessage = followUp[followUp.length - 1]!;
    return toolResultMessage.content[0] as {
      tool_use_id: string;
      content: string | Array<TextBlock | ImageBlock>;
      is_error?: boolean;
    };
  }

  it('a read_file on a published .png returns the image as a base64 block, not UTF-8 text', async () => {
    writeFileSync(join(runDir, 'artifacts', 'shot.png'), PNG_BYTES);

    const block = await resultOfRead('artifacts/shot.png');
    expect(block.is_error).toBeUndefined();
    expect(Array.isArray(block.content)).toBe(true);
    const [label, image] = block.content as [TextBlock, ImageBlock];
    expect(label.type).toBe('text');
    expect(label.text).toContain('artifacts/shot.png');
    expect(image.type).toBe('image');
    expect(image.source.media_type).toBe('image/png');
    expect(Buffer.from(image.source.data, 'base64')).toEqual(PNG_BYTES);
  });

  it('.jpg and .jpeg map to image/jpeg', async () => {
    for (const name of ['shot.jpg', 'shot.jpeg']) {
      writeFileSync(join(runDir, 'artifacts', name), jpegBytes(1280, 720));
      const block = await resultOfRead(`artifacts/${name}`);
      const image = (block.content as Array<TextBlock | ImageBlock>)[1] as ImageBlock;
      expect(image.source.media_type, `for ${name}`).toBe('image/jpeg');
    }
  });

  it('an over-cap image returns a steering error instead of blowing the request', async () => {
    writeFileSync(join(runDir, 'artifacts', 'huge.png'), Buffer.alloc(JUDGE_MAX_IMAGE_BYTES + 1));

    const block = await resultOfRead('artifacts/huge.png');
    expect(block.is_error).toBe(true);
    expect(block.content).toContain('too large');
    expect(block.content).toContain('unverified');
  });

  it('an over-dimension image (a full-page capture) steers instead of 400-failing the request', async () => {
    // Well under the byte cap but taller than the API's 8000px limit — the
    // shape that killed every merged_prs validation trial.
    writeFileSync(join(runDir, 'artifacts', 'fullpage.png'), pngBytes(1280, JUDGE_MAX_IMAGE_DIMENSION_PX + 4000));

    const block = await resultOfRead('artifacts/fullpage.png');
    expect(block.is_error).toBe(true);
    expect(block.content).toContain('12000');
    expect(block.content).toContain('unverified');
  });

  it('an over-wide JPEG is caught the same way', async () => {
    writeFileSync(join(runDir, 'artifacts', 'wide.jpg'), jpegBytes(JUDGE_MAX_IMAGE_DIMENSION_PX + 1, 400));

    const block = await resultOfRead('artifacts/wide.jpg');
    expect(block.is_error).toBe(true);
    expect(block.content).toContain('too large');
  });

  it('an image at exactly the dimension limit is still viewed', async () => {
    writeFileSync(
      join(runDir, 'artifacts', 'edge.png'),
      pngBytes(1280, JUDGE_MAX_IMAGE_DIMENSION_PX),
    );

    const block = await resultOfRead('artifacts/edge.png');
    expect(block.is_error).toBeUndefined();
    expect(Array.isArray(block.content)).toBe(true);
  });

  it('bytes that do not parse as the claimed image type are refused, not sent to the API', async () => {
    writeFileSync(join(runDir, 'artifacts', 'fake.png'), Buffer.from('not actually a png'));

    const block = await resultOfRead('artifacts/fake.png');
    expect(block.is_error).toBe(true);
    expect(block.content).toContain('Not a readable');
  });

  it('an image outside artifacts/ is still off-diet — the scope guard wins', async () => {
    mkdirSync(join(runDir, 'scratch'), { recursive: true });
    writeFileSync(join(runDir, 'scratch', 'shot.png'), PNG_BYTES);

    const block = await resultOfRead('scratch/shot.png');
    expect(block.is_error).toBe(true);
    expect(block.content).toContain('evidence scope');
  });

  it('a missing image reads as the standard missing-file error', async () => {
    const block = await resultOfRead('artifacts/nope.png');
    expect(block.is_error).toBe(true);
    expect(block.content).toContain('File does not exist: artifacts/nope.png');
  });
});
