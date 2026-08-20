import { EventEmitter } from 'node:events';

import { Terminal } from '@xterm/headless';
import { afterEach, describe, expect, it } from 'vitest';

import { App } from '../../src/tui/components/App.js';
import { createConfig } from '../../src/tui/config.js';
import { render } from '../../src/tui/resizeSafeRender.js';

class TerminalOutput extends EventEmitter {
  columns = 200;
  rows = 60;
  viewportClearCount = 0;
  readonly isTTY = true;
  readonly writable = true;
  readonly destroyed = false;
  readonly writableEnded = false;
  readonly writableLength = 0;

  constructor(private readonly terminal: Terminal) {
    super();
  }

  write(data: string, callback?: () => void): boolean {
    this.viewportClearCount += data.split('\u001B[2J\u001B[H').length - 1;
    // A real PTY's output processing maps LF to CRLF before bytes reach the
    // terminal emulator. Headless xterm needs that behavior made explicit.
    const terminalData = data.replace(/(?<!\r)\n/g, '\r\n');
    this.terminal.write(terminalData, callback);
    return true;
  }

  resize(columns: number): void {
    this.columns = columns;
    this.terminal.resize(columns, this.rows);
    this.emit('resize');
  }
}

class TerminalInput extends EventEmitter {
  readonly isTTY = true;
  private pending: string | null = null;

  setEncoding(): void {}
  setRawMode(): void {}
  resume(): void {}
  pause(): void {}
  ref(): void {}
  unref(): void {}
  read(): string | null {
    const data = this.pending;
    this.pending = null;
    return data;
  }

  write(data: string): void {
    this.pending = data;
    this.emit('readable');
    this.emit('data', data);
  }
}

const mounted: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of mounted.splice(0)) cleanup();
});

function settle(ms = 40): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function typeText(input: TerminalInput, text: string): Promise<void> {
  for (const character of text) {
    input.write(character);
    await settle(1);
  }
}

describe('resize-safe Ink rendering', () => {
  it.each([
    ['reflowing rows', true],
    ['non-reflowing rows', false],
  ])('does not stamp prior frames with %s', async (_name, autoWrap) => {
    const terminal = new Terminal({
      allowProposedApi: true,
      cols: 200,
      rows: 60,
      scrollback: 1_000,
    });
    const output = new TerminalOutput(terminal);
    const input = new TerminalInput();
    if (!autoWrap) output.write('\u001B[?7l');
    output.write(`shell-history-marker\n${'prior shell output\n'.repeat(70)}`);
    const instance = render(
      <App
        config={createConfig()}
        apiKeyPresent={false}
        identity={{ name: 'Brios', model: 'claude-sonnet-5', cwd: '~' }}
      />,
      {
        stdout: output as unknown as NodeJS.WriteStream,
        stderr: output as unknown as NodeJS.WriteStream,
        stdin: input as unknown as NodeJS.ReadStream,
        patchConsole: false,
        exitOnCtrlC: false,
        maxFps: 30,
      },
    );
    mounted.push(() => {
      instance.cleanup();
      terminal.dispose();
    });

    await settle();
    await typeText(input, '/unknown');
    input.write('\r');
    await settle();
    await typeText(input, 'draft survives resize');

    for (const width of [190, 170, 150, 130, 110, 100, 120, 145, 177, 125, 177]) {
      output.resize(width);
      await settle(10);
    }
    await settle(180);

    // A second, separately settled gesture proves that cleanup is repeatable,
    // not just correct for the first resize after mount.
    for (const width of [140, 105, 160, 177]) {
      output.resize(width);
      await settle(10);
    }
    await settle(180);

    const buffer = terminal.buffer.active;
    const lines = Array.from({ length: output.rows }, (_, row) =>
      (buffer.getLine(buffer.baseY + row)?.translateToString(true) ?? '').trimEnd(),
    );
    const topBorders = lines.filter((line) => line.startsWith('╭'));

    // The welcome card and the current composer are the only bordered tops.
    // Without the settled repaint, prior shrink and growth widths remain.
    expect(topBorders).toHaveLength(2);
    expect(topBorders).toContain(`╭${'─'.repeat(175)}╮`);
    expect(lines.some((line) => line.includes('Welcome back Brios!'))).toBe(true);
    expect(lines.some((line) => line.includes("Hmm, /unknown isn't a command"))).toBe(true);
    expect(lines.some((line) => line.includes('draft survives resize'))).toBe(true);
    expect(lines.some((line) => line.includes('/help for commands'))).toBe(true);
    expect(output.viewportClearCount).toBe(2);

    // CSI 2J clears only the viewport. Sherlock must not destroy output that
    // predates it in the user's native terminal scrollback.
    const allLines = Array.from({ length: buffer.length }, (_, row) =>
      buffer.getLine(row)?.translateToString(true),
    );
    expect(allLines.some((line) => line?.includes('shell-history-marker'))).toBe(true);
  });
});
