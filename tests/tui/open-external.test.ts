// The external-open helper's contract: exact platform commands, children
// that can never touch Ink's raw-mode TTY (stdio ignored, detached,
// unref'd), and a never-throws result — a missing binary surfaces via
// the child's 'error' event as { ok: false, message }.

import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';

import {
  openPath,
  quickLookPath,
  revealPath,
  type SpawnFn,
} from '../../src/tui/openExternal.js';

const PATH = '/runs/2026-08-12_demo/artifacts/page.png';

class FakeChild extends EventEmitter {
  unrefCalls = 0;
  unref(): void {
    this.unrefCalls += 1;
  }
}

interface RecordedCall {
  command: string;
  args: readonly string[];
  options: { stdio: 'ignore'; detached: true };
}

/** An injectable spawn recorder whose fake children the test drives. */
function makeSpawnRecorder() {
  const calls: RecordedCall[] = [];
  const children: FakeChild[] = [];
  const spawn: SpawnFn = (command, args, options) => {
    calls.push({ command, args, options });
    const child = new FakeChild();
    children.push(child);
    return child;
  };
  return { calls, children, spawn };
}

const TTY_SAFE_OPTIONS = { stdio: 'ignore', detached: true } as const;

describe('on darwin', () => {
  it('openPath launches `open <path>`', async () => {
    const { calls, children, spawn } = makeSpawnRecorder();
    const result = openPath(PATH, { spawn, platform: 'darwin' });
    children[0]!.emit('spawn');
    await expect(result).resolves.toEqual({ ok: true });
    expect(calls).toEqual([
      { command: 'open', args: [PATH], options: TTY_SAFE_OPTIONS },
    ]);
    expect(children[0]!.unrefCalls).toBe(1);
  });

  it('revealPath launches `open -R <path>` (reveal in Finder)', async () => {
    const { calls, children, spawn } = makeSpawnRecorder();
    const result = revealPath(PATH, { spawn, platform: 'darwin' });
    children[0]!.emit('spawn');
    await expect(result).resolves.toEqual({ ok: true });
    expect(calls).toEqual([
      { command: 'open', args: ['-R', PATH], options: TTY_SAFE_OPTIONS },
    ]);
    expect(children[0]!.unrefCalls).toBe(1);
  });

  it('quickLookPath launches `qlmanage -p <path>`', async () => {
    const { calls, children, spawn } = makeSpawnRecorder();
    const result = quickLookPath(PATH, { spawn, platform: 'darwin' });
    children[0]!.emit('spawn');
    await expect(result).resolves.toEqual({ ok: true });
    expect(calls).toEqual([
      { command: 'qlmanage', args: ['-p', PATH], options: TTY_SAFE_OPTIONS },
    ]);
    expect(children[0]!.unrefCalls).toBe(1);
  });
});

describe('on linux', () => {
  it('openPath launches `xdg-open <path>`', async () => {
    const { calls, children, spawn } = makeSpawnRecorder();
    const result = openPath(PATH, { spawn, platform: 'linux' });
    children[0]!.emit('spawn');
    await expect(result).resolves.toEqual({ ok: true });
    expect(calls).toEqual([
      { command: 'xdg-open', args: [PATH], options: TTY_SAFE_OPTIONS },
    ]);
    expect(children[0]!.unrefCalls).toBe(1);
  });

  it('quickLookPath falls back to `xdg-open <path>` (no Quick Look)', async () => {
    const { calls, children, spawn } = makeSpawnRecorder();
    const result = quickLookPath(PATH, { spawn, platform: 'linux' });
    children[0]!.emit('spawn');
    await expect(result).resolves.toEqual({ ok: true });
    expect(calls).toEqual([
      { command: 'xdg-open', args: [PATH], options: TTY_SAFE_OPTIONS },
    ]);
  });

  it('revealPath reports not supported without spawning', async () => {
    const { calls, spawn } = makeSpawnRecorder();
    await expect(revealPath(PATH, { spawn, platform: 'linux' })).resolves.toEqual({
      ok: false,
      message: 'Reveal in the file manager is not supported on linux',
    });
    expect(calls).toEqual([]);
  });
});

describe('on an unknown platform', () => {
  it('every action resolves a not-supported notice and spawns nothing', async () => {
    const { calls, spawn } = makeSpawnRecorder();
    const deps = { spawn, platform: 'win32' };
    await expect(openPath(PATH, deps)).resolves.toEqual({
      ok: false,
      message: expect.stringContaining('not supported on win32'),
    });
    await expect(revealPath(PATH, deps)).resolves.toEqual({
      ok: false,
      message: expect.stringContaining('not supported on win32'),
    });
    await expect(quickLookPath(PATH, deps)).resolves.toEqual({
      ok: false,
      message: expect.stringContaining('not supported on win32'),
    });
    expect(calls).toEqual([]);
  });
});

describe('launch failures', () => {
  it("a missing binary (the child's 'error' event) resolves ok:false with a readable message", async () => {
    const { children, spawn } = makeSpawnRecorder();
    const result = quickLookPath(PATH, { spawn, platform: 'darwin' });
    children[0]!.emit('error', new Error('spawn qlmanage ENOENT'));
    await expect(result).resolves.toEqual({
      ok: false,
      message: 'qlmanage failed to launch: spawn qlmanage ENOENT',
    });
    // Detachment does not depend on the launch succeeding.
    expect(children[0]!.unrefCalls).toBe(1);
  });

  it('a synchronously throwing spawn is caught, never rethrown', async () => {
    const spawn: SpawnFn = () => {
      throw new Error('EAGAIN');
    };
    await expect(openPath(PATH, { spawn, platform: 'darwin' })).resolves.toEqual({
      ok: false,
      message: 'open failed to launch: EAGAIN',
    });
  });
});
