// The single slash-command registry (R1): one source of truth for input
// routing, the /help block, and the composer's autosuggest panel. No Ink
// imports — pure data plus a prefix filter.

/** The routing kind a known command maps to (name minus the slash). */
export type CommandKind = 'help' | 'runs' | 'artifacts' | 'evals' | 'exit';

/** One slash command: its full name and a one-line description. */
export interface SlashCommand {
  readonly name: `/${CommandKind}`;
  readonly description: string;
}

/** Every command Sherlock understands, in display order. */
export const SLASH_COMMANDS: readonly SlashCommand[] = [
  { name: '/help', description: 'Show this list' },
  { name: '/runs', description: 'Browse past run directories' },
  { name: '/artifacts', description: "Browse the last run's artifacts" },
  { name: '/evals', description: 'Run eval tasks' },
  { name: '/exit', description: 'Quit Sherlock' },
];

/** Commands available in this runtime. Evals exist only in a checkout. */
export function availableCommands(
  evalsEnabled = true,
): readonly SlashCommand[] {
  return evalsEnabled
    ? SLASH_COMMANDS
    : SLASH_COMMANDS.filter((entry) => entry.name !== '/evals');
}

/** The registry entry whose name is exactly `command`, if any. */
export function findCommand(
  command: string,
  evalsEnabled = true,
): SlashCommand | undefined {
  return availableCommands(evalsEnabled).find((entry) => entry.name === command);
}

/**
 * Commands the autosuggest panel should offer for the composer text so
 * far: the input must start with `/` and contain no whitespace, and each
 * match's name must start with the typed prefix (case-insensitive).
 * Returns [] otherwise — an empty result hides the panel.
 */
export function filterCommands(
  input: string,
  evalsEnabled = true,
): readonly SlashCommand[] {
  if (!input.startsWith('/') || /\s/.test(input)) return [];
  const prefix = input.toLowerCase();
  return availableCommands(evalsEnabled).filter((entry) =>
    entry.name.startsWith(prefix),
  );
}
