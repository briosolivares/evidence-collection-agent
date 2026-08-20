import { EventEmitter } from 'node:events';

import { Terminal } from '@xterm/headless';
import { afterEach, describe, expect, it } from 'vitest';

import { App } from '../../src/tui/components/App.js';
import { createConfig } from '../../src/tui/config.js';
import { render } from '../../src/tui/resizeSafeRender.js';

class TerminalOutput extends EventEmitter {
  columns = 200;
  rows = 60;
  readonly isTTY = true;
  readonly writable = true;
  readonly destroyed = false;
  readonly writableEnded = false;
  readonly writableLength = 0;

  constructor(private readonly terminal: Terminal) {
    super();
  }

  write(data: string, callback?: () => void): boolean {
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

  setEncoding(): void {}
  setRawMode(): void {}
  resume(): void {}
  pause(): void {}
  ref(): void {}
  unref(): void {}
  read(): null {
    return null;
  }
}

const mounted: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of mounted.splice(0)) cleanup();
});

function settle(ms = 40): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('resize-safe Ink rendering', () => {
  it('does not stamp prior composer borders while the terminal narrows', async () => {
    const terminal = new Terminal({
      allowProposedApi: true,
      cols: 200,
      rows: 60,
      scrollback: 1_000,
    });
    const output = new TerminalOutput(terminal);
    const input = new TerminalInput();
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
        maxFps: 1_000,
      },
    );
    mounted.push(() => {
      instance.cleanup();
      terminal.dispose();
    });

    await settle();
    for (const width of [190, 180, 170, 160, 150, 140, 130, 120, 110, 100]) {
      output.resize(width);
      await settle(10);
    }
    await settle();

    const buffer = terminal.buffer.active;
    const lines = Array.from({ length: buffer.length }, (_, row) =>
      (buffer.getLine(row)?.translateToString(true) ?? '').trimEnd(),
    );
    const topBorders = lines.filter((line) => line.startsWith('╭'));

    // The welcome card and the current composer are the only bordered tops.
    // Without the resize correction, all ten prior composer widths remain.
    expect(topBorders).toHaveLength(2);
    expect(topBorders).toContain(`╭${'─'.repeat(98)}╮`);
    expect(lines.some((line) => line.includes('Welcome back Brios!'))).toBe(true);
    expect(lines.some((line) => line.includes('/help for commands'))).toBe(true);
  });
});
