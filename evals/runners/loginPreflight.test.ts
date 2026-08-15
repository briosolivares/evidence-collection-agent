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
    const message = formatLoginPreflightFailure(statuses, requirements, 'local');

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
    expect(formatLoginPreflightFailure(statuses, requirements, 'local')).not.toContain('elon_tweets');
  });

  // An unverified session is the case that silently burned two batches:
  // treating it as "probably fine" is exactly the mistake the gate exists
  // to stop making.
  it('reports an unverified probe as a blocker, not a pass', () => {
    const statuses: ServiceLoginStatus[] = [{ service: X_HOME, state: 'pending' }];
    const message = formatLoginPreflightFailure(statuses, requirements, 'local');
    expect(message).toContain('X: UNVERIFIED');
    expect(message).toContain('blocks elon_tweets');
  });

  // A Browserbase batch is fixed by a human clicking through Live View, not
  // by anything that runs on the operator's own machine — so the fix line
  // has to name that command and say nothing about local Chrome.
  it('points a browserbase failure at Live View, not local Chrome', () => {
    const statuses: ServiceLoginStatus[] = [
      { service: GOOGLE_SHEETS, state: 'logged-out' },
      { service: X_HOME, state: 'logged-in' },
    ];
    const message = formatLoginPreflightFailure(statuses, requirements, 'browserbase');

    expect(message).toContain('LOGIN REQUIRED');
    expect(message).toContain('Google (Sheets): NOT LOGGED IN');
    expect(message).toContain('blocks mit_sororities');
    expect(message).toContain('npm run login');
    expect(message).toContain('Browserbase Live View');
    expect(message).toContain('--skip-login-check');
  });

  // `--manual` launches a local Chrome on a local profile; a Browserbase
  // batch has neither, so the flag would do nothing but pop an unrelated
  // window on the operator's machine. Google being the failing service is
  // exactly the case that triggers `--manual` advice on the local branch —
  // proving it stays absent here is the point of this test.
  it('never suggests --manual for browserbase, even when Google is failing', () => {
    const statuses: ServiceLoginStatus[] = [{ service: GOOGLE_SHEETS, state: 'logged-out' }];
    const message = formatLoginPreflightFailure(statuses, requirements, 'browserbase');
    expect(message).not.toContain('--manual');
  });
});
