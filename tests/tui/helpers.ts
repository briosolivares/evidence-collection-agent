// Shared helpers for TUI component tests (ink-testing-library drives a
// fake stdin/stdout; state updates settle on the microtask/timer queue).

import { EventEmitter } from 'node:events';
import { render as inkRender } from 'ink';
import type { ReactElement } from 'react';

import type { OpenExternalResult } from '../../src/tui/openExternal.js';

/** Let queued React/Ink work settle before asserting on frames. */
export function tick(ms = 0): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** The terminal Enter key, as ink-text-input expects it on stdin. */
export const ENTER = '\r';

/** The Escape key. */
export const ESC = '\u001b';

/** Type text into a rendered component's stdin one write at a time. */
export async function typeText(
  stdin: { write: (data: string) => void },
  text: string,
): Promise<void> {
  for (const char of text) {
    stdin.write(char);
    await tick();
  }
}

/**
 * A width-controllable render harness (ink-testing-library fixes the
 * terminal at 100 columns; the rendering contract must hold on narrow
 * terminals too). Ink's debug mode writes complete frames.
 */
export function renderAt(width: number, tree: ReactElement) {
  const frames: string[] = [];
  const stdout = Object.assign(new EventEmitter(), {
    columns: width,
    rows: 40,
    isTTY: true,
    write: (data: string) => {
      frames.push(data);
      return true;
    },
  });
  // Mirrors ink-testing-library's Stdin: write buffers one chunk and
  // signals both readable-stream styles so Ink's useInput picks it up.
  let pending: string | null = null;
  const stdin = Object.assign(new EventEmitter(), {
    isTTY: true,
    setRawMode: () => {},
    setEncoding: () => {},
    read: () => {
      const data = pending;
      pending = null;
      return data;
    },
    unref: () => {},
    ref: () => {},
    resume: () => {},
    pause: () => {},
  });
  const instance = inkRender(tree, {
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    debug: true,
    exitOnCtrlC: false,
    patchConsole: false,
  });
  return {
    lastFrame: () => frames.at(-1) ?? '',
    stdin: {
      write: (data: string) => {
        pending = data;
        stdin.emit('readable');
        stdin.emit('data', data);
      },
    },
    unmount: () => instance.unmount(),
  };
}

/** The Down/Up/Left/Right arrow keys. */
export const DOWN = '\u001b[B';
export const UP = '\u001b[A';
export const LEFT = '\u001b[D';
export const RIGHT = '\u001b[C';

/** An injected open/reveal/preview helper that records its paths and resolves a result. */
export function recorder(result: OpenExternalResult = { ok: true }) {
  const paths: string[] = [];
  const action: ExternalAction = (absPath) => {
    paths.push(absPath);
    return Promise.resolve(result);
  };
  return { paths, action };
}

export type ExternalAction = (absPath: string) => Promise<OpenExternalResult>;

export const okAction: ExternalAction = () => Promise.resolve({ ok: true });

/** Assert zero overflow: no rendered line wider than the terminal. */
export function expectNoOverflow(frame: string, width: number): void {
  for (const line of frame.split('\n')) {
    if (line.length > width) {
      throw new Error(`line overflows ${width} columns: ${JSON.stringify(line)}`);
    }
  }
}
