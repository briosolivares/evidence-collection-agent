import { Buffer } from 'node:buffer';
import { join } from 'node:path';

import { writeFileDurablyAtomic } from '../run/atomicFile.js';
import { readFileNoFollow } from '../run/noFollowFile.js';

export const STEERING_JOURNAL_PATH = 'harness/steering.json';
export const MAX_STEERING_MESSAGE_BYTES = 64 * 1024;

const STEERING_JOURNAL_VERSION = 1;
const STEERING_JOURNAL_MAX_BYTES = 64 * 1024 * 1024;
const STEERING_JOURNAL_MAX_ACTIONS = 1_000;
const HARNESS_FILE_MODE = 0o600;

type PendingSteeringAction = { kind: 'interrupt' } | { kind: 'message'; text: string };

type SteeringAction = PendingSteeringAction & { id: number };

interface SteeringJournal {
  version: typeof STEERING_JOURNAL_VERSION;
  actions: SteeringAction[];
}

export interface SteeringMessage {
  id: number;
  text: string;
}

export interface SteeringModelCall {
  signal: AbortSignal;
  interrupted(): boolean;
  close(): void;
}

export interface SteeringWorkerTurn extends SteeringModelCall {
  messages: readonly SteeringMessage[];
}

/**
 * One run's durable user-control mailbox. Producer calls are synchronous so
 * Enter/Esc are journaled before control returns to Ink. The worker consumes
 * actions only at a model boundary; its checkpoint records consumedCursor,
 * making a crash before that save replay the message and a crash after it
 * skip it exactly once.
 */
export class RunSteeringMailbox {
  private readonly beforeBind: PendingSteeringAction[] = [];
  private readonly waiters = new Set<() => void>();
  private actions: SteeringAction[] = [];
  private runDir: string | undefined;
  private nextId = 1;
  private consumed = 0;
  private activeCall: AbortController | undefined;
  private sealed = false;

  bindRunDir(runDir: string): void {
    if (this.runDir !== undefined) {
      if (this.runDir !== runDir)
        throw new Error('steering mailbox is already bound to another run');
      return;
    }
    this.runDir = runDir;
    this.actions = readJournal(runDir).actions;
    this.nextId = (this.actions.at(-1)?.id ?? 0) + 1;
    if (this.beforeBind.length > 0) {
      for (const pending of this.beforeBind) {
        this.actions.push({ id: this.nextId, ...pending });
        this.nextId += 1;
      }
      this.beforeBind.length = 0;
      this.persist();
    }
    this.notify();
  }

  restoreConsumedCursor(cursor: number): void {
    if (!Number.isSafeInteger(cursor) || cursor < 0) {
      throw new Error(`invalid steering cursor ${cursor}`);
    }
    const lastId = this.actions.at(-1)?.id ?? 0;
    if (cursor > lastId) {
      throw new Error(
        `steering checkpoint cursor ${cursor} exceeds journal cursor ${lastId}; ` +
          'the durable steering journal is missing or truncated',
      );
    }
    this.consumed = cursor;
  }

  consumedCursor(): number {
    return this.consumed;
  }

  hasUnconsumedActions(): boolean {
    return (this.actions.at(-1)?.id ?? 0) > this.consumed;
  }

  steer(text: string): void {
    const trimmed = text.trim();
    if (trimmed === '') return;
    const bytes = Buffer.byteLength(trimmed, 'utf8');
    if (bytes > MAX_STEERING_MESSAGE_BYTES) {
      throw new Error(
        `steering message is ${bytes} bytes; maximum is ${MAX_STEERING_MESSAGE_BYTES}`,
      );
    }
    this.append({ kind: 'message', text: trimmed });
  }

  interrupt(): void {
    this.append({ kind: 'interrupt' });
  }

  /** Stop accepting user input once terminalization has synchronously won. */
  seal(): void {
    this.sealed = true;
    this.notify();
  }

  /**
   * Wait through a bare Esc pause, consume every action through the latest
   * resume message, and install the per-model-call interrupt signal without
   * a race between draining the mailbox and registering the call.
   */
  async beginWorkerTurn(parentSignal: AbortSignal): Promise<SteeringWorkerTurn> {
    for (;;) {
      parentSignal.throwIfAborted();
      const pending = this.actions.filter((action) => action.id > this.consumed);
      let paused = false;
      let cursor = this.consumed;
      const messages: SteeringMessage[] = [];
      for (const action of pending) {
        cursor = action.id;
        if (action.kind === 'interrupt') {
          paused = true;
        } else {
          paused = false;
          messages.push({ id: action.id, text: action.text });
        }
      }
      if (!paused) {
        this.consumed = cursor;
        return { messages, ...this.openModelCall(parentSignal) };
      }
      await this.waitForAction(parentSignal);
    }
  }

  /** Interrupt a read-only verifier call without consuming queued messages. */
  beginInterruptibleCall(parentSignal: AbortSignal): SteeringModelCall {
    return this.openModelCall(parentSignal);
  }

  private append(action: PendingSteeringAction): void {
    if (this.sealed) throw new Error('the run is already finishing');
    if (this.actions.length + this.beforeBind.length >= STEERING_JOURNAL_MAX_ACTIONS) {
      throw new Error(`a run accepts at most ${STEERING_JOURNAL_MAX_ACTIONS} steering actions`);
    }
    if (this.runDir === undefined) {
      this.beforeBind.push(action);
    } else {
      this.actions.push({ id: this.nextId, ...action });
      this.nextId += 1;
      this.persist();
    }
    this.activeCall?.abort(new Error('model call interrupted by user steering'));
    this.notify();
  }

  private openModelCall(parentSignal: AbortSignal): SteeringModelCall {
    parentSignal.throwIfAborted();
    if (this.activeCall !== undefined) throw new Error('a steering model call is already active');
    const local = new AbortController();
    this.activeCall = local;
    const signal = AbortSignal.any([parentSignal, local.signal]);
    return {
      signal,
      interrupted: () => local.signal.aborted && !parentSignal.aborted,
      close: () => {
        if (this.activeCall === local) this.activeCall = undefined;
      },
    };
  }

  private waitForAction(signal: AbortSignal): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const finish = (): void => {
        signal.removeEventListener('abort', onAbort);
        this.waiters.delete(onAction);
      };
      const onAction = (): void => {
        finish();
        resolve();
      };
      const onAbort = (): void => {
        finish();
        reject(signal.reason);
      };
      if (signal.aborted) {
        onAbort();
        return;
      }
      this.waiters.add(onAction);
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  private notify(): void {
    for (const waiter of [...this.waiters]) waiter();
  }

  private persist(): void {
    const runDir = this.runDir;
    if (runDir === undefined) return;
    const journal: SteeringJournal = {
      version: STEERING_JOURNAL_VERSION,
      actions: this.actions,
    };
    writeFileDurablyAtomic(
      join(runDir, STEERING_JOURNAL_PATH),
      `${JSON.stringify(journal, null, 2)}\n`,
      { fileMode: HARNESS_FILE_MODE },
    );
  }
}

function readJournal(runDir: string): SteeringJournal {
  const path = join(runDir, STEERING_JOURNAL_PATH);
  let bytes: Buffer;
  try {
    bytes = readFileNoFollow(path, {
      maxBytes: STEERING_JOURNAL_MAX_BYTES,
      expectedMode: HARNESS_FILE_MODE,
      stableSize: true,
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { version: STEERING_JOURNAL_VERSION, actions: [] };
    }
    throw error;
  }
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    throw new Error(`invalid steering journal JSON: ${String(error)}`);
  }
  if (!isRecord(value) || value.version !== STEERING_JOURNAL_VERSION) {
    throw new Error('invalid steering journal version');
  }
  if (!Array.isArray(value.actions) || value.actions.length > STEERING_JOURNAL_MAX_ACTIONS) {
    throw new Error('invalid steering journal actions');
  }
  const actions: SteeringAction[] = [];
  for (const [index, action] of value.actions.entries()) {
    if (!isRecord(action) || action.id !== index + 1) {
      throw new Error('steering journal action ids must be contiguous from one');
    }
    if (action.kind === 'interrupt') {
      actions.push({ id: action.id, kind: 'interrupt' });
      continue;
    }
    if (
      action.kind !== 'message' ||
      typeof action.text !== 'string' ||
      action.text.trim() === '' ||
      Buffer.byteLength(action.text, 'utf8') > MAX_STEERING_MESSAGE_BYTES
    ) {
      throw new Error(`invalid steering journal message at action ${action.id}`);
    }
    actions.push({ id: action.id, kind: 'message', text: action.text });
  }
  return { version: STEERING_JOURNAL_VERSION, actions };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
