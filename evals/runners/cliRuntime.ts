import type { BrowserController } from '../../src/browser/controller.js';
import { runTask, usableStartUrl, type RunTaskConfig } from '../../src/cli/runTask.js';
import type { ProgressEvent } from '../../src/model/callModel.js';
import type { PermissionRequest } from '../../src/tools/registry.js';
import type { RunTaskFn } from '../types.js';
import type { EvalBrowserRuntime } from './browserRuntime.js';

/** Marker the operator (or a log watcher) can grep for. Deliberately one
 * fixed, unmistakable token: mid-batch console output interleaves across
 * concurrent lanes, so the signal has to survive being read out of order. */
export const HUMAN_NEEDED_MARKER = 'HUMAN NEEDED';

export interface BrowserBackedRunTaskOptions {
  browserRuntime: EvalBrowserRuntime;
  model: string;
  runsBaseDir: string;
  onProgress?: (taskName: string, trialNumber: number, k: number, event: ProgressEvent) => void;
  /** Announce that a trial asked its human a question nobody is there to
   * answer. Defaults to a console warning. */
  onHumanNeeded?: (message: string) => void;
  /** Test seam for the production composition root. */
  runTaskFn?: (taskText: string, config: RunTaskConfig) => Promise<{ runDir: string }>;
}

/**
 * Turn one unanswerable `ask_user_question` into a loud operator warning and
 * a denial the agent can act on sensibly.
 *
 * The eval CLI has no dialog, so before this the pipeline's generic
 * fail-closed error was the whole story: the operator never heard about it,
 * and the agent was told to "proceed without it" — which is how a trial
 * blocked by a signed-out Google account ended up attempting to create one.
 * Denying is still right for an unattended batch (blocking every lane on
 * stdin for an hour is worse), but the denial now says what to do instead,
 * and the run no longer fails silently from the operator's side.
 */
function denyWithNotice(
  taskName: string,
  trialNumber: number,
  k: number,
  request: PermissionRequest,
  notify: (message: string) => void,
): { behavior: 'deny'; feedback: string } {
  const question = (request.input as { question?: unknown } | null)?.question;
  notify(
    `${HUMAN_NEEDED_MARKER} — ${taskName} trial ${trialNumber}/${k} called ` +
      `${request.toolName} and no human is attached: ` +
      `${typeof question === 'string' ? question : '(no question text)'}`,
  );
  return {
    behavior: 'deny',
    feedback:
      'No human is attached to this run, so this question cannot be answered. ' +
      'Do not create an account, sign up, or enter any credentials — you hold ' +
      'none, and doing so is never the task. If a login wall or missing ' +
      'permission blocks the task, complete every part you can reach, then ' +
      'report the blocker plainly in your deliverables and finish the run.',
  };
}

/** Build the CLI agent function while keeping browser policy outside runTask. */
export function createBrowserBackedRunTask(options: BrowserBackedRunTaskOptions): RunTaskFn {
  const runTaskFn = options.runTaskFn ?? runTask;
  const notify = options.onHumanNeeded ?? ((message: string) => console.warn(`\n${message}\n`));
  return (taskText, evalOptions) => {
    const startUrl = usableStartUrl(evalOptions.startUrl);
    return options.browserRuntime.withBrowser(evalOptions.headed, (browser: BrowserController) =>
      runTaskFn(taskText, {
        browser,
        model: options.model,
        runsBaseDir: options.runsBaseDir,
        requestPermission: (request) =>
          Promise.resolve(
            denyWithNotice(
              evalOptions.taskName,
              evalOptions.trialNumber,
              evalOptions.k,
              request,
              notify,
            ),
          ),
        // The headed lane is the persistent/login-capable browser. State the
        // authority and JavaScript grant explicitly; isolated trials are
        // anonymous but use the same static v3 tool prefix.
        authenticated: evalOptions.headed,
        javascriptPolicy: 'allow',
        signal: evalOptions.signal,
        ...(startUrl === undefined ? {} : { startUrl }),
        ...(options.onProgress === undefined
          ? {}
          : {
              onProgress: (event) =>
                options.onProgress!(
                  evalOptions.taskName,
                  evalOptions.trialNumber,
                  evalOptions.k,
                  event,
                ),
            }),
      }),
    );
  };
}
