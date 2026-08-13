import { Box, Text } from 'ink';

import type { SlashCommand } from '../store/commands.js';
import { theme } from '../theme.js';

/** Name column width: the longest command name plus two spaces. */
const NAME_COLUMN = 12;

interface CommandSuggestionsProps {
  /** What has been typed so far (starts with `/`); bolded inside names. */
  prefix: string;
  /** Prefix-matched commands, in registry order. */
  suggestions: readonly SlashCommand[];
  /** Index of the highlighted row. */
  selectedIndex: number;
}

/**
 * The slash-command autosuggest panel, rendered directly above the
 * composer while a `/command` is being typed (R1): command name left
 * with the typed prefix bolded, muted description right, `›` plus
 * emphasis color on the selected row. Each row is one nested-Text
 * paragraph that truncates at the terminal edge, so narrow terminals
 * never overflow.
 */
export function CommandSuggestions({
  prefix,
  suggestions,
  selectedIndex,
}: CommandSuggestionsProps) {
  return (
    <Box flexDirection="column">
      {suggestions.map((command, index) => {
        const selected = index === selectedIndex;
        const typed = command.name.slice(0, prefix.length);
        const rest = command.name.slice(prefix.length);
        const gap = ' '.repeat(Math.max(2, NAME_COLUMN - command.name.length));
        return (
          <Text key={command.name} wrap="truncate-end">
            <Text color={theme.emphasis}>{selected ? '› ' : '  '}</Text>
            <Text bold color={selected ? theme.emphasis : theme.primary}>
              {typed}
            </Text>
            <Text color={selected ? theme.emphasis : undefined}>{rest}</Text>
            <Text color={theme.muted}>{gap + command.description}</Text>
          </Text>
        );
      })}
    </Box>
  );
}
