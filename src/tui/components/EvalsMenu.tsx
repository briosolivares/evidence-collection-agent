import { Box, Text, useInput } from 'ink';
import { useState } from 'react';

import { DEFAULT_EVAL_CONCURRENCY } from '../../../evals/config.js';
import type { EvalTaskChoice } from '../bridge/evalSession.js';
import { theme } from '../theme.js';

export function validateK(text: string): number | undefined {
  return validatePositiveInteger(text);
}

export function validateConcurrency(text: string): number | undefined {
  return validatePositiveInteger(text);
}

interface EvalsMenuProps {
  tasks: readonly EvalTaskChoice[];
  onConfirm: (tasks: string[], k: number, concurrency: number) => void;
  onClose: () => void;
}

/** Task selection followed by k and normal/headless concurrency prompts. */
export function EvalsMenu({ tasks, onConfirm, onClose }: EvalsMenuProps) {
  const [stage, setStage] = useState<'tasks' | 'k' | 'concurrency'>('tasks');
  const [cursor, setCursor] = useState(0);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [kText, setKText] = useState('3');
  const [concurrencyText, setConcurrencyText] = useState(String(DEFAULT_EVAL_CONCURRENCY));
  const [error, setError] = useState<string | undefined>(undefined);

  useInput((input, key) => {
    if (key.escape) {
      if (stage === 'concurrency') setStage('k');
      else if (stage === 'k') setStage('tasks');
      else onClose();
      setError(undefined);
      return;
    }

    if (stage === 'tasks') {
      if (key.upArrow) setCursor((current) => Math.max(0, current - 1));
      else if (key.downArrow) setCursor((current) => Math.min(tasks.length - 1, current + 1));
      else if (input === ' ') {
        const task = tasks[cursor];
        if (task === undefined) return;
        setSelected((current) => {
          const next = new Set(current);
          if (next.has(task.name)) next.delete(task.name);
          else next.add(task.name);
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

    if (key.return) {
      const value = stage === 'k' ? validateK(kText) : validateConcurrency(concurrencyText);
      if (value === undefined) {
        setError(`${stage === 'k' ? 'k' : 'concurrency'} must be a positive integer.`);
        return;
      }
      if (stage === 'k') {
        setStage('concurrency');
      } else {
        onConfirm(
          tasks.filter((task) => selected.has(task.name)).map((task) => task.name),
          validateK(kText)!,
          value,
        );
      }
      setError(undefined);
      return;
    }

    const currentText = stage === 'k' ? kText : concurrencyText;
    const setText = stage === 'k' ? setKText : setConcurrencyText;
    if (key.backspace || key.delete) {
      setText(currentText.slice(0, -1));
      setError(undefined);
    } else if (/^\d$/.test(input)) {
      setText((currentText + input).slice(0, 4));
      setError(undefined);
    }
  });

  return (
    <Box flexDirection="column" marginTop={1}>
      <Text color={theme.primary} bold>
        Eval tasks
      </Text>
      {tasks.length === 0 ? (
        <Text color={theme.muted}>{'  No eval tasks found.'}</Text>
      ) : stage === 'tasks' ? (
        <>
          {tasks.map((task, index) => (
            <Box key={task.name}>
              <Text color={index === cursor ? theme.emphasis : undefined}>
                {index === cursor ? '› ' : '  '}
              </Text>
              <Text color={selected.has(task.name) ? theme.emphasis : undefined}>
                {`[${selected.has(task.name) ? 'x' : ' '}] ${task.name}${
                  task.headed ? ' [headed]' : ''
                }`}
              </Text>
            </Box>
          ))}
          <Text color={theme.muted}>{'  space toggle · enter continue · esc cancel'}</Text>
        </>
      ) : (
        <>
          <Text>
            {stage === 'k'
              ? '  Trials per task — k: '
              : '  Parallel headless trials — concurrency: '}
            <Text color={theme.emphasis}>{(stage === 'k' ? kText : concurrencyText) || '∙'}</Text>
          </Text>
          <Text color={theme.muted}>
            {`  running ${[...selected].join(', ')} · enter ${
              stage === 'k' ? 'continue' : 'start'
            } · esc back`}
          </Text>
        </>
      )}
      {error !== undefined && <Text color={theme.error}>{`  ${error}`}</Text>}
    </Box>
  );
}

function validatePositiveInteger(text: string): number | undefined {
  if (!/^\d+$/.test(text)) return undefined;
  const value = Number(text);
  return Number.isInteger(value) && value > 0 ? value : undefined;
}
