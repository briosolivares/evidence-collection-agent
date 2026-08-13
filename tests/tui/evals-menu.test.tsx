import { render } from 'ink-testing-library';
import { describe, expect, it, vi } from 'vitest';

import {
  EvalsMenu,
  validateConcurrency,
  validateK,
} from '../../src/tui/components/EvalsMenu.js';
import { ESC, tick } from './helpers.js';

// Interaction-heavy suites type through a fake stdin tick by tick and
// can exceed the 5 s default under full-suite parallel load.
vi.setConfig({ testTimeout: 30_000 });

const DOWN = '\u001b[B';
const ENTER = '\r';
const BACKSPACE = '\u007f';

describe('validateK', () => {
  it('accepts positive integers', () => {
    expect(validateK('3')).toBe(3);
    expect(validateK('1')).toBe(1);
    expect(validateK('12')).toBe(12);
  });

  it('rejects non-positive and non-integer entries', () => {
    expect(validateK('0')).toBeUndefined();
    expect(validateK('')).toBeUndefined();
    expect(validateK('2.5')).toBeUndefined();
    expect(validateK('-1')).toBeUndefined();
    expect(validateK('abc')).toBeUndefined();
  });
});

describe('validateConcurrency', () => {
  it('accepts only positive integers', () => {
    expect(validateConcurrency('3')).toBe(3);
    expect(validateConcurrency('0')).toBeUndefined();
    expect(validateConcurrency('1.5')).toBeUndefined();
  });
});

describe('EvalsMenu', () => {
  const tasks = [
    { name: 'edgar', headed: false },
    { name: 'hacker_news', headed: false },
    { name: 'stub', headed: true },
  ];

  it('toggles checkboxes with space and requires a selection', async () => {
    const { lastFrame, stdin, unmount } = render(
      <EvalsMenu tasks={tasks} onConfirm={() => {}} onClose={() => {}} />,
    );
    await tick();
    expect(lastFrame()).toContain('[ ] edgar');
    stdin.write(ENTER); // nothing selected yet
    await tick();
    expect(lastFrame()).toContain('Select at least one task');
    stdin.write(' ');
    await tick();
    expect(lastFrame()).toContain('[x] edgar');
    stdin.write(' ');
    await tick();
    expect(lastFrame()).toContain('[ ] edgar');
    unmount();
  });

  it('confirms a multi-select with default k=3 and concurrency=3', async () => {
    const onConfirm = vi.fn();
    const { lastFrame, stdin, unmount } = render(
      <EvalsMenu tasks={tasks} onConfirm={onConfirm} onClose={() => {}} />,
    );
    await tick();
    stdin.write(' '); // select edgar
    await tick();
    stdin.write(DOWN);
    await tick();
    stdin.write(' '); // select hacker_news
    await tick();
    stdin.write(ENTER); // to k stage
    await tick();
    expect(lastFrame()).toContain('k: 3');
    stdin.write(ENTER); // to concurrency stage
    await tick();
    expect(lastFrame()).toContain('concurrency: 3');
    stdin.write(ENTER); // confirm defaults
    await tick();
    expect(onConfirm).toHaveBeenCalledWith(['edgar', 'hacker_news'], 3, 3);
    unmount();
  });

  it('rejects a non-positive k and confirms a corrected one', async () => {
    const onConfirm = vi.fn();
    const { lastFrame, stdin, unmount } = render(
      <EvalsMenu tasks={tasks} onConfirm={onConfirm} onClose={() => {}} />,
    );
    await tick();
    stdin.write(' ');
    await tick();
    stdin.write(ENTER); // to k stage
    await tick();
    stdin.write(BACKSPACE); // clear the default 3
    await tick();
    stdin.write('0');
    await tick();
    stdin.write(ENTER);
    await tick();
    expect(onConfirm).not.toHaveBeenCalled();
    expect(lastFrame()).toContain('k must be a positive integer');
    stdin.write(BACKSPACE);
    await tick();
    stdin.write('2');
    await tick();
    stdin.write(ENTER); // to concurrency stage
    await tick();
    stdin.write(ENTER); // confirm default concurrency
    await tick();
    expect(onConfirm).toHaveBeenCalledWith(['edgar'], 2, 3);
    unmount();
  });

  it('ignores non-digit input at the k prompt', async () => {
    const onConfirm = vi.fn();
    const { lastFrame, stdin, unmount } = render(
      <EvalsMenu tasks={tasks} onConfirm={onConfirm} onClose={() => {}} />,
    );
    await tick();
    stdin.write(' ');
    await tick();
    stdin.write(ENTER);
    await tick();
    stdin.write('x');
    await tick();
    expect(lastFrame()).toContain('k: 3');
    unmount();
  });

  it('Esc closes from the task stage and steps back from the k stage', async () => {
    const onClose = vi.fn();
    const { lastFrame, stdin, unmount } = render(
      <EvalsMenu tasks={tasks} onConfirm={() => {}} onClose={onClose} />,
    );
    await tick();
    stdin.write(' ');
    await tick();
    stdin.write(ENTER); // to k stage
    await tick();
    expect(lastFrame()).toContain('k: 3');
    stdin.write(ESC);
    await tick(150);
    expect(onClose).not.toHaveBeenCalled();
    expect(lastFrame()).toContain('[x] edgar'); // back at task stage
    stdin.write(ESC);
    await tick(150);
    expect(onClose).toHaveBeenCalledTimes(1);
    unmount();
  });

  it('marks authenticated tasks in the selection list', async () => {
    const { lastFrame, unmount } = render(
      <EvalsMenu tasks={tasks} onConfirm={() => {}} onClose={() => {}} />,
    );
    await tick();
    expect(lastFrame()).toContain('stub [headed]');
    unmount();
  });
});
