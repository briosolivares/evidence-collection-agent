import { Box, Text } from 'ink';
import TextInput from 'ink-text-input';
import { useState } from 'react';

import { theme } from '../theme.js';

interface ComposerProps {
  /** While true the input ignores keystrokes and shows a waiting hint. */
  disabled?: boolean;
  /** Called with the trimmed, non-empty submitted text. */
  onSubmit: (text: string) => void;
}

/**
 * The persistent input box anchored at the bottom of the transcript (R2).
 * Submitting clears the field; empty submissions are ignored.
 */
export function Composer({ disabled = false, onSubmit }: ComposerProps) {
  const [value, setValue] = useState('');

  const handleSubmit = (raw: string) => {
    const text = raw.trim();
    if (text === '') return;
    setValue('');
    onSubmit(text);
  };

  return (
    <Box borderStyle="round" borderColor={theme.muted} paddingX={1}>
      <Text color={theme.primary}>{'› '}</Text>
      {disabled ? (
        <Text color={theme.muted}>(waiting for agent…)</Text>
      ) : (
        <TextInput value={value} onChange={setValue} onSubmit={handleSubmit} />
      )}
    </Box>
  );
}
