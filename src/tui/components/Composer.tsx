import { Box, Text, useInput } from 'ink';
import TextInput from 'ink-text-input';

import type { SuggestionView, UiAction } from '../store/reducer.js';
import type { ComposerState } from '../store/state.js';
import { theme } from '../theme.js';
import { CommandSuggestions } from './CommandSuggestions.js';

interface ComposerProps {
  /** While true the input ignores keystrokes and shows the hint. */
  disabled?: boolean;
  /** Disabled text, or the enabled composer's empty-value placeholder. */
  hint?: string;
  /** Optional empty-value guidance while the composer remains enabled. */
  placeholder?: string;
  /** The reducer-owned input substate (value, selection, remount count). */
  composer: ComposerState;
  /** The suggestion panel derived from that substate — App passes
   * deriveSuggestions(state), the same view the reducer's tab_pressed
   * consults. */
  suggestions: SuggestionView;
  /** Dispatch into the session store (typing, panel navigation). */
  dispatch: (action: UiAction) => void;
  /** Called with the trimmed, non-empty submitted text. */
  onSubmit: (text: string) => void;
}

/**
 * The persistent input box anchored at the bottom of the transcript (R2).
 * Submitting clears the field (App's composer_submitted dispatch rides
 * its routing); empty submissions are ignored.
 *
 * While an idle-mode `/command` is being typed (leading slash, no
 * whitespace), an autosuggest panel renders directly above the input
 * (R1). The input line and suggestion selection live in the reducer
 * (state.composer) — promoted from component-local state because a
 * globally-routed key's meaning depends on them: Tab completes the
 * highlighted suggestion while the panel is up and only otherwise
 * touches the artifacts panel, and App's single tab_pressed route must
 * see that state the frame it decides. Keys while the panel is up:
 * ↑/↓ move the selection (clamped), Esc dismisses the panel until the
 * input next changes, Enter submits the selected command. Tab is
 * deliberately not handled here — one key, one owner (App).
 *
 * The highlighted command's untyped remainder renders inline after the
 * cursor as muted ghost text (R5), and input starting with `/` renders
 * in the emphasis color rather than plain text.
 */
export function Composer({
  disabled = false,
  hint = '(waiting for agent…)',
  placeholder,
  composer,
  suggestions,
  dispatch,
  onSubmit,
}: ComposerProps) {
  const { value, completions } = composer;
  const { suggestions: matches, panelVisible, cursor, selected } = suggestions;

  // The untyped remainder of the highlighted command, shown inline after
  // the cursor as ghost text — what Tab will fill in.
  const ghost =
    selected !== undefined && selected.name.length > value.length
      ? selected.name.slice(value.length)
      : '';
  const isCommand = value.startsWith('/');

  const handleSubmit = (raw: string) => {
    // With the panel up, Enter submits the highlighted command; with it
    // hidden (no match, or Esc-dismissed) the line submits as typed.
    const text = selected?.name ?? raw.trim();
    if (text === '') return;
    onSubmit(text);
  };

  // Panel-only keys (Tab excepted — App owns it). TextInput ignores
  // ↑/↓, and idle-mode Esc is a no-op in App, so nothing else competes
  // for these while the panel is up.
  useInput(
    (_input, key) => {
      if (key.escape) {
        dispatch({ type: 'suggest_dismiss' });
      } else if (key.upArrow) {
        dispatch({ type: 'suggest_nav', delta: -1 });
      } else if (key.downArrow) {
        dispatch({ type: 'suggest_nav', delta: 1 });
      }
    },
    { isActive: panelVisible },
  );

  return (
    <Box flexDirection="column">
      {panelVisible && (
        <CommandSuggestions prefix={value} suggestions={matches} selectedIndex={cursor} />
      )}
      <Box borderStyle="round" borderColor={theme.muted} paddingX={1}>
        <Text color={theme.primary}>{'› '}</Text>
        {disabled ? (
          <Text color={theme.muted}>{hint}</Text>
        ) : (
          <>
            <Text color={isCommand ? theme.emphasis : undefined}>
              {/* Keyed on the Tab-completion count: TextInput only derives
                  its cursor offset on mount (afterwards it merely clamps
                  to a shrinking value), so a completion-grown value would
                  leave the cursor mid-word; the remount puts it at the
                  end. */}
              <TextInput
                key={completions}
                value={value}
                placeholder={placeholder}
                onChange={(next) => dispatch({ type: 'composer_changed', value: next })}
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
