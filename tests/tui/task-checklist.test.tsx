import { render } from 'ink-testing-library';
import { describe, expect, it } from 'vitest';

import type { ChecklistTask } from '../../src/run/checklist.js';
import { chooseCurrentTask, TaskChecklist, truncateSubject } from '../../src/tui/components/TaskChecklist.js';

const task = (id: string, status: ChecklistTask['status'], subject: string): ChecklistTask => ({
  id,
  status,
  subject,
  description: `${subject} description`,
});

describe('TaskChecklist', () => {
  it('renders nothing for an empty list', () => {
    expect(render(<TaskChecklist tasks={[]} variant="compact" />).lastFrame()).toBe('');
  });

  it('prioritizes the first in-progress task and renders compact status glyphs', () => {
    const { lastFrame, unmount } = render(
      <TaskChecklist
        tasks={[
          task('10', 'pending', 'Later'),
          task('2', 'in_progress', 'Current'),
          task('1', 'completed', 'Done'),
          task('3', 'in_progress', 'Other current'),
        ]}
        variant="compact"
      />,
    );
    const frame = lastFrame();
    expect(frame).toContain('└ ■ Current');
    expect(frame).toContain('✓ Done');
    expect(frame).toContain('□ Later');
    expect(frame).toContain('■ Other current');
    expect(frame!.indexOf('Current')).toBeLessThan(frame!.indexOf('Done'));
    expect(frame!.indexOf('Done')).toBeLessThan(frame!.indexOf('Later'));
    expect(chooseCurrentTask([task('3', 'in_progress', 'Third'), task('2', 'in_progress', 'Second')])?.id).toBe('2');
    unmount();
  });

  it('sorts numerically and uses a standalone heading without a tree connector', () => {
    const { lastFrame, unmount } = render(
      <TaskChecklist tasks={[task('10', 'pending', 'Ten'), task('2', 'pending', 'Two')]} variant="standalone" />,
    );
    const frame = lastFrame();
    expect(frame).toContain('Checklist');
    expect(frame).toContain('□ Two');
    expect(frame).toContain('□ Ten');
    expect(frame).not.toContain('└');
    expect(frame!.indexOf('Two')).toBeLessThan(frame!.indexOf('Ten'));
    unmount();
  });

  it('caps rows and reports hidden statuses in one summary', () => {
    const { lastFrame, unmount } = render(
      <TaskChecklist
        tasks={[
          task('1', 'in_progress', 'Current'),
          task('2', 'pending', 'Pending one'),
          task('3', 'completed', 'Completed one'),
          task('4', 'completed', 'Completed two'),
        ]}
        variant="compact"
        maxRows={2}
      />,
    );
    expect(lastFrame()).toContain('… +1 pending · 2 completed');
    expect(lastFrame()).not.toContain('Pending one');
    expect(lastFrame()).not.toContain('Completed two');
    unmount();
  });

  it('truncates subjects to the available width with an ellipsis', () => {
    expect(truncateSubject('Collecting evidence', 10)).toBe('Collectin…');
    const { lastFrame, unmount } = render(
      <TaskChecklist tasks={[task('1', 'pending', 'A very long checklist subject')]} variant="compact" width={16} />,
    );
    expect(lastFrame()).toContain('A very lo…');
    unmount();
  });
});
