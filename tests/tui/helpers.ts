// Shared helpers for TUI component tests (ink-testing-library drives a
// fake stdin/stdout; state updates settle on the microtask/timer queue).

import { EventEmitter } from 'node:events';
import { render as inkRender } from 'ink';
import type { ReactElement } from 'react';

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
  const stdin = Object.assign(new EventEmitter(), {
    isTTY: true,
    setRawMode: () => {},
    setEncoding: () => {},
    read: () => null,
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
    unmount: () => instance.unmount(),
  };
}
