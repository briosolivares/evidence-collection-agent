import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { RunSteeringMailbox, STEERING_JOURNAL_PATH } from '../../src/agent/steering.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function runDir(): string {
  const root = mkdtempSync(join(tmpdir(), 'sherlock-steering-'));
  roots.push(root);
  const harness = join(root, 'harness');
  mkdirSync(harness, { mode: 0o700 });
  chmodSync(harness, 0o700);
  return root;
}

describe('RunSteeringMailbox', () => {
  it('durably journals a message, interrupts the active model call, and replays by cursor', async () => {
    const root = runDir();
    const mailbox = new RunSteeringMailbox();
    mailbox.bindRunDir(root);
    mailbox.restoreConsumedCursor(0);
    const parent = new AbortController();

    const first = await mailbox.beginWorkerTurn(parent.signal);
    expect(first.messages).toEqual([]);
    mailbox.steer('Only use filings from 2025.');
    expect(first.signal.aborted).toBe(true);
    expect(first.interrupted()).toBe(true);
    first.close();

    const second = await mailbox.beginWorkerTurn(parent.signal);
    expect(second.messages).toEqual([{ id: 1, text: 'Only use filings from 2025.' }]);
    expect(mailbox.consumedCursor()).toBe(1);
    second.close();

    const journal = JSON.parse(readFileSync(join(root, STEERING_JOURNAL_PATH), 'utf8'));
    expect(journal.actions).toEqual([
      { id: 1, kind: 'message', text: 'Only use filings from 2025.' },
    ]);

    const replay = new RunSteeringMailbox();
    replay.bindRunDir(root);
    replay.restoreConsumedCursor(0);
    const replayed = await replay.beginWorkerTurn(parent.signal);
    expect(replayed.messages).toEqual([{ id: 1, text: 'Only use filings from 2025.' }]);
    replayed.close();

    const consumed = new RunSteeringMailbox();
    consumed.bindRunDir(root);
    consumed.restoreConsumedCursor(1);
    const empty = await consumed.beginWorkerTurn(parent.signal);
    expect(empty.messages).toEqual([]);
    empty.close();
  });

  it('holds a bare interrupt until a later message resumes the worker', async () => {
    const root = runDir();
    const mailbox = new RunSteeringMailbox();
    mailbox.bindRunDir(root);
    mailbox.restoreConsumedCursor(0);
    mailbox.interrupt();

    let settled = false;
    const waiting = mailbox.beginWorkerTurn(new AbortController().signal).then((turn) => {
      settled = true;
      return turn;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);

    mailbox.steer('Continue, but use the signed copy.');
    const resumed = await waiting;
    expect(resumed.messages).toEqual([{ id: 2, text: 'Continue, but use the signed copy.' }]);
    expect(mailbox.consumedCursor()).toBe(2);
    resumed.close();
  });

  it('fails closed when a checkpoint cursor is ahead of the journal', () => {
    const mailbox = new RunSteeringMailbox();
    mailbox.bindRunDir(runDir());
    expect(() => mailbox.restoreConsumedCursor(1)).toThrow('missing or truncated');
  });
});
