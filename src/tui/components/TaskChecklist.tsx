import { Box, Text, useStdout } from 'ink';

import type { ChecklistTask } from '../../run/checklist.js';
import { theme } from '../theme.js';

export interface TaskChecklistProps {
  tasks: readonly ChecklistTask[];
  variant: 'compact' | 'standalone';
  /** Maximum number of task rows before a status-aware overflow row. */
  maxRows?: number;
  /** Available terminal width used to truncate subjects. */
  width?: number;
}

/** Select the first in-progress task (numeric order) as the current item. */
export function chooseCurrentTask(tasks: readonly ChecklistTask[]): ChecklistTask | undefined {
  return [...tasks]
    .filter((task) => task.status === 'in_progress')
    .sort(compareTaskIds)[0];
}

/** Render the live checklist without placing its changing state in the transcript. */
export function TaskChecklist({
  tasks,
  variant,
  maxRows,
  width,
}: TaskChecklistProps) {
  const { stdout } = useStdout();
  if (tasks.length === 0) return null;

  const availableWidth = width ?? stdout?.columns ?? 80;
  const ordered = [...tasks].sort(compareTaskIds);
  const current = chooseCurrentTask(ordered);
  const rows = current === undefined
    ? ordered
    : [current, ...ordered.filter((task) => task !== current)];
  const terminalBudget = Math.max(2, Math.min(7, Math.floor((stdout?.rows ?? 24) / 4)));
  const rowBudget = Math.max(2, maxRows ?? terminalBudget);
  const visibleCount = rows.length > rowBudget ? rowBudget - 1 : rows.length;
  const visible = rows.slice(0, visibleCount);
  const hidden = rows.slice(visibleCount);

  return (
    <Box flexDirection="column">
      {variant === 'standalone' && (
        <Text color={theme.primary} bold>Checklist</Text>
      )}
      {visible.map((task, index) => (
        <TaskRow
          key={task.id}
          task={task}
          current={variant === 'compact' && index === 0 && task === current}
          width={availableWidth}
          variant={variant}
        />
      ))}
      {hidden.length > 0 && <OverflowRow tasks={hidden} />}
    </Box>
  );
}

function TaskRow({
  task,
  current,
  width,
  variant,
}: {
  task: ChecklistTask;
  current: boolean;
  width: number;
  variant: TaskChecklistProps['variant'];
}) {
  const prefix = current ? '  └ ■ ' : variant === 'standalone' ? '  ' : '    ';
  const glyph = current
    ? ''
    : task.status === 'completed'
      ? '✓ '
      : task.status === 'in_progress'
        ? '■ '
        : '□ ';
  const subjectWidth = Math.max(1, width - prefix.length - glyph.length);
  const subject = truncateSubject(task.subject, subjectWidth);

  if (current) {
    return <Text><Text color={theme.primary}>{prefix}</Text><Text bold>{subject}</Text></Text>;
  }
  if (task.status === 'completed') {
    return <Text><Text color={theme.success}>{`${prefix}${glyph}`}</Text><Text color={theme.muted} dimColor>{subject}</Text></Text>;
  }
  if (task.status === 'in_progress') {
    return (
      <Text>
        <Text color={theme.primary}>{`${prefix}${glyph}`}</Text>
        <Text bold>{subject}</Text>
      </Text>
    );
  }
  return (
    <Text>
      <Text color={theme.primary}>{`${prefix}${glyph}`}</Text>
      {subject}
    </Text>
  );
}

function OverflowRow({ tasks }: { tasks: readonly ChecklistTask[] }) {
  const counts = new Map<string, number>();
  for (const task of tasks) {
    const label = task.status === 'completed' ? 'completed' : task.status === 'pending' ? 'pending' : 'in progress';
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  const parts = ['pending', 'in progress', 'completed']
    .filter((label) => counts.has(label))
    .map((label) => `${counts.get(label)} ${label}`);
  return <Text color={theme.muted}>{`    … +${parts.join(' · ')}`}</Text>;
}

export function truncateSubject(subject: string, width: number): string {
  if (subject.length <= width) return subject;
  if (width <= 1) return '…'.slice(0, width);
  return `${subject.slice(0, width - 1)}…`;
}

function compareTaskIds(left: ChecklistTask, right: ChecklistTask): number {
  const a = BigInt(left.id);
  const b = BigInt(right.id);
  return a < b ? -1 : a > b ? 1 : 0;
}
