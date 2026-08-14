import { describe, expect, it } from 'vitest';

import { GOOGLE_SHEETS, X_HOME, type ServiceLoginStatus } from '../../src/cli/loginProbe.js';
import type { EvalTask } from '../types.js';
import { formatLoginPreflightFailure, requiredLogins } from './loginPreflight.js';

function task(name: string, requiresLogin: string[]): EvalTask {
  return {
    name,
    taskText: name,
    headed: requiresLogin.length > 0,
    requiresLogin,
    fetchOracle: async () => ({}),
    grade: () => [],
  };
}

describe('requiredLogins', () => {
  it('is empty when no task in the batch declares a login', () => {
    expect(requiredLogins([task('hacker_news', []), task('edgar', [])])).toEqual([]);
  });

  it('unions ids across tasks and records every task that needs each', () => {
    expect(
      requiredLogins([
        task('mit_sororities', ['google-sheets']),
        task('elon_tweets', ['x']),
        task('other_sheet_task', ['google-sheets']),
      ]),
    ).toEqual([
      { id: 'google-sheets', tasks: ['mit_sororities', 'other_sheet_task'] },
      { id: 'x', tasks: ['elon_tweets'] },
    ]);
  });

  it('does not list the same task twice for one service', () => {
    const duplicated = task('mit_sororities', ['google-sheets', 'google-sheets']);
    expect(requiredLogins([duplicated])).toEqual([
      { id: 'google-sheets', tasks: ['mit_sororities'] },
    ]);
  });
});

describe('formatLoginPreflightFailure', () => {
  const requirements = [
    { id: 'google-sheets', tasks: ['mit_sororities'] },
    { id: 'x', tasks: ['elon_tweets'] },
  ];

  it('names the failing service, the tasks it blocks, and the fix', () => {
    const statuses: ServiceLoginStatus[] = [
      { service: GOOGLE_SHEETS, state: 'logged-out' },
      { service: X_HOME, state: 'logged-in' },
    ];
    const message = formatLoginPreflightFailure(statuses, requirements);

    expect(message).toContain('LOGIN REQUIRED');
    expect(message).toContain('Google (Sheets): NOT LOGGED IN');
    expect(message).toContain('blocks mit_sororities');
    expect(message).toContain('npm run login');
    expect(message).toContain('--skip-login-check');
  });

  it('omits services that are ready', () => {
    const statuses: ServiceLoginStatus[] = [
      { service: GOOGLE_SHEETS, state: 'logged-out' },
      { service: X_HOME, state: 'logged-in' },
    ];
    expect(formatLoginPreflightFailure(statuses, requirements)).not.toContain('elon_tweets');
  });

  // An unverified session is the case that silently burned two batches:
  // treating it as "probably fine" is exactly the mistake the gate exists
  // to stop making.
  it('reports an unverified probe as a blocker, not a pass', () => {
    const statuses: ServiceLoginStatus[] = [{ service: X_HOME, state: 'pending' }];
    const message = formatLoginPreflightFailure(statuses, requirements);
    expect(message).toContain('X: UNVERIFIED');
    expect(message).toContain('blocks elon_tweets');
  });
});
