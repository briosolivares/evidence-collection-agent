import { Box, Text, useInput } from 'ink';
import { useState } from 'react';

import { theme } from '../theme.js';

/** Parse a trial-count entry: a positive integer, or undefined. */
export function validateK(text: string): number | undefined {
  if (!/^\d+$/.test(text)) return undefined;
  const value = Number(text);
  return Number.isInteger(value) && value > 0 ? value : undefined;
}

interface EvalsMenuProps {
  /** Discovered task names. */
  tasks: readonly string[];
  /** Called with the selected task names and validated k. */
  onConfirm: (tasks: string[], k: number) => void;
  /** Called on Esc from the task stage. */
  onClose: () => void;
}

/**
 * The /evals overlay: checkbox multi-select of tasks (space toggles,
 * enter confirms), then a numeric prompt for trials-per-task k (default
 * 3, positive integer). Menu-only by design — no CLI-style args (R10).
 */
export function EvalsMenu({ tasks, onConfirm, onClose }: EvalsMenuProps) {
  const [stage, setStage] = useState<'tasks' | 'k'>('tasks');
  const [cursor, setCursor] = useState(0);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [kText, setKText] = useState('3');
  const [error, setError] = useState<string | undefined>(undefined);

  useInput((input, key) => {
    if (key.escape) {
      if (stage === 'k') {
        setStage('tasks');
        setError(undefined);
      } else {
        onClose();
      }
      return;
    }

    if (stage === 'tasks') {
      if (key.upArrow) {
        setCursor((current) => Math.max(0, current - 1));
      } else if (key.downArrow) {
        setCursor((current) => Math.min(tasks.length - 1, current + 1));
      } else if (input === ' ') {
        const task = tasks[cursor];
        if (task === undefined) return;
        setSelected((current) => {
          const next = new Set(current);
          if (next.has(task)) next.delete(task);
          else next.add(task);
          return next;
        });
        setError(undefined);
      } else if (key.return) {
        if (selected.size === 0) {
          setError('Select at least one task (space toggles).');
          return;
        }
        setError(undefined);
        setStage('k');
      }
      return;
    }

    // Stage 'k': digits only, backspace edits, enter validates.
    if (key.return) {
      const k = validateK(kText);
      if (k === undefined) {
        setError('k must be a positive integer.');
        return;
      }
      onConfirm(tasks.filter((task) => selected.has(task)), k);
      return;
    }
    if (key.backspace || key.delete) {
      setKText((current) => current.slice(0, -1));
      setError(undefined);
      return;
    }
    if (/^\d$/.test(input)) {
      setKText((current) => (current + input).slice(0, 4));
      setError(undefined);
    }
  });

  return (
    <Box flexDirection="column" marginTop={1}>
      <Text color={theme.primary} bold>
        Eval tasks
      </Text>
      {tasks.length === 0 ? (
        <Text color={theme.muted}>  No eval tasks found.</Text>
      ) : stage === 'tasks' ? (
        <>
          {tasks.map((task, index) => (
            <Box key={task}>
              <Text color={index === cursor ? theme.emphasis : undefined}>
                {index === cursor ? '› ' : '  '}
              </Text>
              <Text color={selected.has(task) ? theme.emphasis : undefined}>
                {`[${selected.has(task) ? 'x' : ' '}] ${task}`}
              </Text>
            </Box>
          ))}
          <Text color={theme.muted}>  space toggle · enter continue · esc cancel</Text>
        </>
      ) : (
        <>
          <Text>
            {`  Trials per task — k: `}
            <Text color={theme.emphasis}>{kText === '' ? '∙' : kText}</Text>
          </Text>
          <Text color={theme.muted}>
            {`  running ${[...selected].join(', ')} · enter start · esc back`}
          </Text>
        </>
      )}
      {error !== undefined && <Text color={theme.error}>{`  ${error}`}</Text>}
    </Box>
  );
}
