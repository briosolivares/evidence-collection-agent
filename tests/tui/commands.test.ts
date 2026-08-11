import { describe, expect, it } from 'vitest';

import {
  filterCommands,
  findCommand,
  SLASH_COMMANDS,
} from '../../src/tui/store/commands.js';
import { HELP_TEXT, routeInput } from '../../src/tui/store/reducer.js';

describe('SLASH_COMMANDS registry', () => {
  it('lists exactly the four commands, each with a description', () => {
    expect(SLASH_COMMANDS.map((entry) => entry.name)).toEqual([
      '/help',
      '/runs',
      '/evals',
      '/exit',
    ]);
    for (const entry of SLASH_COMMANDS) {
      expect(entry.description.length).toBeGreaterThan(0);
    }
  });

  it('findCommand matches exact names only', () => {
    expect(findCommand('/runs')?.name).toBe('/runs');
    expect(findCommand('/run')).toBeUndefined();
    expect(findCommand('runs')).toBeUndefined();
  });
});

describe('filterCommands (autosuggest filter)', () => {
  it('offers every command for a bare slash', () => {
    expect(filterCommands('/')).toEqual(SLASH_COMMANDS);
  });

  it('prefix-filters case-insensitively', () => {
    expect(filterCommands('/e').map((entry) => entry.name)).toEqual([
      '/evals',
      '/exit',
    ]);
    expect(filterCommands('/E').map((entry) => entry.name)).toEqual([
      '/evals',
      '/exit',
    ]);
    expect(filterCommands('/ru').map((entry) => entry.name)).toEqual(['/runs']);
  });

  it('still matches an exactly typed command', () => {
    expect(filterCommands('/exit').map((entry) => entry.name)).toEqual(['/exit']);
  });

  it('returns nothing without a leading slash', () => {
    expect(filterCommands('')).toEqual([]);
    expect(filterCommands('find the filings')).toEqual([]);
    expect(filterCommands('e/')).toEqual([]);
  });

  it('returns nothing once the input contains whitespace', () => {
    expect(filterCommands('/runs ')).toEqual([]);
    expect(filterCommands('/help me')).toEqual([]);
  });

  it('returns nothing when no name matches the prefix', () => {
    expect(filterCommands('/z')).toEqual([]);
    expect(filterCommands('/exits')).toEqual([]);
  });
});

describe('registry drives routeInput and HELP_TEXT', () => {
  it('routes every registry command to its non-unknown kind', () => {
    for (const entry of SLASH_COMMANDS) {
      expect(routeInput(entry.name)).toEqual({ kind: entry.name.slice(1) });
    }
  });

  it('still routes unregistered slash commands as unknown', () => {
    expect(routeInput('/frobnicate')).toEqual({
      kind: 'unknown',
      command: '/frobnicate',
    });
  });

  it('HELP_TEXT lists every registry name with its description', () => {
    for (const entry of SLASH_COMMANDS) {
      expect(HELP_TEXT).toContain(entry.name);
      expect(HELP_TEXT).toContain(entry.description);
    }
  });

  it('HELP_TEXT is byte-identical to the pre-registry literal', () => {
    expect(HELP_TEXT).toBe(
      [
        'Commands',
        '  /help   Show this list',
        '  /runs   Browse past run directories',
        '  /evals  Run eval tasks',
        '  /exit   Quit Sherlock',
        'Keys',
        '  Esc     Cancel the current run',
        '  Ctrl+C  Quit',
      ].join('\n'),
    );
  });
});
