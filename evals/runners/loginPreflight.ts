/**
 * Pre-batch login gate.
 *
 * A batch that needs a signed-in session and does not have one does not
 * fail fast: the agent reaches the login wall twenty minutes in, finds
 * nobody to ask (the CLI has no dialog), and improvises — in one recorded
 * case by trying to create a Google account. The trial is wasted either
 * way, and the operator only learns about it from the final report.
 *
 * So the requirement is checked before the first trial starts, against the
 * same profile directory the trials launch, and the batch refuses to run
 * until the human has fixed it. Cheap check, expensive failure.
 *
 * Pure logic only — the browser lives in `src/cli/loginCheck.ts`, so every
 * decision and every line of operator-facing text here is unit-testable.
 */
import { formatLoginState, type ServiceLoginStatus } from '../../src/cli/loginProbe.js';
import type { BrowserProviderKind } from '../../src/browser/sessionProvider.js';
import type { EvalTask } from '../types.js';

/**
 * The union of login service ids the batch's tasks declare, with the tasks
 * that asked for each.
 *
 * @param tasks - the loaded tasks about to run
 * @returns one entry per required service id, in first-appearance order;
 *   empty when no task in the batch needs a session
 */
export function requiredLogins(tasks: readonly EvalTask[]): { id: string; tasks: string[] }[] {
  const byId = new Map<string, string[]>();
  for (const task of tasks) {
    for (const id of task.requiresLogin) {
      const owners = byId.get(id);
      if (owners === undefined) byId.set(id, [task.name]);
      else if (!owners.includes(task.name)) owners.push(task.name);
    }
  }
  return [...byId].map(([id, taskNames]) => ({ id, tasks: taskNames }));
}

/**
 * The operator-facing refusal: which service is not ready, which tasks it
 * blocks, and the one command that fixes it.
 *
 * Names the blocked tasks because the useful next decision is often "log in"
 * *or* "drop that task and run the rest" — and the operator cannot make it
 * without knowing what is at stake.
 *
 * `provider` is required, not defaulted, on purpose: this module exists
 * because a batch that hit the login wall twenty minutes in was worse than
 * one that never started, and the same is true of a preflight that hands out
 * local-only advice for a batch actually running against Browserbase. Every
 * call site has to say which runtime it means; there is no "probably local"
 * to fall back on.
 */
export function formatLoginPreflightFailure(
  statuses: readonly ServiceLoginStatus[],
  requirements: readonly { id: string; tasks: string[] }[],
  provider: BrowserProviderKind,
): string {
  const lines = ['', 'LOGIN REQUIRED — batch not started.', ''];
  for (const status of statuses) {
    if (status.state === 'logged-in') continue;
    const blocked = requirements.find((req) => req.id === status.service.id)?.tasks ?? [];
    lines.push(
      `  ${status.service.name}: ${formatLoginState(status.state)}` +
        (blocked.length > 0 ? ` — blocks ${blocked.join(', ')}` : ''),
    );
  }
  // Google refuses its sign-in flow inside an automated browser, so the
  // default helper cannot fix a Google failure however many times you run
  // it — but only the local default helper is automated in the way Google
  // objects to. `--manual` launches a plain local Chrome on the local
  // profile; against Browserbase there is no local profile to launch it on,
  // so that flag would do nothing but open an unrelated Chrome on the
  // operator's machine. The remote fix is `npm run login` itself: it opens a
  // Live View, which is a human clicking through a real browser tab already,
  // so Google's automation objection never applies there in the first place.
  const needsManual =
    provider === 'local' &&
    statuses.some(
      (status) => status.state !== 'logged-in' && status.service.id === 'google-sheets',
    );
  lines.push(
    '',
    needsManual
      ? 'Fix it with:  npm run login -- --manual\n' +
          '(a plain Chrome opens on the same profile — Google only accepts its\n' +
          ' sign-in flow there; sign in, quit Chrome, and it verifies itself)'
      : provider === 'local'
        ? 'Fix it with:  npm run login\n' +
          '(a Chrome window opens; sign in by hand, press Enter to verify)'
        : 'Fix it with:  npm run login\n' +
          '(a Browserbase Live View opens; sign in by hand — the login is verified\n' +
          ' against a second session on the same context, which is what an\n' +
          ' authenticated trial will use)',
    '',
    'Then re-run the batch. To run anyway and let the blocked tasks fail,',
    'pass --skip-login-check.',
  );
  return lines.join('\n');
}
