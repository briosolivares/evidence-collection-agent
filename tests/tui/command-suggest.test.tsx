import { render } from 'ink-testing-library';
import { describe, expect, it, vi } from 'vitest';

import { App } from '../../src/tui/components/App.js';
import { CommandSuggestions } from '../../src/tui/components/CommandSuggestions.js';
import { createConfig } from '../../src/tui/config.js';
import { SLASH_COMMANDS } from '../../src/tui/store/commands.js';
import { DOWN, ENTER, ESC, expectNoOverflow, renderAt, tick, typeText, UP } from './helpers.js';

// Interaction-heavy suites type through a fake stdin tick by tick and
// can exceed the 5 s default under full-suite parallel load.
vi.setConfig({ testTimeout: 30_000 });

const config = createConfig();

// Descriptions only ever render in the panel (or a /help notice we never
// trigger here), so they are the unambiguous visibility probe — command
// names also appear in the composer echo and the "/help for commands"
// footer hint.
const DESCRIPTIONS = {
  help: 'Show this list',
  runs: 'Browse past run directories',
  evals: 'Run eval tasks',
  exit: 'Quit Sherlock',
} as const;

describe('slash-command autosuggest panel (R1)', () => {
  it('typing / lists every command with its description', async () => {
    const { lastFrame, stdin, unmount } = render(<App config={config} apiKeyPresent={true} />);
    await tick();
    await typeText(stdin, '/');
    const frame = lastFrame() ?? '';
    for (const value of Object.values(DESCRIPTIONS)) {
      expect(frame).toContain(value);
    }
    // First row is selected by default.
    expect(frame).toContain('› /help');
    unmount();
  });

  it('typing /e filters to /evals and /exit only', async () => {
    const { lastFrame, stdin, unmount } = render(<App config={config} apiKeyPresent={true} />);
    await tick();
    await typeText(stdin, '/e');
    const frame = lastFrame() ?? '';
    expect(frame).toContain(DESCRIPTIONS.evals);
    expect(frame).toContain(DESCRIPTIONS.exit);
    expect(frame).not.toContain(DESCRIPTIONS.help);
    expect(frame).not.toContain(DESCRIPTIONS.runs);
    expect(frame).toContain('› /evals');
    unmount();
  });

  it('down arrow then Enter opens the highlighted command overlay', async () => {
    const runsConfig = createConfig({ runsBaseDir: '/nonexistent-runs-dir' });
    const { lastFrame, stdin, unmount } = render(<App config={runsConfig} apiKeyPresent={true} />);
    await tick();
    await typeText(stdin, '/');
    stdin.write(DOWN); // from /help to /runs
    await tick();
    expect(lastFrame()).toContain('› /runs');
    stdin.write(ENTER);
    await tick();
    expect(lastFrame()).toContain('Past runs');
    expect(lastFrame()).not.toContain(DESCRIPTIONS.runs); // panel gone
    unmount();
  });

  it('Enter submits the selected command, not the typed prefix', async () => {
    const onExit = vi.fn();
    const { stdin, unmount } = render(<App config={config} apiKeyPresent={true} onExit={onExit} />);
    await tick();
    await typeText(stdin, '/e');
    stdin.write(DOWN); // from /evals to /exit
    await tick();
    stdin.write(ENTER);
    await tick();
    expect(onExit).toHaveBeenCalledTimes(1);
    unmount();
  });

  it('selection clamps at both ends instead of wrapping', async () => {
    const { lastFrame, stdin, unmount } = render(<App config={config} apiKeyPresent={true} />);
    await tick();
    await typeText(stdin, '/e');
    stdin.write(UP); // at the top stays on /evals
    await tick();
    expect(lastFrame()).toContain('› /evals');
    stdin.write(DOWN);
    await tick();
    stdin.write(DOWN); // at the bottom stays on /exit
    await tick();
    expect(lastFrame()).toContain('› /exit');
    unmount();
  });

  it('Tab completes the name plus a space, cursor at the end', async () => {
    const { frames, lastFrame, stdin, unmount } = render(
      <App config={config} apiKeyPresent={true} />,
    );
    await tick();
    await typeText(stdin, '/ev');
    stdin.write('\t');
    await tick();
    const frame = lastFrame() ?? '';
    // The input now holds the full name; the trailing space hides the panel…
    expect(frame).toContain('› /evals');
    expect(frame).not.toContain(DESCRIPTIONS.evals);
    // …and the cursor sits after that space: typing appends at the end.
    await typeText(stdin, 'x');
    expect(lastFrame()).toContain('› /evals x');
    // Nothing was submitted: no overlay, no notice, no transcript echo.
    const output = frames.join('\n');
    expect(output).not.toContain('Eval tasks');
    expect(output).not.toContain('not available in --demo');
    expect(output).not.toContain('▸');
    unmount();
  });

  it('Enter after Tab submits the completed command', async () => {
    const onExit = vi.fn();
    const { stdin, unmount } = render(<App config={config} apiKeyPresent={true} onExit={onExit} />);
    await tick();
    await typeText(stdin, '/ex');
    stdin.write('\t');
    await tick();
    stdin.write(ENTER); // "/exit " trims to /exit and routes
    await tick();
    expect(onExit).toHaveBeenCalledTimes(1);
    unmount();
  });

  it('Esc dismisses the panel and typing brings it back', async () => {
    const { lastFrame, stdin, unmount } = render(<App config={config} apiKeyPresent={true} />);
    await tick();
    await typeText(stdin, '/');
    expect(lastFrame()).toContain(DESCRIPTIONS.help);
    stdin.write(ESC);
    await tick(150); // Ink defers a lone ESC byte
    const dismissed = lastFrame() ?? '';
    expect(dismissed).not.toContain(DESCRIPTIONS.help);
    expect(dismissed).not.toContain(DESCRIPTIONS.exit);
    // The typed text survives dismissal…
    await typeText(stdin, 'e');
    // …and further typing re-filters and re-shows the panel.
    expect(lastFrame()).toContain(DESCRIPTIONS.evals);
    expect(lastFrame()).toContain(DESCRIPTIONS.exit);
    unmount();
  });

  it('hides when nothing matches and the line submits as typed', async () => {
    const { frames, lastFrame, stdin, unmount } = render(
      <App config={config} apiKeyPresent={true} />,
    );
    await tick();
    await typeText(stdin, '/zz');
    expect(lastFrame()).not.toContain(DESCRIPTIONS.help);
    stdin.write(ENTER);
    await tick();
    expect(frames.join('\n')).toContain("/zz isn't a command I know");
    unmount();
  });

  it('hides once the input contains a space (a task, not a command)', async () => {
    const { lastFrame, stdin, unmount } = render(<App config={config} apiKeyPresent={true} />);
    await tick();
    await typeText(stdin, '/help ');
    expect(lastFrame()).not.toContain(DESCRIPTIONS.help);
    unmount();
  });
});

describe('CommandSuggestions rendering contract', () => {
  const panel = (prefix: string, selectedIndex: number) => (
    <CommandSuggestions
      prefix={prefix}
      suggestions={SLASH_COMMANDS}
      selectedIndex={selectedIndex}
    />
  );

  it('locks the panel at normal width (80 columns)', async () => {
    const { lastFrame, unmount } = renderAt(80, panel('/', 1));
    await tick();
    expect(lastFrame()).toMatchSnapshot();
    unmount();
  });

  it('renders with zero overflow at 44 columns', async () => {
    const { lastFrame, unmount } = renderAt(44, panel('/', 0));
    await tick();
    const frame = lastFrame();
    expectNoOverflow(frame, 44);
    expect(frame).toMatchSnapshot();
    unmount();
  });
});

describe('composer ghost completion (R5)', () => {
  /** The composer's input row (bordered, holds the › marker). */
  const composerLine = (frame: string | undefined): string =>
    (frame ?? '').split('\n').find((line) => line.includes('│') && line.includes('› ')) ?? '';

  it('shows the untyped remainder inline and follows the selection', async () => {
    const { lastFrame, stdin, unmount } = render(<App config={config} apiKeyPresent={true} />);
    await tick();
    await typeText(stdin, '/e');
    // TextInput's cursor renders as one cell between value and ghost.
    expect(composerLine(lastFrame())).toContain('/e vals');
    stdin.write(DOWN); // /evals → /exit
    await tick();
    expect(composerLine(lastFrame())).toContain('/e xit');
    unmount();
  });

  it('Tab fills the value; ghost and panel disappear once complete', async () => {
    const { lastFrame, stdin, unmount } = render(<App config={config} apiKeyPresent={true} />);
    await tick();
    await typeText(stdin, '/r');
    expect(composerLine(lastFrame())).toContain('/r uns');
    stdin.write('\t');
    await tick();
    // Value is now "/runs " with only the cursor cell after it — no ghost
    // letters, and the trailing space hides the panel (not submitted).
    expect(composerLine(lastFrame())).toMatch(/› \/runs\s+│/);
    expect(lastFrame()).not.toContain(DESCRIPTIONS.runs);
    unmount();
  });
});
