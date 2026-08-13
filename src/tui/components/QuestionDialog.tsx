import { Box, Text, useInput } from 'ink';
import TextInput from 'ink-text-input';
import { useState } from 'react';

import type { AskUserAnswers, AskUserQuestionInput } from '../../tools/index.js';
import { theme } from '../theme.js';

interface QuestionDialogProps {
  /** The interactive tool being gated (only ask_user_question today). */
  toolName: string;
  /** The tool call's validated input; read defensively so a future
   * interactive tool without these fields still renders something. */
  input: unknown;
  /** Resolve the dialog with the user's answers (the allow path). */
  onSubmit: (answers: AskUserAnswers) => void;
  /** Dismiss the dialog without answering (the deny path). */
  onDismiss: () => void;
}

/**
 * The mid-run question dialog: rendered above the composer while an
 * interactive tool holds the run paused. Free text is always available;
 * ↑/↓ move the option highlight, Tab toggles options when several may be
 * chosen, Enter submits, Esc dismisses (deny). While it is open the run
 * sits inside an awaited tool call, so time costs nothing.
 */
export function QuestionDialog({
  toolName,
  input,
  onSubmit,
  onDismiss,
}: QuestionDialogProps) {
  const view = input as Partial<AskUserQuestionInput>;
  const question = view.question ?? `Tool "${toolName}" needs your input.`;
  const options = view.options ?? [];
  const multiSelect = view.multi_select === true;

  const [text, setText] = useState('');
  const [highlighted, setHighlighted] = useState(0);
  const [toggled, setToggled] = useState<readonly number[]>([]);

  useInput((_input, key) => {
    if (key.escape) {
      onDismiss();
      return;
    }
    if (options.length === 0) return;
    if (key.upArrow) {
      setHighlighted((index) => Math.max(0, index - 1));
    } else if (key.downArrow) {
      setHighlighted((index) => Math.min(options.length - 1, index + 1));
    } else if (key.tab && multiSelect) {
      setToggled((current) =>
        current.includes(highlighted)
          ? current.filter((index) => index !== highlighted)
          : [...current, highlighted],
      );
    }
  });

  const handleSubmit = (raw: string) => {
    const freeText = raw.trim();
    // Multi-select answers are the toggled set; single-select uses the
    // highlight — unless the user typed their own answer, which wins.
    const chosen = multiSelect
      ? options
          .filter((_, index) => toggled.includes(index))
          .map((option) => option.label)
      : freeText === '' && options.length > 0
        ? [options[highlighted]!.label]
        : [];
    if (freeText === '' && chosen.length === 0) return;
    onSubmit({ chosen, ...(freeText === '' ? {} : { freeText }) });
  };

  const keysHint = [
    ...(options.length > 0 ? ['↑/↓ choose'] : []),
    ...(multiSelect ? ['tab toggle'] : []),
    'enter answer',
    'esc dismiss',
  ].join(' · ');

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.emphasis} paddingX={1}>
      {view.header !== undefined && (
        <Text color={theme.emphasis} bold>
          {view.header}
        </Text>
      )}
      <Text>{question}</Text>
      {options.map((option, index) => {
        const active = index === highlighted;
        const marker = multiSelect
          ? toggled.includes(index)
            ? '[x]'
            : '[ ]'
          : active
            ? '❯'
            : ' ';
        return (
          <Text key={option.label} color={active ? theme.emphasis : undefined}>
            {`  ${marker} ${option.label}`}
            {option.description !== undefined && (
              <Text color={theme.muted}> — {option.description}</Text>
            )}
          </Text>
        );
      })}
      <Box>
        <Text color={theme.primary}>{'› '}</Text>
        <TextInput value={text} onChange={setText} onSubmit={handleSubmit} />
      </Box>
      <Text color={theme.muted}>{`  ${keysHint}`}</Text>
    </Box>
  );
}
