// The single slash-command registry (R1): one source of truth for input
// routing, the /help block, and the composer's autosuggest panel. No Ink
// imports — pure data plus a prefix filter.

/** The routing kind a known command maps to (name minus the slash). */
export type CommandKind = 'help' | 'runs' | 'evals' | 'exit';

/** One slash command: its full name and a one-line description. */
export interface SlashCommand {
  readonly name: `/${CommandKind}`;
  readonly description: string;
}

/** Every command Sherlock understands, in display order. */
export const SLASH_COMMANDS: readonly SlashCommand[] = [
  { name: '/help', description: 'Show this list' },
  { name: '/runs', description: 'Browse past run directories' },
  { name: '/evals', description: 'Run eval tasks' },
  { name: '/exit', description: 'Quit Sherlock' },
];

/** The registry entry whose name is exactly `command`, if any. */
export function findCommand(command: string): SlashCommand | undefined {
  return SLASH_COMMANDS.find((entry) => entry.name === command);
}

/**
 * Commands the autosuggest panel should offer for the composer text so
 * far: the input must start with `/` and contain no whitespace, and each
 * match's name must start with the typed prefix (case-insensitive).
 * Returns [] otherwise — an empty result hides the panel.
 */
export function filterCommands(input: string): readonly SlashCommand[] {
  if (!input.startsWith('/') || /\s/.test(input)) return [];
  const prefix = input.toLowerCase();
  return SLASH_COMMANDS.filter((entry) => entry.name.startsWith(prefix));
}
