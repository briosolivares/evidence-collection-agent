import { Box, Text, useInput } from 'ink';
import TextInput from 'ink-text-input';
import { useState } from 'react';

import { filterCommands } from '../store/commands.js';
import { theme } from '../theme.js';
import { CommandSuggestions } from './CommandSuggestions.js';

interface ComposerProps {
  /** While true the input ignores keystrokes and shows the hint. */
  disabled?: boolean;
  /** What the disabled composer shows (why input is unavailable). */
  hint?: string;
  /** Called with the trimmed, non-empty submitted text. */
  onSubmit: (text: string) => void;
}

/**
 * The persistent input box anchored at the bottom of the transcript (R2).
 * Submitting clears the field; empty submissions are ignored.
 *
 * While an idle-mode `/command` is being typed (leading slash, no
 * whitespace), an autosuggest panel renders directly above the input
 * (R1). Suggestion selection is purely local component state — the
 * reducer never sees it. Keys while the panel is up: ↑/↓ move the
 * selection (clamped), Tab completes the selected name plus a trailing
 * space with the cursor after it (the space also hides the panel) without
 * submitting, Enter submits the selected command, Esc dismisses the
 * panel until the input next changes.
 *
 * The highlighted command's untyped remainder renders inline after the
 * cursor as muted ghost text (R5), and input starting with `/` renders
 * in the emphasis color rather than plain text.
 */
export function Composer({
  disabled = false,
  hint = '(waiting for agent…)',
  onSubmit,
}: ComposerProps) {
  const [value, setValue] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  // Bumped on every Tab completion. TextInput only derives its internal
  // cursor offset on mount (afterwards it merely clamps to a shrinking
  // value), so an externally grown value would leave the cursor mid-word;
  // keying the input on this count remounts it with the cursor at the end.
  const [completionCount, setCompletionCount] = useState(0);

  const suggestions = disabled || dismissed ? [] : filterCommands(value);
  const panelVisible = suggestions.length > 0;
  // Clamp so a shrinking match list can never strand the selection.
  const cursor = Math.min(selectedIndex, suggestions.length - 1);
  const selected = panelVisible ? suggestions[cursor] : undefined;

  // The untyped remainder of the highlighted command, shown inline after
  // the cursor as ghost text — what Tab will fill in.
  const ghost =
    selected !== undefined && selected.name.length > value.length
      ? selected.name.slice(value.length)
      : '';
  const isCommand = value.startsWith('/');

  const handleChange = (next: string) => {
    setValue(next);
    setSelectedIndex(0);
    setDismissed(false);
  };

  const handleSubmit = (raw: string) => {
    // With the panel up, Enter submits the highlighted command; with it
    // hidden (no match, or Esc-dismissed) the line submits as typed.
    const text = selected?.name ?? raw.trim();
    if (text === '') return;
    setValue('');
    setSelectedIndex(0);
    setDismissed(false);
    onSubmit(text);
  };

  // Panel-only keys. TextInput ignores ↑/↓/Tab, and idle-mode Esc is a
  // no-op in App, so nothing else competes for these while idle.
  useInput(
    (_input, key) => {
      if (key.escape) {
        setDismissed(true);
      } else if (key.upArrow) {
        setSelectedIndex(Math.max(0, cursor - 1));
      } else if (key.downArrow) {
        setSelectedIndex(Math.min(suggestions.length - 1, cursor + 1));
      } else if (key.tab && selected !== undefined) {
        // Complete to "<name> " — the trailing space readies the line for
        // arguments and, containing whitespace, hides the panel.
        setValue(`${selected.name} `);
        setSelectedIndex(0);
        setCompletionCount((count) => count + 1);
      }
    },
    { isActive: panelVisible },
  );

  return (
    <Box flexDirection="column">
      {panelVisible && (
        <CommandSuggestions
          prefix={value}
          suggestions={suggestions}
          selectedIndex={cursor}
        />
      )}
      <Box borderStyle="round" borderColor={theme.muted} paddingX={1}>
        <Text color={theme.primary}>{'› '}</Text>
        {disabled ? (
          <Text color={theme.muted}>{hint}</Text>
        ) : (
          <>
            <Text color={isCommand ? theme.emphasis : undefined}>
              <TextInput
                key={completionCount}
                value={value}
                onChange={handleChange}
                onSubmit={handleSubmit}
              />
            </Text>
            {ghost !== '' && (
              <Text color={theme.muted} dimColor>
                {ghost}
              </Text>
            )}
          </>
        )}
      </Box>
    </Box>
  );
}
